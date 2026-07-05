// src/checkpoint/manager.ts
//
// LAYER: checkpoint/
//
// Checkpoint lifecycle management.
// Handles creating, restoring, branching, and listing checkpoints.

import { randomUUID } from "crypto";
import { loadCheckpointHistory, saveCheckpointHistory } from "./storage.js";
import { captureFileState, restoreFileState, createFilePatch, applyFilePatch } from "./patcher.js";
import type { Checkpoint, CheckpointBranch, FilePatch } from "./types.js";

/**
 * Creates a new checkpoint for the given file changes.
 * Automatically determines the parent checkpoint based on the active branch.
 * 
 * @param description - Human-readable description of the change
 * @param changedFiles - List of files that were changed
 * @param oldFileStates - Map of file paths to their content before the change (optional, will capture if not provided)
 */
export function createCheckpoint(description: string, changedFiles: string[], oldFileStates?: Map<string, string | null>): Checkpoint {
  const history = loadCheckpointHistory();
  
  // Get the active branch
  const activeBranch = history.branches.find(b => b.id === history.activeBranchId);
  
  // If no active branch, create the main branch
  let branchId = history.activeBranchId;
  let parentId: string | null = null;
  let stepIndex = 0;
  
  if (!activeBranch) {
    // Create the main branch
    branchId = randomUUID();
    const newBranch: CheckpointBranch = {
      id: branchId,
      name: "main",
      rootCheckpointId: "", // Will be set after checkpoint is created
      headCheckpointId: "", // Will be set after checkpoint is created
      createdAt: new Date().toISOString(),
    };
    history.branches.push(newBranch);
    history.activeBranchId = branchId;
  } else {
    // Use the active branch's head as parent
    const headCheckpoint = history.checkpoints.get(activeBranch.headCheckpointId);
    if (headCheckpoint) {
      parentId = headCheckpoint.id;
      stepIndex = headCheckpoint.stepIndex + 1;
    }
  }
  
  // Capture file states and create patches
  const patches: FilePatch[] = [];
  for (const filePath of changedFiles) {
    const oldContent = oldFileStates?.get(filePath) ?? captureFileState(filePath);
    const newContent = captureFileState(filePath); // Current state after change
    
    // Only create a patch if the file actually changed
    if (oldContent !== newContent) {
      patches.push(createFilePatch(filePath, oldContent, newContent));
    }
  }
  
  // Create the checkpoint
  const checkpoint: Checkpoint = {
    id: randomUUID(),
    parentId,
    branchId,
    stepIndex,
    description,
    timestamp: new Date().toISOString(),
    patches,
  };
  
  // Add to history
  history.checkpoints.set(checkpoint.id, checkpoint);
  
  // Update branch head
  const branch = history.branches.find(b => b.id === branchId)!;
  if (branch.rootCheckpointId === "") {
    branch.rootCheckpointId = checkpoint.id;
  }
  branch.headCheckpointId = checkpoint.id;
  
  // Save history
  saveCheckpointHistory(history);
  
  return checkpoint;
}

/**
 * Restores the workspace to a specific checkpoint state.
 * Applies all patches from the checkpoint's ancestors up to the target.
 */
export function restoreCheckpoint(checkpointId: string): void {
  const history = loadCheckpointHistory();
  const targetCheckpoint = history.checkpoints.get(checkpointId);
  
  if (!targetCheckpoint) {
    throw new Error(`Checkpoint ${checkpointId} not found`);
  }
  
  // Collect all checkpoints from the branch's root to the target
  const branch = history.branches.find(b => b.id === targetCheckpoint.branchId);
  if (!branch) {
    throw new Error(`Branch ${targetCheckpoint.branchId} not found`);
  }
  
  // Build the chain of checkpoints from root to target
  const checkpointChain: Checkpoint[] = [];
  let currentId = checkpointId;
  
  while (currentId) {
    const checkpoint = history.checkpoints.get(currentId);
    if (!checkpoint) break;
    checkpointChain.unshift(checkpoint);
    currentId = checkpoint.parentId || "";
  }
  
  // Restore to the target state by applying all patches up to the target
  // First, revert to the branch root (no changes)
  // Then apply patches up to the target
  for (const checkpoint of checkpointChain) {
    for (const patch of checkpoint.patches) {
      applyFilePatch(patch);
    }
  }
  
  // Update the active branch's head to the restored checkpoint
  branch.headCheckpointId = checkpointId;
  
  // If restoring to a checkpoint that's not the current head, create a new branch
  if (checkpointId !== branch.headCheckpointId) {
    // This is handled by the caller - they can create a new branch if needed
  }
  
  saveCheckpointHistory(history);
}

/**
 * Creates a new branch from a specific checkpoint.
 */
export function createBranch(name: string, fromCheckpointId: string): CheckpointBranch {
  const history = loadCheckpointHistory();
  const fromCheckpoint = history.checkpoints.get(fromCheckpointId);
  
  if (!fromCheckpoint) {
    throw new Error(`Checkpoint ${fromCheckpointId} not found`);
  }
  
  // Check if branch name already exists
  if (history.branches.some(b => b.name === name)) {
    throw new Error(`Branch ${name} already exists`);
  }
  
  // Create the new branch
  const newBranch: CheckpointBranch = {
    id: randomUUID(),
    name,
    rootCheckpointId: fromCheckpointId,
    headCheckpointId: fromCheckpointId,
    createdAt: new Date().toISOString(),
  };
  
  history.branches.push(newBranch);
  
  // Switch to the new branch
  history.activeBranchId = newBranch.id;
  
  saveCheckpointHistory(history);
  
  return newBranch;
}

/**
 * Switches the active branch.
 */
export function switchBranch(branchId: string): void {
  const history = loadCheckpointHistory();
  const branch = history.branches.find(b => b.id === branchId);
  
  if (!branch) {
    throw new Error(`Branch ${branchId} not found`);
  }
  
  // Restore to the branch's head
  restoreCheckpoint(branch.headCheckpointId);
  
  // Update active branch
  history.activeBranchId = branchId;
  
  saveCheckpointHistory(history);
}

/**
 * Lists all checkpoints, optionally filtered by branch.
 */
export function listCheckpoints(branchId?: string): Checkpoint[] {
  const history = loadCheckpointHistory();
  const checkpoints: Checkpoint[] = [];
  
  for (const checkpoint of history.checkpoints.values()) {
    if (branchId === undefined || checkpoint.branchId === branchId) {
      checkpoints.push(checkpoint);
    }
  }
  
  // Sort by timestamp
  checkpoints.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  
  return checkpoints;
}

/**
 * Lists all branches.
 */
export function listBranches(): CheckpointBranch[] {
  const history = loadCheckpointHistory();
  return history.branches;
}

/**
 * Gets the active branch.
 */
export function getActiveBranch(): CheckpointBranch | null {
  const history = loadCheckpointHistory();
  return history.branches.find(b => b.id === history.activeBranchId) || null;
}

/**
 * Compares two checkpoints and returns the diff patches.
 */
export function diffCheckpoints(fromId: string, toId: string): FilePatch[] {
  const history = loadCheckpointHistory();
  const fromCheckpoint = history.checkpoints.get(fromId);
  const toCheckpoint = history.checkpoints.get(toId);
  
  if (!fromCheckpoint || !toCheckpoint) {
    throw new Error("One or both checkpoints not found");
  }
  
  // For simplicity, return the patches from the to checkpoint
  // A more sophisticated implementation would compute the actual diff
  return toCheckpoint.patches;
}

/**
 * Deletes a checkpoint.
 */
export function deleteCheckpoint(checkpointId: string): void {
  const history = loadCheckpointHistory();
  const checkpoint = history.checkpoints.get(checkpointId);
  
  if (!checkpoint) {
    throw new Error(`Checkpoint ${checkpointId} not found`);
  }
  
  // Check if checkpoint is a branch head
  const branch = history.branches.find(b => b.headCheckpointId === checkpointId);
  if (branch) {
    throw new Error(`Cannot delete checkpoint ${checkpointId}: it is the head of branch ${branch.name}`);
  }
  
  // Check if checkpoint is a branch root
  const rootBranch = history.branches.find(b => b.rootCheckpointId === checkpointId);
  if (rootBranch) {
    throw new Error(`Cannot delete checkpoint ${checkpointId}: it is the root of branch ${rootBranch.name}`);
  }
  
  // Remove the checkpoint
  history.checkpoints.delete(checkpointId);
  
  saveCheckpointHistory(history);
}
