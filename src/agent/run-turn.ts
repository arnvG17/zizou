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
  createWriteFileTool,
  createEditFileTool,
  glob,
  grep,
  listDir,
  openFile,
  addFileToContext,
  createRunBashTool,
  createRunBackgroundTool,
  manageTasks,
  managePorts,
  createFileOperationsTool,
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
  /** The provider name — used to configure provider-specific options (e.g. parallelToolCalls for OpenAI). */
  provider?: string;
  /** Called whenever run_bash wants permission before executing. */
  onConfirm: ConfirmFn;
  /** Extra system-prompt text (repo map, context) injected by src/context/. */
  systemPrompt?: string;
  /** Safety cap on internal tool-call rounds per turn. */
  maxSteps?: number;
  /** Optional flag to disable tools. */
  disableTools?: boolean;
  /** Sampling temperature (0 = deterministic, 1 = max creative). From AIConfig. */
  temperature?: number;
  /** Maximum number of output tokens per response. From AIConfig. */
  maxOutputTokens?: number;
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
//
// Handles two classes of malformed output:
//
// CLASS 1 — <function/...> pseudo-tags (observed from llama-3.3-70b via Groq):
//   <function/runBash({"command": "npm install chess.js"})</function>
//   <function/writeFile>{"path": "index.html", "contents": "..."}</function>
//   <function/runBash{"command": "npm install chess.js"}></function>
//
// CLASS 2 — Raw JSON block with name+arguments keys (small-model fallback):
//   {"name": "writeFile", "arguments": {"path": "...", "contents": "..."}}

/**
 * Attempts to extract a tool call from raw assistant text when the model
 * failed to use native function-calling. Tries <function/...> tags first,
 * then falls back to raw JSON block parsing.
 *
 * @returns { name, arguments } if a parseable pseudo-call was found, else null.
 */
export function extractRawToolCall(text: string): { name: string; arguments: any } | null {
  // ── Strategy 1: <function/NAME...> pseudo-tags ───────────────────────
  //
  // Regex captures:
  //   group 1 = function name (word chars)
  //   group 2 = the JSON-ish blob (everything between the outermost { and })
  //
  // The pattern tolerates the three observed delimiters between name and JSON:
  //   NAME(  NAME>  NAME{  (the last one has no delimiter, JSON starts immediately)
  const tagMatch = text.match(
    /<function\/(\w+)\s*[>(]?\s*(\{[\s\S]*\})\s*\)?\s*(?:<\/function>|>\s*(?:<\/function>)?)/
  );

  if (tagMatch) {
    const name = tagMatch[1];
    const parsed = tolerantJsonParse(tagMatch[2]);
    if (parsed !== null) {
      return { name, arguments: parsed };
    }
  }

  // ── Strategy 2: Raw JSON block with name + arguments keys ────────────
  const jsonMatch = text.match(/(?:```(?:json)?\s*)?(\{[\s\S]*?\})(?:\s*```)?/);
  if (jsonMatch) {
    const parsed = tolerantJsonParse(jsonMatch[1]);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.name === "string" &&
      typeof parsed.arguments === "object"
    ) {
      return { name: parsed.name, arguments: parsed.arguments };
    }
  }

  return null;
}

/**
 * Attempts JSON.parse with light repair for common LLM quirks:
 *   - Sanitizes unescaped newlines inside strings
 *   - Strips a stray trailing `)` outside the JSON
 *   - Attempts to close unclosed braces (one level only)
 */
function tolerantJsonParse(raw: string): any | null {
  // First attempt: direct parse after newline sanitization
  const sanitized = sanitizeJsonString(raw.trim());
  try {
    return JSON.parse(sanitized);
  } catch {
    // continue to repair attempts
  }

  // Repair 1: strip trailing `)` that leaks from the (JSON) wrapping
  let repaired = sanitized.replace(/\)\s*$/, "");
  try {
    return JSON.parse(repaired);
  } catch {
    // continue
  }

  // Repair 2: close one unclosed brace
  const opens = (repaired.match(/\{/g) || []).length;
  const closes = (repaired.match(/\}/g) || []).length;
  if (opens > closes) {
    repaired += "}".repeat(opens - closes);
    try {
      return JSON.parse(repaired);
    } catch {
      // give up
    }
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
  const { history, model, provider, onConfirm, systemPrompt, maxSteps = 15, disableTools, temperature, maxOutputTokens } = options;

  // Debug logger — writes verbose diagnostics to zizou-debug.log.
  const log = new TurnLogger();
  log.writePreTurn({ model, history, systemPrompt, maxSteps });

  // ── Build the tool map ─────────────────────────────────────────────────

  const tools = disableTools ? undefined : {
    readFile,
    writeFile: createWriteFileTool(onConfirm),
    editFile: createEditFileTool(onConfirm),
    glob,
    grep,
    listDir,
    openFile,
    addFileToContext,
    runBash: createRunBashTool(onConfirm),
    runBackground: createRunBackgroundTool(onConfirm),
    manageTasks,
    managePorts,
    fileOperations: createFileOperationsTool(onConfirm),
  };

  // ── Call the LLM ───────────────────────────────────────────────────────
  //
  // maxRetries: 0 disables the AI SDK's built-in retry logic.
  // WHY: The SDK default is maxRetries:2 (= 3 total attempts). On a
  // rate-limit 429, each retry resends the FULL payload (system prompt +
  // tools + history), tripling token consumption for zero benefit. We
  // surface the error immediately instead so the user can wait or switch
  // providers without burning their daily quota.

  // ── Provider-specific options ──────────────────────────────────────────
  //
  // OpenAI's default parallel tool calls cause race conditions in agentic
  // loops (e.g., writing a file while also reading it). Force sequential
  // tool execution for reliable read→write→verify behavior.
  const providerOptions = provider === "openai"
    ? { openai: { parallelToolCalls: false } }
    : undefined;

  const result = streamText({
    model,
    system: systemPrompt,
    tools,
    stopWhen: stepCountIs(maxSteps),
    messages: history,
    maxRetries: 0,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  });

  // ── Consume the live stream ────────────────────────────────────────────
  //
  // fullStream interleaves everything in real-time: text chunks, tool
  // calls, tool results, step boundaries. We forward only the subset
  // that the UI needs to render.

  let stepIndex = 0;

  let rateLimitCaught = false;

  try {
    for await (const rawPart of result.fullStream) {
      const part = rawPart as any;
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
  } catch (err: any) {
    // ── Rate-limit detection ───────────────────────────────────────────
    //
    // Detect API rate-limit errors (HTTP 429 / "Rate limit" in message)
    // and surface a clean, actionable message instead of a raw stack trace.
    // This prevents the old behavior where the SDK would silently retry 3×,
    // tripling token waste for zero benefit.
    const errMsg = String(err?.message ?? err ?? "");
    const isRateLimit =
      errMsg.includes("Rate limit") ||
      errMsg.includes("rate_limit") ||
      errMsg.includes("429") ||
      errMsg.includes("Too Many Requests") ||
      errMsg.includes("tokens per") ||
      errMsg.includes("TPD") ||
      errMsg.includes("TPM") ||
      errMsg.includes("RPM") ||
      errMsg.includes("RPD");

    if (isRateLimit) {
      rateLimitCaught = true;

      // Extract the "try again in Xm Ys" hint if present
      const waitMatch = errMsg.match(/try again in\s+([^\\.]+)/i);
      const waitHint = waitMatch ? ` Wait ${waitMatch[1].trim()}.` : "";

      const friendlyMsg =
        `⚠️  Rate limit hit — your API provider rejected this request.${waitHint}\n` +
        `Tip: Switch to a different provider/model, or wait for your quota to reset.\n` +
        `(No retries attempted — this saves your remaining token budget.)`;

      yield { kind: "text-delta", text: friendlyMsg };
    } else {
      // Re-throw non-rate-limit errors so the caller handles them normally
      throw err;
    }
  }

  // ── Early exit on rate limit ────────────────────────────────────────────
  //
  // If we caught a rate-limit error, the stream never completed — accessing
  // result.responseMessages would re-throw the same error. Bail out
  // gracefully by returning the current history unchanged.
  if (rateLimitCaught) {
    yield { kind: "turn-complete" };
    return history;
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
          { type: "tool-call", toolCallId, toolName: rawToolCall.name, input: rawToolCall.arguments } as any,
        ],
      };

      // Append the tool result message
      responseMessages.push({
        role: "tool",
        content: [
          { type: "tool-result", toolCallId, toolName: rawToolCall.name, output, isError } as any,
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
