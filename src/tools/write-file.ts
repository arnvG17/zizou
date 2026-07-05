/**
 * write-file.ts — Tool definition for writing or creating files on disk.
 *
 * Layer: tools
 * Allowed imports: config (none above)
 *
 * SAFETY: Requires user confirmation via the ConfirmFn injected at creation
 * time. Shows a warning dialog before creating new files or overwriting
 * existing ones so the user can approve or deny the operation.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { tool } from "ai";
import type { ConfirmFn } from "./types.js";

export const createWriteFileTool = (confirm: ConfirmFn) => {
  return tool({
    description:
      "Create a new file or completely overwrite an existing file with the specified contents. " +
      "Use this tool when you want to create new files or replace the entire file contents. " +
      "Relative paths are resolved against the current working directory. " +
      "This requires user confirmation before proceeding.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or relative path to the file to write/create"),
      contents: z.string().describe("The complete string content to write to the file"),
    }),
    execute: async ({ path: inputPath, contents }) => {
      try {
        // Always resolve to an absolute path so relative paths like "index.html"
        // are anchored to the project's cwd instead of failing with ENOENT.
        const absPath = resolve(process.cwd(), inputPath);
        const dir = dirname(absPath);

        // Determine whether this is a new file or an overwrite
        const fileExists = existsSync(absPath);
        const action = fileExists ? "Overwrite existing file" : "Create new file";

        // Ask the user for permission
        const isApproved = await confirm(
          `${action}: ${absPath}`
        );

        if (!isApproved) {
          return {
            success: false as const,
            error: "User denied permission to write this file.",
          };
        }

        mkdirSync(dir, { recursive: true });
        writeFileSync(absPath, contents, "utf-8");

        return {
          success: true as const,
          message: `Successfully wrote file to ${absPath}`,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error writing file";
        return { success: false as const, error: message };
      }
    },
  });
};
