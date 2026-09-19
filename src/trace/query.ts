// src/trace/query.ts
//
// LAYER: trace/
//
// Views over the ledger: the per-file rollup `/changes` lists, and the turn
// selection `/undo` and `/redo` operate on.
//
// The ledger records one entry per file per tool call, which is the right
// granularity for correctness but the wrong one to read: an agent that edits
// one file four times should show the user ONE row with the net effect, not
// four. Rolling up here keeps the ledger honest and the display legible.

import { buildFileDiff } from "../agent/debug/file-diff.js";
import { getBlob } from "./blobs.js";
import { readEdits, readGaps } from "./ledger.js";
import { toAbsolute } from "./paths.js";
import type { CoverageGap, EditKind, FileEdit } from "./types.js";

/** Every edit to one file, collapsed into a single row. */
export interface FileRollup {
  path: string;
  /** Oldest first. Reverting the rollup means reverting these in reverse. */
  edits: FileEdit[];
  /** Net effect across all of them, not the sum of the individual diffs. */
  kind: EditKind;
  added: number;
  removed: number;
  /** Content before the first edit — what a full revert restores. */
  beforeBlob: string | null;
  /** Content after the last edit. */
  afterBlob: string | null;
  /** True when no edit to this file is still live. */
  fullyReverted: boolean;
  /** True when any edit came from an opaque tool and may be incomplete. */
  bestEffort: boolean;
}

export interface ChangesView {
  files: FileRollup[];
  gaps: CoverageGap[];
}

/**
 * Collapses edits into one row per file.
 *
 * Net +/- is recomputed from the first `before` against the last `after`
 * rather than summed, because summing double-counts: adding a line and then
 * deleting it reads as "+1 -1" when the honest answer is that nothing changed.
 */
export function rollupByFile(edits: FileEdit[], root: string): FileRollup[] {
  const byPath = new Map<string, FileEdit[]>();
  for (const edit of edits) {
    const list = byPath.get(edit.path);
    if (list) list.push(edit);
    else byPath.set(edit.path, [edit]);
  }

  const out: FileRollup[] = [];
  for (const [path, list] of byPath) {
    list.sort((a, b) => a.seq - b.seq);
    const first = list[0];
    const last = list[list.length - 1];

    const before = getBlob(first.beforeBlob);
    const after = getBlob(last.afterBlob);
    const diff = buildFileDiff(path, toAbsolute(path, root), before, after);

    const kind: EditKind =
      first.beforeBlob === null ? "created" : last.afterBlob === null ? "deleted" : "modified";

    out.push({
      path,
      edits: list,
      kind,
      added: diff.added,
      removed: diff.removed,
      beforeBlob: first.beforeBlob,
      afterBlob: last.afterBlob,
      fullyReverted: list.every((e) => e.revertedAt !== null),
      bestEffort: list.some((e) => e.coverage === "best-effort"),
    });
  }

  // Most recently touched first: the thing the user just watched happen is
  // the thing they are most likely reacting to.
  return out.sort((a, b) => b.edits[b.edits.length - 1].seq - a.edits[a.edits.length - 1].seq);
}

/**
 * The `/changes` view.
 *
 * Scoped to a session when one is given, because a project's ledger outlives
 * any single conversation and "what did you just change" should not list work
 * from a session the user closed days ago. Passing null shows everything.
 */
export function getChanges(root: string, sessionId: string | null): ChangesView {
  const all = readEdits();
  const edits = sessionId === null ? all : all.filter((e) => e.sessionId === sessionId);
  const turnIds = new Set(edits.map((e) => e.turnId));

  return {
    files: rollupByFile(edits, root),
    gaps: readGaps().filter((g) => turnIds.has(g.turnId)),
  };
}

/** The most recent turn that still has something to undo. */
export function lastUndoableTurn(sessionId: string | null): string | null {
  const edits = readEdits().filter(
    (e) => !e.revertedAt && (sessionId === null || e.sessionId === sessionId),
  );
  if (edits.length === 0) return null;
  return edits[edits.length - 1].turnId;
}

/**
 * The most recent turn that was undone and can be redone.
 *
 * A turn only counts when EVERY one of its edits is reverted. A half-reverted
 * turn — the user undid the turn, then reverted one file back by hand — is
 * ambiguous, and quietly re-applying part of it would surprise them.
 */
export function lastRedoableTurn(sessionId: string | null): string | null {
  const scoped = readEdits().filter((e) => sessionId === null || e.sessionId === sessionId);

  const byTurn = new Map<string, FileEdit[]>();
  for (const edit of scoped) {
    const list = byTurn.get(edit.turnId);
    if (list) list.push(edit);
    else byTurn.set(edit.turnId, [edit]);
  }

  let best: { turnId: string; seq: number } | null = null;
  for (const [turnId, list] of byTurn) {
    if (!list.every((e) => e.revertedAt !== null)) continue;
    const seq = Math.max(...list.map((e) => e.seq));
    if (!best || seq > best.seq) best = { turnId, seq };
  }

  return best?.turnId ?? null;
}

/** Live (non-reverted) edit count, for the `/undo` confirmation line. */
export function countLiveEdits(turnId: string): number {
  return readEdits().filter((e) => e.turnId === turnId && !e.revertedAt).length;
}
