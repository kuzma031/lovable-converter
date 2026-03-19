import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import fs from "fs/promises";
import crypto from "crypto";

export function isValidGithubRepoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:") return false;
    if (parsed.hostname !== "github.com") return false;

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return false;

    return true;
  } catch {
    return false;
  }
}

export function safeJoin(base: string, target: string) {
  const resolved = path.resolve(base, target);
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_CLONE_DIR = path.join(__dirname, "..", "..", "temp");
const CLONE_TIMEOUT_MS = 60_000; // 60 seconds

/** Resolve the repo path for a job ID (temp/<jobId>/repo). */
export function getRepoPath(jobId: string): string {
  const jobDir = safeJoin(BASE_CLONE_DIR, jobId);
  return path.join(jobDir, "repo");
}

type CloneResult = {
  jobId: string;
  repoPath: string;
};

export async function cloneGithubRepo(repoUrl: string): Promise<CloneResult> {
  if (!isValidGithubRepoUrl(repoUrl)) {
    throw new Error("Invalid GitHub repository URL");
  }

  const jobId = crypto.randomUUID();
  const jobDir = safeJoin(BASE_CLONE_DIR, jobId);
  const repoDir = path.join(jobDir, "repo");

  await fs.mkdir(jobDir, { recursive: true });

  const env = { ...process.env };

  const args = [
    "clone",
    "--depth=1",
    "--no-tags",
    "--single-branch",
    repoUrl,
    repoDir,
  ];

  return new Promise((resolve, reject) => {
    const git = spawn("git", args, {
      env,
      stdio: "ignore", // VERY IMPORTANT: no stdout leaks
    });

    const timeout = setTimeout(async () => {
      git.kill("SIGKILL");
      await cleanup(jobDir);
      reject(new Error("Git clone timed out"));
    }, CLONE_TIMEOUT_MS);

    git.on("error", async (err) => {
      clearTimeout(timeout);
      await cleanup(jobDir);
      reject(err);
    });

    git.on("close", async (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        await cleanup(jobDir);
        reject(new Error(`Git clone failed with exit code ${code}`));
        return;
      }

      resolve({
        jobId,
        repoPath: repoDir,
      });
    });
  });
}

async function cleanup(dir: string) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {}
}
