// src/agent/router.test.ts
//
// Covers the router's two jobs: reading a model's answer correctly, and
// producing a usable route when it cannot.
//
// The LLM call itself is not exercised here — that would be a network test of
// someone else's model. What IS tested is every way that call can come back
// wrong, because the router's contract is that none of them reach the user as
// an error.

import { test, expect } from "bun:test";
import {
  parseRouteDecision,
  applyConfidencePolicy,
  fallbackRoute,
  isConversational,
  type RouteDecision,
} from "./router.js";

// ─── Parsing ─────────────────────────────────────────────────────────────────

test("parses each of the four routes", () => {
  for (const route of ["chat", "ask", "build", "plan"] as const) {
    const parsed = parseRouteDecision(`{"route":"${route}","confidence":0.9,"reason":"because"}`);
    expect(parsed?.route).toBe(route);
    expect(parsed?.source).toBe("llm");
  }
});

test("parses a fenced JSON block", () => {
  // Models add fences despite being told not to, and a fence is not a reason
  // to throw away an otherwise correct answer.
  const parsed = parseRouteDecision(
    '```json\n{"route":"plan","confidence":0.8,"reason":"multi-file work"}\n```',
  );
  expect(parsed?.route).toBe("plan");
  expect(parsed?.reason).toBe("multi-file work");
});

test("parses an object buried in a sentence", () => {
  const parsed = parseRouteDecision(
    'Sure! Here is the classification: {"route":"ask","confidence":0.7,"reason":"a question"} Hope that helps.',
  );
  expect(parsed?.route).toBe("ask");
});

test("rejects a route the model invented", () => {
  // An unknown label must not be coerced into a real one. Returning null is
  // what lets the caller fall back deterministically instead of running
  // whichever route happened to sort first.
  expect(parseRouteDecision('{"route":"refactor","confidence":0.9,"reason":"x"}')).toBeNull();
  expect(parseRouteDecision('{"route":"auto","confidence":0.9,"reason":"x"}')).toBeNull();
});

test("rejects non-JSON and empty output", () => {
  expect(parseRouteDecision("I think this is a build task.")).toBeNull();
  expect(parseRouteDecision("")).toBeNull();
  expect(parseRouteDecision("{not json at all}")).toBeNull();
});

test("keeps a valid route when only the metadata is malformed", () => {
  // Confidence and reason are advisory. Discarding a correct route because
  // the model wrote confidence as a string would trade a good answer for a
  // fallback, which is strictly worse.
  const parsed = parseRouteDecision('{"route":"build","confidence":"high"}');
  expect(parsed?.route).toBe("build");
  expect(parsed?.confidence).toBe(0.5);
  expect(parsed?.reason).toBe("no reason given");
});

test("clamps confidence into 0..1", () => {
  expect(parseRouteDecision('{"route":"build","confidence":7,"reason":"x"}')?.confidence).toBe(1);
  expect(parseRouteDecision('{"route":"build","confidence":-3,"reason":"x"}')?.confidence).toBe(0);
});

// ─── Confidence policy ───────────────────────────────────────────────────────

const decide = (route: RouteDecision["route"], confidence: number): RouteDecision => ({
  route,
  confidence,
  reason: "r",
  source: "llm",
});

test("a low-confidence plan becomes a build", () => {
  // Being wrong toward plan costs a planning round trip and a gate to
  // decline. Being wrong toward build costs one undoable step.
  expect(applyConfidencePolicy(decide("plan", 0.2)).route).toBe("build");
});

test("a low-confidence chat becomes an ask", () => {
  // Reading a few files it did not need beats answering a real question from
  // nothing.
  expect(applyConfidencePolicy(decide("chat", 0.2)).route).toBe("ask");
});

test("a confident decision is left alone", () => {
  expect(applyConfidencePolicy(decide("plan", 0.9)).route).toBe("plan");
  expect(applyConfidencePolicy(decide("chat", 0.9)).route).toBe("chat");
  expect(applyConfidencePolicy(decide("ask", 0.1)).route).toBe("ask");
  expect(applyConfidencePolicy(decide("build", 0.1)).route).toBe("build");
});

// ─── Fallback ────────────────────────────────────────────────────────────────

test("the fallback sends a greeting to chat and everything else to build", () => {
  expect(fallbackRoute("hey", "offline").route).toBe("chat");
  expect(fallbackRoute("add a --verbose flag", "offline").route).toBe("build");
});

test("the fallback marks itself as a fallback with zero confidence", () => {
  // The journal and any future UI need to tell "the model chose build" from
  // "nothing chose anything and build is the default".
  const decision = fallbackRoute("do a thing", "router unavailable");
  expect(decision.source).toBe("fallback");
  expect(decision.confidence).toBe(0);
  expect(decision.reason).toBe("router unavailable");
});

// ─── The greeting detector ───────────────────────────────────────────────────

test("recognises greetings and chit-chat", () => {
  for (const p of ["hi", "hello!", "hey there".slice(0, 3), "yo", "  Good morning  ", "ping"]) {
    expect(isConversational(p)).toBe(true);
  }
});

test("a greeting with a task attached is not conversational", () => {
  // The task is the message. Routing "hi build me a file" to chat would drop
  // the only part that asked for anything.
  expect(isConversational("hi build me a file")).toBe(false);
  expect(isConversational("hey, can you fix the header")).toBe(false);
});

test("an ordinary request is not conversational", () => {
  expect(isConversational("refactor the auth module")).toBe(false);
  expect(isConversational("how does the checkpoint system work?")).toBe(false);
});
