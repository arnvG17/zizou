// src/telemetry/usage.ts
//
// LAYER: telemetry/
// Allowed imports: config/, ./pricing.js. Nothing from agent/, ui/, tools/.
//
// The session's token ledger: one place every model call reports to, and the
// one place the UI reads from.
//
// WHY THIS EXISTS. Zizou makes model calls from four places:
//
//     agent/router.ts:356     classifies the prompt in auto mode
//     agent/planner.ts:271    builds the plan
//     agent/run-turn.ts       the executor loop (streamText)
//     agent/verifier.ts:482   checks the step afterwards
//
// Only the executor's usage ever reached the UI, because Chat.tsx accumulated
// `usageEntries` from the agent `finish` event and nothing else. So in plan
// mode the cost readout omitted the router call, the planner call, and one
// verifier call per step — on a ten-step plan, twelve invisible calls against
// one counted loop. The number in the sidebar was not a slight underestimate;
// it was the wrong quantity.
//
// Making the UI subscribe to a ledger that all four write to is what makes the
// displayed figure mean what it says. It also means adding a fifth call site
// later cannot silently un-count itself: the call records usage or it does not
// appear at all, and "missing" is visible as a role with zero calls.

import { costOf, formatCost, getRate, type CostableUsage } from "./pricing.js";

/** Which part of the agent spent the tokens. */
export type UsageRole = "router" | "planner" | "executor" | "verifier" | "chat";

export const USAGE_ROLES: UsageRole[] = ["router", "planner", "executor", "verifier", "chat"];

export interface UsageEvent {
  role: UsageRole;
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  /** USD, or null when the model has no known rate. */
  costUsd: number | null;
  at: number;
}

export interface RoleTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /** True when at least one call in this role had no known rate. */
  hasUnpricedCalls: boolean;
}

export interface SessionUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalReasoningTokens: number;
  totalTokens: number;
  totalCalls: number;
  /**
   * Summed USD over calls we could price.
   *
   * Read together with `unpricedCalls`: a cost of $0.12 with three unpriced
   * calls is a floor, not a total, and the UI must say so rather than
   * presenting it as complete.
   */
  costUsd: number;
  unpricedCalls: number;
  byRole: Record<UsageRole, RoleTotals>;
  /** Distinct models used, most recent first. Auto mode can mix them. */
  models: string[];
}

function emptyRole(): RoleTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    hasUnpricedCalls: false,
  };
}

function emptyUsage(): SessionUsage {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    totalReasoningTokens: 0,
    totalTokens: 0,
    totalCalls: 0,
    costUsd: 0,
    unpricedCalls: 0,
    byRole: {
      router: emptyRole(),
      planner: emptyRole(),
      executor: emptyRole(),
      verifier: emptyRole(),
      chat: emptyRole(),
    },
    models: [],
  };
}

// ─── State ───────────────────────────────────────────────────────────────────
//
// Process-wide, like the debug journal's active-journal slot, and for the same
// reason: one interactive session runs at a time and threading an accumulator
// through router -> planner -> executor -> verifier would be noise at every
// layer. Unlike the journal this IS read back, so the eval harness resets it
// per run rather than sharing it — see resetUsage().

let current: SessionUsage = emptyUsage();
const listeners = new Set<(u: SessionUsage) => void>();

/** Snapshot. Safe to hold: callers get a copy, not the live object. */
export function getSessionUsage(): SessionUsage {
  return {
    ...current,
    byRole: {
      router: { ...current.byRole.router },
      planner: { ...current.byRole.planner },
      executor: { ...current.byRole.executor },
      verifier: { ...current.byRole.verifier },
      chat: { ...current.byRole.chat },
    },
    models: [...current.models],
  };
}

/** Clears the ledger. The eval harness calls this between runs. */
export function resetUsage(): void {
  current = emptyUsage();
  notify();
}

/**
 * Subscribe to changes. Returns an unsubscribe function.
 *
 * Used by the sidebar so the token figures move as the agent works, rather
 * than only at the end of a turn.
 */
export function onUsageChange(fn: (u: SessionUsage) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  const snapshot = getSessionUsage();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch {
      // A broken listener must not break the agent loop that fed it.
    }
  }
}

/**
 * Records one model call.
 *
 * Tolerant of a partial usage object: providers differ in what they report,
 * and a missing `cachedInputTokens` should read as zero rather than NaN its
 * way into the total. Never throws — a telemetry failure must not fail a turn.
 */
export function recordUsage(input: {
  role: UsageRole;
  provider: string;
  modelId: string;
  usage: Partial<CostableUsage> | undefined | null;
}): void {
  try {
    const u = input.usage ?? {};
    const normalized: CostableUsage = {
      inputTokens: Math.max(0, u.inputTokens ?? 0),
      outputTokens: Math.max(0, u.outputTokens ?? 0),
      cachedInputTokens: Math.max(0, u.cachedInputTokens ?? 0),
      reasoningTokens: Math.max(0, u.reasoningTokens ?? 0),
    };

    // A call that reported nothing at all is still a call worth counting, but
    // it must not be priced as though it were free.
    const reportedNothing =
      normalized.inputTokens === 0 && normalized.outputTokens === 0;

    const cost = reportedNothing
      ? null
      : costOf(input.modelId, normalized, input.provider);

    const role = current.byRole[input.role] ?? current.byRole.executor;
    role.calls++;
    role.inputTokens += normalized.inputTokens;
    role.outputTokens += normalized.outputTokens;
    role.cachedInputTokens += normalized.cachedInputTokens ?? 0;
    role.reasoningTokens += normalized.reasoningTokens ?? 0;
    if (cost === null) role.hasUnpricedCalls = true;
    else role.costUsd += cost;

    current.totalCalls++;
    current.totalInputTokens += normalized.inputTokens;
    current.totalOutputTokens += normalized.outputTokens;
    current.totalCachedInputTokens += normalized.cachedInputTokens ?? 0;
    current.totalReasoningTokens += normalized.reasoningTokens ?? 0;
    current.totalTokens = current.totalInputTokens + current.totalOutputTokens;
    if (cost === null) current.unpricedCalls++;
    else current.costUsd += cost;

    if (input.modelId && !current.models.includes(input.modelId)) {
      current.models.unshift(input.modelId);
    }

    notify();
  } catch {
    // Telemetry is never load-bearing.
  }
}

/**
 * Records a call when all you have is the AI SDK model object.
 *
 * The planner and verifier are handed a resolved `LanguageModel` and are
 * forbidden by their layer rules from importing config/ to ask which provider
 * produced it. Both fields are on the model itself, so this duck-types them
 * out rather than making those layers reach for something they may not have.
 *
 * `provider` arrives from the SDK as e.g. "anthropic.messages" or
 * "openai.chat"; only the segment before the dot names the vendor, and that is
 * what the local-provider and pricing checks expect.
 */
export function recordModelUsage(
  role: UsageRole,
  model: unknown,
  usage: Partial<CostableUsage> | undefined | null,
): void {
  const m = model as { modelId?: string; provider?: string } | string | undefined;
  const modelId = typeof m === "string" ? m : (m?.modelId ?? "unknown");
  const rawProvider = typeof m === "string" ? "unknown" : (m?.provider ?? "unknown");
  const provider = rawProvider.split(".")[0] ?? "unknown";
  recordUsage({ role, provider, modelId, usage });
}

/**
 * How the cost should be rendered given what we could and could not price.
 *
 * A bare "$0.0412" when two calls were unpriced claims a completeness the
 * number does not have, so this returns a marked form instead.
 */
export function formatSessionCost(usage: SessionUsage): string {
  if (usage.totalCalls === 0) return "$0.0000";
  if (usage.unpricedCalls === 0) return formatCost(usage.costUsd);
  if (usage.costUsd === 0) return "unknown";
  return `>${formatCost(usage.costUsd)}`;
}

/** True when every call so far had a known rate. */
export function costIsComplete(usage: SessionUsage): boolean {
  return usage.unpricedCalls === 0;
}

/** Whether we can price this model at all — for a "pricing unknown" hint. */
export function modelIsPriced(modelId: string, provider?: string): boolean {
  return getRate(modelId, provider) !== null;
}
