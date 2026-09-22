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

import { writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, basename, extname, relative, join } from "node:path";
import { z } from "zod";
import { tool } from "ai";
import type { ConfirmFn } from "./types.js";


/** How deep to walk looking for a same-named file, and how many to report. */
const SIMILAR_SEARCH_DEPTH = 4;
const SIMILAR_MAX_RESULTS = 3;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".zizou",
  "coverage",
  "vendor",
]);

/**
 * Finds existing files that look like the one about to be created.
 *
 * "Looks like" is deliberately narrow: the same basename, or the same stem
 * with a different extension. A looser match would fire on every new .ts file
 * in a TypeScript project, and a hint that fires always is a hint nobody
 * reads.
 *
 * Returns paths relative to the search root, capped and depth-limited so this
 * stays cheap enough to run inline before a confirmation prompt.
 */
function findSimilarFiles(targetPath: string): string[] {
  const root = process.cwd();
  const name = basename(targetPath);
  const stem = basename(targetPath, extname(targetPath));
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > SIMILAR_SEARCH_DEPTH || found.length >= SIMILAR_MAX_RESULTS) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory is not worth failing a write over
    }

    for (const entry of entries) {
      if (found.length >= SIMILAR_MAX_RESULTS) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }

      if (full === targetPath) continue;
      if (entry.name === name || basename(entry.name, extname(entry.name)) === stem) {
        found.push(relative(root, full));
      }
    }
  };

  try {
    walk(root, 0);
  } catch {
    return [];
  }

  return found;
}

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

        // For a NEW file, say whether something like it already exists
        // elsewhere. The repeated failure this catches: the agent writing a
        // fresh game.html at the root while a game-app/ directory already
        // held one, or a second copy of a component beside the original —
        // two files that disagree, where one edit was wanted.
        //
        // ADVISORY, like the scope hint: it informs the confirmation the user
        // is already being shown. It does not block the write, because a
        // similarly-named file is evidence, not proof.
        //
        // IT ALSO GOES TO THE MODEL, in the result below. This list used to
        // reach the human and stop there — so the one actor that could act on
        // it, by consolidating the two files instead of leaving them to
        // disagree, was the only one never told. The system prompt asked the
        // model to search for an existing implementation before creating a
        // file; this is the harness doing that search and handing over what it
        // found, rather than trusting that the instruction was followed.
        const siblings = fileExists ? [] : findSimilarFiles(absPath);
        const siblingNote = siblings.length
          ? "\n  Similar files already exist — edit one of these instead?\n" +
            siblings.map((f) => `    ${f}`).join("\n")
          : "";

        // Ask the user for permission
        const isApproved = await confirm(
          `${action}: ${absPath}${siblingNote}`
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
          ...(siblings.length
            ? {
                similarFiles: siblings,
                note:
                  `A new file was created, but these already exist and look like it: ${siblings.join(", ")}. ` +
                  `If one of them is the file this work belonged in, consolidate — two files that ` +
                  `disagree is worse than either alone.`,
              }
            : {}),
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error writing file";
        return { success: false as const, error: message };
      }
    },
  });
};
