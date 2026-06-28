/**
 * run-bash.ts — Tool definition for safely executing shell commands.
 *
 * Layer: tools
 * Allowed imports: config, types
 *
 * This tool executes a shell command but requires user confirmation via the
 * ConfirmFn injected at creation time. It implements safety limits:
 * - 120-second timeout (enough for npm install, npx create-*, etc.)
 * - 1MB max buffer
 * - Truncates output sent back to the LLM to 5000 chars to save context window.
 *
 * Platform handling:
 * - Windows: uses PowerShell (absolute path) for better compatibility
 * - macOS/Linux: uses the default shell (/bin/sh)
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { tool } from "ai";
import { ConfirmFn } from "./types.js";

const execAsync = promisify(exec);

/**
 * Returns the platform-appropriate shell configuration for exec().
 * On Windows, cmd.exe is the default but it's very limited — PowerShell
 * handles modern tooling (npm, npx, git) much better.
 * We resolve the absolute path to powershell.exe to ensure compatibility.
 */
function getShellConfig(): { shell: string } | {} {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const powershellPath = join(systemRoot, "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    return { shell: powershellPath };
  }
  return {}; // use default shell on macOS/Linux
}

export const createRunBashTool = (confirm: ConfirmFn) => {
  return tool({
    description:
      "Execute a shell command. " +
      "This requires user confirmation, so only use it when necessary. " +
      "Commands run with a 120-second timeout. Output is truncated if too long. " +
      "On Windows this runs in PowerShell; on macOS/Linux it uses the default shell.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
    }),
    execute: async ({ command }) => {
      // Step 1: User confirmation
      const isApproved = await confirm(
        `The agent wants to run the following command:\n  ${command}\nAllow?`
      );

      if (!isApproved) {
        return {
          success: false as const,
          error: "User denied permission to run this command.",
        };
      }

      // Step 2: Execute safely
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 120_000, // 120 seconds — enough for npm install, npx create-*, etc.
          maxBuffer: 1024 * 1024, // 1 MB
          cwd: process.cwd(), // explicit: run from the project root
          ...getShellConfig(),
        });

        const rawOutput = `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;

        // Truncate to ~5000 characters
        const MAX_LEN = 5000;
        const finalOutput =
          rawOutput.length > MAX_LEN
            ? rawOutput.slice(0, MAX_LEN) + "\n...[OUTPUT TRUNCATED]"
            : rawOutput;

        return {
          success: true as const,
          output: finalOutput,
        };
      } catch (err) {
        // execAsync throws on non-zero exit codes, timeouts, or buffer limits
        let message = "Unknown error running command";
        if (err instanceof Error) {
          message = err.message;
        }

        // Truncate error messages too, just in case
        const MAX_LEN = 5000;
        if (message.length > MAX_LEN) {
          message = message.slice(0, MAX_LEN) + "\n...[ERROR TRUNCATED]";
        }

        return {
          success: false as const,
          error: message,
        };
      }
    },
  });
};
