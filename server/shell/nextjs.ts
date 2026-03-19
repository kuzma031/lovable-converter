import { execa } from "execa";
import path from "path";
import fs from "fs-extra";

/**
 * Create a new Next.js project in the given directory.
 * @param jobId - The job ID for the project.
 * @param projectRoot - The path to the project root.
 */
export const shellCreateNextjsProject = async (
  jobId: string,
  projectRoot: string,
) => {
  // https://nextjs.org/docs/app/api-reference/cli/create-next-app

  if (!fs.existsSync(projectRoot)) {
    const projectOutputBase = path.resolve("next-output");
    fs.ensureDirSync(projectOutputBase);

    await execa(
      "npx",
      [
        "create-next-app@latest",
        jobId,
        "--ts",
        "--app",
        "--eslint",
        "--no-tailwind",
        "--no-react-compiler",
        "--no-src-dir",
        "--import-alias",
        "@/*",
        "--use-yarn",
        "--no-turbopack", // https://nextjs.org/docs/app/api-reference/turbopack
        "--skip-install",
      ],
      {
        cwd: projectOutputBase,
        stdio: "inherit",
      },
    );
  }
};
