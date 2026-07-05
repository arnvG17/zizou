// src/session/storage.ts
//
// LAYER: session/
//
// Storage utilities for session directory structure and project hashing.

import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";

const ZIZOU_DIR = join(homedir(), ".zizou");
const SESSIONS_DIR = join(ZIZOU_DIR, "sessions");

/**
 * Gets the project hash for the current working directory.
 * Uses a hash of the directory path for local persistence.
 */
export function getProjectHash(): string {
  const cwd = process.cwd();
  
  // Simple hash of the directory path
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
