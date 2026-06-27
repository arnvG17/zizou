/**
 * list-dir.ts — Tool definition for listing the contents of a directory.
 *
 * Layer: tools
 * Allowed imports: none above (this is the base layer)
 *
 * Gives the agent a lightweight way to explore the project structure
 * before deciding where to place a new file. Unlike glob (which searches
 * recursively by filename pattern) this returns the IMMEDIATE children of a
 * single directory — exactly what you'd see with `ls` — so the model can
 * progressively navigate into subdirectories without an expensive full-tree walk.
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { tool } from "ai";

export const listDir = tool({
  description:
    "List the files and subdirectories inside a directory. " +
    "Use this to explore the project structure and find the right place to put a new file. " +
    "Relative paths are resolved from the project root (cwd). " +
    "Skips node_modules, .git, dist, and other build artefacts automatically.",
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe(
        "Directory path to list. Omit or use '.' to list the project root."
      ),
  }),
  execute: async ({ path: inputPath }) => {
    const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache"]);
    try {
      const dir = resolve(process.cwd(), inputPath ?? ".");
      const entries = readdirSync(dir);

      const items: Array<{ name: string; type: "file" | "dir" }> = [];
      for (const entry of entries) {
        if (SKIP.has(entry)) continue;
        try {
          const stat = statSync(join(dir, entry));
          items.push({ name: entry, type: stat.isDirectory() ? "dir" : "file" });
        } catch {
          // unreadable entry — skip silently
        }
      }

      return {
        success: true as const,
        directory: dir,
        entries: items,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error listing directory";
      return { success: false as const, error: message };
    }
  },
});
