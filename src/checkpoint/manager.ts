// src/checkpoint/manager.ts
//
// LAYER: checkpoint/
//
// Checkpoint lifecycle management.
// Handles creating, restoring, branching, and listing checkpoints.

import { randomUUID } from "crypto";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";
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
 * Reconstructs the state of all files in the workspace at a given checkpoint.
 */
export function reconstructFileStates(checkpointId: string): Map<string, string | null> {
  const history = loadCheckpointHistory();
  const checkpoint = history.checkpoints.get(checkpointId);
  if (!checkpoint) {
    return new Map();
  }
  
  // Build chain from root to target
  const chain: Checkpoint[] = [];
  let currentId: string | null = checkpointId;
  while (currentId) {
    const c = history.checkpoints.get(currentId);
    if (!c) break;
    chain.unshift(c);
    currentId = c.parentId;
  }
  
  const fileStates = new Map<string, string | null>();
  for (const c of chain) {
    for (const patch of c.patches) {
      fileStates.set(patch.filePath, patch.newContent);
    }
  }
  return fileStates;
}

/**
 * Compares two checkpoints and returns the actual diff patches.
 */
export function diffCheckpoints(fromId: string, toId: string): FilePatch[] {
  const fromStates = reconstructFileStates(fromId);
  const toStates = reconstructFileStates(toId);
  
  const patches: FilePatch[] = [];
  const allFiles = new Set([...fromStates.keys(), ...toStates.keys()]);
  
  for (const filePath of allFiles) {
    const oldContent = fromStates.get(filePath) ?? null;
    const newContent = toStates.get(filePath) ?? null;
    
    if (oldContent !== newContent) {
      let operation: "create" | "modify" | "delete";
      if (oldContent === null && newContent !== null) {
        operation = "create";
      } else if (oldContent !== null && newContent === null) {
        operation = "delete";
      } else {
        operation = "modify";
      }
      patches.push({ filePath, operation, oldContent, newContent });
    }
  }
  
  return patches;
}

/**
 * Recursively scans a directory for files, ignoring common non-project paths.
 */
function scanDirectoryForCode(dir: string, baseDir: string = dir): string[] {
  const files: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
    
    // Ignore common non-project directories
    if (
      entry === "node_modules" ||
      entry === ".git" ||
      entry === "dist" ||
      entry === "build" ||
      entry === ".zizou" ||
      entry === ".gemini" ||
      entry === "package-lock.json" ||
      entry === "bun.lock"
    ) {
      continue;
    }
    
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        files.push(...scanDirectoryForCode(fullPath, baseDir));
      } else if (stat.isFile()) {
        files.push(relPath);
      }
    } catch {
      // Ignore errors
    }
  }
  
  return files;
}

export interface LocalChange {
  filePath: string;
  operation: "create" | "modify" | "delete";
  oldContent: string | null;
  newContent: string | null;
}

/**
 * Gets all uncommitted local changes in the workspace since the head checkpoint.
 */
export function getLocalChanges(): LocalChange[] {
  const history = loadCheckpointHistory();
  const activeBranch = history.branches.find(b => b.id === history.activeBranchId);
  
  const headFileStates = new Map<string, string | null>();
  if (activeBranch && activeBranch.headCheckpointId) {
    const checkpointChain: Checkpoint[] = [];
    let currentId: string | null = activeBranch.headCheckpointId;
    while (currentId) {
      const checkpoint = history.checkpoints.get(currentId);
      if (!checkpoint) break;
      checkpointChain.unshift(checkpoint);
      currentId = checkpoint.parentId;
    }
    
    for (const checkpoint of checkpointChain) {
      for (const patch of checkpoint.patches) {
        headFileStates.set(patch.filePath, patch.newContent);
      }
    }
  }
  
  const changes: LocalChange[] = [];
  const CWD = process.cwd();
  
  // 1. Check all tracked files for modifications or deletions
  for (const [filePath, headContent] of headFileStates.entries()) {
    const currentContent = captureFileState(filePath);
    if (headContent !== currentContent) {
      if (currentContent === null) {
        changes.push({
          filePath,
          operation: "delete",
          oldContent: headContent,
          newContent: null
        });
      } else {
        changes.push({
          filePath,
          operation: "modify",
          oldContent: headContent,
          newContent: currentContent
        });
      }
    }
  }
  
  // 2. Check for newly created files
  const projectFiles = scanDirectoryForCode(CWD);
  for (const filePath of projectFiles) {
    if (!headFileStates.has(filePath)) {
      const currentContent = captureFileState(filePath);
      if (currentContent !== null) {
        changes.push({
          filePath,
          operation: "create",
          oldContent: null,
          newContent: currentContent
        });
      }
    }
  }
  
  return changes;
}

/**
 * Reverts all uncommitted local changes in the workspace back to the head checkpoint state.
 */
export function revertLocalChanges(): void {
  const changes = getLocalChanges();
  for (const change of changes) {
    restoreFileState(change.filePath, change.oldContent);
  }
}

/**
 * Computes a line-by-line diff between old and new file content using LCS.
 */
export function computeLineDiff(oldContent: string | null, newContent: string | null): string {
  if (oldContent === null && newContent === null) return "";
  
  const oldLines = oldContent !== null ? oldContent.split(/\r?\n/) : [];
  const newLines = newContent !== null ? newContent.split(/\r?\n/) : [];
  
  // Handle simple cases directly to avoid DP allocation
  if (oldLines.length === 0) {
    return newLines.map(line => `+ ${line}`).join("\n");
  }
  if (newLines.length === 0) {
    return oldLines.map(line => `- ${line}`).join("\n");
  }

  // To prevent performance hit on very large files, fall back if too large
  if (oldLines.length > 800 || newLines.length > 800) {
    return `[Diff too large to display inline (${oldLines.length} lines vs ${newLines.length} lines)]`;
  }

  const dp: number[][] = Array(oldLines.length + 1).fill(null).map(() => Array(newLines.length + 1).fill(0));
  
  for (let i = 1; i <= oldLines.length; i++) {
    for (let j = 1; j <= newLines.length; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const diffLines: string[] = [];
  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffLines.unshift(`  ${oldLines[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffLines.unshift(`+ ${newLines[j - 1]}`);
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      diffLines.unshift(`- ${oldLines[i - 1]}`);
      i--;
    }
  }

  return diffLines.join("\n");
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

/**
 * Reconstructs the state of the workspace before the session began (at the parent of the root checkpoint).
 */
export function getSessionInitialFileStates(): Map<string, string | null> {
  const history = loadCheckpointHistory();
  const activeBranch = history.branches.find(b => b.id === history.activeBranchId);
  if (!activeBranch || !activeBranch.rootCheckpointId) {
    return new Map();
  }
  
  const rootCheckpoint = history.checkpoints.get(activeBranch.rootCheckpointId);
  if (!rootCheckpoint || !rootCheckpoint.parentId) {
    // If the root checkpoint has no parent, the initial state is empty (no files tracked yet)
    return new Map();
  }
  
  return reconstructFileStates(rootCheckpoint.parentId);
}

/**
 * Gets all changes in the workspace since the session began.
 */
export function getSessionChanges(): LocalChange[] {
  const initialStates = getSessionInitialFileStates();
  const changes: LocalChange[] = [];
  const CWD = process.cwd();
  
  // 1. Check all files that existed at the start of the session
  for (const [filePath, initialContent] of initialStates.entries()) {
    const currentContent = captureFileState(filePath);
    if (initialContent !== currentContent) {
      if (currentContent === null) {
        changes.push({
          filePath,
          operation: "delete",
          oldContent: initialContent,
          newContent: null
        });
      } else {
        changes.push({
          filePath,
          operation: "modify",
          oldContent: initialContent,
          newContent: currentContent
        });
      }
    }
  }
  
  // 2. Check for newly created files
  const projectFiles = scanDirectoryForCode(CWD);
  for (const filePath of projectFiles) {
    if (!initialStates.has(filePath)) {
      const currentContent = captureFileState(filePath);
      if (currentContent !== null) {
        changes.push({
          filePath,
          operation: "create",
          oldContent: null,
          newContent: currentContent
        });
      }
    }
  }
  
  return changes;
}

/**
 * Reverts all changes in the workspace back to the initial state of the session.
 */
export function revertSessionChanges(): void {
  const changes = getSessionChanges();
  for (const change of changes) {
    restoreFileState(change.filePath, change.oldContent);
  }
}

/**
 * Formats a diff with ANSI green and red highlights and handles top-10-line truncation for created files.
 */
export function formatColoredDiff(
  filePath: string,
  operation: "create" | "modify" | "delete",
  oldContent: string | null,
  newContent: string | null,
  showFull: boolean
): string {
  const diffText = computeLineDiff(oldContent, newContent);
  if (!diffText) return "";
  
  const lines = diffText.split(/\r?\n/);
  
  let formattedLines = lines.map(line => {
    if (line.startsWith("+")) {
      return `\x1b[32m${line}\x1b[0m`; // Green text
    } else if (line.startsWith("-")) {
      return `\x1b[31m${line}\x1b[0m`; // Red text
    } else {
      return line;
    }
  });

  // If the file was created and --full is not specified, truncate to top 10 lines
  if (operation === "create" && !showFull && lines.length > 10) {
    const totalLines = lines.length;
    formattedLines = formattedLines.slice(0, 10);
    formattedLines.push(
      `\x1b[33m... [truncated ${totalLines - 10} lines. Run '/checkpoint diff --full' to view the entire file]\x1b[0m`
    );
  }

  return formattedLines.join("\n");
}
