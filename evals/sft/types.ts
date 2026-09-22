// evals/sft/types.ts
//
// Shapes for the executor fine-tuning dataset.
//
// THE CONTRACT THIS FILE ENCODES, and why it is not the one in
// specs/010-sft-dataset.md:
//
// That document says the correct output is `toolName` + `input`, and calls
// `{"name": ..., "arguments": ...}` a "LOSER". That is backwards. `toolName`/
// `input` is the AI SDK's INTERNAL representation — it never reaches the
// model. What the model actually emits is decided by its chat template, and
// qwen3:4b's template (read from a live server via /api/show) requires:
//
//     <tool_call>
//     {"name": "writeFile", "arguments": {"path": "...", "contents": "..."}}
//     </tool_call>
//
// Training against the old document would teach a format Ollama cannot parse.
//
// So records here store the neutral OpenAI message shape — which is what
// HuggingFace's apply_chat_template consumes — and rendering to any specific
// template is a separate, late step. One dataset, any base model.
//
// Two more template facts that shape these types:
//   - Tool schemas are injected INTO THE SYSTEM BLOCK as <tools>...</tools>,
//     so `system` and `tools` share one budget. That is why the 4096 num_ctx
//     default was so damaging, and why token length is a validated property.
//   - Tool results render as role "user" inside <tool_response>, not as a
//     distinct role. We still store role "tool"; the template does that
//     translation, and encoding it here would lock the data to one model.

import type { Fixture } from "../types.js";

// ─── Bands ───────────────────────────────────────────────────────────────────

/**
 * What a group of scenarios is teaching.
 *
 * Weighted toward observed failures rather than spread evenly over tools —
 * see specs/010-sft-dataset.md for the counts and the reasoning behind them.
 */
export type Band =
  /** read → editFile with a verbatim old_string. The core loop. */
  | "single-edit"
  /** writeFile after looking, exercising FILE PLACEMENT and EDIT-DON'T-RECREATE. */
  | "create-in-place"
  /** grep/glob first, because the edit is not expressible without it. */
  | "search-then-act"
  /** One symbol across several files — tests not stopping after the first. */
  | "multi-file"
  /** A REAL failure followed by the correct recovery. */
  | "recovery"
  /** runBash, runBackground, manageTasks, managePorts. */
  | "shell-process"
  /** fileOperations delete / createDirectory / copy / move. */
  | "fs-ops"
  /** Genuinely underspecified — answer in one sentence, call nothing. */
  | "blocked"
  /** An ordinary question. Guards against reaching for a tool to answer prose. */
  | "no-tool-chat";

export const BANDS: Band[] = [
  "single-edit",
  "create-in-place",
  "search-then-act",
  "multi-file",
  "recovery",
  "shell-process",
  "fs-ops",
  "blocked",
  "no-tool-chat",
];

// ─── Scenario authoring ──────────────────────────────────────────────────────

/**
 * One tool call the executor should make, as the scenario author writes it.
 *
 * `args` is a plain object here for readability; the generator serializes it
 * and the validator checks it against the live Zod schema, so a typo in a
 * field name fails the build rather than reaching the model.
 */
export interface ScenarioStep {
  tool: string;
  args: Record<string, unknown>;
  /**
   * Assistant prose accompanying this call.
   *
   * Usually absent. The executor's contract is to act, not narrate, and the
   * system prompt says text is "for conversation, explanations, and status
   * updates ONLY" — so prose on a tool call is the exception, used where a
   * shell command genuinely needs explaining first.
   */
  say?: string;
  /**
   * Set when this call is EXPECTED to fail, e.g. an editFile whose old_string
   * matches twice.
   *
   * The generator asserts the failure actually happened. A "recovery" scenario
   * whose failing step silently starts succeeding is no longer teaching
   * recovery, and that regression is invisible without this flag.
   */
  expectFailure?: boolean;
}

/**
 * One training example before its tool results exist.
 *
 * The author supplies the fixture, the request, and the calls. The generator
 * supplies the results BY RUNNING THE REAL TOOLS — see generate.ts for why
 * hand-written tool output is the thing most worth designing out.
 */
export interface Scenario {
  /** Stable id. Also the split key, so variants never straddle train/val. */
  id: string;
  band: Band;
  /** The user's message — what a person would actually type. */
  prompt: string;
  /** Files written into a fresh workspace before the run. */
  fixture?: Fixture;
  /**
   * Initialize the workspace as a git repo with one commit.
   *
   * Required by any scenario whose steps shell out to git. Without it those
   * commands fail with "not a git repository" — which the generator catches
   * as an unexpected failure rather than recording, because a training set
   * full of fatal git errors would teach the model that git never works.
   */
  git?: boolean;
  /** The calls to make, in order. Empty for `blocked` and `no-tool-chat`. */
  steps: ScenarioStep[];
  /**
   * The assistant's closing message.
   *
   * Required when there are no steps (the whole answer is prose) and
   * otherwise optional — a short summary after the work is done, which is
   * what runTurn's loop expects to terminate on.
   */
  finalText?: string;
}

// ─── Output records ──────────────────────────────────────────────────────────

/** OpenAI-shape tool call. `arguments` is a JSON STRING, as on the wire. */
export interface ToolCallMessage {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type TrainingMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; tool_calls?: ToolCallMessage[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface TrainingRecord {
  meta: {
    id: string;
    scenario: string;
    band: Band;
    /** Every tool called, in order. Used for coverage stats. */
    tools: string[];
    /** Number of messages, so length outliers are findable without parsing. */
    turns: number;
  };
  /**
   * The real executor system prompt, verbatim from buildSystemPrompt(), with
   * the workspace path normalized. Byte-identical to what the model is served
   * at inference — a dataset trained on a prompt Zizou does not send teaches
   * the model to expect a world it will never see.
   */
  system: string;
  /**
   * Tool definitions as JSON Schema, from the AI SDK's own converter. The
   * template injects these into the system block, so they are part of the
   * prompt the model must learn to read.
   */
  tools: unknown[];
  messages: TrainingMessage[];
}

/** Placeholder the workspace path is rewritten to, so paths never leak. */
export const WORKSPACE_PLACEHOLDER = "/workspace";
