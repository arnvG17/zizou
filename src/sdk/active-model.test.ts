// src/sdk/active-model.test.ts
//
// The displayed model must be the model that is actually called.
//
// THE BUG: getActiveModelId (what /model, /help and the sidebar print) and
// resolveAgentConfig().modelId (what the agent calls) fell through to two
// DIFFERENT tables when no model was explicitly pinned:
//
//   getActiveModelId  →  getProviderModel() ?? DEFAULT_MODELS[provider]
//   the runtime       →  pinned ?? modelForEffort(provider, effort)
//
// So the UI reported claude-3-5-sonnet-latest while the agent called
// claude-sonnet-4-5 — and gpt-4o-mini vs gpt-5-mini, and gemma-4-31b vs
// llama-3.3-70b. Three of six providers displayed a model never contacted.
//
// effort.ts documents this exact failure being fixed once on the execution
// path. It survived on the display path, where it is harder to notice: the
// agent works fine, it is only the label that lies.

import { test, expect } from "bun:test";
import { getActiveModelId, DEFAULT_MODELS } from "./resolve-model.js";
import { EFFORT_MODELS, EFFORT_LEVELS, modelForEffort } from "../config/effort.js";
import { resolveAgentConfig, setSessionEffort } from "../config/agent-config.js";
import { getProviderModel, type ProviderChoice } from "../config/api-keys.js";
import {
  localModelForEffort,
  setLocalCatalog,
  clearLocalCatalog,
} from "../config/local-catalog.js";

const PROVIDERS: ProviderChoice[] = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "openrouter",
  "ollama",
];

test("the displayed model matches the model the agent resolves", () => {
  // The single invariant this file exists for, checked against whatever the
  // machine is actually configured with.
  const cfg = resolveAgentConfig();
  expect(getActiveModelId(cfg.provider)).toBe(cfg.modelId);
});

test("every provider's display agrees with its runtime resolution", () => {
  const { effort } = resolveAgentConfig();

  for (const provider of PROVIDERS) {
    const pinned = getProviderModel(provider);
    const fromEffort =
      provider === "ollama" ? localModelForEffort(effort) : modelForEffort(provider, effort);
    const expected = pinned ?? fromEffort ?? DEFAULT_MODELS[provider];
    expect(getActiveModelId(provider)).toBe(expected);
  }
});

test("an explicit pin wins over the effort tier", () => {
  // Pinning a model is a statement that you want THAT model. Raising effort
  // must widen the budget without silently swapping the model out.
  for (const provider of PROVIDERS) {
    const pinned = getProviderModel(provider);
    if (!pinned) continue;
    expect(getActiveModelId(provider)).toBe(pinned);
  }
});

test("changing effort changes the displayed model for unpinned providers", () => {
  // The regression that using DEFAULT_EFFORT here would reintroduce: /effort
  // max would raise the model the agent calls while the display kept showing
  // the balanced one.
  // EFFORT_MODELS has no ollama entry by design — its catalogue is read from
  // the server, and the test above covers that path.
  const unpinned = PROVIDERS.filter(
    (p) => !getProviderModel(p) && EFFORT_MODELS[p] && EFFORT_MODELS[p].fast !== EFFORT_MODELS[p].max,
  );

  // Nothing to prove on a machine where every provider is pinned.
  if (unpinned.length === 0) return;

  const original = resolveAgentConfig().effort;
  try {
    for (const effort of EFFORT_LEVELS) {
      setSessionEffort(effort);
      for (const provider of unpinned) {
        expect(getActiveModelId(provider)).toBe(EFFORT_MODELS[provider][effort]);
      }
    }
  } finally {
    setSessionEffort(original);
  }
});

test("resolveAgentConfig and getActiveModelId track each other across efforts", () => {
  const original = resolveAgentConfig().effort;
  try {
    for (const effort of EFFORT_LEVELS) {
      setSessionEffort(effort);
      const cfg = resolveAgentConfig();
      expect(getActiveModelId(cfg.provider)).toBe(cfg.modelId);
    }
  } finally {
    setSessionEffort(original);
  }
});

test("every hosted provider in DEFAULT_MODELS has an effort tier to fall back to", () => {
  // If a provider existed in one table and not the other, the two resolutions
  // would diverge again for that provider only — the shape of the original
  // bug, one provider at a time.
  //
  // Ollama is exempt BY DESIGN and is covered by the two tests below instead:
  // its catalogue is whatever the user pulled, so it cannot be a table in the
  // source. It is read from the server into config/local-catalog.ts.
  for (const provider of Object.keys(DEFAULT_MODELS) as ProviderChoice[]) {
    if (provider === "ollama") continue;
    expect(EFFORT_MODELS[provider]).toBeDefined();
    for (const effort of EFFORT_LEVELS) {
      expect(typeof EFFORT_MODELS[provider][effort]).toBe("string");
    }
  }
});

test("ollama resolves from the local catalogue, and both resolvers agree", () => {
  // The original bug, in the one place it could still happen: a provider
  // whose model table lives on a server rather than in the source. Display
  // and runtime must read it through the same function.
  clearLocalCatalog();
  const original = resolveAgentConfig().effort;
  try {
    setLocalCatalog([
      { name: "small:1b", sizeBytes: 1, toolCapable: true },
      { name: "big:70b", sizeBytes: 100, toolCapable: true },
    ]);

    // Only meaningful when nothing is pinned — a pin legitimately wins.
    if (getProviderModel("ollama")) return;

    for (const effort of EFFORT_LEVELS) {
      setSessionEffort(effort);
      expect(getActiveModelId("ollama")).toBe(localModelForEffort(effort)!);
    }

    setSessionEffort("fast");
    expect(getActiveModelId("ollama")).toBe("small:1b");
    setSessionEffort("max");
    expect(getActiveModelId("ollama")).toBe("big:70b");
  } finally {
    setSessionEffort(original);
    clearLocalCatalog();
  }
});

test("ollama falls back to the built-in default before the catalogue is primed", () => {
  // Startup, and every session where Ollama is not running. Must degrade to
  // the default rather than resolving to nothing.
  clearLocalCatalog();
  if (getProviderModel("ollama")) return;
  expect(getActiveModelId("ollama")).toBe(DEFAULT_MODELS.ollama);
});
