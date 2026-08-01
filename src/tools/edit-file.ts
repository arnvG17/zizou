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
 *
 * DISAMBIGUATION via `near_line` (new):
 *   When old_string matches multiple locations, the optional `near_line`
 *   parameter picks the occurrence closest to the given line number. This
 *   avoids the failure loop where the model keeps adding context but the
 *   file has structurally identical blocks (e.g. two event listeners with
 *   the same body). The model can also get line numbers from the enhanced
 *   error message that now lists every match location.
 *
 * SAFETY: Requires user confirmation via the ConfirmFn injected at creation
 * time. Shows a warning dialog before editing a file so the user can approve
 * or deny the operation.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { tool } from "ai";
import type { ConfirmFn } from "./types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Finds all character-offset positions where `needle` appears in `haystack`.
 */
function findAllOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    positions.push(pos);
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return positions;
}

/**
 * Converts a character offset to a 1-based line number.
 */
function offsetToLine(contents: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < contents.length; i++) {
    if (contents[i] === "\n") line++;
  }
  return line;
}

/**
 * Returns a few lines of context around a given 1-based line number.
 * The output is formatted with line numbers for easy identification.
 */
function getContextAroundLine(
  contents: string,
  line: number,
  contextLines: number = 2,
): string {
  const lines = contents.split("\n");
  const start = Math.max(0, line - 1 - contextLines);
  const end = Math.min(lines.length, line - 1 + contextLines + 1);

  return lines
    .slice(start, end)
    .map((l, i) => {
      const lineNum = start + i + 1;
      const marker = lineNum === line ? " >>>" : "    ";
      return `${marker} ${lineNum}: ${l}`;
    })
    .join("\n");
}

// ─── Failure Tracker ─────────────────────────────────────────────────────────

export const editFailureTracker = new Map<string, number>();

// ─── Tool Factory ────────────────────────────────────────────────────────────

export const createEditFileTool = (confirm: ConfirmFn) => {
  return tool({
    description:
      "Edit the contents of a file by replacing an exact string. " +
      "You must provide the exact string you want to replace, including all whitespace. " +
      "If the string is not found, the tool will fail and return an error. " +
      "If the string is found multiple times, you can use the optional near_line parameter " +
      "to specify which occurrence to replace (the one closest to that line number). " +
      "Without near_line, the tool will fail and show the line numbers of all matches " +
      "so you can either add more context or specify near_line. " +
      "This requires user confirmation before proceeding.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or relative path to the file to edit"),
      old_string: z.string().describe("The exact string to be replaced"),
      new_string: z.string().describe("The new string to insert in its place"),
      near_line: z
        .number()
        .optional()
        .describe(
          "Optional line number hint. When old_string matches multiple times, " +
          "the occurrence closest to this line number will be replaced. " +
          "Use this when the same string appears in multiple places in the file."
        ),
    }),
    execute: async ({ path, old_string, new_string, near_line }) => {
      const absPath = resolve(process.cwd(), path);
      const normalizedPath = absPath.replace(/\\/g, "/").toLowerCase();

      const recordFailure = (baseError: string) => {
        const failCount = (editFailureTracker.get(normalizedPath) ?? 0) + 1;
        editFailureTracker.set(normalizedPath, failCount);

        if (failCount >= 2) {
          editFailureTracker.delete(normalizedPath);
          return {
            success: false as const,
            error:
              `editFile failed ${failCount} times on ${path}. FORCED FALLBACK: ` +
              `you must now call writeFile with the complete corrected file contents ` +
              `instead of retrying editFile.`,
            forceFallback: "writeFile",
          };
        }

        return {
          success: false as const,
          error: baseError,
        };
      };

      try {
        // Ask the user for permission before editing
        const isApproved = await confirm(
          `Edit file: ${absPath} (replace text)`
        );

        if (!isApproved) {
          return {
            success: false as const,
            error: "User denied permission to edit this file.",
          };
        }

        let contents = readFileSync(absPath, "utf-8");

        // Normalize line endings to \n to avoid silent mismatch issues on Windows
        contents = contents.replace(/\r\n/g, "\n");
        old_string = old_string.replace(/\r\n/g, "\n");

        // Find all occurrences
        const positions = findAllOccurrences(contents, old_string);
        const count = positions.length;

        // ── No matches ───────────────────────────────────────────────────
        if (count === 0) {
          // Try to find a partial/fuzzy match to help the model understand
          // what went wrong (e.g. whitespace differences)
          const firstLine = old_string.split("\n")[0].trim();
          let hint = "";
          if (firstLine.length > 10) {
            const lines = contents.split("\n");
            const nearMatches: { line: number; content: string }[] = [];
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(firstLine)) {
                nearMatches.push({ line: i + 1, content: lines[i] });
              }
            }
            if (nearMatches.length > 0) {
              hint =
                "\n\nPartial matches found (first line of your old_string appears at):\n" +
                nearMatches
                  .slice(0, 5)
                  .map(
                    (m) =>
                      `  Line ${m.line}: ${m.content.length > 120 ? m.content.slice(0, 120) + "..." : m.content}`
                  )
                  .join("\n") +
                "\n\nThe mismatch is likely caused by whitespace differences. " +
                "Check indentation (spaces vs tabs) and trailing spaces.";
            }
          }

          return recordFailure(
            `NOT_FOUND: The exact string was not found in ${path}. The file may have changed ` +
              `since you last read it, or you may have missed some whitespace. ` +
              `Please read the file again or adjust your exact string.` +
              hint
          );
        }

        // ── Multiple matches ─────────────────────────────────────────────
        if (count > 1) {
          // Convert positions to line numbers
          const matchLines = positions.map((pos) => offsetToLine(contents, pos));

          // If near_line is provided, pick the closest match
          if (near_line !== undefined) {
            let closestIdx = 0;
            let closestDist = Math.abs(matchLines[0] - near_line);
            for (let i = 1; i < matchLines.length; i++) {
              const dist = Math.abs(matchLines[i] - near_line);
              if (dist < closestDist) {
                closestDist = dist;
                closestIdx = i;
              }
            }

            // Perform the replacement at the closest occurrence
            const targetPos = positions[closestIdx];
            const updatedContents =
              contents.slice(0, targetPos) +
              new_string +
              contents.slice(targetPos + old_string.length);
            writeFileSync(absPath, updatedContents, "utf-8");
            editFailureTracker.delete(normalizedPath);

            return {
              success: true as const,
              message:
                `Successfully replaced occurrence at line ${matchLines[closestIdx]} ` +
                `(closest to near_line=${near_line}) in ${absPath}. ` +
                `${count} total matches existed at lines: ${matchLines.join(", ")}.`,
            };
          }

          // No near_line — return detailed AMBIGUOUS_MATCH error with line numbers and context
          const matchDetails = matchLines
            .map((line, i) => {
              const context = getContextAroundLine(contents, line);
              return `\n  Match ${i + 1} at line ${line}:\n${context}`;
            })
            .join("\n");

          return recordFailure(
            `AMBIGUOUS_MATCH: old_string matches ${count} locations in ${path}. ` +
              `Add more surrounding lines (2-3 lines of context above and/or below the target) ` +
              `to make old_string unique before retrying. Do not guess which occurrence.\n` +
              `\nHere is the context around each match:${matchDetails}\n\n` +
              `To fix this, either:\n` +
              `  1. Include more surrounding context in old_string that is UNIQUE to one occurrence, OR\n` +
              `  2. Use the near_line parameter (e.g. near_line: ${matchLines[0]}) to target a specific occurrence.`
          );
        }

        // ── Exactly 1 occurrence — perform the replacement ───────────────
        const updatedContents = contents.replace(old_string, new_string);
        writeFileSync(absPath, updatedContents, "utf-8");
        editFailureTracker.delete(normalizedPath);

        return {
          success: true as const,
          message: `Successfully replaced 1 occurrence in ${absPath}`,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error editing file";
        return recordFailure(message);
      }
    },
  });
};
