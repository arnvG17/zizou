// src/agent/clean-history.test.ts
//
// History trimming between turns.
//
// The bug these guard: the cleaner read `part.result` and `part.args`, but AI
// SDK v7 names those `output` and `input`. Every lookup returned undefined, so
// nothing was ever trimmed and a junk `{success:true, message:"undefined"}`
// was bolted onto every tool result. Real sessions reached 144KB of state.json.
//
// So these assert on `output` specifically, and on payloads actually shrinking
// — not merely on the function returning something.

import { test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { cleanHistoryForNextTurn, FULL_DETAIL_ROUNDS } from "./executor.js";

const BIG = "X".repeat(50_000);

/** One assistant tool-call round plus its result, in AI SDK v7 shape. */
function round(callId: string, toolName: string, input: unknown, output: unknown): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName, input }] } as any,
    { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName, output }] } as any,
  ];
}

/** Rounds of filler so earlier ones fall outside the full-detail window. */
function filler(count: number): ModelMessage[] {
  return Array.from({ length: count }, (_, i) =>
    round(`f${i}`, "listDir", { path: "." }, { success: true, entries: [] }),
  ).flat();
}

function toolOutput(messages: ModelMessage[], callId: string): any {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content as any[]) {
      if (part.type === "tool-result" && part.toolCallId === callId) return part.output;
    }
  }
  return undefined;
}

function toolInput(messages: ModelMessage[], callId: string): any {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content as any[]) {
      if (part.type === "tool-call" && part.toolCallId === callId) return part.input;
    }
  }
  return undefined;
}

test("an old readFile result loses its contents", () => {
  const history: ModelMessage[] = [
    { role: "user", content: "go" },
    ...round("c1", "readFile", { path: "big.ts" }, { success: true, contents: BIG }),
    ...filler(FULL_DETAIL_ROUNDS + 1),
  ];

  const out = cleanHistoryForNextTurn(history);
  const result = toolOutput(out, "c1");

  expect(result.contents).toBeUndefined();
  expect(result.file).toBe("big.ts");
  expect(result.success).toBe(true);
});

test("a recent readFile result keeps its contents", () => {
  // The model is still working with this; collapsing it was the original
  // design's mistake in the other direction.
  const history: ModelMessage[] = [
    { role: "user", content: "go" },
    ...round("c1", "readFile", { path: "big.ts" }, { success: true, contents: BIG }),
  ];

  const out = cleanHistoryForNextTurn(history);
  expect(toolOutput(out, "c1").contents).toBe(BIG);
});

test("no tool result is given a junk `result` field", () => {
  // The old cleaner wrote String(undefined) into a field the SDK ignores.
  const history: ModelMessage[] = [
    { role: "user", content: "go" },
    ...round("c1", "readFile", { path: "a.ts" }, { success: true, contents: "hi" }),
    ...filler(FULL_DETAIL_ROUNDS + 1),
  ];

  const out = cleanHistoryForNextTurn(history);
  for (const msg of out) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content as any[]) {
      if (part.type === "tool-result") {
        expect(part.result).toBeUndefined();
        expect(JSON.stringify(part.output)).not.toContain("undefined");
      }
    }
  }
});

test("an old writeFile call drops the file body it wrote", () => {
  // writeFile's INPUT holds the whole new file. Left in place it is re-sent
  // on every later request for the rest of the session.
  const history: ModelMessage[] = [
    { role: "user", content: "go" },
    ...round("c1", "writeFile", { path: "out.ts", contents: BIG }, { success: true }),
    ...filler(FULL_DETAIL_ROUNDS + 1),
  ];

  const out = cleanHistoryForNextTurn(history);
  const input = toolInput(out, "c1");

  expect(input.contents).not.toBe(BIG);
  expect(input.contents).toContain("elided");
  expect(input.path).toBe("out.ts");
  expect(toolOutput(out, "c1").file).toBe("out.ts");
});

test("a small writeFile body is left alone", () => {
  const small = "export const a = 1;\n";
  const history: ModelMessage[] = [
    { role: "user", content: "go" },
    ...round("c1", "writeFile", { path: "s.ts", contents: small }, { success: true }),
    ...filler(FULL_DETAIL_ROUNDS + 1),
  ];

  expect(toolInput(cleanHistoryForNextTurn(history), "c1").contents).toBe(small);
});

test("an old grep keeps which files matched, not the matching lines", () => {
  const history: ModelMessage[] = [
    { role: "user", content: "go" },
    ...round("c1", "grep", { pattern: "foo" }, {
      success: true,
      matches: ["src/a.ts:12:foo()", "src/a.ts:40:foo()", "src/b.ts:3:foo()"],
    }),
    ...filler(FULL_DETAIL_ROUNDS + 1),
  ];

  const result = toolOutput(cleanHistoryForNextTurn(history), "c1");
  expect(result.matches).toEqual(["src/a.ts", "src/b.ts"]);
});

test("an old failing command keeps its error", () => {
  // Collapsing must never hide WHY something failed — that is the detail a
  // later turn most needs.
  const history: ModelMessage[] = [
    { role: "user", content: "go" },
    ...round("c1", "runBash", { command: "bun test" }, {
      success: false,
      error: "exit code 1",
      stdout: BIG,
    }),
    ...filler(FULL_DETAIL_ROUNDS + 1),
  ];

  const result = toolOutput(cleanHistoryForNextTurn(history), "c1");
  expect(result.success).toBe(false);
  expect(result.error).toBe("exit code 1");
  expect(result.stdout).toBeUndefined();
});

test("trimming actually shrinks the serialized history", () => {
  // The end the whole exercise serves.
  const history: ModelMessage[] = [
    { role: "user", content: "go" },
    ...round("c1", "readFile", { path: "a.ts" }, { success: true, contents: BIG }),
    ...round("c2", "writeFile", { path: "b.ts", contents: BIG }, { success: true }),
    ...filler(FULL_DETAIL_ROUNDS + 1),
  ];

  const before = JSON.stringify(history).length;
  const after = JSON.stringify(cleanHistoryForNextTurn(history)).length;

  expect(after).toBeLessThan(before / 10);
});

test("plain text messages pass through untouched", () => {
  const history: ModelMessage[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
    ...filler(FULL_DETAIL_ROUNDS + 1),
  ];

  const out = cleanHistoryForNextTurn(history);
  expect(out[0]).toEqual({ role: "user", content: "hello" });
  expect(out[1]).toEqual({ role: "assistant", content: "hi there" });
});
