// src/config/effort.ts
//
// LAYER: config/
//
// ONE dial for how hard the agent should work.
//
// Effort sets the model, the sampling parameters, AND how many tool rounds
// the agent gets — because those are the same decision. This replaces two
// dials that had to be kept in sync by hand:
//
//   /expert fast|balanced|high|testing   (model + temperature + maxOutputTokens)
//   /context light|default|max           (how much repo map to paste in)
//
// Asking for a fast run and separately asking for less context was busywork,
// and the two could contradict each other ("fast" with "max" context).
//
// /context was doubly pointless: the budget was consumed as a boolean
// (`budget !== "light"`), so "default" and "max" produced byte-identical
// prompts.
//
// Two things the old preset system claimed to do but did not:
//   - The preset's model never reached the runtime. Chat.tsx resolved the
//     model from the api-keys store that /model writes, so `/expert fast` told
//     you it had switched to a small model while the agent kept using whatever
//     /model had set. Effort profiles are read by resolveModel directly.
//   - `reasoning: low|medium|high` was stored, displayed, and settable via two
//     commands, and read by nothing whatsoever. It is gone. If per-provider
//     reasoning controls are wired up later they belong in EFFORT_PROFILES,
//     where they will actually be plumbed through.
//
// DEPENDENCY DIRECTION: imports nothing from the project.

/** How hard to work. The only speed/quality dial the user sets. */
export type Effort = "fast" | "balanced" | "max";

export const EFFORT_LEVELS: Effort[] = ["fast", "balanced", "max"];

export interface EffortProfile {
  /** Sampling temperature. Lower as effort rises — more effort, less guessing. */
  temperature: number;
  /** Cap on output tokens per response. */
  maxOutputTokens: number;
  /**
   * Cap on tool-call rounds per turn — how much looking the agent may do
   * before it must commit to an answer.
   *
   * THIS IS HOW EFFORT CONTROLS CONTEXT NOW. It used to set a "context
   * budget" that decided whether a pre-computed repo map was pasted into the
   * prompt. That map is gone (see context/build-system-prompt.ts); both the
   * planner and executor discover the codebase with glob/grep/readFile. So
   * the meaningful lever is no longer how big a blob we paste, it is how many
   * searches the model is allowed before answering.
   *
   * Each step is a model round trip, so this bounds latency and cost directly.
   */
  maxSteps: number;
  /** One line shown by /help and /effort. */
  description: string;
}

export const EFFORT_PROFILES: Record<Effort, EffortProfile> = {
  fast: {
    temperature: 0.2,
    maxOutputTokens: 1024,
    maxSteps: 6,
    description: "Small model, little searching. Quick edits and questions.",
  },
  balanced: {
    temperature: 0.2,
    maxOutputTokens: 4096,
    maxSteps: 15,
    description: "Mid model, normal searching. The default.",
  },
  max: {
    temperature: 0.1,
    maxOutputTokens: 8192,
    maxSteps: 30,
    description: "Strongest model, thorough searching. Hard or wide work.",
  },
};

/**
 * The model each provider uses at each effort level.
 *
 * Adding a provider means adding one entry here and nothing else.
 * A provider missing from this table falls back to the resolver's default
 * model, so an unknown provider degrades rather than throwing.
 */
export const EFFORT_MODELS: Record<string, Record<Effort, string>> = {
  anthropic: {
    fast: "claude-haiku-4-5",
    balanced: "claude-sonnet-4-5",
    max: "claude-opus-4-5",
  },
  openai: {
    fast: "gpt-5-mini",
    balanced: "gpt-5-mini",
    max: "gpt-5",
  },
  google: {
    fast: "gemini-2.0-flash",
    balanced: "gemini-2.5-flash",
    max: "gemini-2.5-pro",
  },
  groq: {
    fast: "llama-3.1-8b-instant",
    balanced: "llama-3.3-70b-versatile",
    max: "llama-3.3-70b-versatile",
  },
  openrouter: {
    fast: "meta-llama/llama-3.1-8b-instruct:free",
    balanced: "meta-llama/llama-3.3-70b-instruct:free",
    max: "deepseek/deepseek-chat",
  },
  // Local models are whatever the user has pulled, so effort cannot pick one
  // for them. These are the common defaults; /model overrides per provider.
  ollama: {
    fast: "qwen3:4b",
    balanced: "qwen3:4b",
    max: "qwen3:4b",
  },
};

export const DEFAULT_EFFORT: Effort = "balanced";

/** Parses user input into an Effort, or null if it isn't one. */
export function parseEffort(input: string | undefined): Effort | null {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "fast" || normalized === "f") return "fast";
  if (normalized === "balanced" || normalized === "b" || normalized === "default") return "balanced";
  if (normalized === "max" || normalized === "m" || normalized === "high") return "max";
  return null;
}

/** The model this provider uses at this effort, or null if unknown. */
export function modelForEffort(provider: string, effort: Effort): string | null {
  return EFFORT_MODELS[provider]?.[effort] ?? null;
}
