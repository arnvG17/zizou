// src/agent/recovery.test.ts
//
// Telling a retry that learned something from one that did not.
//
// The repair budget used to be a count: exactly one retry, on the reasoning
// that a model thrashes beyond it. The diagnosis was right and the remedy was
// a proxy for it — counting attempts cannot distinguish thrash from progress,
// so it cut off the genuine two-stage fix (the repair reveals a second,
// different error) for the same reason it cut off the thrash.
//
// What actually separates them is whether the failure CHANGED. These pin the
// comparison that decides it.

import { test, expect } from "bun:test";
import { failureSignature, repairDecision } from "./orchestrator.js";
import { makeFinding } from "./types.js";

// ─── The attempt budget ──────────────────────────────────────────────────────

test("a failure that moved earns another repair", () => {
  expect(repairDecision(0, false).retry).toBe(true);
  expect(repairDecision(1, false).retry).toBe(true);
});

test("the budget is two repairs, not one", () => {
  // `attempt` counts REPAIRS, so the initial run is 0. Writing the bound as
  // `attempt + 1 < MAX` permits exactly one repair however high MAX goes —
  // which silently reproduces the single-retry budget this replaced, and is
  // the bug this test exists for.
  expect(repairDecision(2, false)).toEqual({ retry: false, reason: "attempts-exhausted" });
});

test("an identical failure stops immediately, whatever budget remains", () => {
  // Sooner than the old single-retry budget, not later: a repeat proves the
  // next attempt would learn nothing, so there is no reason to spend it.
  expect(repairDecision(0, true)).toEqual({ retry: false, reason: "no-progress" });
  expect(repairDecision(1, true).reason).toBe("no-progress");
});

test("the same failure twice produces the same signature", () => {
  const attempt = () => [
    makeFinding("command-failed", undefined, "`bun run build` exited 1\nerror TS2304: Cannot find name 'Foo'."),
  ];

  // This is the stop condition: identical means the retry changed nothing
  // that mattered, and a third attempt will not either.
  expect(failureSignature(attempt())).toBe(failureSignature(attempt()));
});

test("a different error is a different signature, even from the same command", () => {
  // The case the old attempt-count budget threw away. Both are
  // `command-failed` from `bun run build`, so the code alone cannot tell them
  // apart — which is why the detail is part of the signature.
  const first = [makeFinding("command-failed", undefined, "`bun run build` exited 1\nerror TS2304: Cannot find name 'Foo'.")];
  const second = [makeFinding("command-failed", undefined, "`bun run build` exited 1\nerror TS2551: Property 'bar' does not exist.")];

  expect(failureSignature(first)).not.toBe(failureSignature(second));
});

test("ordering noise does not read as a change", () => {
  // Two findings from one attempt can be collected in either order. Treating
  // a reshuffle as progress would buy a pointless extra attempt.
  const a = [makeFinding("command-failed", undefined, "build broke"), makeFinding("tool-error", "x.ts", "write failed")];
  const b = [makeFinding("tool-error", "x.ts", "write failed"), makeFinding("command-failed", undefined, "build broke")];

  expect(failureSignature(a)).toBe(failureSignature(b));
});

test("soft findings are excluded", () => {
  // A soft finding is a prediction that did not pan out. Letting one into the
  // signature would make an unchanged failure look like it had moved, purely
  // because the planner guessed a different path.
  const hard = makeFinding("command-failed", undefined, "build broke");

  expect(failureSignature([hard])).toBe(
    failureSignature([hard, makeFinding("target-not-created", "guessed/path.ts")]),
  );
});

test("the same error at a different file is a different signature", () => {
  const a = [makeFinding("tool-error", "src/a.ts", "write failed")];
  const b = [makeFinding("tool-error", "src/b.ts", "write failed")];

  expect(failureSignature(a)).not.toBe(failureSignature(b));
});

test("a clean verification has an empty signature", () => {
  expect(failureSignature([])).toBe("");
  expect(failureSignature([makeFinding("target-not-created", "x.ts")])).toBe("");
});

test("content beyond the compared head is ignored", () => {
  // Bounded so a long stack trace's tail — pids, temp paths, durations —
  // cannot make an unchanged failure look like progress. The bound is
  // generous on purpose: see failureSignature's note on why "different" is
  // the cheaper way to be wrong.
  const head = `\`bun test\` exited 1\nAssertionError: expected 1 to equal 2\n${"  at src/thing.ts:12\n".repeat(12)}`;
  expect(head.length).toBeGreaterThan(200);

  const a = [makeFinding("command-failed", undefined, `${head}\nat /tmp/run-1111/x.js`)];
  const b = [makeFinding("command-failed", undefined, `${head}\nat /tmp/run-2222/y.js`)];

  expect(failureSignature(a)).toBe(failureSignature(b));
});

test("a fix that resolves one of several errors reads as progress", () => {
  // The costly direction. If the signature were truncated to the first line,
  // both of these would be "`bun run build` exited 1" — identical — and a
  // step that had just fixed two of three errors would be abandoned as stuck.
  const before = [
    makeFinding("command-failed", undefined, "`bun run build` exited 1\nerror TS2304: Cannot find name 'Foo'.\nerror TS2551: Property 'bar' does not exist.\nerror TS7006: Parameter 'x' implicitly has an 'any' type."),
  ];
  const after = [
    makeFinding("command-failed", undefined, "`bun run build` exited 1\nerror TS7006: Parameter 'x' implicitly has an 'any' type."),
  ];

  expect(failureSignature(before)).not.toBe(failureSignature(after));
});
