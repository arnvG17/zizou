/**
 * open-file.ts — Tool definition for opening a file with the OS default application.
 *
 * Layer: tools
 * Allowed imports: none above (base layer)
 *
 * Uses the platform's native "open" command:
 *   Windows → start
 *   macOS   → open
 *   Linux   → xdg-open
 *
 * This is intentionally a fire-and-forget tool — it launches the file viewer
 * and returns immediately. It does NOT require user confirmation because it only
 * opens a passive viewer (browser, text editor, image viewer, etc.) and cannot
 * modify anything on the filesystem.
 */

import { spawn } from "node:child_process";
import { resolve, extname } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { tool } from "ai";

function getOpenCommand(): string {
  if (process.platform === "win32") return "start";
  if (process.platform === "darwin") return "open";
  return "xdg-open";
}

export const openFile = tool({
  description:
    "Open a file using the operating system's default application. " +
    "For HTML files this opens the browser. For images it opens the image viewer. " +
    "For text files it opens the default editor. " +
    "Use this after creating or editing a file to let the user preview it. " +
    "Relative paths are resolved from the project root (cwd).",
  inputSchema: z.object({
    path: z
      .string()
      .describe(
        "Path to the file to open. Relative paths are resolved from cwd."
      ),
  }),
  execute: async ({ path: inputPath }) => {
    try {
      const absPath = resolve(process.cwd(), inputPath);

      if (!existsSync(absPath)) {
        return {
          success: false as const,
          error: `File not found: ${absPath}`,
        };
      }

      const ext = extname(absPath).toLowerCase();
      const openCmd = getOpenCommand();

      // On Windows, `start` needs an empty title argument when the path
      // contains spaces, otherwise the path is treated as the window title.
      const args =
        process.platform === "win32"
          ? ["", absPath]   // start "" "C:\path\to\file.html"
          : [absPath];

      const child = spawn(openCmd, args, {
        detached: true,
        stdio: "ignore",
        shell: process.platform === "win32", // required for `start` on Windows
      });
      child.unref(); // don't block the process

      return {
        success: true as const,
        message: `Opened ${absPath} (${ext || "file"}) with the system default application.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error opening file";
      return { success: false as const, error: message };
    }
  },
});
