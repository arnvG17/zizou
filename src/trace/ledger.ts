// src/trace/ledger.ts
//
// LAYER: trace/
//
// The append-only record of every file change the agent made.
//
// JSONL, not a single JSON document. The old history.json was rewritten in
// full on every change, so a crash mid-write could lose the entire history;
// here a torn write costs at most the last line, and appending does not
// require reading what is already there.
//
// Reverts are recorded by APPENDING a marker line rather than editing the
// original entry in place, keeping the file strictly append-only. readAll()
// folds those markers into the edits they refer to.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTraceDir } from "./blobs.js";
import type { CoverageGap, FileEdit, LedgerEntry } from "./types.js";

function ledgerPath(): string {
  return join(getTraceDir(), "ledger.jsonl");
}

/** A line saying an edit was reverted or re-applied, written after the fact. */
interface RevertMarker {
  type: "revert";
  editId: string;
  /** null re-applies (redo); a timestamp marks it reverted. */
  revertedAt: string | null;
}

type Line = LedgerEntry | RevertMarker;

function appendLine(line: Line): void {
  mkdirSync(getTraceDir(), { recursive: true });
  appendFileSync(ledgerPath(), `${JSON.stringify(line)}\n`, "utf-8");
}

/**
 * Reads every line.
 *
 * Malformed lines are SKIPPED rather than thrown on. A single corrupt line —
 * from a killed process mid-append — must not make the whole history
 * unreadable and every past change unrevertable.
 */
function readLines(): Line[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];

  const out: Line[] = [];
  for (const raw of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Line);
    } catch {
      // Unparseable line: skip it and keep the rest of the history usable.
    }
  }
  return out;
}

/** The next sequence number. Derived from the file so it survives a restart. */
function nextSeq(lines: Line[]): number {
  let max = 0;
  for (const line of lines) {
    if (line.type === "edit" || line.type === "gap") {
      if (line.seq > max) max = line.seq;
    }
  }
  return max + 1;
}

/** Appends an edit, assigning its seq. Returns the stored record. */
export function appendEdit(edit: Omit<FileEdit, "seq">): FileEdit {
  const stored: FileEdit = { ...edit, seq: nextSeq(readLines()) };
  appendLine({ type: "edit", ...stored });
  return stored;
}

/** Appends a note that an opaque tool ran. */
export function appendGap(gap: Omit<CoverageGap, "seq">): void {
  appendLine({ type: "gap", ...gap, seq: nextSeq(readLines()) });
}

/** Marks an edit reverted (or, with null, re-applied). */
export function setReverted(editId: string, revertedAt: string | null): void {
  appendLine({ type: "revert", editId, revertedAt });
}

/** Every edit, oldest first, with revert markers already folded in. */
export function readEdits(): FileEdit[] {
  const lines = readLines();
  const edits: FileEdit[] = [];
  const byId = new Map<string, FileEdit>();

  for (const line of lines) {
    if (line.type === "edit") {
      const { type: _t, ...edit } = line;
      const record = edit as FileEdit;
      edits.push(record);
      byId.set(record.id, record);
    } else if (line.type === "revert") {
      // A marker for an edit we never saw means the ledger was truncated ahead
      // of it; nothing to fold, and dropping it is correct.
      const target = byId.get(line.editId);
      if (target) target.revertedAt = line.revertedAt;
    }
  }

  return edits.sort((a, b) => a.seq - b.seq);
}

/** Every coverage gap, oldest first. */
export function readGaps(): CoverageGap[] {
  return readLines()
    .filter((l): l is { type: "gap" } & CoverageGap => l.type === "gap")
    .map(({ type: _t, ...gap }) => gap as CoverageGap)
    .sort((a, b) => a.seq - b.seq);
}

/** Distinct turn ids, most recent first. */
export function readTurns(): string[] {
  const seen: string[] = [];
  for (const edit of readEdits()) {
    if (!seen.includes(edit.turnId)) seen.push(edit.turnId);
  }
  return seen.reverse();
}
