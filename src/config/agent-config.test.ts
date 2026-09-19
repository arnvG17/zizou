// src/config/agent-config.test.ts
//
// The effort dial's contract, and the precedence between its three sources.
//
// The bug this exists to prevent: the previous preset system chose a model,
// stored it, displayed it — and never passed it to resolveModel, which read a
// different store entirely. `/expert fast` reported switching to a small model
// while the agent kept calling whatever /model had set. So these tests assert
// on the resolved modelId, not on what was stored.

import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  resolveAgentConfig,
  setSessionEffort,
  clearSessionEffort,
} from "./agent-config.js";
import { EFFORT_PROFILES, modelForEffort } from "./effort.js";

const workspace = mkdtempSync(join(tmpdir(), "zizou-agentcfg-test-"));

beforeEach(() => {
  clearSessionEffort();
  rmSync(join(workspace, "ZIZOU.md"), { force: true });
});

afterAll(() => {
  clearSessionEffort();
  rmSync(workspace, { recursive: true, force: true });
});

function writeZizouMd(body: string) {
  writeFileSync(join(workspace, "ZIZOU.md"), body, "utf-8");
}

test("effort picks the provider's model for that level", () => {
  writeZizouMd("## Agent\nprovider: anthropic\neffort: fast\n");
  const fast = resolveAgentConfig(workspace);

  expect(fast.provider).toBe("anthropic");
  expect(fast.effort).toBe("fast");
  expect(fast.modelId).toBe(modelForEffort("anthropic", "fast")!);
  expect(fast.modelPinned).toBe(false);

  writeZizouMd("## Agent\nprovider: anthropic\neffort: max\n");
  const max = resolveAgentConfig(workspace);

  expect(max.modelId).toBe(modelForEffort("anthropic", "max")!);
  // The whole point of one dial: raising effort must change the model, not
  // just the token cap.
  expect(max.modelId).not.toBe(fast.modelId);
});

test("effort also sets the search budget and sampling, not just the model", () => {
  writeZizouMd("## Agent\nprovider: anthropic\neffort: fast\n");
  const fast = resolveAgentConfig(workspace);
  writeZizouMd("## Agent\nprovider: anthropic\neffort: max\n");
  const max = resolveAgentConfig(workspace);

  expect(fast.maxSteps).toBe(EFFORT_PROFILES.fast.maxSteps);
  expect(max.maxSteps).toBe(EFFORT_PROFILES.max.maxSteps);

  // Every lever must move together — the old two-dial setup let you ask for
  // a fast run with max context, and its "default" and "max" were identical.
  expect(max.maxSteps).toBeGreaterThan(fast.maxSteps);
  expect(max.maxOutputTokens).toBeGreaterThan(fast.maxOutputTokens);
});

test("a session override beats the project file", () => {
  // /effort is "for this session"; ZIZOU.md is how a choice is made permanent.
  writeZizouMd("## Agent\nprovider: anthropic\neffort: fast\n");
  expect(resolveAgentConfig(workspace).effortSource).toBe("project");

  setSessionEffort("max");
  const overridden = resolveAgentConfig(workspace);

  expect(overridden.effort).toBe("max");
  expect(overridden.effortSource).toBe("session");
  expect(overridden.modelId).toBe(modelForEffort("anthropic", "max")!);
});

test("clearing the session override restores the project setting", () => {
  writeZizouMd("## Agent\nprovider: anthropic\neffort: fast\n");
  setSessionEffort("max");
  expect(resolveAgentConfig(workspace).effort).toBe("max");

  clearSessionEffort();
  const restored = resolveAgentConfig(workspace);
  expect(restored.effort).toBe("fast");
  expect(restored.effortSource).toBe("project");
});

test("an explicitly pinned model survives an effort change", () => {
  // If you named a model, raising effort must not silently swap it out --
  // but it should still widen the search budget and raise the token cap.
  writeZizouMd("## Agent\nprovider: anthropic\neffort: fast\nmodel: my-custom-model\n");
  const pinnedFast = resolveAgentConfig(workspace);

  expect(pinnedFast.modelId).toBe("my-custom-model");
  expect(pinnedFast.modelPinned).toBe(true);

  setSessionEffort("max");
  const pinnedMax = resolveAgentConfig(workspace);

  expect(pinnedMax.modelId).toBe("my-custom-model");
  expect(pinnedMax.maxSteps).toBe(EFFORT_PROFILES.max.maxSteps);
  expect(pinnedMax.maxOutputTokens).toBe(EFFORT_PROFILES.max.maxOutputTokens);
});

test("an unknown provider degrades to a usable model instead of throwing", () => {
  writeZizouMd("## Agent\nprovider: some-new-provider\neffort: max\n");
  const config = resolveAgentConfig(workspace);

  expect(config.provider as string).toBe("some-new-provider");
  expect(typeof config.modelId).toBe("string");
  expect(config.modelId.length).toBeGreaterThan(0);
});

test("with no project file the effort falls back to the built-in default", () => {
  const config = resolveAgentConfig(workspace);
  expect(config.effort).toBe("balanced");
  expect(config.effortSource).toBe("default");
});
