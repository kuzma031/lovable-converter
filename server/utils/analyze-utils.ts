import path from "path";
import fs from "fs";
import traverseDefault, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";

import { walkDir } from "./fs";
import { AnalysisResult, EntryFile, FileInfo } from "../types";
import { getImportsAndExports } from "./imports-exports";
import { parseTSX } from "./ast";
import { routePathToAppDir } from "./nextjs";
import { config } from "../config";
import openAIClient from "../openai";
import { zodTextFormat } from "openai/helpers/zod.mjs";
import z from "zod";
import { handleOpenAIError } from "../openai/openai-errors";
import { analyzeIndexFilePrompt } from "../openai/prompts";

const traverse =
  typeof traverseDefault === "function"
    ? traverseDefault
    : (traverseDefault as { default: typeof traverseDefault }).default;

const COMPONENT_DIR_NAMES = ["components", "Components"];

const CODE_EXT = [".ts", ".tsx", ".js", ".jsx"];

/**
 * Finds the React entry file (has createRoot) and the root layout file (what createRoot().render() renders).
 * @param projectRoot - Path to the project root (repo)
 * @returns { entryFile: string, layoutFile: string } - absolute paths; empty string if not found
 */
function getMainFiles(projectRoot: string): {
  entryFile: string;
  layoutFile: string;
} {
  const srcDir = path.join(projectRoot, "src");
  if (!fs.existsSync(srcDir)) return { entryFile: "", layoutFile: "" };

  const files = walkDir(srcDir).filter((f) =>
    CODE_EXT.some((ext) => f.endsWith(ext)),
  );

  let entryFile = "";
  for (const file of files) {
    const code = fs.readFileSync(file, "utf-8");
    if (!code.includes("createRoot")) continue;
    try {
      const ast = parseTSX(code);
      let hasCreateRoot = false;
      traverse(ast, {
        ImportDeclaration(nodePath: NodePath<t.Node>) {
          const node = nodePath.node as t.ImportDeclaration;
          const source = t.isStringLiteral(node.source)
            ? node.source.value
            : "";
          if (source !== "react-dom" && source !== "react-dom/client") return;
          const specifiers = node.specifiers || [];
          for (const spec of specifiers) {
            const name = t.isImportSpecifier(spec)
              ? (spec.imported as t.Identifier).name
              : t.isImportDefaultSpecifier(spec)
                ? (spec.local as t.Identifier).name
                : "";
            if (name === "createRoot") {
              hasCreateRoot = true;
              break;
            }
          }
        },
      });
      if (hasCreateRoot) {
        entryFile = file;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!entryFile) return { entryFile: "", layoutFile: "" };

  const entryCode = fs.readFileSync(entryFile, "utf-8");
  const entryDir = path.dirname(entryFile);
  let rootComponentName = "";

  try {
    const ast = parseTSX(entryCode);
    traverse(ast, {
      CallExpression(nodePath: NodePath<t.Node>) {
        const node = nodePath.node as t.CallExpression;
        if (!t.isMemberExpression(node.callee)) return;
        const { object, property } = node.callee;
        if (!t.isIdentifier(property, { name: "render" })) return;
        if (!t.isCallExpression(object)) return;
        const renderArg = node.arguments[0];
        if (t.isJSXElement(renderArg)) {
          const opening = renderArg.openingElement;
          if (t.isJSXIdentifier(opening.name)) {
            rootComponentName = opening.name.name;
          }
        } else if (
          t.isCallExpression(renderArg) &&
          t.isIdentifier(renderArg.callee, { name: "createElement" })
        ) {
          const firstArg = renderArg.arguments[0];
          if (t.isIdentifier(firstArg)) {
            rootComponentName = firstArg.name;
          }
        }
      },
    });
  } catch {
    return { entryFile, layoutFile: "" };
  }

  if (!rootComponentName) return { entryFile, layoutFile: "" };

  const { importsByModule } = getImportsAndExports(entryFile);
  let layoutFile = "";
  for (const [specifier, names] of Object.entries(importsByModule)) {
    if (!names.includes(rootComponentName)) continue;
    const resolved = path.resolve(entryDir, specifier);
    for (const ext of CODE_EXT) {
      const withExt = resolved.endsWith(ext) ? resolved : resolved + ext;
      if (fs.existsSync(withExt)) {
        layoutFile = withExt;
        break;
      }
    }
    if (!layoutFile && fs.existsSync(resolved)) layoutFile = resolved;
    if (layoutFile) break;
  }

  return { entryFile, layoutFile };
}

/**
 * Add entry files to the analysis. Entry files are the main files that are used to render the app.
 * @param projectRoot - Path to the project root (repo)
 * @returns { files: EntryFile[], layoutFile: string } - absolute paths; empty string if not found
 */
export function addEntryFiles(projectRoot: string) {
  const { entryFile, layoutFile } = getMainFiles(projectRoot);

  const { importsByModule: importsByModuleEntry, exports: exportsEntry } =
    getImportsAndExports(entryFile);
  const { importsByModule: importsByModuleLayout, exports: exportsLayout } =
    getImportsAndExports(layoutFile);

  const files: EntryFile[] = [
    {
      path: entryFile,
      importsByModule: importsByModuleEntry,
      exports: exportsEntry,
    },
    {
      path: layoutFile,
      importsByModule: importsByModuleLayout,
      exports: exportsLayout,
    },
  ];

  return { files, layoutFile };
}

/**
 * Add not found route to the analysis routes array.
 * If it exists, update its properties for sending to AI.
 * If it doesn't exist, create a new not found route.
 * Ensure its always sent to AI for conversion.
 **/
export function addNotFoundRoute(analysis: AnalysisResult, sourceRoot: string) {
  const existingNotFound = analysis.routes.find((r) => r.path === "*");
  if (existingNotFound) {
    existingNotFound.shouldSendToAi = true;
    existingNotFound.isScoreCalculated = true;
  } else {
    const srcDir = path.join(sourceRoot, "src");
    const pagesDir = path.join(srcDir, "pages");
    const exts = [".tsx", ".ts", ".jsx", ".js"];
    let notFoundSource: string | null = null;
    for (const name of ["NotFound", "NotFoundPage", "not-found"]) {
      for (const ext of exts) {
        const candidate = path.join(pagesDir, `${name}${ext}`);
        if (fs.existsSync(candidate)) {
          notFoundSource = candidate;
          break;
        }
      }
      if (notFoundSource) break;
    }
    if (notFoundSource) {
      const component = path
        .basename(notFoundSource, path.extname(notFoundSource))
        .replace(/^([a-z])/, (_, c: string) => c.toUpperCase());
      const { exports: exportsList, importsByModule } =
        getImportsAndExports(notFoundSource);
      const notFoundRoute: FileInfo = {
        path: "*", // catch-all route path on vite
        component: component || "NotFound",
        sourceFile: notFoundSource,
        outputFile: "app/not-found.tsx",
        importsByModule,
        exports: exportsList,
        shouldSendToAi: true,
        isScoreCalculated: true,
        isAuthProtected: false,
      };
      analysis.routes.push(notFoundRoute);
    }
  }
}

/** Return list of component file path in the project src directory */
export function getComponentFilesPaths(projectRoot: string): string[] {
  const srcDir = path.join(projectRoot, "src");
  const componentFiles: string[] = [];
  const seenRealDirs = new Set<string>();
  for (const dirName of COMPONENT_DIR_NAMES) {
    const componentDir = path.join(srcDir, dirName);
    if (!fs.existsSync(componentDir)) continue;
    // On Windows, "components" and "Components" are the same folder; realpathSync can preserve casing so normalize
    const realDir = fs.realpathSync(componentDir);
    const realDirKey = realDir.toLowerCase();
    if (seenRealDirs.has(realDirKey)) continue;
    seenRealDirs.add(realDirKey);
    componentFiles.push(...walkDir(componentDir));
  }
  // Deduplicate by canonical path (same file can appear as .../components/... or .../Components/... on Windows)
  const seenFiles = new Set<string>();
  return componentFiles.filter((f) => {
    if (!CODE_EXT.some((ext) => f.endsWith(ext))) return false;
    const canonical = path.resolve(f).toLowerCase();
    if (seenFiles.has(canonical)) return false;
    seenFiles.add(canonical);
    return true;
  });
}

/**
 * Where to write a component file in the Next.js output (next-output/{jobId}).
 * Always under "components/...". Preserves subfolder structure if the source
 * was under src/components/ or src/Components/; otherwise uses just the filename.
 * @example componentOutputFile("C:/proj/src/components/Button/Button.tsx", "C:/proj/src") → "components/Button/Button.tsx"
 * @example componentOutputFile("C:/proj/src/Components/Header.tsx", "C:/proj/src") → "components/Header.tsx"
 */
function componentOutputFile(sourceFile: string, srcDir: string): string {
  const relative = path.relative(srcDir, sourceFile);
  const normalized = relative.split(path.sep).join("/");
  const match = normalized.match(/^(components|Components)\//i);
  const after = match
    ? normalized.slice(match[0].length)
    : path.basename(sourceFile);
  return `components/${after}`;
}

/**
 * Maps a React Router route path to the corresponding Next.js App Router file path.
 * Dynamic segments (:id) become [id]. Root "/" becomes app/page.tsx; "*" becomes app/not-found.tsx.
 * @example routeOutputFile("/") → "app/page.tsx"
 * @example routeOutputFile("/about") → "app/about/page.tsx"
 * @example routeOutputFile("/users/:id") → "app/users/[id]/page.tsx"
 * @example routeOutputFile("*") → "app/not-found.tsx"
 */
function routeOutputFile(routePath: string): string {
  if (routePath === "*") return "app/not-found.tsx";
  const dir = routePathToAppDir(routePath);
  return dir ? `app/${dir}/page.tsx` : "app/page.tsx";
}

/**
 * Create RouteInfo[] for reusable components (from src/components/).
 * We already have the file list from getComponentFilesPaths, so we just map each file → RouteInfo.
 */
export function createComponentFilesInfo(
  componentFilePaths: string[],
  projectSrcDirectory: string,
): FileInfo[] {
  const componentFiles: FileInfo[] = componentFilePaths.map((sourceFile) => {
    const base = path.basename(sourceFile, path.extname(sourceFile));
    const component = base.replace(/^([a-z])/, (_, c) => c.toUpperCase());
    const { exports: exportsList, importsByModule } =
      getImportsAndExports(sourceFile);
    const outputFile = componentOutputFile(sourceFile, projectSrcDirectory);
    return {
      path: "",
      component,
      sourceFile,
      outputFile,
      importsByModule,
      exports: exportsList,
      shouldSendToAi: false,
      isScoreCalculated: false,
      isAuthProtected: false,
    };
  });

  return componentFiles;
}

/**
 * Analyze the index file by AI and return the routes and auth protected component.
 * @param indexFilePath - Path to the index file
 * @returns { routes: RouteInfo[], authProtectedComponent: { path: string, fullImportStatement: string } | null }
 */
export async function analyzeIndexFileByAi(indexFilePath: string) {
  try {
    if (!indexFilePath || !fs.existsSync(indexFilePath)) {
      return { routes: [] };
    }

    const fileContent = fs.readFileSync(indexFilePath, "utf-8");

    const prompt = analyzeIndexFilePrompt(fileContent);

    const RoutesFromIndexSchema = z.object({
      routes: z.array(
        z.object({
          path: z.string(),
          component: z.string(),
          isProtected: z.boolean(),
          importPath: z.string(),
        }),
      ),
      authProtectedComponent: z
        .object({
          path: z.string(),
          fullImportStatement: z.string(),
        })
        .optional()
        .nullable(),
    });

    const response = await openAIClient.responses.parse({
      model: config.DEFAULT_AI_MODEL,
      temperature: 0,
      input: prompt,
      text: {
        format: zodTextFormat(RoutesFromIndexSchema, "routes_from_index"),
      },
    });

    const parsed = RoutesFromIndexSchema.parse(response.output_parsed);
    return parsed;
  } catch (error) {
    handleOpenAIError(error, {
      context: "analyzing index file",
    });
  }
}

/**
 * Resolve source file from AI-extracted importPath (relative to router file).
 * importPath has no extension (e.g. "./pages/about/testing/again/index"); try each CODE_EXT.
 * Returns null if no file exists (e.g. AI mistake or wrong path).
 */
function resolveSourceFileFromImportPath(
  routerFile: string,
  importPath: string,
): string | null {
  const dir = path.dirname(routerFile);
  const basePath = path.resolve(dir, importPath);
  for (const ext of CODE_EXT) {
    const candidate = basePath + ext;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Converts AI-extracted routes (path + component + importPath) into FileInfo[] for analysis.
 * Resolves source file from importPath (add extension); no folder/component lookup needed.
 * @param aiRoutes - Routes extracted from the index file by AI (with importPath per route)
 * @param sourceAppFilePath - Path to the input project app file (e.g. src/App.tsx)
 * @returns FileInfo[] - List of routes
 */
export function generateRoutes(
  aiRoutes: Array<{
    path: string;
    component: string;
    isProtected: boolean;
    importPath: string;
  }>,
  sourceAppFilePath: string,
): FileInfo[] {
  const result: FileInfo[] = [];
  for (const { path: routePath, component, isProtected, importPath } of aiRoutes) {
    const sourceFile = resolveSourceFileFromImportPath(
      sourceAppFilePath,
      importPath,
    );
    if (sourceFile === null) {
      console.warn(
        `Could not resolve source file for route "${routePath}" (importPath: "${importPath}"). Skipping route.`,
      );
      continue;
    }
    const outputFile = routeOutputFile(routePath);
    const { exports: exportsList, importsByModule } =
      getImportsAndExports(sourceFile);
    result.push({
      path: routePath,
      component,
      sourceFile,
      outputFile,
      importsByModule,
      exports: exportsList,
      shouldSendToAi: false,
      isScoreCalculated: false,
      isAuthProtected: isProtected,
    });
  }
  return result;
}

// Default vite project root files/folders
const VITE_EXCLUDE_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "index.html",
  ".git",
  ".gitignore",
  "bun.lockb",
  "eslint.config.js",
  //   "postcss.config.js", // ?
  "README.md",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vitest.config.ts",
  "public",
]);

// Default vite files/folders
const VITE_SRC_EXCLUDE_NAMES = new Set([
  "components",
  "main.tsx",
  "pages",
  "vite-env.d.ts",
  "App.tsx",
  "test", // TODO: how to do this ?
]);

/**
 * Returns names of all files and folders in projectRoot except package.json,
 * package-lock.json, and index.html.
 */
export function getExtraFilesFolders(
  projectRoot: string,
  type: "root" | "src",
): string[] {
  if (!fs.existsSync(projectRoot)) return [];

  const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  const result: string[] = [];

  const ROOT_FOLDER_EXCLUDE_NAMES = new Set([...VITE_EXCLUDE_NAMES, "src"]);

  const SRC_FOLDER_EXCLUDE_NAMES = new Set([
    ...VITE_SRC_EXCLUDE_NAMES,
    "assets",
    "hooks", // Exclude hooks since they are passed to extraLogicFiles
  ]);

  const TO_EXCLUDE =
    type === "root" ? ROOT_FOLDER_EXCLUDE_NAMES : SRC_FOLDER_EXCLUDE_NAMES;

  for (const e of entries) {
    if (TO_EXCLUDE.has(e.name)) continue;
    if (e.name.endsWith(".css")) continue;
    result.push(e.name);
  }

  return result;
}

const EXTRA_LOGIC_EXCLUDE_NAMES = new Set([
  ...VITE_EXCLUDE_NAMES,
  ...VITE_SRC_EXCLUDE_NAMES,
  "tailwind.config.ts",
]);

function pushExtraLogicFile(
  result: FileInfo[],
  sourceFile: string,
  rootDir: string,
  routeSourceFiles: Set<string>,
  componentSourceFiles: Set<string>,
  outputFile: string,
) {
  if (!CODE_EXT.some((ext) => sourceFile.endsWith(ext))) return;
  if (routeSourceFiles.has(sourceFile) || componentSourceFiles.has(sourceFile))
    return;

  const parts = path
    .relative(rootDir, sourceFile)
    .split(path.sep)
    .filter(Boolean);
  if (parts.some((p) => EXTRA_LOGIC_EXCLUDE_NAMES.has(p))) return;

  const base = path.basename(sourceFile, path.extname(sourceFile));
  const component = base.replace(/^([a-z])/, (_, c) => c.toUpperCase());
  const { exports: exportsList, importsByModule } =
    getImportsAndExports(sourceFile);

  result.push({
    path: "",
    component,
    sourceFile,
    outputFile,
    importsByModule,
    exports: exportsList,
    shouldSendToAi: false,
    isScoreCalculated: false,
    isAuthProtected: false,
  });
}

/**
 * Returns FileInfo[] for all code files (.ts, .tsx, .js, .jsx) in the project,
 * excluding route/component source files and any path segment in EXTRA_LOGIC_EXCLUDE_NAMES.
 * Root-level files (excluding src) go into resultRoot; files under src go into resultSrc.
 */
export function getExtraLogicFilesInfo(
  projectRoot: string,
  routeSourceFiles: Set<string>,
  componentSourceFiles: Set<string>,
) {
  const resultRoot: FileInfo[] = [];
  const resultSrc: FileInfo[] = [];

  // Same as before but ignore files under "src"
  const allFilesRoot = walkDir(projectRoot);
  for (const sourceFile of allFilesRoot) {
    const relativeToRoot = path.relative(projectRoot, sourceFile);
    const parts = relativeToRoot.split(path.sep).filter(Boolean);
    if (parts[0] === "src") continue; // ignore src folder
    const outputFile = relativeToRoot.split(path.sep).join("/");
    pushExtraLogicFile(
      resultRoot,
      sourceFile,
      projectRoot,
      routeSourceFiles,
      componentSourceFiles,
      outputFile,
    );
  }

  // Same logic but only for the src folder
  const srcDir = path.join(projectRoot, "src");
  if (fs.existsSync(srcDir)) {
    const allFilesSrc = walkDir(srcDir);
    for (const sourceFile of allFilesSrc) {
      const relativeToSrc = path.relative(srcDir, sourceFile);
      const outputFile = path
        .join("src", relativeToSrc)
        .split(path.sep)
        .join("/");
      pushExtraLogicFile(
        resultSrc,
        sourceFile,
        srcDir,
        routeSourceFiles,
        componentSourceFiles,
        outputFile,
      );
    }
  }

  return {
    extraLogicFiles: resultRoot,
    extraLogicFilesSrc: resultSrc,
  };
}

/**
 * Save analysis to a file for debugging.
 * @param analysis - The analysis to save.
 * @param name - The name of the project.
 */
export function saveAnalysisForDebug(analysis: AnalysisResult, name: string) {
  if (config.DEBUG.SAVE_ANALYSIS) {
    const projectRoot = process.cwd();
    const outDir = path.join(projectRoot, "analysis", name);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "analysis.json"),
      JSON.stringify(analysis, null, 2),
      "utf-8",
    );
  }
}

interface Tree {
  [key: string]: true | Tree;
}

/**
 * Returns the output Next.js project folder structure as a string (for AI context).
 * Uses routes, componentFiles, extraLogicFiles*, and extra*FilesFolders. Paths under
 * src in the source are represented at project root (no src/ prefix).
 */
export function getOutputProjectStructure(
  routes: FileInfo[],
  componentFiles: FileInfo[],
  extraLogicFilesRoot: FileInfo[],
  extraLogicFilesSrc: FileInfo[],
  extraRootFilesFolders: string[],
  extraSrcFilesFolders: string[],
): string {
  const tree: Tree = {};

  const add = (outputFile: string) => {
    const normalized = outputFile.replace(/^src[/\\]/, "").trim();
    if (normalized) addPathToTree(tree, normalized);
  };

  for (const r of routes) add(r.outputFile ?? "");
  for (const c of componentFiles) add(c.outputFile ?? "");
  for (const f of extraLogicFilesRoot) add(f.outputFile ?? "");
  for (const f of extraLogicFilesSrc)
    add((f.outputFile ?? "").replace(/^src[/\\]/, ""));

  for (const name of extraRootFilesFolders) {
    if (!name) continue;
    if (tree[name] === undefined) tree[name] = name.includes(".") ? true : {};
  }
  for (const name of extraSrcFilesFolders) {
    if (!name) continue;
    if (tree[name] === undefined) tree[name] = name.includes(".") ? true : {};
  }

  const lines = renderTree(tree, 0);
  return lines.length ? lines.join("\n") : "(empty)";
}

function addPathToTree(tree: Tree, outputPath: string) {
  const parts = outputPath.replace(/\\/g, "/").split("/").filter(Boolean);
  let current = tree;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    if (isLast) {
      current[part] = true;
    } else {
      if (current[part] === undefined || current[part] === true) {
        current[part] = {};
      }
      current = current[part] as Tree;
    }
  }
}

function renderTree(tree: Tree, indent: number): string[] {
  const lines: string[] = [];
  const entries = Object.keys(tree).sort();
  for (const name of entries) {
    const node = tree[name];
    const prefix = "  ".repeat(indent);
    if (node === true) {
      lines.push(`${prefix}${name}`);
    } else {
      lines.push(`${prefix}${name}/`);
      lines.push(...renderTree(node, indent + 1));
    }
  }
  return lines;
}
