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
import { captureFileState, restoreFileState, createFilePatch } from "./patcher.js";
import type { Checkpoint, CheckpointBranch, FilePatch } from "./types.js";

/**
 * Creates a new checkpoint for the given file changes.
 * Automatically determines the parent checkpoint based on the active branch.
 * 
 * @param description - Human-readable description of the change
 * @param changedFiles - List of files that were changed
 * @param oldFileStates - Map of file paths to their content before the change (optional, will capture if not provided)
 */
export function createCheckpoint(
  description: string,
  changedFiles: string[],
  oldFileStates?: Map<string, string | null>,
  sessionId?: string,
): Checkpoint {
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
    // Use `has`, not `??`. A recorded null means "this file did not exist
    // before the change" — a legitimate value. `??` treated it as absent and
    // fell through to captureFileState(), which returns the file's CURRENT
    // content, making oldContent === newContent so no patch was written at
    // all. Every file creation was silently dropped from the checkpoint.
    const oldContent = oldFileStates?.has(filePath)
      ? oldFileStates.get(filePath)!
      : captureFileState(filePath);
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
    sessionId,
    patches,
  };
  
  // Add to history
  history.checkpoints.set(checkpoint.id, checkpoint);

  // Update branch head
  const branch = history.branches.find(b => b.id === branchId)!;
  if (branch.rootCheckpointId === "") {
    branch.rootCheckpointId = checkpoint.id;
  } else if (branch.headCheckpointId === "" && parentId === null) {
    // The user undid every checkpoint and then made a new change. Like
    // committing after a reset: this becomes the branch's new root, and the
    // undone chain stays in history but is no longer reachable from the head.
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

  const branch = history.branches.find(b => b.id === targetCheckpoint.branchId);
  if (!branch) {
    throw new Error(`Branch ${targetCheckpoint.branchId} not found`);
  }

  // Restoring has TWO halves, and only the first used to be implemented:
  //
  //   1. Files the target checkpoint knows about → set to their state AT the
  //      target (replay root→target). This is what reconstructFileStates does.
  //
  //   2. Files first touched AFTER the target → must be rolled back, or they
  //      are left on disk at their newer state. Replaying forward can never
  //      undo them, because the target's chain has no patch mentioning them.
  //      Without this, restoring backwards silently leaves newer edits behind
  //      and history.json permanently disagrees with the working tree.
  const targetStates = reconstructFileStates(checkpointId);

  // Walk from the head that is currently on disk back toward the target,
  // recording each file's pre-change content. We walk backwards, so later
  // writes overwrite earlier ones and the value that survives is from the
  // checkpoint CLOSEST to the target — i.e. the file's state at the target.
  const activeBranch = history.branches.find(b => b.id === history.activeBranchId) ?? branch;
  const rollback = new Map<string, string | null>();
  let cursor: string | null = activeBranch.headCheckpointId;
  const seen = new Set<string>(); // guard against a malformed/cyclic chain
  while (cursor && cursor !== checkpointId && !seen.has(cursor)) {
    seen.add(cursor);
    const checkpoint: Checkpoint | undefined = history.checkpoints.get(cursor);
    if (!checkpoint) break;
    for (const patch of checkpoint.patches) {
      rollback.set(patch.filePath, patch.oldContent);
    }
    cursor = checkpoint.parentId;
  }

  // Half 1: authoritative state at the target.
  for (const [filePath, content] of targetStates) {
    restoreFileState(filePath, content);
  }

  // Half 2: everything the target never knew about, rolled back to its
  // pre-change content. targetStates wins on any overlap.
  for (const [filePath, content] of rollback) {
    if (!targetStates.has(filePath)) {
      restoreFileState(filePath, content);
    }
  }

  // The restored checkpoint is now the head of its branch.
  branch.headCheckpointId = checkpointId;

  saveCheckpointHistory(history);
}

// ─── Undo / redo ─────────────────────────────────────────────────────────────
//
// Undo and redo are POINTER MOVES along the checkpoint chain — not a separate
// stack. There used to be a second store (checkpoints/undo-redo-stack.ts, a
// Conf file under <cwd>/.zizou) holding its own snapshots, and the two never
// talked to each other:
//
//   - /undo restored files but left history.json claiming the undone content
//     was still current, so /checkpoint diff reported the undone step as a
//     fresh local modification and /checkpoint revert would RE-APPLY it.
//   - /checkpoint restore changed the disk without touching the stacks, so a
//     later /undo reverted to a "before" state that no longer matched reality.
//
// With one chain and one head pointer, that divergence cannot be expressed.
//
// A head of "" means "before the root checkpoint" — every change undone.

/** The checkpoint the working tree currently reflects, or null if fully undone. */
function getHeadCheckpoint(history: ReturnType<typeof loadCheckpointHistory>): Checkpoint | null {
  const branch = history.branches.find(b => b.id === history.activeBranchId);
  if (!branch || !branch.headCheckpointId) return null;
  return history.checkpoints.get(branch.headCheckpointId) ?? null;
}

/** The checkpoint that would be re-applied by redo, if any. */
function getRedoTarget(history: ReturnType<typeof loadCheckpointHistory>): Checkpoint | null {
  const branch = history.branches.find(b => b.id === history.activeBranchId);
  if (!branch) return null;

  // Fully undone: the next thing forward is the branch root.
  if (!branch.headCheckpointId) {
    return history.checkpoints.get(branch.rootCheckpointId) ?? null;
  }

  // Otherwise the child of the current head on this branch. If a restore
  // created several children, take the most recent — that is the one the
  // user was last working on.
  const children = [...history.checkpoints.values()]
    .filter(c => c.parentId === branch.headCheckpointId && c.branchId === branch.id)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return children[0] ?? null;
}

/** How many checkpoints can still be undone. */
export function getUndoDepth(): number {
  const history = loadCheckpointHistory();
  let depth = 0;
  let cursor = getHeadCheckpoint(history);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    depth++;
    cursor = cursor.parentId ? history.checkpoints.get(cursor.parentId) ?? null : null;
  }
  return depth;
}

/** How many checkpoints can be redone. */
export function getRedoDepth(): number {
  const history = loadCheckpointHistory();
  let depth = 0;
  let cursor = getRedoTarget(history);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    depth++;
    const next: Checkpoint | undefined = [...history.checkpoints.values()]
      .filter(c => c.parentId === cursor!.id && c.branchId === cursor!.branchId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
    cursor = next ?? null;
  }
  return depth;
}

/**
 * Reverts the head checkpoint's changes and moves the head to its parent.
 * Returns the checkpoint that was undone, or null if there was nothing to undo.
 */
export function undoCheckpoint(): Checkpoint | null {
  const history = loadCheckpointHistory();
  const branch = history.branches.find(b => b.id === history.activeBranchId);
  const head = getHeadCheckpoint(history);
  if (!branch || !head) return null;

  // Reverting a patch means restoring each file to its pre-change content.
  for (const patch of head.patches) {
    restoreFileState(patch.filePath, patch.oldContent);
  }

  branch.headCheckpointId = head.parentId ?? "";
  saveCheckpointHistory(history);
  return head;
}

/**
 * Re-applies the next checkpoint forward and moves the head onto it.
 * Returns the checkpoint that was redone, or null if there was nothing to redo.
 */
export function redoCheckpoint(): Checkpoint | null {
  const history = loadCheckpointHistory();
  const branch = history.branches.find(b => b.id === history.activeBranchId);
  const target = getRedoTarget(history);
  if (!branch || !target) return null;

  for (const patch of target.patches) {
    restoreFileState(patch.filePath, patch.newContent);
  }

  branch.headCheckpointId = target.id;
  saveCheckpointHistory(history);
  return target;
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
  const branch = loadCheckpointHistory().branches.find(b => b.id === branchId);

  if (!branch) {
    throw new Error(`Branch ${branchId} not found`);
  }

  // Restore to the branch's head. This loads and saves history itself.
  restoreCheckpoint(branch.headCheckpointId);

  // Re-load AFTER the restore. Holding the pre-restore history object here
  // and saving it would clobber the head pointer restoreCheckpoint just wrote.
  const history = loadCheckpointHistory();
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
 *
 * Returns null when there is NO session baseline to compare against — i.e. the
 * active branch has no root checkpoint, or that root has no parent (the normal
 * case for a fresh project whose first checkpoint IS the root).
 *
 * WHY null AND NOT AN EMPTY MAP: an empty map is indistinguishable from "the
 * session started with zero files on disk". getSessionChanges() would then
 * classify every file in the project as newly created with oldContent=null,
 * and revertSessionChanges() would unlink the entire working tree. The absence
 * of a baseline must be an explicit, unrepresentable-as-data state.
 */
export function getSessionInitialFileStates(): Map<string, string | null> | null {
  const history = loadCheckpointHistory();
  const activeBranch = history.branches.find(b => b.id === history.activeBranchId);
  if (!activeBranch || !activeBranch.rootCheckpointId) {
    return null;
  }

  const rootCheckpoint = history.checkpoints.get(activeBranch.rootCheckpointId);
  if (!rootCheckpoint || !rootCheckpoint.parentId) {
    // Root checkpoint has no parent — there is no recorded pre-session state.
    return null;
  }

  return reconstructFileStates(rootCheckpoint.parentId);
}

/**
 * Whether a session baseline exists to diff or revert against.
 * Callers should use this to tell "nothing changed" apart from "we have no
 * idea what the starting state was".
 */
export function hasSessionBaseline(): boolean {
  return getSessionInitialFileStates() !== null;
}

/**
 * Gets all changes in the workspace since the session began.
 * Returns an empty list when there is no session baseline (see above).
 */
export function getSessionChanges(): LocalChange[] {
  const initialStates = getSessionInitialFileStates();
  if (initialStates === null) {
    return [];
  }
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
  // Refuse rather than guess. Without a baseline every file looks "created",
  // and reverting a create means deleting it — i.e. emptying the project.
  if (getSessionInitialFileStates() === null) {
    throw new Error(
      "No session baseline recorded for this branch, so there is no known " +
      "state to revert to. Use '/checkpoint revert' (without 'session') to " +
      "revert to the head checkpoint instead."
    );
  }

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
