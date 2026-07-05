// src/git/git.ts
//
// LAYER: git/
//
// Git operations - all git commands are isolated in this module.
// No other module should run raw git commands.

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { CommitInfo, BranchInfo, SessionCommit, SessionSnapshots } from "./types.js";
import type { ConfirmFn } from "../tools/index.js";

const CWD = process.cwd();

/**
 * Runs a git command and returns the output.
 */
function runGitCommand(args: string[]): string {
  try {
    return execSync(`git ${args.join(" ")}`, { cwd: CWD, encoding: "utf-8" }).trim();
  } catch (error: any) {
    const message = error.stderr?.toString() || error.message || "Unknown git error";
    throw new Error(`Git command failed: git ${args.join(" ")}\n${message}`);
  }
}

/**
 * Checks if the git working tree is clean (no uncommitted changes).
 */
export function gitStatus(): string {
  return runGitCommand(["status", "--porcelain"]);
}

/**
 * Gets the current git branch name.
 */
export function gitGetCurrentBranch(): string {
  return runGitCommand(["branch", "--show-current"]);
}

/**
 * Gets the current git HEAD commit SHA.
 */
export function gitGetCurrentCommit(): string {
  return runGitCommand(["rev-parse", "HEAD"]);
}

/**
 * Creates a new branch from the current HEAD and switches to it.
 */
export function gitCreateBranch(branchName: string): void {
  runGitCommand(["checkout", "-b", branchName]);
}

/**
 * Creates a commit with the given message.
 * Returns the SHA of the new commit.
 */
export function gitCommit(message: string): string {
  runGitCommand(["add", "."]);
  runGitCommand(["commit", "-m", message]);
  return gitGetCurrentCommit();
}

/**
 * Resets the current branch to the target commit.
 */
export function gitReset(target: string): void {
  runGitCommand(["reset", "--hard", target]);
}

/**
 * Gets the commit log for a branch.
 * Returns an array of commit info (SHA and message).
 */
export function gitGetCommitLog(branch: string): CommitInfo[] {
  const output = runGitCommand(["log", branch, "--format=%H %s"]);
  const lines = output.split("\n").filter(line => line.trim());
  
  return lines.map(line => {
    const spaceIndex = line.indexOf(" ");
    const sha = line.slice(0, spaceIndex);
    const message = line.slice(spaceIndex + 1);
    return { sha, message };
  });
}

/**
 * Gets the diff between two commits.
 * If target is not provided, shows diff for the last commit.
 */
export function gitGetDiff(target?: string, base?: string): string {
  if (target && base) {
    return runGitCommand(["diff", base, target]);
  } else if (target) {
    return runGitCommand(["show", target, "--stat"]);
  } else {
    return runGitCommand(["diff", "HEAD~1", "HEAD"]);
  }
}

/**
 * Creates a session branch from the current HEAD.
 * Returns the branch name and starting commit SHA.
 */
export function createSessionBranch(sessionName: string): BranchInfo {
  const branchName = `zizou/${sessionName}`;
  const startCommit = gitGetCurrentCommit();
  gitCreateBranch(branchName);
  return { branch: branchName, startCommit };
}

/**
 * Gets the snapshots file path for a session.
 * Uses the same project hash logic as the session storage module.
 */
function getSnapshotsPath(sessionId: string): string {
  const homedir = process.env.HOME || process.env.USERPROFILE || "";
  
  // Get project hash (same logic as session/storage.ts)
  let projectHash = "";
  try {
    projectHash = runGitCommand(["rev-parse", "HEAD"]);
  } catch {
    // Not a git repo, hash the directory path
    let hash = 0;
    const str = CWD.toLowerCase();
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    projectHash = Math.abs(hash).toString(16);
  }
  
  const sessionsDir = join(homedir, ".zizou", "sessions", projectHash);
  return join(sessionsDir, sessionId, "snapshots.json");
}

/**
 * Loads session snapshots from disk.
 */
export function loadSnapshots(sessionId: string): SessionSnapshots {
  const snapshotsPath = getSnapshotsPath(sessionId);
  if (!existsSync(snapshotsPath)) {
    return { startCommit: "", commits: [] };
  }
  
  try {
    const data = readFileSync(snapshotsPath, "utf-8");
    return JSON.parse(data) as SessionSnapshots;
  } catch (error) {
    console.error(`Failed to load snapshots for ${sessionId}:`, error);
    return { startCommit: "", commits: [] };
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
 * Creates a commit for a verified step.
 * Returns the SHA of the new commit.
 */
export function createSessionCommit(
  sessionId: string,
  stepIndex: number,
  description: string
): { sha: string } {
  const message = `[${sessionId}] step ${stepIndex}: ${description}`;
  const sha = gitCommit(message);
  
  // Update snapshots.json
  const snapshots = loadSnapshots(sessionId);
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
 * Lists all commits for a session.
 */
export function listSessionCommits(sessionId: string): SessionCommit[] {
 const snapshots = loadSnapshots(sessionId);
  return snapshots.commits;
}

/**
 * Reverts a session to a specific point.
 * Target can be undefined (revert last commit), a stepIndex (number), or a SHA (string).
 * Throws if target is not found in the session's commit list.
 */
export async function revertSession(
  sessionId: string,
  target?: string | number,
  onConfirm?: ConfirmFn
): Promise<void> {
  const snapshots = loadSnapshots(sessionId);
  
  if (snapshots.commits.length === 0) {
    throw new Error("No commits found for this session");
  }
  
  let targetSha: string;
  
  if (target === undefined) {
    // Revert last commit
    if (snapshots.commits.length === 1) {
      throw new Error("Cannot revert: only one commit exists");
    }
    targetSha = snapshots.commits[snapshots.commits.length - 2].sha;
  } else if (typeof target === "number") {
    // Find by stepIndex
    const commit = snapshots.commits.find(c => c.stepIndex === target);
    if (!commit) {
      throw new Error(`Step ${target} not found in session commit history`);
    }
    targetSha = commit.sha;
  } else {
    // Find by SHA
    const commit = snapshots.commits.find(c => c.sha === target);
    if (!commit) {
      throw new Error(`Commit ${target} not found in session commit history`);
    }
    targetSha = commit.sha;
  }
  
  // Find commits that will be discarded
  const targetIndex = snapshots.commits.findIndex(c => c.sha === targetSha);
  const discardedCommits = snapshots.commits.slice(targetIndex + 1);
  
  if (discardedCommits.length === 0) {
    throw new Error("Already at target commit");
  }
  
  // Show what will be discarded and require confirmation
  if (onConfirm) {
    const discardList = discardedCommits
      .map(c => `  Step ${c.stepIndex}: ${c.description}`)
      .join("\n");
    
    const confirmed = await onConfirm(
      `This will discard the following commits:\n${discardList}\n\nRevert to step ${snapshots.commits[targetIndex].stepIndex}? (y/n)`
    );
    
    if (!confirmed) {
      throw new Error("Revert cancelled by user");
    }
  }
  
  // Execute the revert
  gitReset(targetSha);
  
  // Note: We do NOT remove entries from snapshots.json
  // This preserves the full history for reference
}
