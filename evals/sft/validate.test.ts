// evals/sft/validate.test.ts
//
// Proves the gate is not vacuous.
//
// A validator that passes everything is worse than no validator, because it
// produces a green tick that people trust. So each test here constructs a
// record with ONE specific defect — every defect taken from something that
// has actually gone wrong, either in specs/010-sft-dataset.md's guidance or in
// the first run of this generator — and asserts it is caught by name.
//
// The field-name cases matter most. specs/010-sft-dataset.md §10.2 lists them as
// a table for a human to check by eye:
//
//     writeFile    filePath, content    → path, contents
//     editFile     file, oldString      → path, old_string
//     managePorts  port: "3000"         → port: 3000
//     manageTasks  action: "stop"       → action: "kill"
//
// Here that table is executed against the live Zod schemas instead, so it
// cannot go stale: rename a field in src/tools and these tests keep working
// without anyone remembering to update a list.

import { test, expect } from "bun:test";
import { validateRecord, validateAll, estimateTokens } from "./validate.js";
import type { TrainingRecord, TrainingMessage } from "./types.js";

// ─── Builders ────────────────────────────────────────────────────────────────

function record(messages: TrainingMessage[], over: Partial<TrainingRecord> = {}): TrainingRecord {
  return {
    meta: { id: "t", scenario: "t", band: "single-edit", tools: [], turns: messages.length },
    system: "You are Zizou.",
    tools: [{ type: "function", function: { name: "readFile" } }],
    messages,
    ...over,
  };
}

function call(name: string, args: unknown, id = "c1"): TrainingMessage {
  return {
    role: "assistant",
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function result(content: unknown, id = "c1", name = "readFile"): TrainingMessage {
  return { role: "tool", tool_call_id: id, name, content: JSON.stringify(content) };
}

const ok = { success: true };

/** A minimal record that must pass, so failures below are attributable. */
function goodRecord(): TrainingRecord {
  return record([
    { role: "user", content: "read the config" },
    call("readFile", { path: "src/config.ts" }),
    result({ success: true, contents: "export const x = 1;\n" }),
    { role: "assistant", content: "It exports a single constant, x." },
  ]);
}

const rules = (r: TrainingRecord) => validateRecord(r).map((p) => p.rule);

// ─── The control ─────────────────────────────────────────────────────────────

test("a well-formed record passes", () => {
  expect(validateRecord(goodRecord())).toEqual([]);
});

// ─── Schema: the §10.2 table, executed ───────────────────────────────────────

test("rejects writeFile with filePath instead of path", () => {
  const r = record([
    { role: "user", content: "write it" },
    call("writeFile", { filePath: "a.ts", contents: "x" }),
    result(ok, "c1", "writeFile"),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).toContain("schema");
});

test("rejects writeFile with content instead of contents", () => {
  const r = record([
    { role: "user", content: "write it" },
    call("writeFile", { path: "a.ts", content: "x" }),
    result(ok, "c1", "writeFile"),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).toContain("schema");
});

test("rejects editFile with camelCase oldString/newString", () => {
  const r = record([
    { role: "user", content: "edit it" },
    call("editFile", { path: "a.ts", oldString: "a", newString: "b" }),
    result(ok, "c1", "editFile"),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).toContain("schema");
});

test("rejects managePorts with port as a string", () => {
  // The mistake a model makes because it just read "3000" out of an error.
  const r = record([
    { role: "user", content: "free the port" },
    call("managePorts", { action: "find", port: "3000" }),
    result(ok, "c1", "managePorts"),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).toContain("schema");
});

test("accepts managePorts with port as a number", () => {
  const r = record([
    { role: "user", content: "free the port" },
    call("managePorts", { action: "find", port: 3000 }),
    result(ok, "c1", "managePorts"),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).not.toContain("schema");
});

test('rejects manageTasks with action "stop"', () => {
  // The enum is list|kill|logs. "stop" and "terminate" are the wrong guesses.
  const r = record([
    { role: "user", content: "stop it" },
    call("manageTasks", { action: "stop", taskId: "bg_1" }),
    result(ok, "c1", "manageTasks"),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).toContain("schema");
});

test("rejects a tool that does not exist", () => {
  const r = record([
    { role: "user", content: "do it" },
    call("searchReplace", { path: "a.ts" }),
    result(ok, "c1", "searchReplace"),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).toContain("known-tool");
});

test("rejects arguments that are an object rather than a JSON string", () => {
  // Renders as [object Object] through the chat template.
  const r = record([
    { role: "user", content: "read" },
    {
      role: "assistant",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "readFile", arguments: { path: "a.ts" } as any } },
      ],
    },
    result(ok),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).toContain("arguments-are-string");
});

test("rejects arguments that are not parseable JSON", () => {
  const r = record([
    { role: "user", content: "read" },
    {
      role: "assistant",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "readFile", arguments: "{path: a.ts" } },
      ],
    },
    result(ok),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).toContain("arguments-parse");
});

// ─── Conversation structure ──────────────────────────────────────────────────

test("rejects a tool result with no matching call", () => {
  const r = record([
    { role: "user", content: "read" },
    result(ok, "orphan"),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).toContain("tool-result-has-call");
});

test("rejects an assistant turn with neither content nor tool calls", () => {
  const r = record([
    { role: "user", content: "hi" },
    { role: "assistant" },
  ]);
  expect(rules(r)).toContain("no-empty-assistant");
});

test("rejects a record that ends on a tool result", () => {
  // Teaches the model to stop mid-loop with the user still waiting.
  const r = record([
    { role: "user", content: "read" },
    call("readFile", { path: "a.ts" }),
    result(ok),
  ]);
  expect(rules(r)).toContain("ends-with-assistant");
});

// ─── The pseudo-call rule ────────────────────────────────────────────────────

test("rejects a <function/> pseudo-tag in assistant text", () => {
  // The exact shape fallback-tool-parse.ts exists to rescue. As a training
  // target it teaches the model to produce what the rescuer must undo.
  const r = record([
    { role: "user", content: "write it" },
    { role: "assistant", content: '<function/writeFile>{"path":"a.ts"}</function>' },
  ]);
  expect(rules(r)).toContain("no-pseudo-calls");
});

test("rejects a <tool_call> tag written as text", () => {
  const r = record([
    { role: "user", content: "write it" },
    { role: "assistant", content: '<tool_call>{"name":"writeFile"}</tool_call>' },
  ]);
  expect(rules(r)).toContain("no-pseudo-calls");
});

test("rejects the AI SDK's toolName/input shape appearing as text", () => {
  // What specs/010-sft-dataset.md called the WINNER. It is an internal
  // representation and never appears on the wire.
  const r = record([
    { role: "user", content: "write it" },
    { role: "assistant", content: 'I will call {"toolName": "writeFile", "input": {}}' },
  ]);
  expect(rules(r)).toContain("no-pseudo-calls");
});

test("does not flag tool RESULTS that happen to contain JSON", () => {
  // A readFile of a package.json legitimately returns text with "arguments"
  // or similar in it. Only what the model is taught to SAY is policed.
  const r = record([
    { role: "user", content: "read" },
    call("readFile", { path: "a.json" }),
    result({ success: true, contents: '{"arguments": ["--watch"]}' }),
    { role: "assistant", content: "It passes --watch." },
  ]);
  expect(rules(r)).not.toContain("no-pseudo-calls");
});

// ─── Edit preconditions ──────────────────────────────────────────────────────

test("rejects an editFile whose old_string is absent from the file just read", () => {
  const r = record([
    { role: "user", content: "edit" },
    call("readFile", { path: "a.ts" }, "c1"),
    result({ success: true, contents: "const a = 1;\n" }, "c1"),
    call("editFile", { path: "a.ts", old_string: "const b = 2;", new_string: "x" }, "c2"),
    result(ok, "c2", "editFile"),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).toContain("edit-precondition");
});

test("rejects a successful editFile whose old_string is ambiguous and has no near_line", () => {
  const r = record([
    { role: "user", content: "edit" },
    call("readFile", { path: "a.ts" }, "c1"),
    result({ success: true, contents: "x: 1,\ny: 2,\nx: 1,\n" }, "c1"),
    call("editFile", { path: "a.ts", old_string: "x: 1,", new_string: "x: 9," }, "c2"),
    result(ok, "c2", "editFile"),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).toContain("edit-precondition");
});

test("allows an ambiguous old_string when the call FAILED — that is a recovery record", () => {
  // The most valuable records in the set are the ones where an edit goes
  // wrong on purpose. Holding them to the precondition would reject them
  // for being exactly what they are.
  const r = record([
    { role: "user", content: "edit" },
    call("readFile", { path: "a.ts" }, "c1"),
    result({ success: true, contents: "x: 1,\ny: 2,\nx: 1,\n" }, "c1"),
    call("editFile", { path: "a.ts", old_string: "x: 1,", new_string: "x: 9," }, "c2"),
    result({ success: false, error: "AMBIGUOUS_MATCH: matches 2 locations" }, "c2", "editFile"),
    call("editFile", { path: "a.ts", old_string: "x: 1,", new_string: "x: 9,", near_line: 1 }, "c3"),
    result({ success: true, message: "replaced" }, "c3", "editFile"),
    { role: "assistant", content: "Targeted the first occurrence." },
  ]);
  expect(rules(r)).not.toContain("edit-precondition");
});

test("tracks file state across edits, so a stale old_string is caught", () => {
  // The second edit uses text the first edit already removed. Valid in
  // isolation, wrong in sequence — which is why the rule replays.
  const r = record([
    { role: "user", content: "edit twice" },
    call("readFile", { path: "a.ts" }, "c1"),
    result({ success: true, contents: "const a = 1;\n" }, "c1"),
    call("editFile", { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }, "c2"),
    result({ success: true, message: "ok" }, "c2", "editFile"),
    call("editFile", { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 3;" }, "c3"),
    result({ success: true, message: "ok" }, "c3", "editFile"),
    { role: "assistant", content: "done" },
  ]);
  expect(rules(r)).toContain("edit-precondition");
});

// ─── Budget and duplicates ───────────────────────────────────────────────────

test("rejects a record over the token budget", () => {
  const r = record(
    [
      { role: "user", content: "x".repeat(200_000) },
      { role: "assistant", content: "ok" },
    ],
  );
  expect(rules(r)).toContain("token-budget");
});

test("estimateTokens grows with length", () => {
  expect(estimateTokens("x".repeat(3600))).toBeGreaterThan(900);
  expect(estimateTokens("")).toBe(0);
});

test("reports duplicate records across the set", () => {
  const a = goodRecord();
  const b = goodRecord();
  b.meta.id = "t2";
  const report = validateAll([a, b]);
  expect(report.duplicates.length).toBe(1);
  expect(report.duplicates[0]).toContain("t2");
});

test("validateAll counts a record once however many problems it has", () => {
  const bad = record([
    { role: "user", content: "go" },
    call("nope", { a: 1 }),
    result(ok, "c1", "nope"),
    { role: "assistant" },
  ]);
  const report = validateAll([bad, goodRecord()]);
  expect(report.total).toBe(2);
  expect(report.passed).toBe(1);
});
