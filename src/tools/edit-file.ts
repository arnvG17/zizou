/**
 * edit-file.ts — Tool definition for editing a file's contents safely.
 *
 * Layer: tools
 * Allowed imports: config (none above)
 *
 * Replaces exactly one occurrence of `old_string` with `new_string` in a file.
 * This exact-string matching approach is intentional. We do NOT use line-number
 * replacement because line numbers often drift as the model reasons about a file
 * that may have already changed. We do NOT use full-file-rewrite because it is
 * wasteful for large files and risks silently dropping content if the model
 * gets lazy or truncates its output.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { tool } from "ai";

export const editFile = tool({
  description:
    "Edit the contents of a file by replacing an exact string. " +
    "You must provide the exact string you want to replace, including all whitespace. " +
    "If the string is not found, or if it is found multiple times, the tool will fail " +
    "and return an error instructing you to provide more context. " +
    "This is safer than line numbers (which drift) and full rewrites (which risk truncation).",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path to the file to edit"),
    old_string: z.string().describe("The exact string to be replaced"),
    new_string: z.string().describe("The new string to insert in its place"),
  }),
  execute: async ({ path, old_string, new_string }) => {
    try {
      const contents = readFileSync(path, "utf-8");

      // Count occurrences of old_string
      let count = 0;
      let pos = contents.indexOf(old_string);
      while (pos !== -1) {
        count++;
        pos = contents.indexOf(old_string, pos + old_string.length);
      }

      if (count === 0) {
        return {
          success: false as const,
          error:
            "The exact string was not found in the file. The file may have changed " +
            "since you last read it, or you may have missed some whitespace. " +
            "Please read the file again or adjust your exact string.",
        };
      }

      if (count > 1) {
        return {
          success: false as const,
          error:
            `The exact string appeared ${count} times in the file. ` +
            "You must provide a unique string to replace. Please include more " +
            "surrounding context (lines above or below) in your old_string to make it unique.",
        };
      }

      // Exactly 1 occurrence: perform the replacement
      const updatedContents = contents.replace(old_string, new_string);
      writeFileSync(path, updatedContents, "utf-8");

      return {
        success: true as const,
        message: `Successfully replaced 1 occurrence in ${path}`,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error editing file";
      return { success: false as const, error: message };
    }
  },
});
