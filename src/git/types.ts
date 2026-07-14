// src/git/types.ts
//
// LAYER: git/
//
// Type definitions for local session snapshot tracking.
// No git-specific types — everything is tracked via local file I/O.

export interface SessionCommit {
  sha: string;       // Locally-generated unique ID (e.g. "local-<timestamp>-step<N>")
  stepIndex: number;
  description: string;
  timestamp: string;
}

export interface SessionSnapshots {
  commits: SessionCommit[];
}
