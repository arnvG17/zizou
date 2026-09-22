// src/commands/changes.ts
//
// LAYER: commands/
//
// `/changes`, `/undo` and `/redo` — the user-facing view of the file trace.
//
// Kept out of commands/index.ts because the rendering is longer than a command
// block should be, and because all three read from the same trace/ views and
// should stay together when one of them changes.

import {
  getChanges,
  lastRedoableTurn,
  lastUndoableTurn,
  type FileRollup,
} from "../trace/query.js";
import { redoTurn, revertEdit, revertTurn, type RevertResult } from "../trace/revert.js";
import { getBlob } from "../trace/blobs.js";
import { formatColoredDiff, formatEditRow } from "../trace/format.js";
import { getActiveSessionId } from "../session/registry.js";

const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Everything these commands need, so they don't reach into CommandContext. */
export interface ChangesDeps {
  root: string;
}

function scope(): string | null {
  return getActiveSessionId() ?? null;
}

/** Renders the table `/changes` prints, including the coverage warning. */
export function renderChanges(root: string): string {
  const { files, gaps } = getChanges(root, scope());
  const live = files.filter((f) => !f.fullyReverted);

  if (files.length === 0) {
    return "No file changes recorded in this session.";
  }

  const lines: string[] = [];
  lines.push(`${live.length} file(s) changed by the agent in this session:`);
  lines.push("");
  files.forEach((file, i) => {
    lines.push(formatEditRow(i + 1, file.edits[file.edits.length - 1], summarize(file)));
  });

  // Say out loud what we could NOT see. A clean list that silently omits
  // bash-created files is worse than one that admits the gap.
  if (gaps.length > 0) {
    lines.push("");
    lines.push(
      `${YELLOW}⚠ ${gaps.length} shell command(s) ran this session. Files they created ` +
        `outside the paths above are not tracked and cannot be reverted:${RESET}`,
    );
    for (const gap of gaps.slice(-5)) {
      lines.push(`${DIM}    ${gap.summary}${RESET}`);
    }
  }

  lines.push("");
  lines.push(`${DIM}/changes diff <n> [--full]   show the diff${RESET}`);
  lines.push(`${DIM}/changes revert <n> [--force]  revert just that file${RESET}`);
  return lines.join("\n");
}

function summarize(file: FileRollup): string {
  const parts: string[] = [];
  if (file.edits.length > 1) parts.push(`${file.edits.length} edits`);
  if (file.bestEffort) parts.push("best-effort");
  return parts.join(", ");
}

/** Resolves a 1-based index from the same ordering renderChanges prints. */
function pick(root: string, arg: string | undefined): FileRollup | string {
  const { files } = getChanges(root, scope());
  if (files.length === 0) return "No file changes recorded in this session.";

  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > files.length) {
    return `Pick a number between 1 and ${files.length}. Run /changes to see the list.`;
  }
  return files[n - 1];
}

/** `/changes diff <n> [--full]` */
export function renderDiff(root: string, arg: string | undefined, full: boolean): string {
  const picked = pick(root, arg);
  if (typeof picked === "string") return picked;

  const before = getBlob(picked.beforeBlob);
  const after = getBlob(picked.afterBlob);
  const body = formatColoredDiff(picked.kind, before, after, full);

  return `${picked.displayPath} (${picked.kind})\n\n${body || "(no textual change)"}`;
}

function describe(results: RevertResult[]): string {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  const lines: string[] = [];
  if (ok.length > 0) {
    lines.push(`Reverted ${ok.length} file(s):`);
    for (const r of ok) lines.push(`    ${r.path}`);
  }
  if (failed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`${YELLOW}Skipped ${failed.length} file(s):${RESET}`);
    for (const r of failed) lines.push(`    ${r.path} — ${r.reason}`);
    lines.push("");
    lines.push(`${DIM}Re-run with --force to overwrite anyway.${RESET}`);
  }
  return lines.join("\n");
}

/** `/changes revert <n> [--force]` — one file, leaving the rest of the turn alone. */
export function revertOneFile(root: string, arg: string | undefined, force: boolean): string {
  const picked = pick(root, arg);
  if (typeof picked === "string") return picked;

  const live = picked.edits.filter((e) => !e.revertedAt);
  if (live.length === 0) return `${picked.displayPath} is already reverted.`;

  // Newest first, so a file edited several times walks back through each
  // recorded state and lands on its content from before the agent touched it.
  const results = live
    .sort((a, b) => b.seq - a.seq)
    .map((e) => revertEdit(e.id, root, force));

  return describe(results);
}

/** `/undo` — revert the most recent turn that still has live changes. */
export function undoLastTurn(root: string, force: boolean): string {
  const turnId = lastUndoableTurn(scope());
  if (!turnId) return "Nothing to undo — the agent has not changed any files in this session.";

  const results = revertTurn(turnId, root, force);
  if (results.length === 0) return "Nothing to undo.";
  return describe(results);
}

/** `/redo` — re-apply the most recent fully-undone turn. */
export function redoLastTurn(root: string, force: boolean): string {
  const turnId = lastRedoableTurn(scope());
  if (!turnId) return "Nothing to redo — no changes have been undone.";

  const results = redoTurn(turnId, root, force);
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  const lines: string[] = [];
  if (ok.length > 0) {
    lines.push(`Reapplied ${ok.length} file(s):`);
    for (const r of ok) lines.push(`    ${r.path}`);
  }
  if (failed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`${YELLOW}Skipped ${failed.length} file(s):${RESET}`);
    for (const r of failed) lines.push(`    ${r.path} — ${r.reason}`);
  }
  return lines.join("\n");
}

/** Dispatches the `/changes` sub-commands. Returns the text to print. */
export function handleChanges(root: string, args: string[]): string {
  const force = args.includes("--force");
  const full = args.includes("--full");
  const positional = args.filter((a) => !a.startsWith("--"));
  const sub = positional[0];

  if (!sub) return renderChanges(root);
  if (sub === "diff") return renderDiff(root, positional[1], full);
  if (sub === "revert") return revertOneFile(root, positional[1], force);

  return `Unknown: /changes ${sub}\n\n  /changes\n  /changes diff <n> [--full]\n  /changes revert <n> [--force]`;
}
