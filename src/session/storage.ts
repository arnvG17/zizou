// src/session/storage.ts
//
// LAYER: session/
//
// Storage utilities for session directory structure and project hashing.

import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { execSync } from "child_process";

const ZIZOU_DIR = join(homedir(), ".zizou");
const SESSIONS_DIR = join(ZIZOU_DIR, "sessions");

/**
 * Gets the project hash for the current working directory.
 * Uses git commit hash if available, otherwise hashes the directory path.
 */
export function getProjectHash(): string {
  const cwd = process.cwd();
  
  try {
    // Try to get git commit hash
    const gitHead = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
    if (gitHead) {
      return gitHead;
    }
  } catch {
    // Not a git repo or git not available, fall back to path hash
  }
  
  // Simple hash of the directory path as fallback
  let hash = 0;
  const str = cwd.toLowerCase();
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Gets the session directory for the current project.
 */
export function getSessionDir(): string {
  const projectHash = getProjectHash();
  return join(SESSIONS_DIR, projectHash);
}

/**
 * Ensures the session directory exists.
 */
export function ensureSessionDir(): string {
  const sessionDir = getSessionDir();
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

/**
 * Gets the directory for a specific session.
 */
export function getSessionDataDir(sessionId: string): string {
  const sessionDir = ensureSessionDir();
  return join(sessionDir, sessionId);
}

/**
 * Ensures a specific session's data directory exists.
 */
export function ensureSessionDataDir(sessionId: string): string {
  const sessionDataDir = getSessionDataDir(sessionId);
  if (!existsSync(sessionDataDir)) {
    mkdirSync(sessionDataDir, { recursive: true });
  }
  return sessionDataDir;
}

/**
 * Gets the deleted sessions archive directory.
 */
export function getDeletedDir(): string {
  const sessionDir = ensureSessionDir();
  const deletedDir = join(sessionDir, ".deleted");
  if (!existsSync(deletedDir)) {
    mkdirSync(deletedDir, { recursive: true });
  }
  return deletedDir;
}

/**
 * Gets the current git HEAD commit.
 */
export function getCurrentGitCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: process.cwd(), encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Checks if the git working tree is clean (no uncommitted changes).
 */
export function isGitWorkingTreeClean(): boolean {
  try {
    const output = execSync("git status --porcelain", { cwd: process.cwd(), encoding: "utf-8" });
    return output.trim().length === 0;
  } catch {
    // If git command fails, assume clean (not a git repo)
    return true;
  }
}
