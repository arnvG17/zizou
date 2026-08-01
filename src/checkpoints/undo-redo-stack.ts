// src/checkpoints/undo-redo-stack.ts
//
// LAYER: checkpoint/
//
// Undo/redo stack management with persistence.
// Uses the conf package to store stacks in .zizou/ directory.

import Conf from "conf";
import type { StepSnapshot } from "./step-snapshot.js";
import { applySnapshotReverse, applySnapshotForward } from "./step-snapshot.js";

interface UndoRedoState {
  undoStack: StepSnapshot[];
  redoStack: StepSnapshot[];
}

const store = new Conf<UndoRedoState>({
  projectName: "zizou",
  cwd: ".zizou",
  defaults: {
    undoStack: [],
    redoStack: [],
  },
});

/**
 * Pushes a new snapshot onto the undo stack.
 * Clears the redo stack (any new action invalidates redo history).
 * 
 * @param snap - The snapshot to push.
 */
export function pushSnapshot(snap: StepSnapshot): void {
  const currentUndo = store.get("undoStack");
  store.set("undoStack", [...currentUndo, snap]);
  store.set("redoStack", []); // Clear redo history on new action
}

/**
 * Pops the most recent snapshot from the undo stack and applies it in reverse.
 * Pushes the snapshot onto the redo stack.
 * 
 * @returns The snapshot that was undone, or null if undo stack is empty.
 */
export function undo(): StepSnapshot | null {
  const stack = store.get("undoStack");
  const last = stack.at(-1);
  
  if (!last) return null;
  
  // Remove from undo stack
  store.set("undoStack", stack.slice(0, -1));
  
  // Add to redo stack
  const currentRedo = store.get("redoStack");
  store.set("redoStack", [...currentRedo, last]);
  
  return last;
}

/**
 * Pops the most recent snapshot from the redo stack and applies it forward.
 * Pushes the snapshot back onto the undo stack.
 * 
 * @returns The snapshot that was redone, or null if redo stack is empty.
 */
export function redo(): StepSnapshot | null {
  const stack = store.get("redoStack");
  const last = stack.at(-1);
  
  if (!last) return null;
  
  // Remove from redo stack
  store.set("redoStack", stack.slice(0, -1));
  
  // Add back to undo stack
  const currentUndo = store.get("undoStack");
  store.set("undoStack", [...currentUndo, last]);
  
  return last;
}

/**
 * Gets the current size of the undo stack.
 * 
 * @returns Number of snapshots in the undo stack.
 */
export function getUndoStackSize(): number {
  return store.get("undoStack").length;
}

/**
 * Gets the current size of the redo stack.
 * 
 * @returns Number of snapshots in the redo stack.
 */
export function getRedoStackSize(): number {
  return store.get("redoStack").length;
}

/**
 * Clears both undo and redo stacks.
 * Useful when starting a new session or explicitly clearing history.
 */
export function clearStacks(): void {
  store.set("undoStack", []);
  store.set("redoStack", []);
}

/**
 * Applies the undo operation (pops from undo stack, restores to before state).
 * This is a convenience function that combines undo() and applySnapshotReverse().
 * 
 * @returns The snapshot that was undone, or null if undo stack is empty.
 */
export function performUndo(): StepSnapshot | null {
  const snapshot = undo();
  if (snapshot) {
    applySnapshotReverse(snapshot);
  }
  return snapshot;
}

/**
 * Applies the redo operation (pops from redo stack, restores to after state).
 * This is a convenience function that combines redo() and applySnapshotForward().
 * 
 * @returns The snapshot that was redone, or null if redo stack is empty.
 */
export function performRedo(): StepSnapshot | null {
  const snapshot = redo();
  if (snapshot) {
    applySnapshotForward(snapshot);
  }
  return snapshot;
}