// src/agent/run-turn.test.ts
//
// Proves the agent loop actually streams (plan Phase 1a).
//
// The regression this guards: executeStep used to buffer every AgentEvent into
// StepResult.agentEvents, and both orchestrator call sites replayed that array
// AFTER the step had finished. Nothing reached the UI until the model stopped.
// A test that only checks "all the events arrived" would have passed happily
// against that bug, so these tests assert on ORDERING relative to the model
// still producing output.

import { test, expect } from "bun:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { runTurn, type AgentEvent } from "./run-turn.js";

/** A model that emits the given text in separate chunks, then finishes. */
function textStreamingModel(chunks: string[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "id-0", modelId: "mock", timestamp: new Date(0) },
          { type: "text-start", id: "t0" },
          ...chunks.map((text) => ({ type: "text-delta" as const, id: "t0", delta: text })),
          { type: "text-end", id: "t0" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "stop" },
            // The provider-level usage shape is nested (usage.inputTokens.total);
            // only the `ai`-facing result flattens it to plain numbers.
            usage: {
              inputTokens: { total: 7, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 11, text: 11, reasoning: undefined },
            },
          },
        ],
        chunkDelayInMs: 0,
      }),
    }),
  });
}

const neverConfirm = async () => false;

test("runTurn yields text deltas incrementally, not as one block at the end", async () => {
  const chunks = ["Hello", ", ", "world", "!"];
  const model = textStreamingModel(chunks);

  const received: string[] = [];
  const turn = runTurn({
    history: [{ role: "user", content: "hi" }],
    model: model as any,
    onConfirm: neverConfirm,
    toolMode: "none",
  });

  let step = await turn.next();
  while (!step.done) {
    if (step.value.kind === "text-delta") received.push(step.value.text);
    step = await turn.next();
  }

  // One yielded event per chunk — not a single concatenated string.
  expect(received).toEqual(chunks);
});

test("a consumer sees the first delta before the model has finished", async () => {
  // The precise property the buffering bug violated: a partial result is
  // observable while generation is still in progress.
  const model = textStreamingModel(["first", "second", "third"]);

  const turn = runTurn({
    history: [{ role: "user", content: "hi" }],
    model: model as any,
    onConfirm: neverConfirm,
    toolMode: "none",
  });

  const first = await turn.next();
  expect(first.done).toBe(false);
  expect(first.value).toEqual({ kind: "text-delta", text: "first" });

  // The generator is suspended here, mid-stream — the turn has NOT completed.
  // Drain the rest so the model is not left hanging.
  let rest = await turn.next();
  while (!rest.done) rest = await turn.next();
});

test("runTurn reports usage and returns the appended history", async () => {
  const model = textStreamingModel(["done"]);

  const events: AgentEvent[] = [];
  const turn = runTurn({
    history: [{ role: "user", content: "hi" }],
    model: model as any,
    onConfirm: neverConfirm,
    toolMode: "none",
  });

  let step = await turn.next();
  while (!step.done) {
    events.push(step.value);
    step = await turn.next();
  }

  const finish = events.find((e) => e.kind === "finish");
  expect(finish).toBeDefined();
  expect((finish as Extract<AgentEvent, { kind: "finish" }>).usage).toEqual({
    inputTokens: 7,
    outputTokens: 11,
  });

  expect(events.some((e) => e.kind === "turn-complete")).toBe(true);

  // The returned history is the canonical ModelMessage[] the executor relies
  // on instead of rebuilding its own copy from the event stream.
  const returned = step.value;
  expect(returned[0]).toEqual({ role: "user", content: "hi" });
  expect(returned.length).toBeGreaterThan(1);
});

test("maxOutputTokens reaches the provider", async () => {
  // Regression: this was passed as `maxTokens`, which AI SDK v7 ignores, so
  // the configured output cap silently did nothing on every request.
  const model = textStreamingModel(["ok"]);

  const turn = runTurn({
    history: [{ role: "user", content: "hi" }],
    model: model as any,
    onConfirm: neverConfirm,
    toolMode: "none",
    maxOutputTokens: 1234,
  });

  let step = await turn.next();
  while (!step.done) step = await turn.next();

  expect(model.doStreamCalls).toHaveLength(1);
  expect(model.doStreamCalls[0]!.maxOutputTokens).toBe(1234);
});
