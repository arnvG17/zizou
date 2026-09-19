// src/trace/format.ts
//
// LAYER: trace/
//
// Rendering traced changes for the terminal.
//
// computeLineDiff and formatColoredDiff are salvaged from checkpoint/manager.ts
// — the only parts of that module worth keeping. They are unchanged apart from
// speaking EditKind instead of the old operation union, and naming /changes in
// the truncation hint.

import type { EditKind, FileEdit } from "./types.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Computes a line-by-line diff between old and new file content using LCS. */
export function computeLineDiff(oldContent: string | null, newContent: string | null): string {
  if (oldContent === null && newContent === null) return "";

  const oldLines = oldContent !== null ? oldContent.split(/\r?\n/) : [];
  const newLines = newContent !== null ? newContent.split(/\r?\n/) : [];

  // Handle simple cases directly to avoid DP allocation
  if (oldLines.length === 0) {
    return newLines.map((line) => `+ ${line}`).join("\n");
  }
  if (newLines.length === 0) {
    return oldLines.map((line) => `- ${line}`).join("\n");
  }

  // To prevent performance hit on very large files, fall back if too large
  if (oldLines.length > 800 || newLines.length > 800) {
    return `[Diff too large to display inline (${oldLines.length} lines vs ${newLines.length} lines)]`;
  }

  const dp: number[][] = Array(oldLines.length + 1)
    .fill(null)
    .map(() => Array(newLines.length + 1).fill(0));

  for (let i = 1; i <= oldLines.length; i++) {
    for (let j = 1; j <= newLines.length; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const diffLines: string[] = [];
  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffLines.unshift(`  ${oldLines[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffLines.unshift(`+ ${newLines[j - 1]}`);
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      diffLines.unshift(`- ${oldLines[i - 1]}`);
      i--;
    }
  }

  return diffLines.join("\n");
}

/** Formats a diff with ANSI colour, truncating a created file unless showFull. */
export function formatColoredDiff(
  kind: EditKind,
  oldContent: string | null,
  newContent: string | null,
  showFull: boolean,
): string {
  const diffText = computeLineDiff(oldContent, newContent);
  if (!diffText) return "";

  const lines = diffText.split(/\r?\n/);

  let formatted = lines.map((line) => {
    if (line.startsWith("+")) return `${GREEN}${line}${RESET}`;
    if (line.startsWith("-")) return `${RED}${line}${RESET}`;
    return line;
  });

  if (kind === "created" && !showFull && lines.length > 10) {
    const total = lines.length;
    formatted = formatted.slice(0, 10);
    formatted.push(
      `${YELLOW}... [truncated ${total - 10} lines. Run '/changes diff <n> --full' to see all]${RESET}`,
    );
  }

  return formatted.join("\n");
}

/** `+12 -3`, coloured. */
export function formatStat(added: number, removed: number): string {
  return `${GREEN}+${added}${RESET} ${RED}-${removed}${RESET}`;
}

const KIND_GLYPH: Record<EditKind, string> = {
  created: "A",
  modified: "M",
  deleted: "D",
};

/** One row of the `/changes` table. */
export function formatEditRow(index: number, edit: FileEdit, extra?: string): string {
  const idx = String(index).padEnd(3);
  const glyph = KIND_GLYPH[edit.kind];
  const path = edit.path.padEnd(44);
  const stat = formatStat(edit.added, edit.removed);
  const tail = edit.revertedAt ? ` ${DIM}(reverted)${RESET}` : extra ? ` ${DIM}${extra}${RESET}` : "";
  return `  ${idx}${glyph}  ${path} ${stat}${tail}`;
}
