// src/tui/cost-tracker.ts
//
// LAYER: tui/
//
// Cost helpers for callers that still hold a list of usage entries.
//
// THE RATE TABLE THAT USED TO LIVE HERE IS GONE. It now lives in
// src/telemetry/pricing.ts, for two reasons:
//
//   1. There were about to be two of them. The eval harness needed the same
//      rates, and a second copy drifting from the first is how a benchmark
//      ends up pricing the same model two ways in the same report.
//
//   2. The table here ended in `"default": { input: 1.0, output: 5.0 }` and
//      silently used it for any model it did not recognise — which was most of
//      them, since it knew `gpt-4o` and `claude-3-5-sonnet-latest` while the
//      effort dial was selecting `gpt-5-mini` and `claude-sonnet-4-5`. The
//      displayed cost was usually that default: a made-up number formatted
//      exactly like a real one.
//
// These functions are kept as a thin shim so existing callers compile, but the
// honest path is src/telemetry — `getSessionUsage()` already knows about every
// call the agent made, including the router, planner and verifier ones that
// never produced a usage entry here.

import { costOf, formatCost as formatCostOrUnknown, getRate } from "../telemetry/pricing.js";

interface UsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Total USD for a list of entries, skipping any whose model has no known rate.
 *
 * Skipping rather than defaulting means the figure is a FLOOR when some models
 * are unpriced. Callers that need to say so should use
 * `telemetry.formatSessionCost`, which marks an incomplete total; this one
 * cannot, because a bare number has nowhere to carry that caveat.
 */
export function estimateCost(entries: UsageEntry[]): number {
  return entries.reduce((total, entry) => {
    const cost = costOf(entry.model, {
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
    });
    return cost === null ? total : total + cost;
  }, 0);
}

/** True when every model in the list has a known rate. */
export function costIsComplete(entries: UsageEntry[]): boolean {
  return entries.every((e) => getRate(e.model) !== null);
}

/** Formats a known cost. Use telemetry's formatCost when null is possible. */
export function formatCost(cost: number): string {
  return formatCostOrUnknown(cost);
}

/** The rate for a model, or null when unknown. Never a defaulted guess. */
export function getModelRate(model: string): { input: number; output: number } | null {
  const rate = getRate(model);
  return rate ? { input: rate.input, output: rate.output } : null;
}
