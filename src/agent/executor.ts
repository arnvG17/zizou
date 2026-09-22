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
import { unwrapToolOutput, tagToolOutput } from "./history.js";
import type { ConfirmFn } from "../tools/types.js";
import type { PlanStep, StepResult, StepDigest, ToolCall, ProjectContext } from "./types.js";
import { getActiveJournal } from "./debug/index.js";
import { wrapToolsWithTrace } from "../trace/wrap-tools.js";
import { getActiveSessionId } from "../session/registry.js";
import { randomUUID } from "node:crypto";
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
  repairContext?: string,
): string {
  let prompt = `Task: ${step.description}\n\nCall a tool to begin immediately. Do not ask clarifying questions.\nIMPORTANT: You MUST use the writeFile or editFile tools to write changes to disk. Printing file contents or code blocks as plain text in chat does NOT write files.`;

  // A repair pass. This goes FIRST, right under the task, because it is the
  // most important thing the model needs to know: the previous attempt failed
  // and here is the actual error. Burying it under the file list invites
  // another cosmetic retry of the same broken action.
  if (repairContext) {
    prompt += repairContext;
  }

  // How this step will be judged. Telling the model the success condition up
  // front is strictly better than checking it afterwards and reporting a
  // failure it was never told to avoid.
  if (step.check) {
    if (step.check.kind === "command" && step.check.command) {
      prompt += `\n\nThis step is verified by running \`${step.check.command}\`${
        step.check.cwd ? ` in ${step.check.cwd}` : ""
      } and requiring exit code 0. Run it yourself and fix anything it reports.`;
    } else if (step.check.kind === "url" && step.check.url) {
      prompt += `\n\nThis step is verified by fetching ${step.check.url}. Start the service, then confirm it with checkUrl.`;
    } else if (step.check.kind === "files" && step.check.files?.length) {
      prompt += `\n\nThis step is verified by these files existing: ${step.check.files.join(", ")}.`;
    }
  }

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
  /**
   * Groups this step's file changes with the rest of the user's request, so
   * `/undo` reverts the whole prompt rather than one plan step of it.
   */
  turnId?: string;
  /** Digests of earlier steps in the same plan. Empty/absent in build mode. */
  priorSteps?: StepDigest[];
  /** Cancels this step's LLM call when the user stops the run. */
  abortSignal?: AbortSignal;
  /**
   * Set on a repair attempt: what went wrong last time, rendered concretely
   * (the command, its exit code, the stderr tail). Absent on a first attempt.
   */
  repairContext?: string;
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
  const stepPrompt = buildStepPrompt(step, conversationHistory, priorSteps, options.repairContext);

  const journal = getActiveJournal();
  journal.phase("executor", `maxSteps=${context.maxSteps} — ${step.description}`, step.index);
  journal.prompt({ role: "executor", system: systemPrompt, user: stepPrompt, stepIndex: step.index });

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
    abortSignal: options.abortSignal,
    turnId: options.turnId,
  });

  /** Renders one labelled block for the session log, matching the existing format. */
  let result = await turn.next();
  while (!result.done) {
    const event = result.value;

    // Stream the event to the caller immediately. This is the whole point of
    // the generator: the UI renders as the model works, not after it stops.
    yield event;

    // ── Capture what the verifier needs ──────────────────────────────────
    if (event.kind === "text-delta") {
      fullResponseText += event.text;
      sawTextDelta = true;
    } else if (event.kind === "tool-call") {

      // Record the pending call so we can pair it with its result.
      pendingToolCalls.set(event.toolCallId, {
        toolName: event.toolName,
        input: event.input,
      });

      // File-modifying call: remember the path for the verifier.
      //
      // This used to ALSO snapshot the file's pre-change content here, for
      // undo. It could not work: the SDK runs execute() concurrently with
      // delivering this event, so the read raced the write it was meant to
      // precede and often captured post-change content. Undo now snapshots
      // inside execute() instead — see trace/wrap-tools.ts.
      const filePath = extractFileFromToolCall(event.toolName, event.input);
      if (filePath) {
        claimedFiles.add(filePath);
      }
    } else if (event.kind === "tool-result") {

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

    // Same map the model was offered in the first place — see tools/index.ts —
    // but WRAPPED, which it was not before.
    //
    // A bare buildToolMap() here meant a fallback-parsed call bypassed both
    // wrappers that runTurn applies: the journal never saw the call or its
    // diff, and — the real damage — neither did the trace ledger, so a file
    // written down this path was invisible to `/undo` and `/changes`. The
    // fallback path is exactly where small models do most of their writing,
    // so this was worst precisely where it mattered most.
    //
    // Wrapper order matches runTurn: trace outermost, so it sees the same
    // before-state the tool itself acts on.
    const fallbackTools = wrapToolsWithTrace(
      journal.wrapTools(buildToolMap(onConfirm)),
      { turnId: options.turnId ?? randomUUID(), sessionId: getActiveSessionId() ?? null, root: process.cwd() },
    );

    if (fallback && fallbackTools[fallback.name]) {
      const tool = fallbackTools[fallback.name];
      if (tool) {
        const toolCallId = `fallback_${Math.random().toString(36).slice(2, 9)}`;

        yield { kind: "tool-call", toolCallId, toolName: fallback.name, input: fallback.arguments };

        journal.fallbackParse(fallback.name, fullResponseText, true);

        // Record into claimedFiles for the verifier. Undo is handled by the
        // trace wrapper around execute(), not from this event stream.
        const filePath = extractFileFromToolCall(fallback.name, fallback.arguments);
        if (filePath) {
          claimedFiles.add(filePath);
        }

        let output: any;
        try {
          output = await tool.execute(fallback.arguments, { toolCallId, messages: history });
          yield { kind: "tool-result", toolCallId, toolName: fallback.name, output };
        } catch (e) {
          output = { error: String(e) };
          yield { kind: "tool-error", toolCallId, toolName: fallback.name, error: e };
        }


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
      journal.note("text-only", "model replied with text and made no tool call");
    }
  }

  const rawHistory = result.value || [];

  const updatedHistory = cleanHistoryForNextTurn(rawHistory);

  // Determine model tier based on provider
  const modelTier: "hosted" | "local" = provider === "ollama" ? "local" : "hosted";

  const finalResult: StepResult = {
    stepIndex: step.index,
    claimedFiles: Array.from(claimedFiles),
    toolCallsMade,
    conversationHistory: updatedHistory,
    modelTier,
  };

  journal.stepEnd({
    stepIndex: step.index,
    claimedFiles: finalResult.claimedFiles,
    toolNames: toolCallsMade.map((t) => t.toolName),
    text: fullResponseText,
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
        // Re-wrap in the SAME tagged shape the SDK requires. Assigning the
        // bare payload here produced a tool-result the ModelMessage schema
        // rejects, and the next request died with "Invalid prompt: The
        // messages do not match the ModelMessage[] schema."
        //
        // It only bit long sessions, because collapsing only applies to
        // rounds older than FULL_DETAIL_ROUNDS — so a short chat never
        // reached the corrupt path, and any sustained agentic run did.
        const { type } = unwrapToolOutput(part);
        return { ...part, output: tagToolOutput(collapseToolOutput(part, pathByCallId), type) };
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
  const { value: output } = unwrapToolOutput(part);
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
    case "runBackground":
    case "terminal":
    case "service": {
      const collapsed: Record<string, unknown> = {
        ...base,
        message: success ? "Command completed successfully" : "Command failed",
      };
      if (output.taskId) collapsed.taskId = output.taskId;
      if (output.name) collapsed.name = output.name;
      if (output.url) collapsed.url = output.url;
      if (output.status) collapsed.status = output.status;

      // A SUCCEEDING command's output is safe to drop — it did what it said.
      // A FAILING one is not: collapsing it to "Command failed" throws away
      // the exit code and the compiler error, leaving the model to retry
      // blind. Keep just enough to act on.
      if (!success) {
        if (output.exitCode !== undefined && output.exitCode !== null) {
          collapsed.exitCode = output.exitCode;
        }
        const detail = String(output.stderr ?? output.crashReason ?? output.output ?? "");
        if (detail) collapsed.stderr = detail.slice(-500);
      }
      return collapsed;
    }

    default:
      return { ...base, message: output.message ?? (success ? "Success" : "Failed") };
  }
}
