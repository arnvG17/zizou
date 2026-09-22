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
import { buildToolMap, buildReadOnlyToolMap, type ConfirmFn } from "../tools/index.js";
import { extractRawToolCall, auditResponse } from "./fallback-tool-parse.js";
import { randomUUID } from "node:crypto";
import { getActiveJournal, type RunJournal, type UsageRecord } from "./debug/index.js";
import { recordUsage } from "../telemetry/index.js";
import { wrapToolsWithTrace } from "../trace/wrap-tools.js";
import { getActiveSessionId } from "../session/registry.js";

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
  /**
   * Which tools this turn may call.
   *
   *   "full"     — every tool, including writes and shell. The default.
   *   "readonly" — readFile, glob, grep, listDir. The agent can look at
   *                anything and change nothing. Used by the ask route and by
   *                the chat route when auto mode picked it.
   *   "none"     — no tools at all. Pinned /chat, where the user asked to
   *                just talk.
   *
   * This replaced a `disableTools` boolean, which could only express "full"
   * and "none" — and a two-state flag is exactly why a question about the
   * codebase had to choose between guessing and full write access.
   */
  toolMode?: "full" | "readonly" | "none";
  /** Sampling temperature (0 = deterministic, 1 = max creative). From AIConfig. */
  temperature?: number;
  /** Maximum number of output tokens per response. From AIConfig. */
  maxOutputTokens?: number;
  /**
   * Where to record what this turn did. Defaults to the process-wide active
   * journal (set by the CLI at startup), so interactive runs are logged with
   * no plumbing. The eval harness passes one per task run instead.
   */
  journal?: RunJournal;
  /**
   * Groups every file change this turn makes into one undoable unit.
   *
   * One user prompt is one turnId, even when plan mode runs several steps to
   * satisfy it — `/undo` should undo what the user asked for, not one internal
   * step of it. Absent means this turn is not part of a larger orchestration,
   * so it still gets a group of its own.
   */
  turnId?: string;
  /** Label for this turn in the journal, e.g. "executor" or "chat". */
  journalRole?: string;
  /**
   * Cancels the turn. Aborting stops the in-flight request at the provider.
   *
   * Without this, "stopping" could only mean the UI walking away from the
   * generator while the model kept streaming and tools kept firing — the run
   * continues, invisibly, and the user's only real remedy is killing the
   * process. Cancelling has to reach the request itself.
   */
  abortSignal?: AbortSignal;
}

/** Normalizes the AI SDK's usage object into the journal's shape. */
function toUsageRecord(raw: any): UsageRecord {
  return {
    inputTokens: raw?.inputTokens ?? 0,
    outputTokens: raw?.outputTokens ?? 0,
    cachedInputTokens: raw?.cachedInputTokens ?? 0,
    reasoningTokens: raw?.reasoningTokens ?? 0,
    totalTokens: raw?.totalTokens,
  };
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
  const { history, model, provider, onConfirm, systemPrompt, maxSteps = 15, toolMode = "full", temperature, maxOutputTokens, abortSignal } = options;

  // Every file change this turn makes is grouped under this id. See trace/.
  const turnId = options.turnId ?? randomUUID();

  // Where this turn gets recorded. See debug/run-journal.ts — the journal is
  // write-only, so an absent one degrades to a no-op rather than a branch.
  const journal = options.journal ?? getActiveJournal();
  const journalRole = options.journalRole ?? "turn";
  const modelId = typeof model === "string" ? model : (model as any)?.modelId;

  // ── Duplicate tool call tracker within this turn loop ────────────────
  //
  // The guard below refuses a tool call that already failed with identical
  // arguments. That is right for editFile, where an unchanged retry is thrash.
  // It is WRONG for commands: `npm run build` after fixing the error it
  // reported has identical arguments by definition, so the guard was refusing
  // the normal shape of a fix-and-retry loop — and refusing it silently, as a
  // synthetic failure the model could only read as "the build is still broken".
  const RETRYABLE_TOOLS = new Set([
    "runBash",
    "runBackground",
    "terminal",
    "service",
    "manageTasks",
    "managePorts",
    "checkUrl",
  ]);

  const callHashes = new Map<string, { attempts: number; failed: boolean }>();

  const wrapToolForDuplicateDetection = (toolName: string, originalTool: any) => {
    if (!originalTool || typeof originalTool.execute !== "function") return originalTool;
    return {
      ...originalTool,
      execute: async (args: any, context: any) => {
        const hash = `${toolName}:${JSON.stringify(args)}`;
        const existing = callHashes.get(hash);
        if (!RETRYABLE_TOOLS.has(toolName) && existing && existing.failed && existing.attempts >= 1) {
          existing.attempts++;
          journal.duplicateBlocked(toolName, args);
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

  // "none" passes `tools: undefined` to the SDK, which is genuinely different
  // from an empty map: the model is never told tools exist at all.
  const rawTools =
    toolMode === "none"
      ? undefined
      : toolMode === "readonly"
        // canOpen: these are conversational routes (ask, and chat under
        // auto), where "open it" is an ordinary thing to say. The planner
        // builds its own strict map and does NOT come through here.
        ? buildReadOnlyToolMap({ canOpen: true })
        : buildToolMap(onConfirm);

  // Order matters. The journal wraps the OUTSIDE, so it records what the model
  // actually got back — including a duplicate-block refusal, which is a real
  // event the log should show rather than an invisible substitution.
  //
  // The TRACE wrapper goes outside the journal's. Both snapshot the filesystem
  // around execute(), and the outer one must see the same before-state the
  // tool itself will act on. Being outermost also means a duplicate-block
  // refusal never reaches it as a file change, which is correct — nothing was
  // written. Unlike the journal, this one is always on: undo cannot depend on
  // whether the user happened to set ZIZOU_DEBUG.
  const tools = rawTools
    ? wrapToolsWithTrace(
        journal.wrapTools(
          Object.fromEntries(
            Object.entries(rawTools).map(([name, toolInstance]) => [
              name,
              wrapToolForDuplicateDetection(name, toolInstance),
            ])
          )
        ),
        { turnId, sessionId: getActiveSessionId() ?? null, root: process.cwd() },
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
  //
  // This applies to every provider served through createOpenAI, not just
  // OpenAI itself. Ollama and OpenRouter go through the same client and so
  // read the same `openai` provider-options key — and they were excluded by
  // the old `provider === "openai"` check, which left the two providers most
  // likely to fire parallel calls (small local models especially) as the only
  // ones without the guard.
  const OPENAI_COMPATIBLE = new Set(["openai", "ollama", "openrouter"]);
  const providerOptions = provider !== undefined && OPENAI_COMPATIBLE.has(provider)
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
    // 8. Cancellation: aborts the request at the provider when the user
    //    presses Esc, rather than leaving it streaming into nothing.
    ...(abortSignal ? { abortSignal } : {}),
  });

  // ── Consume the live stream ────────────────────────────────────────────
  //
  // fullStream interleaves everything in real-time: text chunks, tool
  // calls, tool results, step boundaries. We forward only the subset
  // that the UI needs to render.

  let stepIndex = 0;

  /** Accumulated so the journal records the reply once, not per delta. */
  let assistantText = "";

  let rateLimitCaught = false;

  try {
    for await (const rawPart of result.fullStream) {
      const part = rawPart as any;
      switch (part.type) {
        case "step-start":
          stepIndex++;
          break;

        // One LLM round trip. Usage is journaled PER STEP and never again at
        // the end: result.usage is the sum over steps, so recording both would
        // double every token count in the totals.
        case "step-finish": {
          const stepUsage = toUsageRecord(part.usage);
          journal.llmCall({
            role: journalRole,
            modelId,
            finishReason: part.finishReason ?? "unknown",
            usage: stepUsage,
            steps: stepIndex,
          });
          // Same per-step reasoning applies here: recording result.usage as
          // well would double-count, since it is the sum over these steps.
          recordUsage({
            role: journalRole === "chat" ? "chat" : "executor",
            provider: provider ?? "unknown",
            modelId: modelId ?? "unknown",
            usage: stepUsage,
          });
          break;
        }

        case "text-delta":
          assistantText += part.text;
          yield { kind: "text-delta", text: part.text };
          break;

        // Tool calls are NOT journaled here. journal.wrapTools() records them
        // around execute() instead, which is the only place a before/after
        // filesystem snapshot is possible — see debug/run-journal.ts.
        case "tool-call":
          yield { kind: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input };
          break;

        case "tool-result":
          yield { kind: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: part.output };
          break;

        case "tool-error":
          // Fires when execute() itself THREW — not a controlled { success: false } return.
          yield { kind: "tool-error", toolCallId: part.toolCallId, toolName: part.toolName, error: part.error };
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

    // A pseudo-call sitting next to real native calls. Not recovered — the
    // native path already ran — but worth recording, because it means the model
    // is half-trusting the tool protocol.
    if (audit.nativeCalls > 0 && audit.pseudoCallDetected) {
      journal.fallbackParse("(alongside native)", textContent, false);
    }

    const rawToolCall = textContent ? extractRawToolCall(textContent) : null;
    const toolDef = rawToolCall ? (tools as any)[rawToolCall.name] : undefined;

    if (rawToolCall && toolDef) {
      didFallback = true;
      const toolCallId = `call_${Math.random().toString(36).slice(2, 9)}`;
      journal.fallbackParse(rawToolCall.name, textContent, true);

      // Emit the tool-call event
      yield { kind: "tool-call", toolCallId, toolName: rawToolCall.name, input: rawToolCall.arguments };

      // Execute the tool. toolDef came from the journal-wrapped map, so the
      // call and its file diffs are recorded by the same code path as a native
      // call — the only difference in the log is the viaFallback marker.
      let output: any;
      let isError = false;

      try {
        output = await toolDef.execute(rawToolCall.arguments, { toolCallId, messages: history });
        yield { kind: "tool-result", toolCallId, toolName: rawToolCall.name, output };
      } catch (e) {
        isError = true;
        output = String(e);
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
    journal.assistantText(assistantText);
    yield { kind: "turn-complete" };

    let usage: { inputTokens: number; outputTokens: number } | undefined;
    try {
      const raw = await result.usage;
      usage = { inputTokens: raw.inputTokens ?? 0, outputTokens: raw.outputTokens ?? 0 };
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
