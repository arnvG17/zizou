// evals/sft/generate.test.ts
//
// The properties that make this dataset worth training on.
//
// The claim the whole pipeline rests on is that tool results are REAL —
// produced by running the actual tools, not written by hand. That claim is
// only as good as the things checked here: that the workspace is genuinely
// isolated, that nothing from the generating machine leaks into a record,
// and that a scenario whose declared behaviour stops matching reality fails
// the build instead of quietly shipping.

import { test, expect } from "bun:test";
import {
  generateRecord,
  generateAll,
  scrubPaths,
  scrubVolatile,
  buildToolSchemas,
} from "./generate.js";
import { validateRecord } from "./validate.js";
import { allScenarios } from "./scenarios/index.js";
import { WORKSPACE_PLACEHOLDER, type Scenario } from "./types.js";

// ─── Tool schemas ────────────────────────────────────────────────────────────

test("embeds all 16 tools with OpenAI-shaped function schemas", () => {
  const schemas = buildToolSchemas() as any[];
  // 13 before the process layer split runBackground into terminal (persistent
  // shells) and service (supervised long-running processes), and added
  // checkUrl. The count is asserted so a tool added to buildToolMap without a
  // training scenario is noticed here rather than silently under-represented.
  expect(schemas.length).toBe(16);
  for (const s of schemas) {
    expect(s.type).toBe("function");
    expect(typeof s.function.name).toBe("string");
    expect(s.function.description.length).toBeGreaterThan(0);
    expect(s.function.parameters.type).toBe("object");
  }
});

test("editFile's schema includes near_line", () => {
  // Omitted entirely from specs/010-sft-dataset.md §1, despite being in the real
  // Zod schema and taught by the real system prompt as THE recovery path.
  // Coming from asSchema() rather than a hand-written list is what makes it
  // impossible to miss.
  const editFile = (buildToolSchemas() as any[]).find((s) => s.function.name === "editFile");
  expect(Object.keys(editFile.function.parameters.properties)).toContain("near_line");
});

// ─── Path scrubbing ──────────────────────────────────────────────────────────

test("scrubs a Windows path out of JSON-escaped text", () => {
  // The case that actually leaked: scrubPaths runs on JSON.stringify output,
  // where backslashes are already doubled, so the raw path never matches.
  const ws = "C:\\Users\\x\\AppData\\Local\\Temp\\zizou-sft\\abc";
  const json = JSON.stringify({ message: `wrote to ${ws}\\src\\a.ts` });
  const out = scrubPaths(json, ws);
  expect(out).not.toContain("Users");
  expect(out).toContain(`${WORKSPACE_PLACEHOLDER}/src/a.ts`);
});

test("scrubs a POSIX path", () => {
  const ws = "/tmp/zizou-sft/abc";
  const out = scrubPaths(JSON.stringify({ p: `${ws}/src/a.ts` }), ws);
  expect(out).toContain(`${WORKSPACE_PLACEHOLDER}/src/a.ts`);
  expect(out).not.toContain("/tmp/");
});

test("leaves text without the workspace path untouched", () => {
  const text = JSON.stringify({ contents: "const a = 1;" });
  expect(scrubPaths(text, "C:\\Temp\\zizou-sft\\abc")).toBe(text);
});

// ─── Volatile values ─────────────────────────────────────────────────────────

test("scrubs pids and timestamps, which vary per run and teach nothing", () => {
  const raw = JSON.stringify({ pid: 16060, startTime: "2026-09-21T04:18:33.553Z" });
  const out = scrubVolatile(raw);
  expect(out).not.toContain("16060");
  expect(out).not.toContain("2026-09-21");
  expect(JSON.parse(out).pid).toBe(1000);
});

test("does NOT scrub taskId — the record exists to teach carrying it forward", () => {
  // task_1 is a sequential counter, so it is already stable. Normalizing it
  // would erase the link between the spawn result and the kill call.
  const raw = JSON.stringify({ taskId: "task_1", pid: 99 });
  expect(JSON.parse(scrubVolatile(raw)).taskId).toBe("task_1");
});

// ─── Generation contract ─────────────────────────────────────────────────────

const simple: Scenario = {
  id: "unit-simple-0",
  band: "single-edit",
  prompt: "Change the value to 2.",
  fixture: { "src/a.ts": "export const value = 1;\n" },
  steps: [
    { tool: "readFile", args: { path: "src/a.ts" } },
    {
      tool: "editFile",
      args: { path: "src/a.ts", old_string: "value = 1", new_string: "value = 2" },
    },
  ],
  finalText: "Done.",
};

test("tool results are the real tool output, not a template", async () => {
  const rec = await generateRecord(simple);
  const read = rec.messages.find((m: any) => m.role === "tool" && m.name === "readFile") as any;
  const parsed = JSON.parse(read.content);
  // The exact { success, contents } shape src/tools/read-file.ts returns,
  // with the fixture's real bytes.
  expect(parsed.success).toBe(true);
  expect(parsed.contents).toBe("export const value = 1;\n");
});

test("the generated record passes validation", async () => {
  expect(validateRecord(await generateRecord(simple))).toEqual([]);
});

test("the system prompt is the real executor prompt", async () => {
  const rec = await generateRecord(simple);
  // Distinctive lines from EXECUTOR_INSTRUCTIONS in build-system-prompt.ts.
  // If the dataset ever stops matching what Zizou serves, this is where it
  // shows up.
  //
  // The tool-protocol line this used to anchor on ("Never emit raw JSON
  // blocks...") was removed from the shared prompt: it is a crutch only small
  // local models need, so the harness now adds it to the step prompt when the
  // provider is ollama rather than charging every hosted call for it. A
  // fine-tune therefore trains on exactly the system prompt it will be served,
  // which is what this test is really protecting.
  expect(rec.system).toContain("You are Zizou");
  expect(rec.system).toContain("Never claim success without verification");
  expect(rec.system).toContain("FILE PLACEMENT");
  expect(rec.system).toContain(`Workspace root (cwd): ${WORKSPACE_PLACEHOLDER}`);
});

test("a record ends on an assistant message", async () => {
  const rec = await generateRecord(simple);
  expect(rec.messages[rec.messages.length - 1]!.role).toBe("assistant");
});

test("arguments are serialized as a JSON string", async () => {
  const rec = await generateRecord(simple);
  const call = (rec.messages.find((m: any) => m.role === "assistant" && m.tool_calls) as any)
    .tool_calls[0];
  expect(typeof call.function.arguments).toBe("string");
  expect(JSON.parse(call.function.arguments).path).toBe("src/a.ts");
});

// ─── The assertions that keep scenarios honest ───────────────────────────────

test("a step that fails unexpectedly fails the scenario", async () => {
  const bad: Scenario = {
    ...simple,
    id: "unit-bad-0",
    steps: [
      { tool: "editFile", args: { path: "src/a.ts", old_string: "nope", new_string: "x" } },
    ],
    finalText: "Done.",
  };
  const { records, errors } = await generateAll([bad]);
  expect(records.length).toBe(0);
  expect(errors[0]).toContain("failed unexpectedly");
});

test("a step marked expectFailure that SUCCEEDS fails the scenario", async () => {
  // The regression this guards: a recovery record whose failing step starts
  // working is still valid JSON and still passes validation, but has silently
  // stopped teaching recovery.
  const bad: Scenario = {
    ...simple,
    id: "unit-bad-1",
    steps: [{ tool: "readFile", args: { path: "src/a.ts" }, expectFailure: true }],
    finalText: "Done.",
  };
  const { errors } = await generateAll([bad]);
  expect(errors[0]).toContain("marked expectFailure but succeeded");
});

test("a scenario with no steps must provide finalText", async () => {
  const bad: Scenario = { id: "unit-bad-2", band: "blocked", prompt: "?", steps: [] };
  const { errors } = await generateAll([bad]);
  expect(errors[0]).toContain("must set finalText");
});

test("an unknown tool fails the scenario", async () => {
  const bad: Scenario = {
    ...simple,
    id: "unit-bad-3",
    steps: [{ tool: "doesNotExist", args: {} }],
  };
  const { errors } = await generateAll([bad]);
  expect(errors[0]).toContain("unknown tool");
});

// ─── The scenario bank itself ────────────────────────────────────────────────

test("scenario ids are unique", () => {
  // Ids are the train/val split key. A collision puts near-identical records
  // on both sides and makes validation loss measure memorization.
  expect(() => allScenarios()).not.toThrow();
});

test("every scenario declares a prompt and a way to finish", () => {
  for (const s of allScenarios()) {
    expect(s.prompt.length).toBeGreaterThan(0);
    if (s.steps.length === 0) expect(s.finalText).toBeTruthy();
  }
});

test("no scenario writes outside its workspace", () => {
  // Every path a scenario hands a tool must be relative. An absolute path
  // would resolve past the temp workspace and edit the real repo — which the
  // generator also fingerprints against, but catching it here is cheaper.
  for (const s of allScenarios()) {
    for (const step of s.steps) {
      for (const [key, value] of Object.entries(step.args)) {
        if (typeof value !== "string") continue;
        if (!["path", "source", "destination"].includes(key)) continue;
        expect(value.startsWith("/")).toBe(false);
        expect(/^[A-Za-z]:/.test(value)).toBe(false);
        expect(value.includes("..")).toBe(false);
      }
    }
  }
});
