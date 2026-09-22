// src/telemetry/telemetry.test.ts
//
// The coverage test here is the important one. Rates are hand-maintained, and
// the failure mode is not a crash — it is a plausible-looking dollar figure
// that happens to be invented. The only durable guard is to make a model the
// effort dial can select, but pricing does not know, fail the build.

import { beforeEach, describe, expect, test } from "bun:test";
import { EFFORT_LEVELS, EFFORT_MODELS } from "../config/effort.js";
import { costOf, formatCost, getRate, isLocalProvider } from "./pricing.js";
import {
  costIsComplete,
  formatSessionCost,
  getSessionUsage,
  recordModelUsage,
  recordUsage,
  resetUsage,
} from "./usage.js";

describe("pricing coverage", () => {
  test("every model the effort dial can select has a known rate", () => {
    const missing: string[] = [];

    for (const [provider, byEffort] of Object.entries(EFFORT_MODELS)) {
      // Local models are priced at zero by provider, not by id — the user's
      // ollama ids are whatever they happened to pull.
      if (isLocalProvider(provider)) continue;

      for (const effort of EFFORT_LEVELS) {
        const modelId = byEffort[effort];
        if (!modelId) continue;
        if (getRate(modelId, provider) === null) {
          missing.push(`${provider}/${effort}: ${modelId}`);
        }
      }
    }

    // If this fails, someone added a model to EFFORT_MODELS without looking up
    // what it costs. Add it to RATES in pricing.ts — do NOT delete this test.
    expect(missing).toEqual([]);
  });

  test("an unknown model yields null, never a defaulted guess", () => {
    expect(getRate("some-model-invented-tomorrow")).toBeNull();
    expect(costOf("some-model-invented-tomorrow", { inputTokens: 1e6, outputTokens: 1e6 })).toBeNull();
  });

  test("dated and -latest model ids resolve to the base model's rate", () => {
    const base = getRate("claude-sonnet-4-5");
    const dated = getRate("claude-sonnet-4-5-20250219");
    expect(dated).not.toBeNull();
    expect(dated!.input).toBe(base!.input);
  });

  test("local providers cost exactly zero, not unknown", () => {
    expect(getRate("qwen3:4b", "ollama")).toEqual({ input: 0, output: 0, asOf: "n/a" });
    expect(costOf("qwen3:4b", { inputTokens: 5e6, outputTokens: 5e6 }, "ollama")).toBe(0);
  });

  test("reasoning tokens bill as output", () => {
    const without = costOf("gpt-5", { inputTokens: 0, outputTokens: 1_000_000 })!;
    const with_ = costOf("gpt-5", {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 1_000_000,
    })!;
    expect(with_).toBeCloseTo(without, 6);
  });

  test("cached input is discounted, not billed as fresh input", () => {
    const fresh = costOf("claude-sonnet-4-5", { inputTokens: 1_000_000, outputTokens: 0 })!;
    const cached = costOf("claude-sonnet-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    })!;
    expect(cached).toBeLessThan(fresh);
    // Anthropic reads cache at a tenth of the input rate.
    expect(cached).toBeCloseTo(fresh / 10, 6);
  });

  test("formatCost never renders null as a number", () => {
    expect(formatCost(null)).toBe("unknown");
    expect(formatCost(0)).toBe("$0.0000");
    expect(formatCost(0.00001)).toBe("<$0.0001");
  });
});

describe("session usage ledger", () => {
  beforeEach(() => resetUsage());

  test("accumulates across all four roles, not just the executor", () => {
    // The exact shape of a plan-mode turn, and the exact thing the old
    // Chat.tsx accounting missed: only `executor` was ever counted.
    recordUsage({ role: "router", provider: "groq", modelId: "llama-3.1-8b-instant", usage: { inputTokens: 500, outputTokens: 10 } });
    recordUsage({ role: "planner", provider: "groq", modelId: "llama-3.3-70b-versatile", usage: { inputTokens: 4000, outputTokens: 600 } });
    recordUsage({ role: "executor", provider: "groq", modelId: "llama-3.3-70b-versatile", usage: { inputTokens: 8000, outputTokens: 900 } });
    recordUsage({ role: "verifier", provider: "groq", modelId: "llama-3.3-70b-versatile", usage: { inputTokens: 2000, outputTokens: 200 } });

    const u = getSessionUsage();
    expect(u.totalCalls).toBe(4);
    expect(u.totalInputTokens).toBe(14_500);
    expect(u.totalOutputTokens).toBe(1_710);

    // The old accounting counted the executor and nothing else. Here that is
    // 8,900 of 16,210 tokens — so the figure the sidebar used to show was
    // missing 45% of the session's real spend, on a single-step plan. The
    // shortfall grows with step count, because each step adds a verifier call.
    const executorOnly = u.byRole.executor.inputTokens + u.byRole.executor.outputTokens;
    const missed = u.totalTokens - executorOnly;
    expect(missed).toBe(7_310);
    expect(missed / u.totalTokens).toBeGreaterThan(0.4);
  });

  test("an unpriced call marks the total incomplete rather than skewing it", () => {
    recordUsage({ role: "executor", provider: "groq", modelId: "llama-3.3-70b-versatile", usage: { inputTokens: 1000, outputTokens: 100 } });
    recordUsage({ role: "planner", provider: "mystery", modelId: "unknown-model-x", usage: { inputTokens: 5000, outputTokens: 500 } });

    const u = getSessionUsage();
    expect(u.unpricedCalls).toBe(1);
    expect(costIsComplete(u)).toBe(false);
    // Tokens are still counted in full — only the cost is partial.
    expect(u.totalInputTokens).toBe(6000);
    // And the rendering says so rather than presenting a floor as a total.
    expect(formatSessionCost(u).startsWith(">")).toBe(true);
  });

  test("a call reporting no tokens is counted but not priced as free", () => {
    recordUsage({ role: "executor", provider: "groq", modelId: "llama-3.3-70b-versatile", usage: undefined });
    const u = getSessionUsage();
    expect(u.totalCalls).toBe(1);
    expect(u.unpricedCalls).toBe(1);
  });

  test("resetUsage clears everything, so eval runs do not inherit each other", () => {
    recordUsage({ role: "executor", provider: "groq", modelId: "llama-3.3-70b-versatile", usage: { inputTokens: 1000, outputTokens: 100 } });
    resetUsage();
    const u = getSessionUsage();
    expect(u.totalCalls).toBe(0);
    expect(u.totalTokens).toBe(0);
    expect(u.costUsd).toBe(0);
  });

  test("recordModelUsage strips the SDK's provider suffix", () => {
    // The SDK reports "anthropic.messages"; pricing and the local check both
    // expect the vendor segment alone.
    recordModelUsage(
      "planner",
      { modelId: "claude-sonnet-4-5", provider: "anthropic.messages" },
      { inputTokens: 1_000_000, outputTokens: 0 },
    );
    const u = getSessionUsage();
    expect(u.unpricedCalls).toBe(0);
    expect(u.costUsd).toBeCloseTo(3, 6);
  });

  test("getSessionUsage returns a copy, so callers cannot corrupt the ledger", () => {
    recordUsage({ role: "executor", provider: "groq", modelId: "llama-3.3-70b-versatile", usage: { inputTokens: 100, outputTokens: 10 } });
    const snapshot = getSessionUsage();
    snapshot.totalInputTokens = 999_999;
    snapshot.byRole.executor.calls = 42;
    expect(getSessionUsage().totalInputTokens).toBe(100);
    expect(getSessionUsage().byRole.executor.calls).toBe(1);
  });
});
