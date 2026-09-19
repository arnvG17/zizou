// src/agent/executor.ts
//
// LAYER: agent/
//
// Step-scoped execution wrapper — takes a single PlanStep and executes it
// by driving the existing runTurn() agent loop with a scoped context.
//
// PURPOSE:
//   The executor is the module that actually DOES things: reads files,
//   writes code, runs commands. It receives one PlanStep at a time from
//   the orchestrator, builds a focused context for just that step, calls
//   runTurn(), and collects the results (which files were touched, which
//   tool calls were made) into a StepResult for the verifier to check.
//
// KEY DESIGN DECISIONS:
//   1. STEP-SCOPED CONTEXT: Each step gets a fresh, minimal context.
//      The system prompt includes only the step's description and target
//      files, not the full plan. This keeps the context window focused
//      and prevents the model from "wandering" into other steps.
//   2. TOOL CALL TRACKING: As the runTurn() stream emits tool-call and
//      tool-result events, the executor captures them to build the
//      claimedFiles list (from writeFile/editFile calls) and the full
//      toolCallsMade log. The verifier uses these.
//   3. BOTH MODES: The executor is used in both build mode (single step
//      from raw prompt) and plan mode (one step at a time from the plan).
//
// CONTEXT:
//   Calls buildSystemPrompt({ role: "executor" }). There is no repo map:
//   the executor FINDS what it needs with glob, grep, listDir and readFile,
//   which return what is on disk right now rather than a stale summary.
//   In build mode targetFiles is empty and the step description IS the
//   user'''s prompt, so searching is the only way it locates anything —
//   that is deliberate, not an oversight to be "fixed" by pre-loading
//   context it may not need.
//
// DEPENDENCY DIRECTION: imports from agent/run-turn.ts, agent/types.ts,
// context/. Must NOT import from ui/, config/, or provider/.

import { type LanguageModel, type ModelMessage } from "ai";
import { buildSystemPrompt, type AgentRole } from "../context/build-system-prompt.js";
import { runTurn, type AgentEvent } from "./run-turn.js";
import { extractRawToolCall } from "./fallback-tool-parse.js";
import type { ConfirmFn } from "../tools/types.js";
import type { PlanStep, StepResult, StepDigest, ToolCall, ProjectContext } from "./types.js";
import { SessionLogger } from "./debug/index.js";
import { captureFileState } from "../checkpoint/patcher.js";
import { buildToolMap } from "../tools/index.js";

// ─── Step Prompt Builder ─────────────────────────────────────────────────────
//
// Constructs the user message for the executor. This is NOT the system
// prompt — it's the "user" message that tells the model what specific
// step to execute. The system prompt comes from buildSystemPrompt().

/**
 * Extracts file paths recently referenced in conversation history from tool calls.
 * Looks at readFile, openFile, editFile, and writeFile calls to determine which
 * files the user has been working with. This resolves deictic references like
 * "that file", "edit it", "the file I just opened", etc.
 */
function extractRecentFileReferences(history?: ModelMessage[]): string[] {
  if (!history || history.length === 0) return [];

  const files = new Set<string>();
  for (const msg of history) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const anyPart = part as any;
      if (anyPart.type === "tool-call") {
        const toolName = anyPart.toolName;
        if (
          toolName === "readFile" ||
          toolName === "openFile" ||
          toolName === "editFile" ||
          toolName === "writeFile"
        ) {
          const path =
            anyPart.args?.path ??
            anyPart.args?.filePath ??
            anyPart.args?.file ??
            anyPart.input?.path ??
            anyPart.input?.filePath;
          if (typeof path === "string") {
            files.add(path);
          }
        }
      }
    }
  }
  return Array.from(files);
}

/**
 * Builds a focused user message for a single step execution.
 * Includes the step description and target files so the model knows
 * exactly what to do without needing the full plan context.
 *
 * When conversationHistory is provided (build mode), extracts recently
 * referenced files so deictic references ("that file", "edit it") resolve
 * correctly even though the executor gets a fresh prompt.
 */
export function buildStepPrompt(
  step: PlanStep,
  conversationHistory?: ModelMessage[],
  priorSteps?: StepDigest[],
): string {
  let prompt = `Task: ${step.description}\n\nCall a tool to begin immediately. Do not ask clarifying questions.\nIMPORTANT: You MUST use the writeFile or editFile tools to write changes to disk. Printing file contents or code blocks as plain text in chat does NOT write files.`;

  // What earlier steps of THIS plan already did. A few lines, not a
  // transcript: enough that the step does not recreate a file a previous
  // step wrote, or search for something already known to exist.
  if (priorSteps && priorSteps.length > 0) {
    prompt += `\n\nEarlier in this plan:\n`;
    for (const prior of priorSteps) {
      const files = prior.filesTouched.length > 0 ? prior.filesTouched.join(", ") : "no files changed";
      const flag = prior.verified ? "" : " (verification reported problems)";
      prompt += `  - Step ${prior.index + 1}: ${prior.description} → ${files}${flag}\n`;
    }
    prompt += `\nThose files already exist. Read one before editing it; do not recreate it from scratch.`;
  }

  if (step.targetFiles.length > 0) {
    prompt += `\n\nTarget files to create or modify:\n`;
    for (const file of step.targetFiles) {
      prompt += `  - ${file}\n`;
    }
    prompt += `\nFocus ONLY on the files listed above. Do not modify other files. Use writeFile or editFile tool calls for each target file.`;
  }

  // In build mode, if the step has no explicit targetFiles but prior tool calls
  // referenced files, include them as context so "that file" / "it" resolves.
  if (step.targetFiles.length === 0 && conversationHistory) {
    const recentFiles = extractRecentFileReferences(conversationHistory);
    if (recentFiles.length > 0) {
      prompt += `\n\nRecently referenced files from this conversation:\n`;
      for (const file of recentFiles) {
        prompt += `  - ${file}\n`;
      }
      prompt += `\nIf the task refers to "that file", "it", or "the file", it likely means one of the files listed above.`;
    }
  }

  return prompt;
}


// ─── File Extraction from Tool Calls ─────────────────────────────────────────
//
// Extracts the list of files the executor claims to have modified from
// the tool call stream. We look at writeFile and editFile calls specifically,
// since those are the tools that modify the filesystem.

/**
 * Checks if a tool call is a file-modifying operation and extracts the
 * target file path if so.
 */
function extractFileFromToolCall(toolName: string, input: unknown): string | null {
  // writeFile and editFile both take a "path" or "filePath" parameter
  // that tells us which file was modified.
  if (toolName === "writeFile" || toolName === "editFile") {
    if (typeof input === "object" && input !== null) {
      const obj = input as Record<string, unknown>;
      // The AI SDK tool definitions use "path" for both writeFile and editFile
      const filePath = obj.path ?? obj.filePath ?? obj.file;
      if (typeof filePath === "string") return filePath;
    }
  }
  return null;
}

// ─── Main Execute Function ───────────────────────────────────────────────────

/** Everything executeStep needs. One object so callers don't juggle seven positional args. */
export interface ExecuteStepOptions {
  /** The plan step to execute. */
  step: PlanStep;
  /** Ambient project info (root, prompt, budget). */
  context: ProjectContext;
  /** The resolved LLM to use for execution. */
  model: LanguageModel;
  /** Callback for user confirmation of shell commands and file writes. */
  onConfirm: ConfirmFn;
  /** Provider name — selects provider-specific options and the model tier. */
  provider?: string;
  /** Prior conversation, so the step prompt can resolve "that file" / "it". */
  conversationHistory?: ModelMessage[];
  /** Digests of earlier steps in the same plan. Empty/absent in build mode. */
  priorSteps?: StepDigest[];
}

/**
 * Executes a single PlanStep, STREAMING AgentEvents as they happen and
 * returning the StepResult when the step finishes.
 *
 * This is the core execution function used in both modes:
 *   - Build mode: orchestrator synthesizes a single step, calls this once.
 *   - Plan mode: orchestrator calls this for each step in dependency order.
 *
 * WHY A GENERATOR: this used to take an `onEvent` callback AND accumulate
 * every event into `StepResult.agentEvents`. Both orchestrator call sites
 * passed onEvent as undefined and replayed the accumulated array after the
 * step had already finished — so nothing reached the UI until the whole step
 * was done, and all of runTurn's streaming was thrown away. Yielding directly
 * removes the duplicate event channel and restores real streaming.
 *
 * Consume it with `yield*` to get the StepResult as the generator's return.
 */
export async function* executeStep(
  options: ExecuteStepOptions,
): AsyncGenerator<AgentEvent, StepResult> {
  const { step, context, model, onConfirm, provider, conversationHistory, priorSteps } = options;

  // The executor discovers the codebase with its own glob/grep/readFile
  // tools rather than being handed a pre-computed summary. targetFiles is
  // no longer passed here: it used to gate a repo map that no longer exists.
  const systemPrompt = await buildSystemPrompt(
    context.projectRoot,
    "executor" as AgentRole,
  );


  // Build the step-specific user message, passing conversation history
  // so it can resolve deictic references ("that file", "it") from prior turns.
  const stepPrompt = buildStepPrompt(step, conversationHistory, priorSteps);

  SessionLogger.logExecutorStepStart(step, `maxSteps=${context.maxSteps}`);
  SessionLogger.logExecutorStepLLM(systemPrompt, stepPrompt);

  // Initialize the conversation history. If conversationHistory is provided (e.g. build mode),
  // we inherit it and swap the last user message with the enriched stepPrompt.
  // Otherwise, start fresh (plan mode isolation).
  let history: ModelMessage[];
  if (conversationHistory && conversationHistory.length > 0) {
    history = [...conversationHistory];
    const lastMsg = history[history.length - 1];
    if (lastMsg && lastMsg.role === "user") {
      history[history.length - 1] = { ...lastMsg, content: stepPrompt };
    } else {
      history.push({ role: "user", content: stepPrompt });
    }
  } else {
    history = [
      { role: "user", content: stepPrompt },
    ];
  }

  // Tracking collections for building the StepResult
  const claimedFiles = new Set<string>();
  const toolCallsMade: ToolCall[] = [];
  const oldFileStates = new Map<string, string | null>();
  let fullResponseText = "";
  let sawTextDelta = false;

  // Track in-progress tool calls so we can pair call → result
  const pendingToolCalls = new Map<string, { toolName: string; input: unknown }>();

  // ── Drive the runTurn loop ─────────────────────────────────────────────
  //
  // runTurn is an async generator that yields AgentEvents. We re-yield every
  // event straight through to the caller and capture what the verifier needs
  // along the way.
  //
  // NOTE: the assistant/tool message history is NOT rebuilt here. runTurn
  // returns the canonical ModelMessage[] as its generator return value (it
  // comes from the AI SDK's own responseMessages), which is what feeds
  // cleanHistoryForNextTurn below. An earlier version reconstructed a
  // parallel `loggedHistory` from the event stream purely to mark round
  // boundaries in the debug log — ~120 lines re-deriving something the SDK
  // already hands over, and a second thing to keep correct.
  const turn = runTurn({
    history,
    model,
    provider,
    onConfirm,
    systemPrompt,
    maxSteps: context.maxSteps,
    temperature: context.temperature,
    maxOutputTokens: context.maxOutputTokens,
  });

  /** Renders one labelled block for the session log, matching the existing format. */
  const logBlock = (title: string, fields: Record<string, string>): void => {
    const body = Object.entries(fields)
      .map(([label, value]) => `    ${label.padEnd(9)}: ${value}`)
      .join("\n");
    SessionLogger.logExecutorStreamEvent(`\n  [${title}]\n${body}\n`);
  };

  /** Indents a JSON payload under its label, truncating very large outputs. */
  const indentPayload = (value: unknown, maxChars = Infinity): string => {
    let text = JSON.stringify(value, null, 2) ?? String(value);
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + "\n... (truncated)";
    }
    return "\n" + text.split("\n").map((l) => `      ${l}`).join("\n");
  };

  let result = await turn.next();
  while (!result.done) {
    const event = result.value;

    // Stream the event to the caller immediately. This is the whole point of
    // the generator: the UI renders as the model works, not after it stops.
    yield event;

    // ── Capture what the verifier and checkpointer need ──────────────────
    if (event.kind === "text-delta") {
      fullResponseText += event.text;
      sawTextDelta = true;
    } else if (event.kind === "tool-call") {
      logBlock("TOOL CALL INITIATED", {
        "Tool Name": event.toolName,
        "ID": event.toolCallId,
        "How Sent": "Sent via native JSON tool-calling protocol (function calling) in LLM API payload",
        "Arguments": indentPayload(event.input),
      });

      // Record the pending call so we can pair it with its result.
      pendingToolCalls.set(event.toolCallId, {
        toolName: event.toolName,
        input: event.input,
      });

      // File-modifying call: remember the path and its pre-change content.
      const filePath = extractFileFromToolCall(event.toolName, event.input);
      if (filePath) {
        claimedFiles.add(filePath);
        if (!oldFileStates.has(filePath)) {
          oldFileStates.set(filePath, captureFileState(filePath));
        }
      }
    } else if (event.kind === "tool-result") {
      logBlock("TOOL CALL COMPLETED", {
        "Tool Name": event.toolName,
        "ID": event.toolCallId,
        "Result": indentPayload(event.output, 2000),
      });

      const pending = pendingToolCalls.get(event.toolCallId);
      if (pending) {
        toolCallsMade.push({
          toolName: pending.toolName,
          toolCallId: event.toolCallId,
          input: pending.input,
          output: event.output,
        });
        pendingToolCalls.delete(event.toolCallId);
      }
    } else if (event.kind === "tool-error") {
      logBlock("TOOL CALL ERROR", {
        "Tool Name": event.toolName,
        "ID": event.toolCallId,
        "Error": String(event.error),
      });

      // Still record the call, with the error as its output.
      const pending = pendingToolCalls.get(event.toolCallId);
      if (pending) {
        toolCallsMade.push({
          toolName: pending.toolName,
          toolCallId: event.toolCallId,
          input: pending.input,
          output: { error: String(event.error) },
        });
        pendingToolCalls.delete(event.toolCallId);
      }
    } else if (event.kind === "finish") {
      SessionLogger.logExecutorStreamEvent(
        `\n  [LLM FINISHED GENERATION] usage=${JSON.stringify(event.usage ?? {})}\n`,
      );
    }

    result = await turn.next();
  }

  // ── Fallback: pseudo-call parser for malformed tool calls ──────────────
  //
  // If runTurn() yielded zero native tool calls but the model emitted text
  // containing a <function/...> pseudo-tag or raw JSON tool-call block,
  // we parse it, execute the tool, and record it. This only fires when
  // there were ZERO native calls — never alongside or after a successful one.

  if (toolCallsMade.length === 0 && fullResponseText.trim().length > 0) {
    const fallback = extractRawToolCall(fullResponseText);
    // Same map the model was offered in the first place — see tools/index.ts.
    const fallbackTools = buildToolMap(onConfirm);

    if (fallback && fallbackTools[fallback.name]) {
      const tool = fallbackTools[fallback.name];
      if (tool) {
        const toolCallId = `fallback_${Math.random().toString(36).slice(2, 9)}`;

        yield { kind: "tool-call", toolCallId, toolName: fallback.name, input: fallback.arguments };

        // Log initiation with FALLBACK marker
        const argsStr = JSON.stringify(fallback.arguments, null, 2);
        SessionLogger.logExecutorStreamEvent(
          `\n  [FALLBACK PSEUDO-CALL PARSED — not a native tool call]\n` +
          `    Tool Name: ${fallback.name}\n` +
          `    ID       : ${toolCallId}\n` +
          `    How Sent : Parsed from raw text via fallback pseudo-call parser\n` +
          `    Arguments:\n` +
          argsStr.split("\n").map(l => `      ${l}`).join("\n") + "\n"
        );

        // Record into claimedFiles and capture pre-execution state before executing
        const filePath = extractFileFromToolCall(fallback.name, fallback.arguments);
        if (filePath) {
          claimedFiles.add(filePath);
          if (!oldFileStates.has(filePath)) {
            oldFileStates.set(filePath, captureFileState(filePath));
          }
        }

        let output: any;
        let success = true;
        try {
          output = await tool.execute(fallback.arguments, { toolCallId, messages: history });
          yield { kind: "tool-result", toolCallId, toolName: fallback.name, output };
        } catch (e) {
          success = false;
          output = { error: String(e) };
          yield { kind: "tool-error", toolCallId, toolName: fallback.name, error: e };
        }

        // Log the full fallback interception via SessionLogger
        SessionLogger.logFallbackToolCall(
          fallback.name,
          fallback.arguments,
          output,
          fullResponseText.slice(0, 500),
          success,
        );

        toolCallsMade.push({
          toolName: fallback.name,
          toolCallId,
          input: fallback.arguments,
          output,
        });

      }
    } else {
      // Model replied with text only — no tool call, no parseable pseudo-call.
      // This is a legitimate response: a question, clarification, or explanation.
      // If the text never arrived as deltas, emit it once so the UI renders it
      // and the user can reply. Without this the text is silently swallowed.
      if (!sawTextDelta) {
        yield { kind: "text-delta", text: fullResponseText };
      }
      SessionLogger.logExecutorStreamEvent(
        `\n  [LLM TEXT-ONLY RESPONSE — no tool call made]\n` +
        `    Text: ${fullResponseText.slice(0, 300)}${fullResponseText.length > 300 ? " ... (truncated)" : ""}\n`
      );
    }
  }

  // Log the canonical exchange once, before we strip payloads for the next turn.
  const rawHistory = result.value || [];
  SessionLogger.logLLMConversation(systemPrompt, rawHistory);

  const updatedHistory = cleanHistoryForNextTurn(rawHistory);

  // Determine model tier based on provider
  const modelTier: "hosted" | "local" = provider === "ollama" ? "local" : "hosted";

  const finalResult: StepResult = {
    stepIndex: step.index,
    claimedFiles: Array.from(claimedFiles),
    toolCallsMade,
    oldFileStates,
    conversationHistory: updatedHistory,
    modelTier,
  };

  SessionLogger.logExecutorStepEnd({
    ...finalResult,
    fullResponseText,
  });

  // Return the StepResult for the verifier to check
  return finalResult;
}

/**
 * Number of recent assistant rounds whose tool results survive intact.
 *
 * The model needs full fidelity for what it is working on right now, and only
 * a receipt for what it already acted on three rounds ago. Collapsing
 * everything (the original intent) threw away detail still in use; collapsing
 * nothing let a single session grow to 144KB of state.json.
 */
export const FULL_DETAIL_ROUNDS = 3;

/** Placeholder left where a large payload used to be, so elision is visible. */
const ELIDED = "<elided from history — see the file on disk>";

/**
 * Trims large tool payloads out of older turns before the next request.
 *
 * WHY THIS WAS DOING NOTHING: it used to read `part.result` and
 * `part.args`. AI SDK v7 names those fields `output` and `input`. Every
 * lookup returned undefined, so the function stringified `undefined` into a
 * `result` field the SDK does not read, while the real `output` passed
 * through untouched by the spread. Net effect: nothing was ever trimmed, and
 * every readFile's full contents, every grep's full match list and every
 * bash command's entire stdout stayed in the context window for the rest of
 * the session — plus a junk `{success: true, message: "undefined"}` on every
 * tool result.
 *
 * Recent rounds are returned unchanged. Older ones keep the shape of what
 * happened (which tool, which file, did it work) and drop the payload.
 */
export function cleanHistoryForNextTurn(messages: ModelMessage[]): ModelMessage[] {
  const cutoff = findRecentCutoff(messages, FULL_DETAIL_ROUNDS);

  // Tool calls carry the path; the matching result does not. Pair them up so
  // a collapsed result can still say WHICH file it was about.
  const pathByCallId = new Map<string, string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content as any[]) {
      if (part.type !== "tool-call") continue;
      const input = part.input ?? part.args;
      const path = input?.path ?? input?.filePath ?? input?.file;
      if (typeof path === "string") pathByCallId.set(part.toolCallId, path);
    }
  }

  return messages.map((msg, index) => {
    if (!Array.isArray(msg.content) || index >= cutoff) return msg;

    const content = (msg.content as any[]).map((part) => {
      if (part.type === "tool-call") return collapseToolCall(part);
      if (part.type === "tool-result") {
        return { ...part, output: collapseToolOutput(part, pathByCallId) };
      }
      return part;
    });

    return { ...msg, content } as ModelMessage;
  });
}

/**
 * Index of the first message belonging to the last `keepRounds` assistant
 * rounds. Messages at or after it are left alone.
 */
function findRecentCutoff(messages: ModelMessage[], keepRounds: number): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    seen++;
    if (seen > keepRounds) return i + 1;
  }
  return 0;
}

/**
 * Drops the bulky argument from an old tool call.
 *
 * writeFile's input holds the ENTIRE new file contents. Left in place it is
 * re-sent on every subsequent request for the rest of the session, which is
 * the single largest contributor to history growth. The path and the fact of
 * the write are what later turns actually need.
 */
function collapseToolCall(part: any): any {
  if (part.toolName !== "writeFile") return part;

  const input = part.input ?? part.args;
  if (!input || typeof input !== "object" || typeof input.contents !== "string") {
    return part;
  }
  if (input.contents.length < 400) return part; // small enough to keep

  return {
    ...part,
    input: { ...input, contents: `${ELIDED} (${input.contents.length} chars written)` },
  };
}

/** Reduces an old tool result to what it accomplished, not what it returned. */
function collapseToolOutput(part: any, pathByCallId: Map<string, string>): any {
  const output = part.output ?? part.result;
  const file = pathByCallId.get(part.toolCallId) ?? "unknown";

  if (!output || typeof output !== "object") {
    return { success: !part.isError, message: String(output ?? "") };
  }

  const success = output.success !== false;
  const base: Record<string, unknown> = { success };
  if (output.error) base.error = String(output.error);

  switch (part.toolName) {
    case "readFile":
      // The contents ARE dropped here, unlike in recent rounds. An old read
      // the model has already acted on is a receipt, not a reference; if it
      // needs the file again it can read it again, and will get the current
      // version rather than a stale copy.
      return { ...base, file, message: success ? "Read file" : "Failed to read file" };

    case "writeFile":
      return { ...base, file, message: success ? "Wrote file" : "Failed to write file" };

    case "editFile":
      return { ...base, file, message: success ? "Edited file" : "Failed to edit file" };

    case "glob":
      return { ...base, matches: Array.isArray(output.files) ? output.files : [] };

    case "grep": {
      // Keep which files matched, drop the matching lines.
      const matches = Array.isArray(output.matches)
        ? [...new Set(output.matches.map((m: string) => String(m).split(":")[0]))]
        : [];
      return { ...base, matches };
    }

    case "runBash":
    case "runBackground": {
      const collapsed: Record<string, unknown> = {
        ...base,
        message: success ? "Command completed successfully" : "Command failed",
      };
      if (output.taskId) collapsed.taskId = output.taskId;
      return collapsed;
    }

    default:
      return { ...base, message: output.message ?? (success ? "Success" : "Failed") };
  }
}
