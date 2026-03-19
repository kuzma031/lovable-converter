import { AnalysisResult, FileInfo } from "../types";
import fs from "fs-extra";
import path from "path";
import { config } from "../config";
import { getImportsAndExports } from "./imports-exports";
import { writeFile } from "./fs";
import {
  ensureClientDirective,
  prependClientDirectiveIfMissing,
} from "./client-components";
import { routePathToAppDir } from "./nextjs";
import { Files } from "openai/resources";

/** Catch-all route path for Next.js not-found page. */
const NOT_FOUND_ROUTE_PATH = "*";

/**
 * For each route, create a page in the Next.js app directory.
 * @param analysis - The analysis result.
 * @param nextJsAppDir - The path to the Next.js app directory.
 */
export function createPagesForRoutesInAnalysis(
  analysis: AnalysisResult,
  nextJsAppDir: string,
) {
  for (const route of analysis.routes) {
    // Not-found / catch-all → Next.js uses app/not-found.tsx, not a directory
    if (route.path === NOT_FOUND_ROUTE_PATH) {
      const notFoundPath = path.join(nextJsAppDir, "not-found.tsx");
      writeFile(
        notFoundPath,
        ensureClientDirective(fs.readFileSync(route.sourceFile, "utf-8")),
      );
      continue;
    }
    const routeDir = routePathToAppDir(route.path);
    const targetDir = path.join(nextJsAppDir, routeDir);
    fs.ensureDirSync(targetDir);
    const pagePath = path.join(targetDir, "page.tsx");

    const sourceContent = fs.readFileSync(route.sourceFile, "utf-8");
    writeFile(pagePath, ensureClientDirective(sourceContent));
  }
}

/**
 * For each component, create a component in the Next.js components directory.
 * @param projectRoot - The path to the project root.
 * @param analysis - The analysis result.
 */
export function createComponentsForRoutesInAnalysis(
  projectRoot: string,
  analysis: AnalysisResult,
) {
  for (const componentInfo of analysis.componentFiles) {
    const sourceFilePath = componentInfo.sourceFile;
    const targetPath = path.join(
      projectRoot,
      componentInfo.outputFile ??
        path.join("components", path.basename(sourceFilePath)),
    );
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) fs.ensureDirSync(targetDir);

    const content = fs.readFileSync(sourceFilePath, "utf-8");
    const outFile = componentInfo.outputFile ?? "";
    const isShadcnUiComponent = outFile.includes("components/ui");
    writeFile(
      targetPath,
      isShadcnUiComponent
        ? prependClientDirectiveIfMissing(content)
        : ensureClientDirective(content),
    );
  }
}

function copyPublicFolder(oldProjectRoot: string, newProjectRoot: string) {
  const publicFolder = path.join(oldProjectRoot, "public");
  const newPublicFolder = path.join(newProjectRoot, "public");
  if (fs.existsSync(newPublicFolder)) {
    fs.rmSync(newPublicFolder, { recursive: true, force: true });
  }
  fs.cpSync(publicFolder, newPublicFolder, { recursive: true });
}

/**
 * Copy source project src/assets to Next.js output public/assets
 * so that imports like @/assets/hero-image.png resolve to /assets/hero-image.png.
 */
function copySrcAssetsToPublic(sourceRoot: string, projectRoot: string) {
  const srcAssets = path.join(sourceRoot, "src", "assets");
  const publicAssets = path.join(projectRoot, "public", "assets");
  if (!fs.existsSync(srcAssets)) return;
  fs.ensureDirSync(path.dirname(publicAssets));
  fs.copySync(srcAssets, publicAssets, { overwrite: true });
}

/**
 * Delete default CSS files from the project root.
 * @param projectRoot - The path to the project root.
 */
function deleteDefaultCSSFiles(projectRoot: string) {
  const appDir = path.join(projectRoot, "app");
  if (!fs.existsSync(appDir)) return;
  const entries = fs.readdirSync(appDir, {
    recursive: true,
    withFileTypes: true,
  }) as fs.Dirent[];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".css")) {
      const fullPath = path.join(entry.path ?? appDir, entry.name);
      fs.removeSync(fullPath);
    }
  }
}

/**
 * Delete favicon from the project root. Favicon is created by create-next-app. We don't need it.
 * @param projectRoot - The path to the project root.
 */
function deleteFavicon(projectRoot: string) {
  const faviconPath = path.join(projectRoot, "app", "favicon.ico");
  if (fs.existsSync(faviconPath)) {
    fs.removeSync(faviconPath);
  }
}

// TODO:
// update tailwind by ai ? new version
// env variables
// tailwind version ? should be lower - postcss config

/**
 * Copy CSS files to the Next.js project.
 * @param analysis - The analysis result.
 * @param projectRoot - The path to the project root.
 */
function copyCssFiles(analysis: AnalysisResult, projectRoot: string) {
  const copyCssForFile = (
    sourceFile: string,
    sourceFolder: string,
    importsByModule: Record<string, string[]>,
  ) => {
    const sourceDir = path.dirname(sourceFile);
    for (const moduleSpecifier of Object.keys(importsByModule)) {
      if (!moduleSpecifier.endsWith(".css")) continue;
      const resolvedSource = path.resolve(sourceDir, moduleSpecifier);
      if (!fs.existsSync(resolvedSource)) continue;
      const fileName = path.basename(resolvedSource);
      const targetDir = path.join(projectRoot, sourceFolder);
      fs.ensureDirSync(targetDir);
      const targetPath = path.join(targetDir, fileName);
      fs.copyFileSync(resolvedSource, targetPath);
    }
  };

  for (const entryFile of analysis.entryFiles) {
    if (entryFile.path && fs.existsSync(entryFile.path)) {
      copyCssForFile(entryFile.path, "app", entryFile.importsByModule);
    }
  }

  const allFileInfos: FileInfo[] = [
    ...analysis.routes,
    ...analysis.componentFiles,
    ...analysis.extraLogicFilesRoot,
    ...analysis.extraLogicFilesSrc,
  ];

  for (const fileInfo of allFileInfos) {
    copyCssForFile(
      fileInfo.sourceFile,
      path.dirname(fileInfo.outputFile),
      fileInfo.importsByModule,
    );
  }
}

/**
 * Copy static assets to the project root.
 * @param analysis - The analysis result.
 * @param projectRoot - The path to the project root.
 * @param sourceRoot - The path to the source root.
 */
export function copyStaticAssets(
  analysis: AnalysisResult,
  projectRoot: string,
  sourceRoot: string,
) {
  copyPublicFolder(sourceRoot, projectRoot);
  copySrcAssetsToPublic(sourceRoot, projectRoot);
  deleteDefaultCSSFiles(projectRoot);
  deleteFavicon(projectRoot);
  copyCssFiles(analysis, projectRoot);
}

/**
 * Copy all extra logic files (hooks, lib, utils, etc.) to the new Next.js project.
 * Root-level files go to projectRoot/outputFile; files under src/ go to project root
 * without the "src/" prefix (e.g. src/contexts/AuthContext.tsx -> contexts/AuthContext.tsx).
 * Also copies extraRootFilesFolders and extraSrcFilesFolders (e.g. .env, supabase, contexts, lib).
 * Each code file is written with "use client" ensured where needed.
 */
export function copyLogicFilesAndFolders(
  analysis: AnalysisResult,
  projectRoot: string,
  sourceRoot: string,
) {
  // Copy extra root and src folders first (e.g. .env, supabase, contexts, lib)
  // so that extraLogicFiles* writes can overwrite code files with ensureClientDirective
  for (const name of analysis.extraRootFilesFolders ?? []) {
    const sourcePath = path.join(sourceRoot, name);
    if (!fs.existsSync(sourcePath)) continue;
    const targetPath = path.join(projectRoot, name);
    fs.copySync(sourcePath, targetPath, { overwrite: true });
  }

  for (const name of analysis.extraSrcFilesFolders ?? []) {
    const sourcePath = path.join(sourceRoot, "src", name);
    if (!fs.existsSync(sourcePath)) continue;
    const targetPath = path.join(projectRoot, name);
    fs.copySync(sourcePath, targetPath, { overwrite: true });
  }

  for (const fileInfo of analysis.extraLogicFilesRoot) {
    const sourcePath = fileInfo.sourceFile;
    if (!fs.existsSync(sourcePath)) continue;
    const targetPath = path.join(projectRoot, fileInfo.outputFile ?? "");
    if (!targetPath) continue;
    const targetDir = path.dirname(targetPath);
    fs.ensureDirSync(targetDir);
    const content = fs.readFileSync(sourcePath, "utf-8");
    writeFile(targetPath, ensureClientDirective(content));
  }

  for (const fileInfo of analysis.extraLogicFilesSrc) {
    const sourcePath = fileInfo.sourceFile;
    if (!fs.existsSync(sourcePath)) continue;
    // Strip leading "src/" so these files go to project root, not src/
    const outputFile = (fileInfo.outputFile ?? "").replace(/^src[/\\]/, "");
    if (!outputFile) continue;
    const targetPath = path.join(projectRoot, outputFile);
    const targetDir = path.dirname(targetPath);
    fs.ensureDirSync(targetDir);
    const content = fs.readFileSync(sourcePath, "utf-8");
    writeFile(targetPath, ensureClientDirective(content));
  }
}

/**
 * Merge source project dependencies into the Next.js project package.json.
 */
export function mergeSourceProjectDependencies(
  projectRoot: string,
  analysis: AnalysisResult,
) {
  // Resolve path to the Next.js project package.json (target we will write to).
  const packageOutputPath = path.join(projectRoot, "package.json");

  // Load current Next.js package.json so we can merge Vite deps into it.
  const nextPkg = fs.readJsonSync(packageOutputPath) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  // Ensure both dependency maps exist on the Next.js package so we can assign into them.
  nextPkg.dependencies = nextPkg.dependencies ?? {};
  nextPkg.devDependencies = nextPkg.devDependencies ?? {};

  // Packages to never copy from Vite: Vite-specific or router that Next does not use.
  const skipDeps = new Set(["react-router-dom", "lovable-tagger"]);
  const isVitePackage = (name: string) => name.toLowerCase().includes("vite");

  // Get Vite project dependencies from analysis (source package.json).
  const sourceDeps = analysis.dependencies ?? {};
  for (const [name, version] of Object.entries(sourceDeps)) {
    // Skip packages that contain "vite" in the name or are in the skip list.
    if (skipDeps.has(name) || isVitePackage(name)) continue;
    // If Next.js already has this package, keep Next.js version; otherwise use Vite version.
    const versionToWrite =
      name in nextPkg.dependencies ? nextPkg.dependencies[name] : version;
    nextPkg.dependencies[name] = versionToWrite;
  }

  // Get Vite project devDependencies from analysis (source package.json).
  const sourceDevDeps = analysis.devDependencies ?? {};
  for (const [name, version] of Object.entries(sourceDevDeps)) {
    // Skip packages that contain "vite" in the name.
    if (isVitePackage(name)) continue;
    // If Next.js already has this package, keep Next.js version; otherwise use Vite version.
    const versionToWrite =
      name in nextPkg.devDependencies ? nextPkg.devDependencies[name] : version;
    nextPkg.devDependencies[name] = versionToWrite;
  }

  // Write merged package.json back to the Next.js project.
  fs.writeJsonSync(packageOutputPath, nextPkg, { spaces: 2 });
}

/**
 * In the Next.js project root, find every file from extraRootFilesFolders whose name
 * contains ".env" (e.g. .env, .env.local), and rewrite env keys from VITE_ to NEXT_PUBLIC_.
 */
export function updateEnvVariables(
  analysis: AnalysisResult,
  projectRoot: string,
) {
  for (const name of analysis.extraRootFilesFolders ?? []) {
    if (!name.includes(".env")) continue;
    const filePath = path.join(projectRoot, name);
    if (!fs.existsSync(filePath)) continue;
    if (!fs.statSync(filePath).isFile()) continue;

    let content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split(/\r?\n/);
    const updatedLines = lines.map((line) => {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) return line;
      const key = line.slice(0, eqIndex).trim();
      const rest = line.slice(eqIndex);
      if (key.startsWith("VITE_")) {
        return "NEXT_PUBLIC_" + key.slice(5) + rest;
      }
      return line;
    });
    writeFile(filePath, updatedLines.join("\n"));
  }
}

// example of package.json for empty vite project
const vitePackageJson = {
  dependencies: {
    react: "^19.2.0",
    "react-dom": "^19.2.0",
  },
  devDependencies: {
    "@eslint/js": "^9.39.1",
    "@types/node": "^24.10.1",
    "@types/react": "^19.2.5",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^5.1.1",
    eslint: "^9.39.1",
    "eslint-plugin-react-hooks": "^7.0.1",
    "eslint-plugin-react-refresh": "^0.4.24",
    globals: "^16.5.0",
    typescript: "~5.9.3",
    "typescript-eslint": "^8.46.4",
    vite: "^7.2.4",
  },
};
