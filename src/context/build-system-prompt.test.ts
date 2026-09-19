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
  // The SECTION, not the phrase: the file-placement rules refer to project
  // conventions by name ("if PROJECT CONVENTIONS below name a layout..."),
  // so a bare substring check here would fail on that reference alone.
  expect(prompt).not.toContain("--- PROJECT CONVENTIONS (from ZIZOU.md) ---");
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

// ─── Roles and file placement ────────────────────────────────────────────────

test("the ask role gets read-only instructions and no write tools", async () => {
  const prompt = await buildSystemPrompt(workspace, "ask");

  expect(prompt).toContain("READ-ONLY tools");
  expect(prompt).toContain("You cannot write");
  // The executor's write instructions must not leak into a role that has no
  // write tools — being told to "ALWAYS invoke the writeFile tool" while
  // holding no such tool is how a model ends up describing an edit it never
  // made.
  expect(prompt).not.toContain("ALWAYS invoke the writeFile tool");
});

test("the ask role gets no file-placement rules", async () => {
  // It cannot create a file, so where files go is noise in its context.
  const prompt = await buildSystemPrompt(workspace, "ask");
  expect(prompt).not.toContain("FILE PLACEMENT");
});

test("the executor and planner both get the file-placement rules", async () => {
  // The planner's targetFiles become the executor's destinations AND what the
  // user sees at the gate, so both need the same rules or they disagree.
  for (const role of ["executor", "planner"] as const) {
    const prompt = await buildSystemPrompt(workspace, role);
    expect(prompt).toContain("FILE PLACEMENT");
    expect(prompt).toContain("does NOT\n  belong at the root");
  }
});

test("the session context no longer offers a root file as its example", async () => {
  // It used to illustrate relative paths with `index.html`, so the one
  // concrete placement example the model saw was a write to the repo root.
  const prompt = await buildSystemPrompt(workspace, "executor");
  expect(prompt).toContain("src/components/Foo.tsx");
  expect(prompt).not.toContain("e.g. index.html");
});

test("project conventions land after the placement rules that defer to them", async () => {
  // The rules end with "if PROJECT CONVENTIONS below name a layout, that
  // layout wins" — which is a lie if the conventions are above them.
  writeFileSync(
    join(workspace, "ZIZOU.md"),
    "## Layout\n\n- apps go in apps/<name>/\n",
    "utf-8",
  );

  const prompt = await buildSystemPrompt(workspace, "executor");

  expect(prompt.indexOf("FILE PLACEMENT")).toBeGreaterThan(-1);
  expect(prompt.indexOf("--- PROJECT CONVENTIONS (from ZIZOU.md) ---")).toBeGreaterThan(
    prompt.indexOf("FILE PLACEMENT"),
  );
  expect(prompt).toContain("apps go in apps/<name>/");
});

test("the executor is told to look for an existing file before creating one", async () => {
  const prompt = await buildSystemPrompt(workspace, "executor");
  expect(prompt).toContain("EDIT, DON'T RECREATE");
});
