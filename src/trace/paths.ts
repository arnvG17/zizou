// src/trace/paths.ts
//
// LAYER: trace/
//
// The single source of path identity for traced edits.
//
// WHY THIS EXISTS: the old checkpoint system stored `filePath` as whatever
// string the model happened to pass and re-resolved it per call. So `src/a.ts`,
// `./src/a.ts` and `C:\proj\src\a.ts` became three independent entries for one
// file — undo would restore one identity and leave the other two claiming the
// change was still live. Every path entering the ledger goes through
// canonicalPath() exactly once.

import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Reduces any path spelling to one canonical, project-relative key.
 *
 * Forward slashes regardless of platform, so a ledger written on Windows can
 * be read anywhere. Lowercased on win32 only, because NTFS is case-insensitive
 * and `SRC/A.ts` and `src/a.ts` are the same file there — but are genuinely
 * different files on Linux, where lowercasing would merge two real entries.
 */
export function canonicalPath(p: string, root: string): string {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  let rel = relative(root, abs);

  // Outside the project root: keep the absolute path rather than emitting a
  // "../../.." key that means nothing once the cwd moves.
  if (rel === "" || rel.startsWith("..")) {
    rel = abs;
  }

  const normalized = rel.split(sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Turns a canonical key back into an absolute path for filesystem access. */
export function toAbsolute(canonical: string, root: string): string {
  return isAbsolute(canonical) ? canonical : resolve(root, canonical);
}
