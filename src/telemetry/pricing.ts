// src/telemetry/pricing.ts
//
// LAYER: telemetry/
// Allowed imports: config/. Nothing from agent/, ui/, tools/, sdk/.
//
// Per-1M-token USD rates, and the deliberate decision to admit when we do not
// have one.
//
// THIS REPLACES THE TABLE IN src/tui/cost-tracker.ts, which had two problems:
//
//   1. It ended with `"default": { input: 1.0, output: 5.0 }` and fell through
//      to it for any unknown model. That is a made-up number rendered in the
//      same "$0.0421" format as a real one, with nothing to tell them apart.
//
//   2. Almost nothing the effort dial actually selects was in it. EFFORT_MODELS
//      picks claude-sonnet-4-5, gpt-5-mini, gemini-2.5-pro and so on; the table
//      knew claude-3-5-sonnet-latest and gpt-4o. So the default rate was not a
//      rare fallback, it was the common path — the displayed cost was usually
//      fiction.
//
// Here a missing rate returns null and the UI prints "unknown". A gap you can
// see is worth more than a number you cannot trust.
//
// RATES ARE POINT-IN-TIME. They are hand-maintained and go stale silently,
// which is why pricing.test.ts asserts that every model EFFORT_MODELS can
// select has an entry — a new model in the effort table fails the build until
// someone looks up what it costs. Check the provider's pricing page before
// trusting a figure here for anything that matters.

/** USD per 1M tokens. */
export interface ModelRate {
  input: number;
  output: number;
  /** Per 1M cached-input tokens, when the provider discounts them. */
  cachedInput?: number;
  /** When this rate was last checked against the provider's pricing page. */
  asOf: string;
}

const LOCAL: ModelRate = { input: 0, output: 0, asOf: "n/a" };

/**
 * Exact model id -> rate.
 *
 * Keys are matched exactly first, then by the prefix rules in RATE_PREFIXES,
 * because providers append dated suffixes (`-20250219`) and `-latest` aliases
 * to the same underlying model at the same price.
 */
const RATES: Record<string, ModelRate> = {
  // ── Anthropic ──────────────────────────────────────────────────────────
  "claude-opus-4-5": { input: 5, output: 25, cachedInput: 0.5, asOf: "2026-09" },
  "claude-sonnet-4-5": { input: 3, output: 15, cachedInput: 0.3, asOf: "2026-09" },
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1, asOf: "2026-09" },
  "claude-3-5-sonnet-latest": { input: 3, output: 15, cachedInput: 0.3, asOf: "2026-09" },
  "claude-3-5-haiku-latest": { input: 0.8, output: 4, cachedInput: 0.08, asOf: "2026-09" },

  // ── OpenAI ─────────────────────────────────────────────────────────────
  "gpt-5": { input: 1.25, output: 10, cachedInput: 0.125, asOf: "2026-09" },
  "gpt-5-mini": { input: 0.25, output: 2, cachedInput: 0.025, asOf: "2026-09" },
  "gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25, asOf: "2026-09" },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075, asOf: "2026-09" },

  // ── Google ─────────────────────────────────────────────────────────────
  "gemini-2.5-pro": { input: 1.25, output: 10, asOf: "2026-09" },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, asOf: "2026-09" },
  "gemini-2.0-flash": { input: 0.1, output: 0.4, asOf: "2026-09" },
  "gemini-1.5-pro": { input: 1.25, output: 5, asOf: "2026-09" },
  "gemini-1.5-flash": { input: 0.075, output: 0.3, asOf: "2026-09" },

  // ── Groq ───────────────────────────────────────────────────────────────
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79, asOf: "2026-09" },
  "llama-3.1-8b-instant": { input: 0.05, output: 0.08, asOf: "2026-09" },
  "gemma2-9b-it": { input: 0.2, output: 0.2, asOf: "2026-09" },

  // ── OpenRouter ─────────────────────────────────────────────────────────
  // `:free` variants are rate-limited but genuinely free, so 0 is exact here
  // rather than a stand-in for "unknown".
  "meta-llama/llama-3.1-8b-instruct:free": LOCAL,
  "meta-llama/llama-3.3-70b-instruct:free": LOCAL,
  "google/gemma-4-31b-it:free": LOCAL,
  "deepseek/deepseek-chat": { input: 0.27, output: 1.1, asOf: "2026-09" },
};

/**
 * Prefix rules, tried when an exact match fails.
 *
 * Providers ship the same model under dated ids — `claude-sonnet-4-5-20250219`
 * bills identically to `claude-sonnet-4-5`. Without this, every dated id would
 * read as unknown and the sidebar would show "unknown" for the default model.
 */
const RATE_PREFIXES: Array<[string, ModelRate]> = [
  ["claude-opus-4-5", RATES["claude-opus-4-5"]!],
  ["claude-sonnet-4-5", RATES["claude-sonnet-4-5"]!],
  ["claude-haiku-4-5", RATES["claude-haiku-4-5"]!],
  ["gpt-5-mini", RATES["gpt-5-mini"]!],
  ["gpt-5", RATES["gpt-5"]!],
  ["gemini-2.5-pro", RATES["gemini-2.5-pro"]!],
  ["gemini-2.5-flash", RATES["gemini-2.5-flash"]!],
  ["gemini-2.0-flash", RATES["gemini-2.0-flash"]!],
];

/**
 * True when the model runs on the user's own hardware, so the real cost is
 * zero rather than unknown. Ollama ids are whatever the user pulled
 * (`qwen3:4b`, `deepseek-r1:14b`), so this is decided by provider, not by id.
 */
export function isLocalProvider(provider: string): boolean {
  return provider === "ollama";
}

/**
 * The rate for a model, or null when we genuinely do not know.
 *
 * Callers must handle null by showing "unknown" — never by substituting a
 * guess. See the header for why.
 */
export function getRate(modelId: string, provider?: string): ModelRate | null {
  if (provider && isLocalProvider(provider)) return LOCAL;

  const exact = RATES[modelId];
  if (exact) return exact;

  for (const [prefix, rate] of RATE_PREFIXES) {
    if (modelId.startsWith(prefix)) return rate;
  }
  return null;
}

/** Token counts a cost can be computed from. */
export interface CostableUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

/**
 * USD for one call, or null when the model has no known rate.
 *
 * Reasoning tokens bill as output on every provider that exposes them, and
 * cached input bills at a discount where the provider offers one — counting
 * either as plain input understates a reasoning model and overstates a cached
 * one, in both cases by enough to change which model looks cheaper.
 */
export function costOf(
  modelId: string,
  usage: CostableUsage,
  provider?: string,
): number | null {
  const rate = getRate(modelId, provider);
  if (!rate) return null;

  const cached = usage.cachedInputTokens ?? 0;
  const freshInput = Math.max(0, usage.inputTokens - cached);
  const output = usage.outputTokens + (usage.reasoningTokens ?? 0);

  const cachedRate = rate.cachedInput ?? rate.input;

  return (
    (freshInput / 1_000_000) * rate.input +
    (cached / 1_000_000) * cachedRate +
    (output / 1_000_000) * rate.output
  );
}

/** `$0.0421`, or `unknown` for null. Never invents a number. */
export function formatCost(cost: number | null): string {
  if (cost === null) return "unknown";
  if (cost === 0) return "$0.0000";
  if (cost < 0.0001) return "<$0.0001";
  return `$${cost.toFixed(4)}`;
}

/** Every model id with a known rate. Used by the coverage test. */
export function knownModelIds(): string[] {
  return Object.keys(RATES);
}
