// src/git/git.ts
//
// LAYER: git/
//
// Local file tracking — all change tracking is done via local file I/O only.
// No git commands are used anywhere in this module.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { SessionCommit, SessionSnapshots } from "./types.js";

const CWD = process.cwd();

/**
 * Gets a stable hash for the current working directory.
 * Used to namespace session data without any git dependency.
 */
function getProjectHash(): string {
  let hash = 0;
  const str = CWD.toLowerCase();
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Gets the snapshots file path for a session.
 * Uses a hash of the project directory path for namespacing.
 */
function getSnapshotsPath(sessionId: string): string {
  const homedir = process.env.HOME || process.env.USERPROFILE || "";
  const projectHash = getProjectHash();
  const sessionsDir = join(homedir, ".zizou", "sessions", projectHash);
  return join(sessionsDir, sessionId, "snapshots.json");
}

/**
 * Loads session snapshots from disk.
 */
export function loadSnapshots(sessionId: string): SessionSnapshots {
  const snapshotsPath = getSnapshotsPath(sessionId);
  if (!existsSync(snapshotsPath)) {
    return { commits: [] };
  }

  try {
    const data = readFileSync(snapshotsPath, "utf-8");
    return JSON.parse(data) as SessionSnapshots;
  } catch (error) {
    console.error(`Failed to load snapshots for ${sessionId}:`, error);
    return { commits: [] };
  }
}

/**
 * Saves session snapshots to disk.
 */
export function saveSnapshots(sessionId: string, snapshots: SessionSnapshots): void {
  const snapshotsPath = getSnapshotsPath(sessionId);
  const dir = join(snapshotsPath, "..");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(snapshotsPath, JSON.stringify(snapshots, null, 2), "utf-8");
}

/**
 * Records a step snapshot for a session.
 * Uses a locally-generated ID (no git SHA) to identify the snapshot.
 */
export function createSessionCommit(
  sessionId: string,
  stepIndex: number,
  description: string
): { sha: string } {
  const snapshots = loadSnapshots(sessionId);

  // Generate a local unique ID (timestamp + step index)
  const sha = `local-${Date.now()}-step${stepIndex}`;

  const commit: SessionCommit = {
    sha,
    stepIndex,
    description,
    timestamp: new Date().toISOString(),
  };

  snapshots.commits.push(commit);
  saveSnapshots(sessionId, snapshots);

  return { sha };
}

/**
 * Lists all recorded step snapshots for a session.
 */
export function listSessionCommits(sessionId: string): SessionCommit[] {
  const snapshots = loadSnapshots(sessionId);
  return snapshots.commits;
}
