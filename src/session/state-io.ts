// src/session/state-io.ts
//
// LAYER: session/
//
// I/O operations for session state and registry.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { SessionState, Registry } from "./types.js";
import { getSessionDir, getSessionDataDir, ensureSessionDataDir, getDeletedDir } from "./storage.js";

const REGISTRY_FILE = "registry.json";
const STATE_FILE = "state.json";

/**
 * Loads the session registry from disk.
 * Returns a default empty registry if the file doesn't exist.
 */
export function loadRegistry(): Registry {
  const sessionDir = getSessionDir();
  const registryPath = join(sessionDir, REGISTRY_FILE);
  
  if (!existsSync(registryPath)) {
    return { activeSessionId: null, sessions: [] };
  }
  
  try {
    const data = readFileSync(registryPath, "utf-8");
    return JSON.parse(data) as Registry;
  } catch (error) {
    console.error("Failed to load registry:", error);
    return { activeSessionId: null, sessions: [] };
  }
}

/**
 * Saves the session registry to disk.
 */
export function saveRegistry(registry: Registry): void {
  const sessionDir = getSessionDir();
  const registryPath = join(sessionDir, REGISTRY_FILE);
  
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
}

/**
 * Loads session state from disk.
 * Returns null if the session doesn't exist or state file is missing.
 */
export function loadSessionState(sessionId: string): SessionState | null {
  const sessionDataDir = getSessionDataDir(sessionId);
  const statePath = join(sessionDataDir, STATE_FILE);
  
  if (!existsSync(statePath)) {
    return null;
  }
  
  try {
    const data = readFileSync(statePath, "utf-8");
    return JSON.parse(data) as SessionState;
  } catch (error) {
    console.error(`Failed to load session state for ${sessionId}:`, error);
    return null;
  }
}

/**
 * Saves session state to disk.
 */
export function saveSessionState(sessionId: string, state: SessionState): void {
  const sessionDataDir = ensureSessionDataDir(sessionId);
  const statePath = join(sessionDataDir, STATE_FILE);
  
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Archives a session's state file to the .deleted directory.
 */
export function archiveSessionState(sessionId: string): void {
  const sessionDataDir = getSessionDataDir(sessionId);
  const statePath = join(sessionDataDir, STATE_FILE);
  
  if (!existsSync(statePath)) {
    return;
  }
  
  const deletedDir = getDeletedDir();
  const archivePath = join(deletedDir, sessionId);
  
  if (!existsSync(archivePath)) {
    mkdirSync(archivePath, { recursive: true });
  }
  
  const archiveStatePath = join(archivePath, STATE_FILE);
  const data = readFileSync(statePath, "utf-8");
  writeFileSync(archiveStatePath, data, "utf-8");
}
