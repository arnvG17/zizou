/**
 * file-operations.ts — Tool definition for native filesystem operations.
 *
 * Layer: tools
 * Allowed imports: config (none above)
 *
 * SAFETY: Destructive operations (delete, move) require user confirmation
 * via the ConfirmFn injected at creation time. Non-destructive operations
 * (copy, createDirectory) proceed without prompting.
 */

import { rmSync, mkdirSync, cpSync, renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { tool } from "ai";
import type { ConfirmFn } from "./types.js";

export const createFileOperationsTool = (confirm: ConfirmFn) => {
  return tool({
    description:
      "Perform safe, native filesystem operations (delete, copy, move, create directories) " +
      "without running shell commands. Always resolves relative paths from the project root. " +
      "Delete and move operations require user confirmation before proceeding.",
    inputSchema: z.object({
      action: z
        .enum(["delete", "createDirectory", "copy", "move"])
        .describe("The filesystem action to perform"),
      source: z
        .string()
        .describe("The target path to delete/copy/move/create. Relative or absolute."),
      destination: z
        .string()
        .optional()
        .describe("The destination path. Required only for 'copy' and 'move' actions."),
    }),
    execute: async ({ action, source, destination }) => {
      try {
        const absSource = resolve(process.cwd(), source);

        if (action === "createDirectory") {
          mkdirSync(absSource, { recursive: true });
          return {
            success: true as const,
            message: `Successfully created directory hierarchy at ${absSource}`,
          };
        }

        if (action === "delete") {
          if (!existsSync(absSource)) {
            return {
              success: false as const,
              error: `Path does not exist: ${absSource}`,
            };
          }

          // Ask the user for permission — deletion is irreversible
          const isApproved = await confirm(
            `DELETE ${absSource} — this is irreversible`
          );

          if (!isApproved) {
            return {
              success: false as const,
              error: "User denied permission to delete this path.",
            };
          }

          rmSync(absSource, { recursive: true, force: true });
          return {
            success: true as const,
            message: `Successfully deleted ${absSource}`,
          };
        }

        // Copy or Move require a destination
        if (!destination) {
          return {
            success: false as const,
            error: `A 'destination' path is required for '${action}' operations.`,
          };
        }

        const absDest = resolve(process.cwd(), destination);

        if (action === "copy") {
          if (!existsSync(absSource)) {
            return {
              success: false as const,
              error: `Source path does not exist: ${absSource}`,
            };
          }
          cpSync(absSource, absDest, { recursive: true });
          return {
            success: true as const,
            message: `Successfully copied ${absSource} to ${absDest}`,
          };
        }

        if (action === "move") {
          if (!existsSync(absSource)) {
            return {
              success: false as const,
              error: `Source path does not exist: ${absSource}`,
            };
          }

          // Ask the user for permission — move removes the source
          const isApproved = await confirm(
            `Move ${absSource} → ${absDest} (source will be removed)`
          );

          if (!isApproved) {
            return {
              success: false as const,
              error: "User denied permission to move this path.",
            };
          }

          renameSync(absSource, absDest);
          return {
            success: true as const,
            message: `Successfully moved/renamed ${absSource} to ${absDest}`,
          };
        }

        return {
          success: false as const,
          error: `Unsupported action: ${action}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error in file operations";
        return { success: false as const, error: message };
      }
    },
  });
};
