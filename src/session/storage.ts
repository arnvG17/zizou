// src/session/storage.ts
//
// LAYER: session/
//
// Storage utilities for session directory structure and project hashing.

import { join, resolve } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { getZizouDir, getProjectHash } from "../config/project-hash.js";

// Re-exported because callers in this layer already import it from here.
export { getProjectHash };

/** ~/.zizou/sessions — computed per call, not cached at module load. */
function sessionsRoot(): string {
  return join(getZizouDir(), "sessions");
}

/**
 * Gets the session directory for the current project.
 */
export function getSessionDir(): string {
  return join(sessionsRoot(), getProjectHash());
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
