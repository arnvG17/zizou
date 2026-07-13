// evals/checks/grep-contains.ts
//
// Deterministic check: does a file's content match a regex pattern?
// Code-executed, never LLM-judged.

import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Returns true if the file at `relPath` within `workspaceDir` contains
 * text matching `pattern`.
 *
 * Returns false if the file doesn't exist or can't be read.
 *
 * @param workspaceDir - Absolute path to the eval workspace root.
 * @param relPath - Relative path from workspace root to the file.
 * @param pattern - RegExp to test against the file's contents.
 */
export async function grepContains(
  workspaceDir: string,
  relPath: string,
  pattern: RegExp,
): Promise<boolean> {
  try {
    const abs = resolve(workspaceDir, relPath);
    const content = readFileSync(abs, "utf-8");
    return pattern.test(content);
  } catch {
    return false;
  }
}
