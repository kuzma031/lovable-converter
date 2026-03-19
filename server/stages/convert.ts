import fs from "fs";
import path from "path";
import fsExtra from "fs-extra";
import { z } from "zod";
import openAIClient from "../openai";
import { zodTextFormat } from "openai/helpers/zod.mjs";
import { AnalysisResult, FileInfo } from "../types";
import { config } from "../config";
import {
  buildComponentConversionTasks,
  getItemsToSendToAi,
  logSendingToAi,
  updateShouldSendToAI,
} from "../utils/convert-utils";
import {
  convertComponentPrompt,
  convertPostCSSFilePrompt,
  convertEntryFilesToLayoutPrompt,
  GLOBAL_SYSTEM_PROMPT,
  CONVERT_ENTRY_FILES_TO_LAYOUT_SYSTEM_PROMPT,
  CONVERT_COMPONENT_SYSTEM_PROMPT,
} from "../openai/prompts";
import { handleOpenAIError } from "../openai/openai-errors";

/**
 * Convert all route pages and component files, writing to the Next.js output folder.
 * @param analysis - Project analysis (routes + componentFiles)
 * @param nextRoot - Absolute path to the Next.js project (e.g. next-output/{jobId}). Each item's outputFile is resolved under this path.
 * @param sourceRoot - Absolute path to the source Vite project root (needed for converting config files from extraRootFilesFolders).
 */
export async function convertAllFiles(
  analysis: AnalysisResult,
  nextRoot: string,
  sourceRoot: string,
) {
  updateShouldSendToAI(analysis);

  const {
    components,
    routes,
    extraLogicFilesRoot,
    extraLogicFilesSrc,
    authProtectedComponent,
  } = getItemsToSendToAi(analysis);

  // Merge all entry files (main + layout) and send to AI to produce app/layout.tsx
  const { entryFiles, projectStructure } = analysis;
  const entryPaths = entryFiles
    .map((e) => e.path)
    .filter(
      (p): p is string => !!p && typeof p === "string" && fs.existsSync(p),
    );

  logSendingToAi(
    entryFiles,
    components,
    routes,
    extraLogicFilesRoot,
    extraLogicFilesSrc,
  );

  // Merge entry files into one string to send to AI
  const entryFileContent = entryPaths
    .map((filePath) => {
      const name = path.basename(filePath);
      const content = fs.readFileSync(filePath, "utf-8");
      return `File: ${name}\n\`\`\`tsx\n${content}\n\`\`\``;
    })
    .join("\n\n");

  if (entryPaths.length > 0)
    await convertEntryFilesToLayout(entryFileContent, nextRoot);

  // Build conversion tasks for component files
  const componentTasks = buildComponentConversionTasks(nextRoot, {
    components,
    routes,
    extraLogicFilesRoot,
    extraLogicFilesSrc,
  });

  // Convert component files in parallel with a concurrency limit
  await runWithConcurrency(
    componentTasks,
    config.CONVERSION_CONCURRENCY,
    (task) =>
      convertComponent(
        task.sourceFile,
        task.targetPath,
        task.isAuthProtected,
        projectStructure,
        authProtectedComponent,
      ),
  );

  const postcssPath = path.join(sourceRoot, "postcss.config.js");
  if (fs.existsSync(postcssPath)) {
    await convertConfigFile(
      postcssPath,
      path.join(nextRoot, "postcss.config.js"),
    );
  }
}

/** Runs async work in parallel with a concurrency limit. */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    await Promise.all(chunk.map(fn));
  }
}

/**
 * Reads all entry files (e.g. main.tsx + App.tsx), sends them to AI with a prompt to merge
 * into a single Next.js root layout, and writes the result to app/layout.tsx.
 */
async function convertEntryFilesToLayout(
  fileContent: string,
  nextRoot: string,
): Promise<void> {
  try {
    if (!config.SEND_COMPONENTS_TO_AI) {
      return;
    }

    const prompt = convertEntryFilesToLayoutPrompt(fileContent);

    const EntryFilesConversionSchema = z.object({
      layoutComponent: z.string(),
      providerComponent: z.string(),
    });

    const response = await openAIClient.responses.parse({
      model: config.DEFAULT_AI_MODEL,
      temperature: 0,
      input: [
        {
          role: "system",
          content: CONVERT_ENTRY_FILES_TO_LAYOUT_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      text: {
        format: zodTextFormat(
          EntryFilesConversionSchema,
          "entry_files_conversion",
        ),
      },
    });

    const parsed = EntryFilesConversionSchema.parse(response.output_parsed);
    const { layoutComponent, providerComponent } = parsed;
    const layoutPath = path.join(nextRoot, "app", "layout.tsx");
    const providerPath = path.join(nextRoot, "app", "providers.tsx");
    fsExtra.ensureDirSync(path.dirname(layoutPath));
    fsExtra.ensureDirSync(path.dirname(providerPath));
    fs.writeFileSync(layoutPath, layoutComponent);
    fs.writeFileSync(providerPath, providerComponent);
    if (config.DEBUG.LOGS) {
      console.log(`Merged entry files → ${layoutPath}`);
    }
  } catch (error) {
    handleOpenAIError(error, {
      context: "converting entry files to layout",
    });
  }
}

const ConvertedCodeSchema = z.object({
  convertedCode: z.string(),
});

/**
 * Sends a single config file to AI to convert from Vite to Next.js and writes the result.
 */
async function convertConfigFile(
  sourceFilePath: string,
  targetFilePath: string,
): Promise<void> {
  try {
    if (!config.SEND_COMPONENTS_TO_AI) {
      return;
    }

    const oldCode = fs.readFileSync(sourceFilePath, "utf-8");

    const prompt = convertPostCSSFilePrompt(oldCode);

    const response = await openAIClient.responses.parse({
      model: config.DEFAULT_AI_MODEL,
      temperature: 0,
      input: [
        {
          role: "system",
          content: GLOBAL_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      text: {
        format: zodTextFormat(ConvertedCodeSchema, "config_conversion"),
      },
    });

    const parsed = ConvertedCodeSchema.parse(response.output_parsed);

    fsExtra.ensureDirSync(path.dirname(targetFilePath));
    fs.writeFileSync(targetFilePath, parsed.convertedCode);
    if (config.DEBUG.LOGS) {
      console.log(
        `Converted config ${path.basename(sourceFilePath)} → ${targetFilePath}`,
      );
    }
  } catch (error) {
    handleOpenAIError(error, {
      context: "converting config file",
    });
  }
}

/**
 * Converts a single component file from Vite to Next.js using AI and writes the result.
 */
export async function convertComponent(
  sourceFilePath: string,
  targetFilePath: string,
  isAuthProtected: boolean = false,
  projectStructure: string,
  authProtectedComponent?: { path: string; fullImportStatement: string } | null,
) {
  if (!config.SEND_COMPONENTS_TO_AI) {
    return;
  }

  try {
    const oldCode = fs.readFileSync(sourceFilePath, "utf-8");

    const prompt = convertComponentPrompt({
      fileContent: oldCode,
      isAuthProtected,
      authProtectedComponent,
      projectStructure,
    });

    const response = await openAIClient.responses.parse({
      model: config.DEFAULT_AI_MODEL,
      temperature: 0,
      input: [
        {
          role: "system",
          content: CONVERT_COMPONENT_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      text: {
        format: zodTextFormat(ConvertedCodeSchema, "component_conversion"),
      },
    });

    const parsed = ConvertedCodeSchema.parse(response.output_parsed);

    fsExtra.ensureDirSync(path.dirname(targetFilePath));
    fs.writeFileSync(targetFilePath, parsed.convertedCode);
    if (config.DEBUG.LOGS) {
      console.log(
        `Converted ${path.basename(sourceFilePath)} → ${targetFilePath}`,
      );
    }
  } catch (error) {
    handleOpenAIError(error, {
      context: "converting component",
    });
  }
}
