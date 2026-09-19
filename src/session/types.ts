// src/session/types.ts
//
// LAYER: session/
//
// Type definitions for session persistence and registry.

import type { ModelMessage } from "ai";
import type { Mode } from "../agent/mode.js";

export interface SessionMeta {
  id: string;          // uuid
  name: string;         // user-facing, e.g. "login-feature"
  createdAt: string;
  lastActiveAt: string;
}

export interface Registry {
  activeSessionId: string | null;
  sessions: SessionMeta[];
}

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  pctUsed: number;
  cost: number;
  contextLimit: number;
}

/**
 * Current on-disk shape of a session's state.
 *
 * Bump this whenever `orchestratorState` or `currentMode` changes shape.
 * Sessions written by an older version keep their conversation transcript but
 * have their orchestrator state dropped — see isCurrentSessionSchema. A
 * half-understood in-flight plan is not worth a migration; the transcript is.
 *
 * v2: mode gained "chat"; orchestrator flow moved behind a reducer.
 * v3: clarification state removed; plans carry assumptions instead.
 */
export const SESSION_SCHEMA_VERSION = 3;

export interface SessionState {
  /** Absent on sessions written before versioning existed (treated as v1). */
  schemaVersion?: number;
  conversation: ModelMessage[];
  tokenStats: TokenStats;
  log: string;  // Full UI log serialized as JSON string to avoid circular dependency
  currentMode: Mode;  // Current operating mode
  orchestratorState?: {
    pendingPlan?: any[];  // Plan steps awaiting the y/n gate
    pendingAssumptions?: string[];  // Assumptions declared for that plan
    isAwaitingPlanApproval?: boolean;
    originalPrompt?: string;
    completedStepIndices?: number[];  // Indices of steps that have been executed
  };
  pinnedFiles: string[];
  createdAt: string;
  lastActiveAt: string;
}

/** True when this session's orchestrator state can be trusted as-is. */
export function isCurrentSessionSchema(state: SessionState): boolean {
  return state.schemaVersion === SESSION_SCHEMA_VERSION;
}
