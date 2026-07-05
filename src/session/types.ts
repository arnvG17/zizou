// src/session/types.ts
//
// LAYER: session/
//
// Type definitions for session persistence and registry.

import type { ModelMessage } from "ai";

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

export interface SessionState {
  conversation: ModelMessage[];
  tokenStats: TokenStats;
  log: string;  // Full UI log serialized as JSON string to avoid circular dependency
  currentMode: "build" | "plan";  // Current operating mode
  orchestratorState?: {
    pendingPlan?: any[];  // Plan steps
    pendingClarifications?: any[];  // Clarification questions
    clarificationAnswers?: Record<string, string>;
    currentClarificationIndex?: number;
    isInClarificationFlow?: boolean;
    isAwaitingPlanApproval?: boolean;
    originalPrompt?: string;
    completedStepIndices?: number[];  // Indices of steps that have been executed
  };
  pinnedFiles: string[];
  createdAt: string;
  lastActiveAt: string;
}
