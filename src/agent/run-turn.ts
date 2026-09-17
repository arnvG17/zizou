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
import { buildToolMap, type ConfirmFn } from "../tools/index.js";
import { extractRawToolCall, auditResponse } from "./fallback-tool-parse.js";
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

  // ── Duplicate tool call tracker within this turn loop ────────────────
  const callHashes = new Map<string, { attempts: number; failed: boolean }>();

  const wrapToolForDuplicateDetection = (toolName: string, originalTool: any) => {
    if (!originalTool || typeof originalTool.execute !== "function") return originalTool;
    return {
      ...originalTool,
      execute: async (args: any, context: any) => {
        const hash = `${toolName}:${JSON.stringify(args)}`;
        const existing = callHashes.get(hash);
        if (existing && existing.failed && existing.attempts >= 1) {
          existing.attempts++;
          return {
            success: false,
            error:
              `BLOCKED: this exact call already failed once with the same arguments. ` +
              `Do not retry unchanged. Read the file again or use a different approach.`,
          };
        }

        const res = await originalTool.execute(args, context);
        const isFailed = !res || res.success === false || !!res.error;
        const attempts = (existing?.attempts ?? 0) + 1;
        callHashes.set(hash, { attempts, failed: isFailed });
        return res;
      },
    };
  };

  // ── Build the tool map ─────────────────────────────────────────────────

  const rawTools = disableTools ? undefined : buildToolMap(onConfirm);

  const tools = rawTools
    ? Object.fromEntries(
        Object.entries(rawTools).map(([name, toolInstance]) => [
          name,
          wrapToolForDuplicateDetection(name, toolInstance),
        ])
      )
    : undefined;

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
    // 1. LLM Model: The provider-agnostic model instance resolved at runtime.
    model,
    // 2. System Prompt: Dynamic system prompt compiled by buildSystemPrompt() (rules, OS, pinned files, repo map).
    system: systemPrompt,
    // 3. Tools: Native tools (readFile, writeFile, runBash, etc.) that the model can invoke.
    tools,
    // 4. Stop Safety Cap: Caps the internal tool-call/re-prompt loop to prevent infinite runaways (default 15 steps).
    stopWhen: stepCountIs(maxSteps),
    // 5. Conversation History & User Query: Full thread history with the latest user query already pre-appended.
    messages: history,
    // 6. Max Retries: Disabled (0) to prevent multiplying token costs on rate limit / 429 errors.
    maxRetries: 0,
    ...(temperature !== undefined ? { temperature } : {}),
    // NOTE: the option is `maxOutputTokens`. This used to say `maxTokens`,
    // which AI SDK v7 does not accept — so the configured output cap was
    // silently dropped on every request. The conditional spread hid it from
    // the compiler (excess-property checks don't apply to spreads).
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    // 7. Provider Options: Includes OpenAI-specific overrides (like parallelToolCalls: false to avoid race conditions).
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

    // Count native tool calls in responseMessages
    let nativeCallsCount = 0;
    for (const msg of responseMessages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ((part as any).type === "tool-call") {
            nativeCallsCount++;
          }
        }
      }
    }

    const audit = auditResponse(nativeCallsCount > 0, textContent);

    if (audit.nativeCalls > 0 && audit.pseudoCallDetected) {
      log.logFallbackIntercept(
        `[AUDIT: pseudo_call_alongside_native] nativeCalls=${nativeCallsCount}`
      );
    }

    const rawToolCall = textContent ? extractRawToolCall(textContent) : null;
    const toolDef = rawToolCall ? (tools as any)[rawToolCall.name] : undefined;

    if (rawToolCall && toolDef) {
      didFallback = true;
      const toolCallId = `call_${Math.random().toString(36).slice(2, 9)}`;
      log.logFallbackIntercept(
        `[AUDIT: pseudo_call_recovered] toolName=${rawToolCall.name}`
      );

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
