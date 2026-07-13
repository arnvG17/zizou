// evals/checks/file-exists.ts
//
// Deterministic check: does a file exist at the given path?
// Code-executed, never LLM-judged.

import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Returns true if the file at `relPath` exists within `workspaceDir`.
 *
 * @param workspaceDir - Absolute path to the eval workspace root.
 * @param relPath - Relative path from workspace root to the file.
 */
export async function fileExists(
  workspaceDir: string,
  relPath: string,
): Promise<boolean> {
  const abs = resolve(workspaceDir, relPath);
  return existsSync(abs);
}
