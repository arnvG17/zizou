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

// ─── Event types emitted to whatever UI is listening ─────────────────────────
//
// We collapse the AI SDK's ~15 stream-part variants into 5 cases so the
// UI layer stays simple. If the SDK adds new event types later, only
// THIS file needs to learn about them.

export type AgentEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { kind: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { kind: "tool-error"; toolCallId: string; toolName: string; error: unknown }
  | { kind: "turn-complete" }
  | { kind: "finish"; usage?: { inputTokens: number; outputTokens: number } };

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

function extractRawToolCall(text: string): { name: string; arguments: any } | null {
  const match = text.match(/(?:```(?:json)?\s*)?(\{[\s\S]*?\})(?:\s*```)?/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(sanitizeJsonString(match[1]));
    if (parsed && typeof parsed === "object" && typeof parsed.name === "string" && typeof parsed.arguments === "object") {
      return { name: parsed.name, arguments: parsed.arguments };
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

// ─── The agent loop ──────────────────────────────────────────────────────────
//
// Async generator: yields AgentEvents as the model streams, then returns
// the updated conversation history with the assistant's response appended.

export async function* runTurn(
  options: RunTurnOptions,
): AsyncGenerator<AgentEvent, ModelMessage[]> {
  const { history, model, onConfirm, systemPrompt, maxSteps = 15 } = options;

  // Debug logger — writes verbose diagnostics to zizou-debug.log.
  const log = new TurnLogger();
  log.writePreTurn({ model, history, systemPrompt, maxSteps });

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

  // ── Call the LLM ───────────────────────────────────────────────────────

  const result = streamText({
    model,
    system: systemPrompt,
    tools,
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
    switch (part.type) {
      case "step-start":
        stepIndex++;
        log.logStepStart(stepIndex);
        break;

      case "step-finish":
        log.logStepFinish(stepIndex, (part as any).finishReason ?? "unknown", (part as any).usage);
        break;

      case "text-delta":
        log.logTextDelta(part.text);
        yield { kind: "text-delta", text: part.text };
        break;

      case "tool-call":
        log.logToolCall(part.toolName, part.toolCallId, part.input);
        yield { kind: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input };
        break;

      case "tool-result":
        log.logToolResult(part.toolName, part.toolCallId, part.output);
        yield { kind: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: part.output };
        break;

      case "tool-error":
        // Fires when execute() itself THREW — not a controlled { success: false } return.
        log.logToolError(part.toolName, part.toolCallId, part.error);
        yield { kind: "tool-error", toolCallId: part.toolCallId, toolName: part.toolName, error: part.error };
        break;

      case "finish":
        log.logFinish((part as any).finishReason ?? "unknown", (part as any).usage);
        break;

      // Other part types (reasoning-*, source, file, start, abort, raw)
      // are intentionally not forwarded to the UI.
    }
  }

  // ── Collect response messages ──────────────────────────────────────────

  let responseMessages = await result.responseMessages;

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

      // Morph the assistant message to look like a native tool call
      responseMessages[responseMessages.length - 1] = {
        role: "assistant",
        content: [
          { type: "text", text: textContent },
          { type: "tool-call", toolCallId, toolName: rawToolCall.name, args: rawToolCall.arguments },
        ],
      };

      // Append the tool result message
      responseMessages.push({
        role: "tool",
        content: [
          { type: "tool-result", toolCallId, toolName: rawToolCall.name, result: output, isError },
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
        });

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
