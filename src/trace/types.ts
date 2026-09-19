// src/trace/types.ts
//
// LAYER: trace/
//
// Type definitions for local file tracing.
//
// A trace records what the AGENT changed on disk, independently of git, so a
// user can see which file changed, read the diff, and revert one file without
// disturbing the others.
//
// This replaces checkpoint/, which recorded changes from the tool-call EVENT
// STREAM. That could not work: the SDK runs execute() concurrently with
// delivering the tool-call part, so the "before" snapshot raced the write it
// was meant to precede and frequently captured post-change content. Tracing
// happens inside execute() instead — see wrap-tools.ts.

/** How the file changed over a single tool call. */
export type EditKind = "created" | "modified" | "deleted";

/**
 * How confident we are that this record is complete.
 *
 *   "exact"       — the tool named its target path in its arguments, so the
 *                   before/after snapshot is of exactly the right file.
 *   "best-effort" — observed by re-checking a previously-seen path after an
 *                   opaque call (runBash). Real, but such a call may also have
 *                   touched files we never saw and therefore cannot list.
 */
export type Coverage = "exact" | "best-effort";

/**
 * One file, changed by one tool call.
 *
 * Content is stored by reference into the blob store rather than inline: an
 * agent that rewrites one large file ten times would otherwise store ten full
 * copies. See blobs.ts.
 */
export interface FileEdit {
  id: string;
  /** Monotonic position in the ledger. Revert order depends on this. */
  seq: number;
  /** The session that made the change, when one was active. */
  sessionId: string | null;
  /** One user prompt produces one turnId. `/undo` operates on a whole turn. */
  turnId: string;
  toolCallId: string;
  toolName: string;
  /** Canonical project-relative path. The single identity for a file — see paths.ts. */
  path: string;
  kind: EditKind;
  /** sha256 of the content before the change; null when the file did not exist. */
  beforeBlob: string | null;
  /** sha256 of the content after; null when the file was deleted. */
  afterBlob: string | null;
  added: number;
  removed: number;
  timestamp: string;
  /** Set when this edit has been reverted, so it can be redone and not re-reverted. */
  revertedAt: string | null;
  coverage: Coverage;
}

/**
 * A note that a tool ran which could have changed files we cannot enumerate.
 *
 * Recorded so the UI can say so out loud. An honest "this bash call may have
 * changed things I am not tracking" is worth more than a clean list that
 * quietly omits them.
 */
export interface CoverageGap {
  seq: number;
  turnId: string;
  toolName: string;
  /** The command, truncated — enough for the user to recognise it. */
  summary: string;
  timestamp: string;
}

/** A ledger line is one or the other, discriminated by `type`. */
export type LedgerEntry =
  | ({ type: "edit" } & FileEdit)
  | ({ type: "gap" } & CoverageGap);
