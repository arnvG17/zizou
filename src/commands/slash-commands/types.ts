import type { ModelMessage } from "ai";
import type { Dispatch, SetStateAction, MutableRefObject } from "react";

export type LogEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; thoughtDuration?: string }
  | {
      kind: "tool-call";
      toolCallId: string;
      name: string;
      input: unknown;
      output?: unknown;
      errorMessage?: string;
      startTime: number;
      duration?: string;
      status: "running" | "success" | "error";
    }
  | { kind: "error"; text: string }
  | { kind: "plan-created"; planLength: number }
  | { kind: "plan-item-started"; itemId: string; action: string; target: string }
  | { kind: "plan-item-verified"; itemId: string }
  | { kind: "plan-item-failed"; itemId: string; error: string }
  | { kind: "replan-triggered"; itemId: string };

export interface CommandContext {
  userText: string;
  history: MutableRefObject<ModelMessage[]>;
  systemPrompt: string;
  systemPromptText: string;
  onChangeKeys?: () => void;
  onContextChange: () => void;
  setLog: Dispatch<SetStateAction<LogEntry[]>>;
  setTokenStats: Dispatch<SetStateAction<any>>;
  calculateTokenStats: (
    history: ModelMessage[],
    systemPrompt: string,
    actualUsage?: { inputTokens: number; outputTokens: number },
    provider?: any
  ) => any;
}
