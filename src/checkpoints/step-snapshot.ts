// src/checkpoints/step-snapshot.ts
//
// LAYER: checkpoint/
//
// Step-level snapshot capture and restoration for undo/redo functionality.
// Builds on existing checkpoint infrastructure to provide per-step granularity.

import { captureFileState, restoreFileState } from "../checkpoint/patcher.js";
import { resolve } from "path";

const CWD = process.cwd();

/**
 * Represents a single step's file changes for undo/redo purposes.
 */
export interface StepSnapshot {
  /** Unique identifier for this step (can use step index or timestamp). */
  stepId: string;
  
  /** ISO timestamp when this snapshot was created. */
  timestamp: string;
  
  /** File changes captured in this step. */
  fileDiffs: FileDiff[];
}

/**
 * Represents a single file's change within a step.
 */
export interface FileDiff {
  /** Relative path from project root. */
  path: string;
  
  /** Content before the step (null means file was created by this step). */
  before: string | null;
  
  /** Content after the step (null means file was deleted by this step). */
  after: string | null;
}

/**
 * Captures the current state of files before a step executes.
 * Returns a map of file paths to their content (or null if file doesn't exist).
 * 
 * @param paths - List of file paths to capture (relative or absolute).
 * @returns Map of absolute paths to current content (null = file doesn't exist).
 */
export function captureBeforeState(paths: string[]): Map<string, string | null> {
  const beforeStates = new Map<string, string | null>();
  
  for (const path of paths) {
    const absPath = resolve(CWD, path);
    const content = captureFileState(path);
    beforeStates.set(absPath, content);
  }
  
  return beforeStates;
}

/**
 * Builds a step snapshot by comparing before and after file states.
 * Reads current disk state for each touched path and computes diffs.
 * 
 * @param stepId - Identifier for this step (e.g., step index).
 * @param before - Map of file paths to their content before the step.
 * @param touchedPaths - List of files that were touched during the step.
 * @returns StepSnapshot with all file diffs.
 */
export function buildSnapshot(
  stepId: string,
  before: Map<string, string | null>,
  touchedPaths: string[]
): StepSnapshot {
  const fileDiffs: FileDiff[] = [];
  
  for (const path of touchedPaths) {
    const absPath = resolve(CWD, path);
    const beforeContent = before.get(absPath);
    const afterContent = captureFileState(path);
    
    fileDiffs.push({
      path,
      before: beforeContent ?? null,
      after: afterContent,
    });
  }
  
  return {
    stepId,
    timestamp: new Date().toISOString(),
    fileDiffs,
  };
}

/**
 * Applies a snapshot in reverse (undo operation).
 * Restores each file to its "before" state.
 * 
 * @param snapshot - The snapshot to revert.
 */
export function applySnapshotReverse(snapshot: StepSnapshot): void {
  for (const diff of snapshot.fileDiffs) {
    restoreFileState(diff.path, diff.before);
  }
}

/**
 * Applies a snapshot forward (redo operation).
 * Restores each file to its "after" state.
 * 
 * @param snapshot - The snapshot to reapply.
 */
export function applySnapshotForward(snapshot: StepSnapshot): void {
  for (const diff of snapshot.fileDiffs) {
    restoreFileState(diff.path, diff.after);
  }
}