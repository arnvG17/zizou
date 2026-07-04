// src/agent/debug/turn-logger.ts
//
// LAYER: agent/debug
//
// All verbose debug logging for the agent loop lives here.
// SILENCED: This module is now silenced to prevent duplicate logging with SessionLogger.
// All execution phase and LLM prompts are logged via SessionLogger.

import type { ModelMessage, LanguageModel } from "ai";
import { ACTIVE_SESSION_LOG_PATH } from "./session-logger.js";

export class TurnLogger {
  private logPath: string;

  constructor() {
    this.logPath = ACTIVE_SESSION_LOG_PATH;
  }

  writePreTurn(opts: {
    model: LanguageModel;
    history: ModelMessage[];
    systemPrompt?: string;
    maxSteps: number;
  }): void {
    // Silenced - handled by SessionLogger
  }

  logStepStart(stepIndex: number): void {
    // Silenced
  }

  logStepFinish(stepIndex: number, finishReason: string, usage: unknown): void {
    // Silenced
  }

  logTextDelta(text: string): void {
    // Silenced
  }

  logToolCall(toolName: string, toolCallId: string, input: unknown): void {
    // Silenced
  }

  logToolResult(toolName: string, toolCallId: string, output: unknown): void {
    // Silenced
  }

  logToolError(toolName: string, toolCallId: string, error: unknown): void {
    // Silenced
  }

  logFinish(finishReason: string, usage: unknown): void {
    // Silenced
  }

  logFallbackIntercept(toolName: string): void {
    // Silenced
  }

  logFallbackExecTime(ms: number): void {
    // Silenced
  }

  logFallbackExecError(error: string): void {
    // Silenced
  }

  logFallbackRecurse(maxSteps: number): void {
    // Silenced
  }

  logFallbackCombinedUsage(inputTokens: number, outputTokens: number): void {
    // Silenced
  }

  logTurnEnd(): void {
    // Silenced
  }

  logFinalUsage(inputTokens: number, outputTokens: number): void {
    // Silenced
  }
}
