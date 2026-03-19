import fs from "fs";
import path from "path";

export function readJSON(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * Walk through a directory and return all files in the directory.
 * @param dir - The directory to walk through.
 * @param files - The files to return.
 * @returns The files in the directory.
 */
export function walkDir(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);

    if (
      stat.isDirectory() &&
      !entry.startsWith(".") &&
      entry !== "node_modules"
    ) {
      walkDir(fullPath, files);
    } else if (stat.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFile(filePath: string, content: string) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}
