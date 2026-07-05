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
  baseBranch: string;   // branch/commit it forked from
  branchName?: string;  // git branch name (e.g. "zizou/login-feature")
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
  pinnedFiles: string[];
  createdAt: string;
  lastActiveAt: string;
}
