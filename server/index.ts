import "dotenv/config";

import { generateMigrationPlan } from "./stages/migration-plan";
import { analyzeProject } from "./stages/analyze";
import { cloneGithubRepo, getRepoPath } from "./utils/clone-repo";
import { scaffoldNextProject } from "./stages/scaffold";
import { convertAllFiles } from "./stages/convert";
import {
  runPostConversionChecks,
  logPostConversionResult,
  fixPostConversionIssuesWithAI,
  fixImportPathsInProject,
} from "./stages/postconfig";
import { config } from "./config";

// TODO
// postconfig should always be in this format:
// module.exports = {
//     plugins: {
//       tailwindcss: {},
//       autoprefixer: {},
//     },
//   };
// import '@/index.css'; at start of layout.tsx file - better prompts
// typescript lint check
// example: 12:8  Warning: 'NextImage' is defined but never used.  @typescript-eslint/no-unused-vars
// 174:40  Error: `"` can be escaped with `&quot;`, `&ldquo;`, `&#34;`, `&rdquo;`.  react/no-unescaped-entities
// 174:40  Error: `"` can be escaped with `&quot;`, `&ldquo;`, `&#34;`, `&rdquo;`.  react/no-unescaped-entities
// 7:50  Error: Unexpected any. Specify a different type.  @typescript-eslint/no-explicit-any
// https://nextjs.org/docs/app/api-reference/config/eslint#disabling-rules

const testHardcode = async (jobId: string) => {
  console.time("Execution Time");
  const projectRoot = getRepoPath(jobId);

  const analysis = await analyzeProject(projectRoot, jobId);

  if (!analysis) return;

  const result = await scaffoldNextProject({
    jobId,
    sourceRoot: projectRoot,
    analysis: analysis,
  });

  await convertAllFiles(analysis, result.projectRoot, projectRoot);

  const postResult = runPostConversionChecks(result.projectRoot);
  logPostConversionResult(postResult, result.projectRoot);
  await fixPostConversionIssuesWithAI(postResult, result.projectRoot);
  fixImportPathsInProject(analysis, result.projectRoot);

  console.timeEnd("Execution Time");
};

const init = async () => {
  const sourceRepoUrl = process.env.SOURCE_REPO_URL?.trim();
  if (!sourceRepoUrl) {
    console.error("SOURCE_REPO_URL is not set. Add it to your .env file (see .env.example).");
    process.exit(1);
  }

  const { jobId } = await cloneGithubRepo(sourceRepoUrl);

  const projectRoot = getRepoPath(jobId);

  const analysis = await analyzeProject(projectRoot, jobId);

  if (!analysis) return;

  //   const plan = await generateMigrationPlan(analysis);

  const result = await scaffoldNextProject({
    jobId,
    sourceRoot: projectRoot,
    analysis,
  });

  await convertAllFiles(analysis, result.projectRoot, projectRoot);

  const postResult = runPostConversionChecks(result.projectRoot);
  logPostConversionResult(postResult, result.projectRoot);
  await fixPostConversionIssuesWithAI(postResult, result.projectRoot);
  fixImportPathsInProject(analysis, result.projectRoot);
};

if (config.IS_TESTING) {
  testHardcode(config.TESTING_PROJECT_ID);
} else {
  init();
}
