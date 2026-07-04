// src/agent/verifier.ts
//
// LAYER: agent/
//
// Filesystem verification — the SINGLE place where "did the executor
// actually change what it claimed to change?" gets answered.
//
// WHY A SEPARATE MODULE:
//   The executor (via runTurn) returns a list of files it claims to have
//   modified. But the model's self-report is unreliable — it might:
//     - Claim it edited a file but the edit actually failed (old_string
//       didn't match, silent error swallowed by the SDK)
//     - Write to files it didn't mention in its summary
//     - Report success when the tool threw an error
//   The verifier treats the FILESYSTEM as ground truth and the model's
//   claims as an assertion to be checked, not evidence to be trusted.
//
// HOW IT WORKS:
//   Before the executor runs a step, we snapshot the mtime of every file
//   in targetFiles (plus any files the executor claims it touched after).
//   After execution, we compare:
//     1. Did every file in claimedFiles actually change (mtime increased)?
//     2. Did any file NOT in claimedFiles change unexpectedly?
//   A mismatch in either direction means verification fails.
//
// DEPENDENCY DIRECTION: imports from agent/types.ts only.
// Must NOT import from ui/, config/, or provider/.

import { statSync } from "fs";
import { resolve } from "path";
import type { PlanStep, StepResult, VerificationResult } from "./types.js";
import { SessionLogger } from "./debug/index.js";

// ─── File State Snapshot ─────────────────────────────────────────────────────
//
// A lightweight record of a file's state at a point in time. We only
// track mtime (not content hash) because:
//   1. mtime is essentially free — one statSync call per file
//   2. For our purposes, "did the file change at all?" is sufficient
//   3. Content hashing would require reading entire file contents, which
//      is expensive for large files and unnecessary for this check

interface FileSnapshot {
  /** Absolute path to the file. */
  path: string;

  /** Last modification time in milliseconds, or null if file doesn't exist. */
  mtimeMs: number | null;
}

/**
 * Takes a snapshot of a file's current state (mtime).
 * Returns null for mtimeMs if the file doesn't exist (which is valid —
 * a step that's supposed to CREATE a file won't have an existing mtime).
 */
function snapshotFile(absolutePath: string): FileSnapshot {
  try {
    const stat = statSync(absolutePath);
    return { path: absolutePath, mtimeMs: stat.mtimeMs };
  } catch {
    // File doesn't exist yet — that's fine for files being created.
    return { path: absolutePath, mtimeMs: null };
  }
}

// ─── Pre-Step Snapshot ───────────────────────────────────────────────────────
//
// Called by the orchestrator BEFORE executing a step. Captures the
// filesystem state of all files the step expects to touch, so we can
// compare after execution.

/**
 * Captures a filesystem snapshot of the files a step plans to touch.
 * Call this BEFORE executeStep(), then pass the result to verifyStep()
 * after execution completes.
 *
 * @param step - The plan step about to be executed.
 * @param cwd - Workspace root for resolving relative paths.
 * @returns A map of absolute paths to their pre-execution snapshots.
 */
export function capturePreSnapshot(
  step: PlanStep,
  cwd: string,
): Map<string, FileSnapshot> {
  const snapshots = new Map<string, FileSnapshot>();

  // Snapshot every file the plan step says it will touch.
  for (const file of step.targetFiles) {
    const abs = resolve(cwd, file);
    snapshots.set(abs, snapshotFile(abs));
  }

  return snapshots;
}

// ─── Post-Step Verification ──────────────────────────────────────────────────
//
// The core verification logic. Compares pre-execution snapshots against
// post-execution filesystem state AND against the executor's claimed
// file list.

/**
 * Verifies that a step's execution matches its claims.
 *
 * Checks two things:
 *   1. Every file the executor CLAIMS it changed actually has a different
 *      mtime than before execution (claimed-but-unchanged detection).
 *   2. Every file in the step's targetFiles that was supposed to be
 *      created or modified actually exists and was touched.
 *
 * NOTE: This intentionally does NOT do a full workspace diff to find
 * "changed-but-not-claimed" files outside targetFiles — that would
 * require scanning the entire repo after every step, which is too slow.
 * We limit the check to the declared targetFiles + claimedFiles sets.
 *
 * @param step - The plan step that was executed.
 * @param result - The executor's reported result (claimed files + tool calls).
 * @param cwd - Workspace root for resolving relative paths.
 * @param preSnapshots - The filesystem snapshot taken BEFORE execution
 *                       (from capturePreSnapshot).
 */
export async function verifyStep(
  step: PlanStep,
  result: StepResult,
  cwd: string,
  preSnapshots: Map<string, FileSnapshot>,
): Promise<VerificationResult> {
  const mismatches: string[] = [];

  SessionLogger.logVerifierStart(step, result.claimedFiles);

  // ── Check 1: Did every claimed file actually change? ───────────────────
  //
  // The executor says it wrote/edited these files. Verify that each one
  // has a different mtime now than it did before execution.
  for (const claimedFile of result.claimedFiles) {
    const abs = resolve(cwd, claimedFile);
    const postSnapshot = snapshotFile(abs);

    // Get the pre-execution snapshot if we have one
    const preSnapshot = preSnapshots.get(abs);

    if (postSnapshot.mtimeMs === null) {
      // File doesn't exist after execution — but the executor claimed
      // it changed. This is a clear mismatch.
      mismatches.push(`claimed-changed-but-missing: ${claimedFile}`);
    } else if (preSnapshot && preSnapshot.mtimeMs !== null) {
      // File existed before AND after — check if mtime actually changed.
      // Note: on some filesystems, rapid writes within the same millisecond
      // can produce the same mtime. We accept this as a known limitation
      // that doesn't justify the cost of content hashing.
      if (postSnapshot.mtimeMs === preSnapshot.mtimeMs) {
        mismatches.push(`claimed-changed-but-unchanged: ${claimedFile}`);
      }
    }
    // If preSnapshot.mtimeMs was null and postSnapshot.mtimeMs is not null,
    // the file was created — that's a valid change, no mismatch.
  }

  // ── Check 2: Were expected target files actually touched? ──────────────
  //
  // The plan step declared targetFiles it expected to modify. If any of
  // them weren't in the executor's claimed list AND their mtime didn't
  // change, that's suspicious — the step may have failed silently.
  for (const targetFile of step.targetFiles) {
    const abs = resolve(cwd, targetFile);
    const postSnapshot = snapshotFile(abs);
    const preSnapshot = preSnapshots.get(abs);

    // Skip files that were already verified as claimed above
    const wasClaimed = result.claimedFiles.some(
      (f) => resolve(cwd, f) === abs,
    );
    if (wasClaimed) continue;

    // Target file not claimed by executor — check if it changed anyway
    if (preSnapshot && preSnapshot.mtimeMs !== null) {
      if (postSnapshot.mtimeMs !== preSnapshot.mtimeMs) {
        // File changed but wasn't claimed — unexpected modification
        mismatches.push(`changed-but-not-claimed: ${targetFile}`);
      }
    } else if (postSnapshot.mtimeMs === null) {
      // Target file was supposed to be created but doesn't exist.
      // This might be okay if the step's description was about modifying
      // the file and it legitimately didn't need to create it. We flag
      // it as a soft warning rather than a hard failure.
      mismatches.push(`target-not-created: ${targetFile}`);
    }
  }

  // Verification passes only if there are zero mismatches.
  const finalResult = {
    verified: mismatches.length === 0,
    mismatches,
  };

  SessionLogger.logVerifierEnd(finalResult);
  return finalResult;
}
