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
import { repairHistory } from "./history.js";

const BIG = "X".repeat(50_000);

/** One assistant tool-call round plus its result, in AI SDK v7 shape. */
/**
 * Builds a round in the shape the AI SDK actually produces.
 *
 * NOTE THE `{ type: "json", value }` WRAPPER. These helpers previously stored
 * the bare payload in `output`, cast through `as any`. That made every test
 * here assert against a shape the SDK never emits and the ModelMessage schema
 * rejects — which is how the collapser came to write that invalid shape into
 * real history, with a green suite the whole time.
 */
function round(callId: string, toolName: string, input: unknown, output: unknown): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName, input }] } as any,
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: callId, toolName, output: { type: "json", value: output } },
      ],
    } as any,
  ];
}

/** Rounds of filler so earlier ones fall outside the full-detail window. */
function filler(count: number): ModelMessage[] {
  return Array.from({ length: count }, (_, i) =>
    round(`f${i}`, "listDir", { path: "." }, { success: true, entries: [] }),
  ).flat();
}

/** The tool result's PAYLOAD — i.e. output.value, not the tagged wrapper. */
function toolOutput(messages: ModelMessage[], callId: string): any {
  return rawToolOutput(messages, callId)?.value;
}

/** The tagged wrapper itself, for asserting the shape is preserved. */
function rawToolOutput(messages: ModelMessage[], callId: string): any {
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

// ─── The message-schema regression ───────────────────────────────────────────
//
// These pin the bug that killed real sessions with
//   "Invalid prompt: The messages do not match the ModelMessage[] schema."
// It only struck long runs, because collapsing applies solely to rounds older
// than FULL_DETAIL_ROUNDS — a short chat never reached the broken path, and
// any sustained agentic session did.

test("a collapsed tool result keeps the SDK's tagged output shape", () => {
  const history: ModelMessage[] = [
    { role: "user", content: "go" },
    ...round("c1", "readFile", { path: "big.ts" }, { success: true, contents: BIG }),
    ...filler(FULL_DETAIL_ROUNDS + 1),
  ];

  const wrapper = rawToolOutput(cleanHistoryForNextTurn(history), "c1");

  // Writing the bare payload here is what produced an unsendable message.
  expect(wrapper.type).toBe("json");
  expect(wrapper).toHaveProperty("value");
  expect(typeof wrapper.value).toBe("object");
});

test("a collapsed FAILURE is not relabelled as a success", () => {
  // Reading `success` off the wrapper instead of off `.value` found nothing on
  // any result, so `success !== false` was always true: a failed command came
  // back to the model as "Command completed successfully".
  const history: ModelMessage[] = [
    { role: "user", content: "go" },
    ...round(
      "c1",
      "runBash",
      { command: "npm run build" },
      { success: false, exitCode: 1, stderr: "error TS2304" },
    ),
    ...filler(FULL_DETAIL_ROUNDS + 1),
  ];

  const out = toolOutput(cleanHistoryForNextTurn(history), "c1");
  expect(out.success).toBe(false);
  expect(out.message).toBe("Command failed");
  expect(out.exitCode).toBe(1);
  expect(out.stderr).toContain("TS2304");
});

// ─── repairHistory ───────────────────────────────────────────────────────────

test("an untagged tool output from an older session is re-tagged on load", () => {
  // Sessions written before the fix hold the broken shape on disk. Without
  // repair they could never be reopened — the turn dies before anything runs.
  const broken: ModelMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "runBash", input: {} }] } as any,
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "c1", toolName: "runBash", output: { success: true, message: "done" } },
      ],
    } as any,
  ];

  const wrapper = rawToolOutput(repairHistory(broken), "c1");
  expect(wrapper.type).toBe("json");
  expect(wrapper.value.message).toBe("done");
});

test("an already-tagged output is left exactly as it is", () => {
  const good: ModelMessage[] = [
    { role: "user", content: "go" },
    ...round("c1", "readFile", { path: "a.ts" }, { success: true, contents: "x" }),
  ];

  expect(repairHistory(good)).toEqual(good);
});

test("a tool call nothing ever answered is dropped", () => {
  // Every provider requires a call to be followed by its result. An aborted
  // turn leaves one behind, and the session can never be sent again.
  const orphaned: ModelMessage[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "starting" },
        { type: "tool-call", toolCallId: "never-answered", toolName: "runBash", input: {} },
      ],
    } as any,
  ];

  const repaired = repairHistory(orphaned);
  const parts = (repaired[1].content as any[]).map((p) => p.type);

  expect(parts).not.toContain("tool-call");
  // The text around it is still worth keeping.
  expect(parts).toContain("text");
});

test("an assistant message left empty by the repair is removed entirely", () => {
  const orphaned: ModelMessage[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "never-answered", toolName: "runBash", input: {} }],
    } as any,
  ];

  const repaired = repairHistory(orphaned);
  expect(repaired).toHaveLength(1);
  expect(repaired[0].role).toBe("user");
});

test("repairing an empty or malformed conversation does not throw", () => {
  expect(repairHistory([])).toEqual([]);
  expect(repairHistory(null as any)).toEqual([]);
  expect(repairHistory([null, undefined] as any)).toEqual([]);
});
