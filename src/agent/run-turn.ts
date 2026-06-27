// src/agent/run-turn.ts
//
// LAYER: agent/. This is the heart of "the agent" — the thing that
// takes a user message, talks to the LLM, runs whatever tools the model
// asks for, and keeps going until the model is done. Everything else in
// this project (the TUI, future alternative UIs) is just a way of
// SHOWING what happens here — none of the actual decision-making lives
// in the UI layer.
//
// Per HOUSE_RULES dependency direction, this file may import from
// tools/, provider/, config/ — but must NEVER import anything from ui/.
// That's what makes it possible to reuse this exact function from a
// completely different interface later (a one-shot CLI flag, a web
// backend, a VS Code extension) without rewriting the loop itself.
//
// THE BIG IDEA, restated plainly:
// The model can only output text. "Tool calling" means the model
// outputs a structured request ("call read_file with path=foo.ts"),
// your code actually runs that function, and the result gets fed back
// into the conversation as if it were the next message. streamText()
// from the AI SDK automates the back-and-forth for you (you don't have
// to manually feed results back in a loop yourself) — but it only
// automates ONE round trip's worth of "ask model -> get tool calls ->
// run them -> ask model again" per call to streamText. The `stopWhen`
// option tells the SDK how many of these internal rounds to allow
// before giving up and returning whatever it has, which is your safety
// valve against an infinite loop.

import { streamText, stepCountIs, type ModelMessage, type LanguageModel } from "ai";
import { readFile, editFile, glob, grep, createRunBashTool, type ConfirmFn } from "../tools/index.js";

// --- Event types this module emits, for whatever UI is listening ---
//
// WHY a custom event type instead of just re-exporting the AI SDK's own
// stream part types directly: the AI SDK's TextStreamPart union has ~15
// variants (tool-input-delta, reasoning-start, source, file, raw, etc)
// most of which a simple coding agent doesn't need to render differently.
// Collapsing them into a small, deliberate set here means the UI layer
// only has to handle 5 cases, not 15 — and if the AI SDK adds new event
// types in a future version, this file is the ONLY place that needs to
// learn about them; the UI doesn't need to change at all.
export type AgentEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { kind: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { kind: "tool-error"; toolCallId: string; toolName: string; error: unknown }
  | { kind: "turn-complete" };

export interface RunTurnOptions {
  /** Full conversation history so far, INCLUDING the new user message already appended. */
  history: ModelMessage[];
  /** The resolved model object from provider/ — this function doesn't care which provider it came from. */
  model: LanguageModel;
  /** Called whenever the run_bash tool wants permission before executing. */
  onConfirm: ConfirmFn;
  /**
   * Optional extra system-prompt text to prepend — this is how the
   * codebase-context system (src/context/) injects the repo map and
   * any retrieved file context, WITHOUT this file needing to know
   * anything about indexing or retrieval. Keeping that knowledge out of
   * here is what lets context/ evolve independently later (e.g. swapping
   * regex extraction for tree-sitter) without touching the agent loop.
   */
  systemPrompt?: string;
  /** Safety cap on how many internal tool-call rounds one turn may take. */
  maxSteps?: number;
}

/**
 * Runs one full "turn": sends the conversation to the model, streams
 * back text and tool activity as it happens via the async generator,
 * and returns the updated history (with the assistant's response,
 * including any tool calls/results, appended) once the turn is done.
 *
 * This is an async GENERATOR (uses `yield`, called with `for await`)
 * rather than a function that returns a Promise, specifically so a UI
 * can render text as it streams in token by token instead of waiting
 * for the whole response before showing anything.
 */
export async function* runTurn(
  options: RunTurnOptions
): AsyncGenerator<AgentEvent, ModelMessage[]> {
  const { history, model, onConfirm, systemPrompt, maxSteps = 15 } = options;

  const result = streamText({
    model,
    system: systemPrompt,
    tools: {
      readFile,
      editFile,
      glob,
      grep,
      runBash: createRunBashTool(onConfirm),
    },
    // stepCountIs(N): allow up to N internal "model asks for a tool ->
    // we run it -> model sees the result -> model asks again" rounds
    // before the SDK stops automatically, even if the model would have
    // kept calling tools forever. Without this, a model stuck in a
    // confused loop (e.g. repeatedly re-reading a file expecting a
    // different answer) could burn unbounded API calls.
    stopWhen: stepCountIs(maxSteps),
    messages: history,
  });

  // fullStream interleaves EVERYTHING in real time order: text chunks,
  // tool calls, tool results, step boundaries. We only forward the
  // subset that's useful to render, per the AgentEvent design above.
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      yield { kind: "text-delta", text: part.text };
    } else if (part.type === "tool-call") {
      yield {
        kind: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      };
    } else if (part.type === "tool-result") {
      yield {
        kind: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: part.output,
      };
    } else if (part.type === "tool-error") {
      // Distinct from tool-result: this fires when the tool's execute()
      // function itself THREW (a bug in the tool, not a normal "success:
      // false" return value, which is still a tool-result). Our own
      // tools in tools/ are written to never throw — they always
      // return { success: false, error } as data — but a future tool
      // someone adds might not follow that convention, so this case
      // needs to be handled rather than silently swallowed.
      yield {
        kind: "tool-error",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        error: part.error,
      };
    }
    // Other part types (reasoning-*, source, file, start-step,
    // finish-step, start, finish, abort, raw) are intentionally not
    // forwarded — see the AgentEvent comment above for why.
  }

  yield { kind: "turn-complete" };

  // CRITICAL: streamText does NOT automatically persist history —
  // verified against the installed ai@7.0.2 types.
  // In ai@7.x, `result.responseMessages` (not `result.response.messages`)
  // resolves to an array of ResponseMessage (AssistantModelMessage |
  // ToolModelMessage). We must manually append these to the running
  // history ourselves, or the next turn will have no memory of what
  // just happened.
  const responseMessages = await result.responseMessages;
  return [...history, ...responseMessages];
}
