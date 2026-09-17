// src/config/project-hash.ts
//
// LAYER: config/
//
// Identifies the current project for on-disk state (checkpoints, sessions).
//
// THIS IS THE ONLY IMPLEMENTATION. The same djb2-style hash was written out
// three times — checkpoint/storage.ts, session/storage.ts and git/git.ts —
// which is three chances for them to drift and silently point at different
// state directories for the same project. config/ is the one layer both
// checkpoint/ and session/ are allowed to import from.
//
// DEPENDENCY DIRECTION: imports nothing from the project.

import { homedir } from "os";
import { join } from "path";

/**
 * A stable short hash of the current working directory.
 *
 * Case-insensitive by design: Windows paths vary in case between invocations
 * (`C:\Users` vs `c:\users`) and must resolve to the same project.
 *
 * Computed per call rather than cached at module load, because the cwd is not
 * guaranteed to be settled when this module is first imported.
 */
export function getProjectHash(): string {
  let hash = 0;
  const str = process.cwd().toLowerCase();
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16);
}

/** Root of Zizou's per-user state: ~/.zizou */
export function getZizouDir(): string {
  // homedir() already falls back appropriately; the old code read HOME and
  // USERPROFILE by hand and produced "" when neither was set, silently
  // writing state into the filesystem root.
  return join(homedir(), ".zizou");
}

/** Per-project state directory: ~/.zizou/<projectHash> */
export function getProjectStateDir(): string {
  return join(getZizouDir(), getProjectHash());
}
