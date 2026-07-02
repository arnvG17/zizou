// src/agent/run-turn.ts
//
// LAYER: agent/
//
// The heart of the agent — takes a user message, talks to the LLM,
// runs whatever tools the model asks for, and keeps going until the
// model is done. Everything else (the TUI, future alternative UIs)
// is just a way of SHOWING what happens here.
//
// Dependency direction: may import from tools/, sdk/, config/.
// Must NEVER import from ui/.
//
// HOW TOOL CALLING WORKS:
//   The model can only output text. "Tool calling" means the model
//   outputs a structured request ("call read_file with path=foo.ts"),
//   our code actually runs that function, and the result gets fed
//   back as the next message. streamText() from the AI SDK automates
//   the round-trips. The `stopWhen` option caps internal rounds to
//   prevent infinite loops.

import fs from "node:fs";
import path from "node:path";
import { streamText, stepCountIs, type ModelMessage, type LanguageModel } from "ai";
import {
  readFile,
  writeFile,
  editFile,
  glob,
  grep,
  listDir,
  openFile,
  addFileToContext,
  createRunBashTool,
  createRunBackgroundTool,
  manageTasks,
  managePorts,
  fileOperations,
  type ConfirmFn,
} from "../tools/index.js";
import { TurnLogger } from "./debug/index.js";
import { getContextMode } from "../config/api-keys.js";
import { runPlanMode } from "./orchestrator.js";
// ─── Event types emitted to whatever UI is listening ─────────────────────────
//
// We collapse the AI SDK's ~15 stream-part variants into 5 cases so the
// UI layer stays simple. If the SDK adds new event types later, only
// THIS file needs to learn about them.

export type PlanItem = { id: string; action: string; target: string; spec: string; dependsOn?: string[]; status: 'pending' | 'done' | 'failed' };

export type AgentEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { kind: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { kind: "tool-error"; toolCallId: string; toolName: string; error: unknown }
  | { kind: "turn-complete" }
  | { kind: "finish"; usage?: { inputTokens: number; outputTokens: number } }
  | { kind: "auto-recovered"; toolName: string; summary: string }
  | { kind: "verification-failed"; message: string }
  | { kind: "auto-continue"; message: string }
  | { kind: "plan-created"; plan: PlanItem[] }
  | { kind: "plan-item-started"; item: PlanItem }
  | { kind: "plan-item-verified"; item: PlanItem }
  | { kind: "plan-item-failed"; item: PlanItem; error: string }
  | { kind: "replan-triggered"; item: PlanItem };

// ─── Options ─────────────────────────────────────────────────────────────────

export interface RunTurnOptions {
  /** Full conversation history, INCLUDING the new user message already appended. */
  history: ModelMessage[];
  /** The resolved model from sdk/ — this function is provider-agnostic. */
  model: LanguageModel;
  /** Called whenever run_bash wants permission before executing. */
  onConfirm: ConfirmFn;
  /** Extra system-prompt text (repo map, context) injected by src/context/. */
  systemPrompt?: string;
  /** Safety cap on internal tool-call rounds per turn. */
  maxSteps?: number;
}

// ─── JSON sanitisation for small-model fallback ──────────────────────────────
//
// Small LLMs (3B) often dump unescaped literal newlines inside JSON string
// values. This state machine escapes them so JSON.parse won't crash.

function sanitizeJsonString(jsonStr: string): string {
  let inString = false;
  let escaped = false;
  let out = "";

  for (const char of jsonStr) {
    if (char === '"' && !escaped) {
      inString = !inString;
      out += char;
    } else if (char === "\\" && !escaped) {
      escaped = true;
      out += char;
    } else if (char === "\n" && inString) {
      out += "\\n";
    } else if (char === "\r" && inString) {
      out += "\\r";
    } else {
      escaped = false;
      out += char;
    }
  }
  return out;
}

// ─── Raw tool-call extraction for models that can't do native tool use ───────

function extractRawToolCall(text: string): { name: string; arguments: any, matchIndex: number, matchLength: number } | null {
  const pseudoMatch = text.match(/<function\s*\(\s*(\w+)\s*\)\s*=\s*(\{[\s\S]*?\})\s*>/);
  if (pseudoMatch) {
    try {
      const parsedArgs = JSON.parse(sanitizeJsonString(pseudoMatch[2]));
      return { name: pseudoMatch[1], arguments: parsedArgs, matchIndex: pseudoMatch.index!, matchLength: pseudoMatch[0].length };
    } catch {
      // fallback
    }
  }

  const match = text.match(/(?:```(?:json)?\s*)?(\{[\s\S]*?\})(?:\s*```)?/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(sanitizeJsonString(match[1]));
    if (parsed && typeof parsed === "object") {
      const name = parsed.name || parsed.toolName || parsed.tool;
      const args = parsed.arguments || parsed.args || parsed.input;
      if (typeof name === "string" && typeof args === "object") {
        return { name, arguments: args, matchIndex: match.index!, matchLength: match[0].length };
      }
    }
  } catch {
    // best-effort
  }
  return null;
}

// ─── Text extraction helper ──────────────────────────────────────────────────

function extractAssistantText(msg: ModelMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const textPart = msg.content.find((p: any) => p.type === "text") as any;
    return textPart?.text ?? "";
  }
  return "";
}

function isTaskShaped(text: string): boolean {
  return /(?:change|fix|create|move|refactor|split|add|delete)\b/i.test(text) || /\w+\.\w+/.test(text);
}

// ─── The agent loop ──────────────────────────────────────────────────────────
//
// Async generator: yields AgentEvents as the model streams, then returns
// the updated conversation history with the assistant's response appended.

export interface RunTurnState {
  pendingPlanItems: PlanItem[];
  autoContinueCount: number;
  itemRetries?: Record<string, number>;
}

export async function* runTurn(
  options: RunTurnOptions,
  state: RunTurnState = { pendingPlanItems: [], autoContinueCount: 0 }
): AsyncGenerator<AgentEvent, ModelMessage[]> {
  const { history, model, onConfirm, systemPrompt, maxSteps = 15 } = options;

  // Debug logger — writes verbose diagnostics to zizou-debug.log.
  const log = new TurnLogger();
  log.writePreTurn({ model, history, systemPrompt, maxSteps });

  let toolChoice: "auto" | "required" = "auto";
  const lastUserMsg = [...history].reverse().find(m => m.role === "user");
  if (lastUserMsg && typeof lastUserMsg.content === "string") {
    const lastUserIdx = history.lastIndexOf(lastUserMsg);
    const hasAssistantAfter = history.slice(lastUserIdx + 1).some(m => m.role === "assistant");
    if (!hasAssistantAfter && isTaskShaped(lastUserMsg.content)) {
      toolChoice = "required";
    }
  }

  const enhancedSystemPrompt = (systemPrompt || "") + 
    "\n\nIMPORTANT: Cap parallel tool calls to a maximum of 3 per step. Do not issue more than 3 tool calls at once. Use sequential or small-batch calls.";

  let turnDidToolCall = false;

  // ── Build the tool map ─────────────────────────────────────────────────

  const tools = {
    readFile,
    writeFile,
    editFile,
    glob,
    grep,
    listDir,
    openFile,
    addFileToContext,
    runBash: createRunBashTool(onConfirm),
    runBackground: createRunBackgroundTool(onConfirm),
    manageTasks,
    managePorts,
    fileOperations,
  };

  const mode = getContextMode();
  if (mode === "plan") {
    return yield* runPlanMode(history, systemPrompt || "", model, tools as any, state, log);
  }

  // ── Call the LLM ───────────────────────────────────────────────────────

  const result = streamText({
    model,
    system: enhancedSystemPrompt,
    tools,
    toolChoice,
    stopWhen: stepCountIs(maxSteps),
    messages: history,
  });

  // ── Consume the live stream ────────────────────────────────────────────
  //
  // fullStream interleaves everything in real-time: text chunks, tool
  // calls, tool results, step boundaries. We forward only the subset
  // that the UI needs to render.

  let stepIndex = 0;

  for await (const part of result.fullStream) {
    const p = part as any;
    switch (p.type) {
      case "step-start":
        stepIndex++;
        log.logStepStart(stepIndex);
        break;

      case "step-finish":
        log.logStepFinish(stepIndex, p.finishReason ?? "unknown", p.usage);
        break;

      case "text-delta":
        log.logTextDelta(p.text);
        yield { kind: "text-delta", text: p.text };
        break;

      case "tool-call":
        turnDidToolCall = true;
        if (p.toolName === "writeFile" || p.toolName === "editFile") {
          const target = (p.input as any).path || (p.input as any).targetFile || (p.input as any).target;
          if (target) state.pendingPlanItems.push({ id: Math.random().toString(36).slice(2), action: p.toolName, target, spec: "", status: 'pending' });
        } else if (p.toolName === "fileOperations") {
          const ops = (p.input as any).operations || [];
          for (const op of ops) {
            const target = op.path || op.targetFile || op.target;
            if (target) state.pendingPlanItems.push({ id: Math.random().toString(36).slice(2), action: "fileOperations", target, spec: "", status: 'pending' });
          }
        }
        log.logToolCall(p.toolName, p.toolCallId, p.input);
        yield { kind: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, input: p.input };
        break;

      case "tool-result":
        log.logToolResult(p.toolName, p.toolCallId, p.output);
        yield { kind: "tool-result", toolCallId: p.toolCallId, toolName: p.toolName, output: p.output };
        break;

      case "tool-error":
        // Fires when execute() itself THREW — not a controlled { success: false } return.
        log.logToolError(p.toolName, p.toolCallId, p.error);
        yield { kind: "tool-error", toolCallId: p.toolCallId, toolName: p.toolName, error: p.error };
        break;

      case "finish":
        log.logFinish(p.finishReason ?? "unknown", p.usage);
        break;

      // Other part types (reasoning-*, source, file, start, abort, raw)
      // are intentionally not forwarded to the UI.
    }
  }

  // ── Collect response messages ──────────────────────────────────────────

  let responseMessages = await result.responseMessages;

  // ── Verification of file writing tools ─────────────────────────────────
  let verificationFailedMsg = "";
  for (const item of state.pendingPlanItems) {
    if (item.status === 'pending') {
      const fullPath = path.resolve(process.cwd(), item.target);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        if (content.trim().length > 0) {
          item.status = 'done';
        } else {
          item.status = 'failed';
          verificationFailedMsg = `writeFile for ${item.target} was not detected as executed (file is empty). Call writeFile now for ONLY this file using the native tool-calling format.`;
        }
      } else {
        item.status = 'failed';
        verificationFailedMsg = `writeFile for ${item.target} was not detected as executed. Call writeFile now for ONLY this file using the native tool-calling format.`;
      }
    }
  }

  // ── Fallback parser ────────────────────────────────────────────────────
  //
  // If the SDK didn't trigger a native tool call but a small model dumped
  // a raw JSON block in its text response, we intercept it, execute the
  // tool manually, and recursively continue the turn.

  const lastMsg = responseMessages[responseMessages.length - 1];
  let didFallback = false;

  if (lastMsg?.role === "assistant") {
    const textContent = extractAssistantText(lastMsg);
    const rawToolCall = textContent ? extractRawToolCall(textContent) : null;
    if (rawToolCall) {
      turnDidToolCall = true;
      if (rawToolCall.name === "writeFile" || rawToolCall.name === "editFile") {
        const target = rawToolCall.arguments.path || rawToolCall.arguments.targetFile || rawToolCall.arguments.target;
        if (target) state.pendingPlanItems.push({ id: Math.random().toString(36).slice(2), action: rawToolCall.name, target, spec: "", status: 'pending' });
      } else if (rawToolCall.name === "fileOperations") {
        const ops = rawToolCall.arguments.operations || [];
        for (const op of ops) {
          const target = op.path || op.targetFile || op.target;
          if (target) state.pendingPlanItems.push({ id: Math.random().toString(36).slice(2), action: "fileOperations", target, spec: "", status: 'pending' });
        }
      }
    }
    const toolDef = rawToolCall ? (tools as any)[rawToolCall.name] : undefined;

    if (rawToolCall && toolDef) {
      didFallback = true;
      const toolCallId = `call_${Math.random().toString(36).slice(2, 9)}`;
      log.logFallbackIntercept(rawToolCall.name);

      // Emit the tool-call event
      yield { kind: "tool-call", toolCallId, toolName: rawToolCall.name, input: rawToolCall.arguments };

      // Execute the tool
      let output: any;
      let isError = false;
      const execStart = Date.now();

      try {
        output = await toolDef.execute(rawToolCall.arguments, { toolCallId, messages: history });
        log.logFallbackExecTime(Date.now() - execStart);
        yield { kind: "tool-result", toolCallId, toolName: rawToolCall.name, output };
      } catch (e) {
        isError = true;
        output = String(e);
        log.logFallbackExecError(output);
        yield { kind: "tool-error", toolCallId, toolName: rawToolCall.name, error: e };
      }

      const summaryText = `Executed ${rawToolCall.name} (auto-recovered from malformed tool-call text)`;
      yield { kind: "auto-recovered", toolName: rawToolCall.name, summary: summaryText };
      
      const cleanedText = textContent.substring(0, rawToolCall.matchIndex) + 
                          "\n[" + summaryText + "]\n" + 
                          textContent.substring(rawToolCall.matchIndex + rawToolCall.matchLength);

      // Morph the assistant message to look like a native tool call
      responseMessages[responseMessages.length - 1] = {
        role: "assistant",
        content: [
          { type: "text", text: cleanedText },
          { type: "tool-call", toolCallId, toolName: rawToolCall.name, args: rawToolCall.arguments } as any,
        ],
      };

      // Append the tool result message
      responseMessages.push({
        role: "tool",
        content: [
          { type: "tool-result", toolCallId, toolName: rawToolCall.name, result: output, isError } as any,
        ],
      });

      // Recursively continue with remaining step budget
      const remainingSteps = maxSteps - stepIndex;
      if (remainingSteps > 0) {
        log.logFallbackRecurse(remainingSteps);

        let stepUsage = { inputTokens: 0, outputTokens: 0 };
        try {
          const rawUsage = await result.usage;
          stepUsage = { inputTokens: rawUsage.inputTokens ?? 0, outputTokens: rawUsage.outputTokens ?? 0 };
        } catch {
          // ignore
        }

        const childStream = runTurn({
          ...options,
          history: [...history, ...responseMessages],
          maxSteps: remainingSteps,
        }, state);

        // Forward child events, combining token usage at the finish event
        const childIter = childStream[Symbol.asyncIterator]();
        let iterResult = await childIter.next();

        while (!iterResult.done) {
          const event = iterResult.value;

          if (event.kind === "finish") {
            const childUsage = event.usage ?? { inputTokens: 0, outputTokens: 0 };
            const combined = {
              inputTokens: stepUsage.inputTokens + childUsage.inputTokens,
              outputTokens: stepUsage.outputTokens + childUsage.outputTokens,
            };
            log.logFallbackCombinedUsage(combined.inputTokens, combined.outputTokens);
            yield { kind: "finish", usage: combined };
          } else {
            yield event;
          }

          iterResult = await childIter.next();
        }

        return iterResult.value;
      }
    }
  }

  // ── Emit turn-complete + usage (only when no fallback recursion) ───────

  if (!didFallback) {
    const isFailedVerification = !!verificationFailedMsg;
    let nextHistory = [...history, ...responseMessages];

    if (isFailedVerification) {
      yield { kind: "verification-failed", message: verificationFailedMsg };
      nextHistory.push({ role: "user", content: [{ type: "text", text: verificationFailedMsg }] });
      return yield* runTurn({ ...options, history: nextHistory, maxSteps: Math.max(1, maxSteps - stepIndex) }, state);
    } else if (!turnDidToolCall && state.autoContinueCount < 2 && lastUserMsg && typeof lastUserMsg.content === "string" && isTaskShaped(lastUserMsg.content)) {
      state.autoContinueCount++;
      const autoContinueMsg = "Proceed with the next step now using a real tool call — do not restate the plan.";
      yield { kind: "auto-continue", message: autoContinueMsg };
      nextHistory.push({ role: "user", content: [{ type: "text", text: autoContinueMsg }] });
      return yield* runTurn({ ...options, history: nextHistory, maxSteps: Math.max(1, maxSteps - stepIndex) }, state);
    }

    log.logTurnEnd();
    yield { kind: "turn-complete" };

    let usage: { inputTokens: number; outputTokens: number } | undefined;
    try {
      const raw = await result.usage;
      usage = { inputTokens: raw.inputTokens ?? 0, outputTokens: raw.outputTokens ?? 0 };
      log.logFinalUsage(usage.inputTokens, usage.outputTokens);
    } catch {
      // ignore
    }
    yield { kind: "finish", usage };
  }

  // CRITICAL: streamText does NOT persist history automatically.
  // We must append responseMessages ourselves so the next turn
  // remembers what just happened.
  return [...history, ...responseMessages];
}
