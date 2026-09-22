// src/trace/revert.ts
//
// LAYER: trace/
//
// Undoing what the agent did — per file, or per turn.
//
// The safety rule that the old system lacked: before restoring anything, check
// that the file on disk still holds the content the agent left there. If the
// user edited it by hand afterwards, a blind restore would silently destroy
// their work in the name of undoing the agent's. That case refuses and says
// so; `force` is the user's explicit override.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getBlob, hasBlob } from "./blobs.js";
import { readEdits, setReverted } from "./ledger.js";
import { toAbsolute } from "./paths.js";
import type { FileEdit } from "./types.js";

export interface RevertResult {
  ok: boolean;
  /** The file, spelled as the user recognises it. */
  path: string;
  /** Set when ok is false — why it was refused, in words meant for the user. */
  reason?: string;
}

function readOrNull(abs: string): string | null {
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

/** Writes content, or deletes the file when content is null. */
function restore(abs: string, content: string | null): void {
  if (content === null) {
    if (existsSync(abs)) rmSync(abs, { force: true });
    return;
  }
  // The old patcher wrote without this and threw whenever the parent directory
  // had since been removed — exactly the case where you most want the undo.
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

/**
 * Restores one traced edit to its pre-change state.
 *
 * `expected` is the blob the file should currently hold for the move to be
 * safe; for a revert that is `afterBlob`, for a redo it is `beforeBlob`.
 */
function move(
  edit: FileEdit,
  root: string,
  direction: "revert" | "redo",
  force: boolean,
): RevertResult {
  const abs = toAbsolute(edit.path, root);
  const expectedBlob = direction === "revert" ? edit.afterBlob : edit.beforeBlob;
  const targetBlob = direction === "revert" ? edit.beforeBlob : edit.afterBlob;

  if (!hasBlob(targetBlob)) {
    return {
      ok: false,
      path: edit.displayPath ?? edit.path,
      reason: "the stored content for this change is missing from the trace store",
    };
  }

  if (!force) {
    const current = readOrNull(abs);
    const expected = getBlob(expectedBlob);
    if (current !== expected) {
      return {
        ok: false,
        path: edit.displayPath ?? edit.path,
        reason:
          current === null
            ? "the file no longer exists — it was changed outside this trace"
            : "the file has changed since the agent touched it — reverting would discard that edit",
      };
    }
  }

  restore(abs, getBlob(targetBlob));
  setReverted(edit.id, direction === "revert" ? new Date().toISOString() : null);
  return { ok: true, path: edit.displayPath ?? edit.path };
}

/** Reverts a single edit by id. */
export function revertEdit(editId: string, root: string, force = false): RevertResult {
  const edit = readEdits().find((e) => e.id === editId);
  if (!edit) return { ok: false, path: editId, reason: "no such change in the trace" };
  if (edit.revertedAt) return { ok: false, path: edit.displayPath ?? edit.path, reason: "already reverted" };
  return move(edit, root, "revert", force);
}

/** Re-applies a single reverted edit. */
export function redoEdit(editId: string, root: string, force = false): RevertResult {
  const edit = readEdits().find((e) => e.id === editId);
  if (!edit) return { ok: false, path: editId, reason: "no such change in the trace" };
  if (!edit.revertedAt) return { ok: false, path: edit.displayPath ?? edit.path, reason: "not reverted" };
  return move(edit, root, "redo", force);
}

/**
 * Reverts every live edit in a turn.
 *
 * Reverse sequence order matters: when a turn edited one file three times,
 * unwinding newest-first walks the file back through each recorded state and
 * lands on the content from before the turn. Forward order would restore the
 * oldest "before" first and then have later reverts overwrite it with newer
 * content — leaving the file mid-turn rather than pre-turn.
 */
export function revertTurn(turnId: string, root: string, force = false): RevertResult[] {
  const edits = readEdits()
    .filter((e) => e.turnId === turnId && !e.revertedAt)
    .sort((a, b) => b.seq - a.seq);

  return edits.map((e) => move(e, root, "revert", force));
}

/** Re-applies a reverted turn, oldest edit first — the mirror of revertTurn. */
export function redoTurn(turnId: string, root: string, force = false): RevertResult[] {
  const edits = readEdits()
    .filter((e) => e.turnId === turnId && e.revertedAt)
    .sort((a, b) => a.seq - b.seq);

  return edits.map((e) => move(e, root, "redo", force));
}
