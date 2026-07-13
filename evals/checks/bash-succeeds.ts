// evals/checks/bash-succeeds.ts
//
// Deterministic check: does a shell command exit with code 0?
// Code-executed, never LLM-judged.

import { spawn } from "child_process";

/**
 * Runs a shell command in `workspaceDir` and returns true if it exits
 * with code 0.
 *
 * Times out after 30 seconds to prevent hanging.
 *
 * @param workspaceDir - Absolute path to the eval workspace root (used as cwd).
 * @param command - The shell command to execute.
 */
export async function bashSucceeds(
  workspaceDir: string,
  command: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd" : "/bin/sh";
    const shellFlag = isWindows ? "/c" : "-c";

    const child = spawn(shell, [shellFlag, command], {
      cwd: workspaceDir,
      stdio: "pipe",
      timeout: 30_000,
    });

    child.on("close", (code) => {
      resolve(code === 0);
    });

    child.on("error", () => {
      resolve(false);
    });
  });
}
