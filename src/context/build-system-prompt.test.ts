// src/context/build-system-prompt.test.ts
//
// What goes into a prompt, and what must not.
//
// Two of these guard leaks that are invisible in normal use: a pinned file is
// injected into EVERY prompt for the life of the session, and ZIZOU.md's
// settings block is configuration for Zizou rather than guidance for a model.
// Neither shows up as an error — they just quietly consume the context window.

import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildSystemPrompt,
  addPinnedFile,
  clearPinnedFiles,
} from "./build-system-prompt.js";

const workspace = mkdtempSync(join(tmpdir(), "zizou-prompt-test-"));

beforeEach(() => {
  clearPinnedFiles();
  rmSync(join(workspace, "ZIZOU.md"), { force: true });
});

afterAll(() => {
  clearPinnedFiles();
  rmSync(workspace, { recursive: true, force: true });
});

test("no prompt contains a pre-computed repo map", () => {
  // The map cost ~5.7k tokens, a quarter of it describing an unrelated app,
  // and it omitted every tool declared as `export const x = tool({...})`.
  // Both roles search instead. If a map ever reappears, it should be a
  // deliberate decision that updates this test, not an accident.
  return Promise.all(
    (["planner", "executor"] as const).map(async (role) => {
      const prompt = await buildSystemPrompt(workspace, role);
      expect(prompt).not.toContain("--- REPO MAP ---");
    }),
  );
});

test("the planner is not told how to write or edit files", async () => {
  // It has read-only tools. Instructions about editFile recovery are noise at
  // best, and an invitation to attempt a write it cannot perform.
  const planner = await buildSystemPrompt(workspace, "planner");

  expect(planner).toContain("READ-ONLY");
  expect(planner).not.toContain("editFile recovery strategy");
  expect(planner).toContain("grep");
});

test("the executor is told how to write and edit files", async () => {
  const executor = await buildSystemPrompt(workspace, "executor");

  expect(executor).toContain("writeFile");
  expect(executor).toContain("editFile recovery strategy");
});

test("ZIZOU.md conventions reach the prompt but its settings block does not", async () => {
  writeFileSync(
    join(workspace, "ZIZOU.md"),
    `# ZIZOU.md

## Agent

provider: anthropic
effort: max

## Conventions

- Use bun, not npm
`,
    "utf-8",
  );

  const prompt = await buildSystemPrompt(workspace, "executor");

  expect(prompt).toContain("Use bun, not npm");
  // "provider: anthropic" is configuration for Zizou, not a project rule.
  expect(prompt).not.toContain("provider: anthropic");
  expect(prompt).not.toContain("effort: max");
});

test("a ZIZOU.md with only settings adds no conventions section", async () => {
  writeFileSync(join(workspace, "ZIZOU.md"), "## Agent\nprovider: groq\n", "utf-8");

  const prompt = await buildSystemPrompt(workspace, "executor");
  expect(prompt).not.toContain("PROJECT CONVENTIONS");
});

test("a large pinned file is truncated rather than swallowing the context window", async () => {
  const big = join(workspace, "big.ts");
  writeFileSync(big, "// x\n".repeat(20_000), "utf-8"); // ~100k chars
  addPinnedFile(workspace, "big.ts");

  const prompt = await buildSystemPrompt(workspace, "executor");

  expect(prompt).toContain("truncated");
  // The cap is 8k characters of content; the whole prompt must stay near it
  // rather than growing to the file's full size.
  expect(prompt.length).toBeLessThan(20_000);
});

test("a small pinned file is included whole", async () => {
  const small = join(workspace, "small.ts");
  writeFileSync(small, "export const answer = 42;\n", "utf-8");
  addPinnedFile(workspace, "small.ts");

  const prompt = await buildSystemPrompt(workspace, "executor");

  expect(prompt).toContain("export const answer = 42;");
  expect(prompt).not.toContain("truncated");
});

test("pinning several files still respects one shared budget", async () => {
  // Per-file caps would let ten pinned files blow the window together.
  for (let i = 0; i < 4; i++) {
    const path = join(workspace, `f${i}.ts`);
    writeFileSync(path, `// file ${i}\n`.repeat(5_000), "utf-8"); // ~65k chars each
    addPinnedFile(workspace, `f${i}.ts`);
  }

  const prompt = await buildSystemPrompt(workspace, "executor");
  expect(prompt.length).toBeLessThan(20_000);
});
