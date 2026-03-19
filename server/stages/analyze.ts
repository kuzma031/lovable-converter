import fs from "fs";
import path from "path";

import { AnalysisResult } from "../types/index";
import { readJSON } from "../utils/fs";
import {
  addEntryFiles,
  addNotFoundRoute,
  analyzeIndexFileByAi,
  createComponentFilesInfo,
  generateRoutes,
  getComponentFilesPaths,
  getExtraFilesFolders,
  getExtraLogicFilesInfo,
  getOutputProjectStructure,
  saveAnalysisForDebug,
} from "../utils/analyze-utils";

export async function analyzeProject(
  projectRoot: string,
  jobId: string,
): Promise<AnalysisResult | null> {
  // Get original file system structure
  const packageJson = readJSON(path.join(projectRoot, "package.json"));

  const projectSrcDirectory = path.join(projectRoot, "src");

  // Get components paths
  const componentFilePaths = getComponentFilesPaths(projectRoot);

  // Create component files info list for the scaffold
  const componentFilesList = createComponentFilesInfo(
    componentFilePaths,
    projectSrcDirectory,
  );

  // Add entry files to analysis
  const { files: entryFiles, layoutFile } = addEntryFiles(projectRoot);

  const analyzedIndexFile = await analyzeIndexFileByAi(layoutFile);

  if (!analyzedIndexFile) {
    console.log("Failed to analyze index file. Skipping project analysis.");
    return null;
  }

  const { routes, authProtectedComponent } = analyzedIndexFile;

  const routesInfo = generateRoutes(routes, layoutFile);

  const routeSourceFiles = new Set(routesInfo.map((r) => r.sourceFile));
  const componentSourceFiles = new Set(
    componentFilesList.map((c) => c.sourceFile),
  );

  const { extraLogicFiles, extraLogicFilesSrc } = getExtraLogicFilesInfo(
    projectRoot,
    routeSourceFiles,
    componentSourceFiles,
  );

  const extraRootFilesFolders = getExtraFilesFolders(projectRoot, "root");
  const extraSrcFilesFolders = getExtraFilesFolders(projectSrcDirectory, "src");

  const projectStructure = getOutputProjectStructure(
    routesInfo,
    componentFilesList,
    extraLogicFiles,
    extraLogicFilesSrc,
    extraRootFilesFolders,
    extraSrcFilesFolders,
  );

  const analysis: AnalysisResult = {
    // framework: "react-vite",
    // router: packageJson.dependencies?.["react-router-dom"] ? "react-router" : "unknown",
    entryFiles,
    routes: routesInfo,
    componentFiles: componentFilesList,
    extraLogicFilesRoot: extraLogicFiles,
    extraLogicFilesSrc: extraLogicFilesSrc,
    extraRootFilesFolders: getExtraFilesFolders(projectRoot, "root"),
    extraSrcFilesFolders: getExtraFilesFolders(projectSrcDirectory, "src"),
    dependencies: packageJson.dependencies,
    devDependencies: packageJson.devDependencies,
    authProtectedComponent,
    projectStructure,
  };

  addNotFoundRoute(analysis, projectRoot);

  saveAnalysisForDebug(analysis, jobId);

  return analysis;
}
