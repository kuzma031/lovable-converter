import fs from "fs";
import path from "path";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod.mjs";
import { walkDir } from "../utils/fs";
import { parseTSX } from "../utils/ast";
import openAIClient from "../openai";
import { config } from "../config";
import { GLOBAL_SYSTEM_PROMPT, fixPostConversionIssuesPrompt } from "../openai/prompts";
import { handleOpenAIError } from "../openai/openai-errors";
import type { AnalysisResult, FileInfo } from "../types";

const CODE_EXT = [".ts", ".tsx", ".js", ".jsx"];

export interface PostConversionIssue {
  /** File path (relative to project root or absolute) */
  file: string;
  /** Issue type for filtering */
  type: "parse" | "heuristic" | "structure";
  message: string;
}

export interface PostConversionResult {
  success: boolean;
  errors: PostConversionIssue[];
  warnings: PostConversionIssue[];
}

/** Patterns that indicate conversion problems (heuristic checks) */
const BAD_PATTERNS = [
  {
    pattern: /import\s+\w+\s+from\s+["']@\/assets\//,
    message: "Leftover Vite-style image import (use /assets/ path with next/image instead)",
  },
  {
    pattern: /<img\s/i,
    message: "Unconverted <img> tag (should be next/image <Image />)",
  },
  {
    pattern: /from\s+["']react-router(?:-dom)?["']/,
    message: "Leftover react-router import (should use Next.js navigation)",
  },
];

/**
 * Run post-conversion checks on the Next.js output project.
 * No npm install or next build — only parse + heuristic + structure checks.
 */
export function runPostConversionChecks(projectRoot: string): PostConversionResult {
  const errors: PostConversionIssue[] = [];
  const warnings: PostConversionIssue[] = [];

  if (!projectRoot || !fs.existsSync(projectRoot)) {
    errors.push({
      file: projectRoot,
      type: "structure",
      message: "Project root does not exist",
    });
    return { success: false, errors, warnings };
  }

  // —— Structural checks ——
  const layoutPath = path.join(projectRoot, "app", "layout.tsx");
  if (!fs.existsSync(layoutPath)) {
    errors.push({
      file: "app/layout.tsx",
      type: "structure",
      message: "Missing app/layout.tsx",
    });
  }

  const appDir = path.join(projectRoot, "app");
  if (fs.existsSync(appDir)) {
    const entries = fs.readdirSync(appDir, { recursive: true }) as string[];
    const hasPage = entries.some(
      (name) => name.endsWith("page.tsx") || name.endsWith("page.jsx"),
    );
    if (!hasPage) {
      warnings.push({
        file: "app/",
        type: "structure",
        message: "No page.tsx found under app/",
      });
    }
  }

  // —— Collect code files (exclude node_modules; walkDir already skips it) ——
  const allFiles = walkDir(projectRoot);
  const codeFiles = allFiles.filter((f) =>
    CODE_EXT.some((ext) => f.toLowerCase().endsWith(ext)),
  );

  for (const filePath of codeFiles) {
    const relativePath = path.relative(projectRoot, filePath);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      errors.push({ file: relativePath, type: "parse", message: "Could not read file" });
      continue;
    }

    // —— Parse check (syntax) ——
    try {
      parseTSX(content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({
        file: relativePath,
        type: "parse",
        message: `Parse error: ${message.slice(0, 120)}`,
      });
    }

    // —— Heuristic checks ——
    for (const { pattern, message } of BAD_PATTERNS) {
      if (pattern.test(content)) {
        errors.push({ file: relativePath, type: "heuristic", message });
      }
    }
  }

  const success = errors.length === 0;
  return { success, errors, warnings };
}

/**
 * Log post-conversion result to console (errors in red, warnings in yellow).
 */
export function logPostConversionResult(result: PostConversionResult, projectRoot?: string): void {
  const prefix = projectRoot ? `[${path.basename(projectRoot)}] ` : "";
  if (result.success && result.warnings.length === 0) {
    console.log(`${prefix}Post-conversion checks: OK`);
    return;
  }
  for (const e of result.errors) {
    console.error(`${prefix}ERROR [${e.type}] ${e.file}: ${e.message}`);
  }
  for (const w of result.warnings) {
    console.warn(`${prefix}WARN [${w.type}] ${w.file}: ${w.message}`);
  }
  if (!result.success) {
    console.error(`${prefix}Post-conversion checks: ${result.errors.length} error(s)`);
  }
}

/** Issue types that can be fixed by editing the file (parse and heuristic only; structure is project-level). */
const FIXABLE_ISSUE_TYPES: PostConversionIssue["type"][] = ["parse", "heuristic"];

/**
 * Returns issues that can be fixed by sending the file to AI (parse + heuristic), grouped by file path.
 */
export function getFixableIssuesByFile(result: PostConversionResult): Map<string, PostConversionIssue[]> {
  const byFile = new Map<string, PostConversionIssue[]>();
  const allFixable = [...result.errors, ...result.warnings].filter((i) =>
    FIXABLE_ISSUE_TYPES.includes(i.type),
  );
  for (const issue of allFixable) {
    const list = byFile.get(issue.file) ?? [];
    list.push(issue);
    byFile.set(issue.file, list);
  }
  return byFile;
}

const FixedCodeSchema = z.object({
  fixedCode: z.string(),
});

/**
 * Sends each file that has post-conversion errors/warnings to AI with a prompt to fix only those
 * issues and not change anything else, then overwrites the file with the fixed content.
 */
export async function fixPostConversionIssuesWithAI(
  result: PostConversionResult,
  projectRoot: string,
): Promise<void> {
  const byFile = getFixableIssuesByFile(result);
  if (byFile.size === 0) return;

  if (!config.SEND_COMPONENTS_TO_AI) {
    if (config.DEBUG.LOGS) {
      console.log("[postconfig] SEND_COMPONENTS_TO_AI is false; skipping AI fix step.");
    }
    return;
  }

  const prefix = projectRoot ? `[${path.basename(projectRoot)}] ` : "";

  for (const [relativeFile, issues] of byFile) {
    const absolutePath = path.join(projectRoot, relativeFile);
    if (!fs.existsSync(absolutePath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(absolutePath, "utf-8");
    } catch {
      if (config.DEBUG.LOGS) {
        console.warn(`${prefix}Could not read ${relativeFile}; skipping AI fix.`);
      }
      continue;
    }

    try {
      const prompt = fixPostConversionIssuesPrompt(
        content,
        relativeFile,
        issues.map((i) => ({ type: i.type, file: i.file, message: i.message })),
      );

      const response = await openAIClient.responses.parse({
        model: config.DEFAULT_AI_MODEL,
        temperature: 0,
        input: [
          { role: "system", content: GLOBAL_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        text: {
          format: zodTextFormat(FixedCodeSchema, "postconfig_fix"),
        },
      });

      const parsed = FixedCodeSchema.parse(response.output_parsed);
      fs.writeFileSync(absolutePath, parsed.fixedCode);
      if (config.DEBUG.LOGS) {
        console.log(`${prefix}Fixed ${issues.length} issue(s) in ${relativeFile}`);
      }
    } catch (error) {
      handleOpenAIError(error, {
        context: `fixing post-conversion issues in ${relativeFile}`,
      });
    }
  }
}

/** Matches static import from "..." or from '...' (captures quote and specifier) */
const IMPORT_FROM_REGEX = /from\s+(["'])([^"']+)\1/g;

/**
 * Collects all output file paths from analysis (routes, components, extra logic).
 * Each path is absolute: projectRoot + output path.
 */
function getOutputFilePaths(analysis: AnalysisResult, projectRoot: string): string[] {
  const paths: string[] = [];
  const add = (outputPath: string) => {
    if (outputPath) paths.push(path.join(projectRoot, outputPath));
  };
  for (const r of analysis.routes) add(r.outputFile);
  for (const c of analysis.componentFiles) add(c.outputFile);
  for (const f of analysis.extraLogicFilesRoot) add(f.outputFile ?? "");
  for (const f of analysis.extraLogicFilesSrc) {
    add((f.outputFile ?? "").replace(/^src[/\\]/, ""));
  }
  return paths.filter(Boolean);
}

/**
 * Converts a relative import like "../../components/header/Header" to "@/components/header/Header".
 * We strip leading "../" (and "./" if any) and treat the rest as path from project root, so that
 * "components", "lib", etc. are always at root, not under "app/".
 */
function relativeSpecifierToAlias(specifier: string): string {
  let rest = specifier.trim().replace(/\\/g, "/");
  while (rest.startsWith("../")) rest = rest.slice(3);
  while (rest.startsWith("./")) rest = rest.slice(2);
  if (!rest) return specifier;
  return `@/${rest}`;
}

/**
 * Rewrites relative import specifiers (../ only) to @/ alias in file content.
 * Same-folder imports (./) are left unchanged. Paths like "../../components/..." become
 * "@/components/..." (project root), not "@/app/components/...".
 */
function rewriteRelativeImportsInContent(content: string): string {
  return content.replace(IMPORT_FROM_REGEX, (match, quote, specifier) => {
    const trimmed = specifier.trim();
    if (trimmed.startsWith("./")) return match;
    if (!trimmed.startsWith("../")) return match;
    if (trimmed.startsWith("@")) return match;
    const newSpec = relativeSpecifierToAlias(trimmed);
    return `from ${quote}${newSpec}${quote}`;
  });
}

/**
 * Goes over all files from analysis (routes, components, extra logic) and rewrites
 * parent-relative imports (../) to @/ alias. Same-folder imports (./) are left unchanged.
 */
export function fixImportPathsInProject(
  analysis: AnalysisResult,
  projectRoot: string,
): void {
  const outputPaths = getOutputFilePaths(analysis, projectRoot);
  const codeExtSet = new Set(CODE_EXT.map((e) => e.toLowerCase()));
  const prefix = projectRoot ? `[${path.basename(projectRoot)}] ` : "";

  for (const absolutePath of outputPaths) {
    if (!fs.existsSync(absolutePath)) continue;
    const ext = path.extname(absolutePath).toLowerCase();
    if (!codeExtSet.has(ext)) continue;

    let content: string;
    try {
      content = fs.readFileSync(absolutePath, "utf-8");
    } catch {
      continue;
    }

    if (!/from\s+["']\.\.\//.test(content)) continue;

    const newContent = rewriteRelativeImportsInContent(content);
    if (newContent === content) continue;

    fs.writeFileSync(absolutePath, newContent);
    if (config.DEBUG.LOGS) {
      const relative = path.relative(projectRoot, absolutePath);
      console.log(`${prefix}Fixed import paths in ${relative}`);
    }
  }
}
