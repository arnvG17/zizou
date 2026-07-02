// src/agent/debug/turn-logger.ts
//
// LAYER: agent/debug
//
// Simplified debug logging for Zizou. Writes a clean, chat-like history
// of turns, inputs, outputs, tool calls, and plan steps to zizou-debug.log.

import { writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelMessage, LanguageModel } from "ai";

export class TurnLogger {
  private logPath: string;
  private assistantText: string = "";

  constructor() {
    this.logPath = resolve(process.cwd(), "zizou-debug.log");
  }

  private append(text: string): void {
    try {
      appendFileSync(this.logPath, text + "\n", "utf-8");
    } catch {
      /* best-effort — never crash the agent loop */
    }
  }

  // ── Pre-turn snapshot ────────────────────────────────────────────────────
  writePreTurn(opts: {
    model: LanguageModel;
    history: ModelMessage[];
    systemPrompt?: string;
    maxSteps: number;
  }): void {
    const { model, history } = opts;
    
    // Find the last user message to show what the user inputted
    let lastUserMessage = "(none)";
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          lastUserMessage = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textPart = msg.content.find((p: any) => p.type === "text") as any;
          lastUserMessage = textPart?.text ?? JSON.stringify(msg.content);
        }
        break;
      }
    }

    const modelName = (model as any)?.modelId ?? (model as any)?.model ?? "unknown";

    const header = [
      "======================================================================",
      ` ZIZOU TURN START  ·  ${new Date().toISOString()}`,
      "======================================================================",
      `[MODEL]: ${modelName}`,
      `[USER]: ${lastUserMessage}`,
      "----------------------------------------------------------------------",
      ""
    ].join("\n");

    try {
      writeFileSync(this.logPath, header, "utf-8");
    } catch {
      /* best-effort */
    }
  }

  // ── Live Stream Events (Standard Mode) ──────────────────────────────────
  logStepStart(stepIndex: number): void {
    this.append(`[STEP ${stepIndex} START]`);
  }

  logStepFinish(stepIndex: number, finishReason: string, usage: any): void {
    // Kept for compatibility, no-op to reduce verbosity
  }

  logTextDelta(text: string): void {
    this.assistantText += text;
  }

  logToolCall(toolName: string, toolCallId: string, input: any): void {
    const args = JSON.stringify(input);
    this.append(`[TOOL CALL]: ${toolName}(${args})`);
  }

  logToolResult(toolName: string, toolCallId: string, output: any): void {
    let resultString = JSON.stringify(output);
    if (resultString.length > 800) {
      resultString = resultString.slice(0, 800) + " ... (truncated)";
    }
    this.append(`[TOOL RESULT]: ${toolName} -> ${resultString}`);
  }

  logToolError(toolName: string, toolCallId: string, error: any): void {
    this.append(`[TOOL ERROR]: ${toolName} -> ${String(error)}`);
  }

  logFinish(finishReason: string, usage: any): void {
    if (this.assistantText.trim().length > 0) {
      this.append(`[ASSISTANT]:\n${this.assistantText.trim()}\n`);
      this.assistantText = "";
    }
    if (usage) {
      this.append(`[TOKENS]: Input: ${usage.inputTokens ?? 0}, Output: ${usage.outputTokens ?? 0}`);
    }
  }

  // ── Fallback Parser (Standard Mode) ──────────────────────────────────────
  logFallbackIntercept(toolName: string): void {
    this.append(`[FALLBACK]: Intercepted raw JSON tool call for "${toolName}"`);
  }

  logFallbackExecTime(ms: number): void {
    // Kept for compatibility
  }

  logFallbackExecError(error: string): void {
    this.append(`[FALLBACK ERROR]: ${error}`);
  }

  logFallbackRecurse(maxSteps: number): void {
    this.append(`[FALLBACK RECURSE]: Continuing with maxSteps=${maxSteps}`);
  }

  logFallbackCombinedUsage(inputTokens: number, outputTokens: number): void {
    this.append(`[FALLBACK TOKENS]: Combined usage: Input: ${inputTokens}, Output: ${outputTokens}`);
  }

  // ── Plan Mode Events ────────────────────────────────────────────────────
  logPlanCreated(plan: any[]): void {
    this.append("[PLAN CREATED]:");
    plan.forEach((item) => {
      const deps = item.dependsOn && item.dependsOn.length > 0 ? ` (depends on: ${item.dependsOn.join(", ")})` : "";
      this.append(`  - [${item.id}] ${item.action} on "${item.target}"${deps}`);
      this.append(`    Spec: ${item.spec}`);
    });
    this.append("");
  }

  logPlanItemStarted(item: any): void {
    this.append(`[PLAN STEP START]: [${item.id}] ${item.action} on "${item.target}"`);
    this.append(`  Spec: ${item.spec}`);
  }

  logPlanItemVerified(item: any): void {
    this.append(`[PLAN STEP SUCCESS]: [${item.id}] completed and verified successfully.`);
    this.append("");
  }

  logPlanItemFailed(item: any, error: string): void {
    this.append(`[PLAN STEP FAILED]: [${item.id}] failed. Error: ${error}`);
  }

  logReplanTriggered(item: any, newPlan: any[]): void {
    this.append(`[RE-PLAN TRIGGERED]: Step [${item.id}] failed twice. Revised plan:`);
    newPlan.forEach((step) => {
      const deps = step.dependsOn && step.dependsOn.length > 0 ? ` (depends on: ${step.dependsOn.join(", ")})` : "";
      this.append(`  - [${step.id}] ${step.action} on "${step.target}"${deps}`);
      this.append(`    Spec: ${step.spec}`);
    });
    this.append("");
  }

  // ── Turn End ─────────────────────────────────────────────────────────────
  logTurnEnd(): void {
    if (this.assistantText.trim().length > 0) {
      this.append(`[ASSISTANT]:\n${this.assistantText.trim()}\n`);
      this.assistantText = "";
    }
    this.append("======================================================================\n");
  }

  logFinalUsage(inputTokens: number, outputTokens: number): void {
    this.append(`[FINAL TOKENS]: Input: ${inputTokens}, Output: ${outputTokens}, Total: ${inputTokens + outputTokens}`);
  }
}
