// src/trace/blobs.ts
//
// LAYER: trace/
//
// Content-addressed storage for file snapshots.
//
// The old checkpoint system inlined full before/after content into a single
// history.json and never pruned it. An agent that rewrote one large file
// repeatedly stored a complete copy each time, and the whole file had to be
// parsed to read any part of it.
//
// Addressing content by its sha256 means an unchanged file costs nothing to
// record twice, and a revert-then-redo cycle reuses the blobs already on disk.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectHash, getZizouDir } from "../config/project-hash.js";

/** ~/.zizou/trace/<projectHash> — per project, like sessions and the old checkpoints. */
export function getTraceDir(): string {
  return join(getZizouDir(), "trace", getProjectHash());
}

function getBlobDir(): string {
  return join(getTraceDir(), "blobs");
}

function blobPath(sha: string): string {
  // Two-character prefix directory: the same reason git does it — tens of
  // thousands of sibling files make a directory slow to list on every platform.
  return join(getBlobDir(), sha.slice(0, 2), sha.slice(2));
}

/** Stores content and returns its sha256. Idempotent. */
export function putBlob(content: string): string {
  const sha = createHash("sha256").update(content, "utf-8").digest("hex");
  const path = blobPath(sha);

  // Already stored. Content addressing means identical sha implies identical
  // bytes, so rewriting would be pure cost.
  if (existsSync(path)) return sha;

  mkdirSync(join(getBlobDir(), sha.slice(0, 2)), { recursive: true });

  // Write-then-rename: a crash mid-write leaves a stray .tmp rather than a
  // truncated blob that a future revert would silently restore as truth.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);

  return sha;
}

/**
 * Reads a blob back.
 *
 * Returns null for a null ref, which callers use to mean "the file did not
 * exist" — a legitimate state, not an error. Throws when a ref that should
 * exist does not, because silently treating a missing blob as "no file" would
 * make a revert DELETE a file it was meant to restore.
 */
export function getBlob(sha: string | null): string | null {
  if (sha === null) return null;
  const path = blobPath(sha);
  if (!existsSync(path)) {
    throw new Error(`Trace blob ${sha.slice(0, 12)} is missing from ${getBlobDir()}`);
  }
  return readFileSync(path, "utf-8");
}

/** True when the blob backing a ref is still on disk. */
export function hasBlob(sha: string | null): boolean {
  if (sha === null) return true; // "no content" is always available
  return existsSync(blobPath(sha));
}
