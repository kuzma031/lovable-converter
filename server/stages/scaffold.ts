import path from "path";
import { AnalysisResult } from "../types/index";
import {
  copyStaticAssets,
  createComponentsForRoutesInAnalysis,
  createPagesForRoutesInAnalysis,
  mergeSourceProjectDependencies,
  copyLogicFilesAndFolders,
  updateEnvVariables,
} from "../utils/scaffold-utils";
import { shellCreateNextjsProject } from "../shell/nextjs";

export interface ScaffoldResult {
  projectRoot: string;
  nextJsAppDir: string;
}

export interface ScaffoldProjectOptions {
  jobId: string;
  sourceRoot: string;
  analysis: AnalysisResult;
}

// https://nextjs.org/docs/pages/guides/migrating/from-vite
export async function scaffoldNextProject({
  jobId,
  sourceRoot,
  analysis,
}: ScaffoldProjectOptions): Promise<ScaffoldResult> {
  // project root path
  const newProjectRoot = path.resolve("next-output", jobId);

  try {
    // Create Next.js project
    await shellCreateNextjsProject(jobId, newProjectRoot);
    // Update package.json with source project dependencies
    mergeSourceProjectDependencies(newProjectRoot, analysis);

    // Create other logic folders
    copyLogicFilesAndFolders(analysis, newProjectRoot, sourceRoot);
    updateEnvVariables(analysis, newProjectRoot);

    const nextJsAppDir = path.join(newProjectRoot, "app");

    // Create UI files for routes and components
    createPagesForRoutesInAnalysis(analysis, nextJsAppDir);
    createComponentsForRoutesInAnalysis(newProjectRoot, analysis);

    // Copy static assets
    copyStaticAssets(analysis, newProjectRoot, sourceRoot);

    return {
      projectRoot: newProjectRoot,
      nextJsAppDir,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Scaffold failed for job ${jobId}: ${message}`);
  }
}
