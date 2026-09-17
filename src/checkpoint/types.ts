// src/checkpoint/types.ts
//
// LAYER: checkpoint/
//
// Type definitions for the internal checkpoint system.
// Checkpoints track AI-generated changes independently of Git.

/**
 * A file patch representing the change made to a single file.
 * Stores both old and new content to enable restoration and diffing.
 */
export interface FilePatch {
  /** Relative path from project root. */
  filePath: string;

  /** Type of change made to the file. */
  operation: "create" | "modify" | "delete";

  /** Content before the change (null for create operations). */
  oldContent: string | null;

  /** Content after the change (null for delete operations). */
  newContent: string | null;
}

/**
 * A checkpoint represents one atomic AI-generated change (one prompt execution).
 * Contains incremental diff patches for all files modified in that operation.
 */
export interface Checkpoint {
  /** Unique identifier for this checkpoint. */
  id: string;

  /** Parent checkpoint ID (null for root checkpoints). */
  parentId: string | null;

  /** Branch this checkpoint belongs to. */
  branchId: string;

  /** Step number within the branch (0-indexed). */
  stepIndex: number;

  /** Human-readable description of the change. */
  description: string;

  /** ISO timestamp when checkpoint was created. */
  timestamp: string;

  /**
   * The session that produced this checkpoint, when one was active.
   *
   * Checkpoint history is per-project and shared across sessions, so without
   * this there is no way to tell which session's work a checkpoint belongs to.
   * Optional because checkpoints written before this field existed have none.
   */
  sessionId?: string;

  /** Incremental diff patches for changed files. */
  patches: FilePatch[];
}

/**
 * A branch represents a linear sequence of checkpoints.
 * Enables branching from any point in history.
 */
export interface CheckpointBranch {
  /** Unique identifier for this branch. */
  id: string;

  /** Human-readable branch name. */
  name: string;

  /** First checkpoint in this branch. */
  rootCheckpointId: string;

  /** Current head of this branch (latest checkpoint). */
  headCheckpointId: string;

  /** ISO timestamp when branch was created. */
  createdAt: string;
}

/**
 * The complete checkpoint history for a project.
 * Contains all branches and checkpoints, plus the active branch pointer.
 */
export interface CheckpointHistory {
  /** All branches in the project. */
  branches: CheckpointBranch[];

  /** Map of checkpoint ID to checkpoint data. */
  checkpoints: Map<string, Checkpoint>;

  /** Currently active branch ID. */
  activeBranchId: string;
}
