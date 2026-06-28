import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { tool } from "ai";
import { ConfirmFn } from "./types.js";
import { registerTask } from "./task-registry.js";

function getShellConfig(): { shell: string } | { shell: true } {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const powershellPath = join(systemRoot, "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    return { shell: powershellPath };
  }
  return { shell: true };
}

export const createRunBackgroundTool = (confirm: ConfirmFn) => {
  return tool({
    description:
      "Execute a shell command in the background (non-blocking). " +
      "This is perfect for starting development servers (e.g. npm run dev), " +
      "or running long tasks like compilation. Returns a taskId immediately. " +
      "Requires user confirmation. On Windows, runs in PowerShell; on macOS/Linux it uses the default shell.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute in the background"),
    }),
    execute: async ({ command }) => {
      // Step 1: User confirmation
      const isApproved = await confirm(
        `The agent wants to run this command in the background:\n  ${command}\nAllow?`
      );

      if (!isApproved) {
        return {
          success: false as const,
          error: "User denied permission to run this command.",
        };
      }

      try {
        const shellOpts = getShellConfig();
        
        // Spawn process in the background
        const child = spawn(command, {
          ...shellOpts,
          cwd: process.cwd(),
          detached: process.platform !== "win32", // detached group on Unix so child isn't killed immediately if parent detaches
          stdio: ["ignore", "pipe", "pipe"], // pipe stdout and stderr
        });

        // If detached on Unix, unref the child process
        if (process.platform !== "win32") {
          child.unref();
        }

        const task = registerTask(command, child);

        return {
          success: true as const,
          message: `Successfully started background task.`,
          taskId: task.id,
          pid: task.pid,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error starting background command";
        return { success: false as const, error: message };
      }
    },
  });
};
