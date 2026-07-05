// src/session/registry.ts
//
// LAYER: session/
//
// Session CRUD operations - create, list, switch, delete sessions.

import { randomUUID } from "crypto";
import type { SessionMeta, SessionState, TokenStats } from "./types.js";
import { loadRegistry, saveRegistry, loadSessionState, saveSessionState, archiveSessionState } from "./state-io.js";
import { getCurrentGitCommit, isGitWorkingTreeClean } from "./storage.js";
import { createSessionBranch } from "../git/git.js";
import type { ModelMessage } from "ai";

/**
 * Creates a new session with the given name.
 */
export function createSession(name: string): SessionMeta {
  const registry = loadRegistry();
  
  // Check if session name already exists
  if (registry.sessions.some(s => s.name === name)) {
    throw new Error(`Session "${name}" already exists`);
  }
  
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const baseBranch = getCurrentGitCommit();
  
  // Create git branch for this session
  let branchName: string | undefined;
  try {
    const branchInfo = createSessionBranch(name);
    branchName = branchInfo.branch;
  } catch (error) {
    // If git branch creation fails, continue without it
    // (e.g., not in a git repo)
    console.warn("Failed to create git branch for session:", error);
  }
  
  const sessionMeta: SessionMeta = {
    id: sessionId,
    name,
    createdAt: now,
    lastActiveAt: now,
    baseBranch,
    branchName,
  };
  
  // Create empty session state
  const emptyState: SessionState = {
    conversation: [],
    tokenStats: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      pctUsed: 0,
      cost: 0,
      contextLimit: 128000,
    },
    pinnedFiles: [],
    createdAt: now,
    lastActiveAt: now,
  };
  
  // Save session state
  saveSessionState(sessionId, emptyState);
  
  // Add to registry and set as active
  registry.sessions.push(sessionMeta);
  registry.activeSessionId = sessionId;
  saveRegistry(registry);
  
  return sessionMeta;
}

/**
 * Lists all sessions.
 */
export function listSessions(): SessionMeta[] {
  const registry = loadRegistry();
  return registry.sessions;
}

/**
 * Switches to the session with the given name.
 * Throws if working tree is dirty or session not found.
 * Returns the switched session.
 */
export function switchSession(name: string): SessionMeta {
  const registry = loadRegistry();
  
  // Check if working tree is clean
  if (!isGitWorkingTreeClean()) {
    throw new Error(
      "Cannot switch sessions: working tree has uncommitted changes.\n" +
      "Please commit or discard changes before switching sessions."
    );
  }
  
  // Find session by name
  const session = registry.sessions.find(s => s.name === name);
  if (!session) {
    throw new Error(`Session "${name}" not found`);
  }
  
  // Set as active
  registry.activeSessionId = session.id;
  session.lastActiveAt = new Date().toISOString();
  saveRegistry(registry);
  
  return session;
}

/**
 * Deletes the session with the given name.
 * Refuses if the session is currently active.
 * Archives state.json instead of hard-deleting.
 */
export function deleteSession(name: string): void {
  const registry = loadRegistry();
  
  // Find session by name
  const sessionIndex = registry.sessions.findIndex(s => s.name === name);
  if (sessionIndex === -1) {
    throw new Error(`Session "${name}" not found`);
  }
  
  const session = registry.sessions[sessionIndex];
  
  // Refuse to delete active session
  if (registry.activeSessionId === session.id) {
    throw new Error(
      `Cannot delete active session "${name}". Switch to another session first.`
    );
  }
  
  // Archive session state
  archiveSessionState(session.id);
  
  // Remove from registry
  registry.sessions.splice(sessionIndex, 1);
  saveRegistry(registry);
}

/**
 * Gets the active session metadata, or null if no active session.
 */
export function getActiveSession(): SessionMeta | null {
  const registry = loadRegistry();
  if (!registry.activeSessionId) {
    return null;
  }
  
  return registry.sessions.find(s => s.id === registry.activeSessionId) || null;
}

/**
 * Gets the active session ID, or null if no active session.
 */
export function getActiveSessionId(): string | null {
  const registry = loadRegistry();
  return registry.activeSessionId;
}

/**
 * Loads the active session state, or null if no active session.
 */
export function loadActiveSessionState(): SessionState | null {
  const activeId = getActiveSessionId();
  if (!activeId) {
    return null;
  }
  return loadSessionState(activeId);
}

/**
 * Saves state to the active session.
 * Throws if no active session.
 */
export function saveActiveSessionState(
  conversation: ModelMessage[],
  tokenStats: TokenStats,
  pinnedFiles: string[]
): void {
  const activeId = getActiveSessionId();
  if (!activeId) {
    return; // No active session, don't save
  }
  
  const existingState = loadSessionState(activeId) || {
    conversation: [],
    tokenStats: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      pctUsed: 0,
      cost: 0,
      contextLimit: 128000,
    },
    pinnedFiles: [],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
  
  const updatedState: SessionState = {
    ...existingState,
    conversation,
    tokenStats,
    pinnedFiles,
    lastActiveAt: new Date().toISOString(),
  };
  
  saveSessionState(activeId, updatedState);
  
  // Update lastActiveAt in registry
  const registry = loadRegistry();
  const session = registry.sessions.find(s => s.id === activeId);
  if (session) {
    session.lastActiveAt = new Date().toISOString();
    saveRegistry(registry);
  }
}
