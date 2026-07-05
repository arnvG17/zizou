// src/git/types.ts
//
// LAYER: git/
//
// Type definitions for git operations and session snapshots.

export interface SessionCommit {
  sha: string;
  stepIndex: number;
  description: string;
  timestamp: string;
}

export interface SessionSnapshots {
  startCommit: string;
  commits: SessionCommit[];
}

export interface BranchInfo {
  branch: string;
  startCommit: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
}
