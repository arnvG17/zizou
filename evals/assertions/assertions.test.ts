// evals/assertions/assertions.test.ts
//
// The assertions decide whether a model passed. If one of them is wrong, every
// number in the report is wrong, and silently so — a broken assertion does not
// crash, it just grades incorrectly. So they are tested directly, against real
// files on disk rather than mocks.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssertionContext } from "../types.js";
import type { RunTotals } from "../../src/agent/debug/index.js";
import {
  advisory,
  allStepsVerified,
  anyOf,
  commandSucceeds,
  fileAbsent,
  fileContains,
  fileExists,
  fileLacks,
  fileMatches,
  noFallbackParsing,
  planHasAtLeast,
  statedAssumptions,
  touchedFiles,
  touchedNothingBut,
} from "./index.js";

function emptyTotals(over: Partial<RunTotals> = {}): RunTotals {
  return {
    durationMs: 0,
    llmCalls: 0,
    toolCalls: 0,
    toolFailures: 0,
    fallbackParses: 0,
    duplicatesBlocked: 0,
    filesCreated: 0,
    filesModified: 0,
    filesDeleted: 0,
    linesAdded: 0,
    linesRemoved: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    filesTouched: [],
    ...over,
  };
}

function ctx(over: Partial<AssertionContext> = {}): AssertionContext {
  return { workspaceDir: ".", totals: emptyTotals(), events: [], ...over };
}

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "zizou-assert-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf-8");
  }
  return dir;
}

describe("filesystem assertions", () => {
  test("fileExists passes for a real file and explains a miss", async () => {
    const dir = workspace({ "a.txt": "hi" });
    expect((await fileExists("a.txt")(ctx({ workspaceDir: dir }))).passed).toBe(true);

    const miss = await fileExists("nope.txt")(ctx({ workspaceDir: dir }));
    expect(miss.passed).toBe(false);
    expect(miss.detail).toContain("not found");
    rmSync(dir, { recursive: true, force: true });
  });

  test("fileAbsent is the inverse", async () => {
    const dir = workspace({ "a.txt": "hi" });
    expect((await fileAbsent("a.txt")(ctx({ workspaceDir: dir }))).passed).toBe(false);
    expect((await fileAbsent("b.txt")(ctx({ workspaceDir: dir }))).passed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fileMatches includes a content preview when it fails", async () => {
    const dir = workspace({ "a.txt": "goodbye world" });
    const r = await fileMatches("a.txt", /hello/)(ctx({ workspaceDir: dir }));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("goodbye world");
    rmSync(dir, { recursive: true, force: true });
  });

  test("fileContains ignores whitespace differences", async () => {
    const dir = workspace({ "a.ts": "export   function\n  greet(name) {}" });
    const r = await fileContains("a.ts", "export function greet(name)")(ctx({ workspaceDir: dir }));
    expect(r.passed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fileLacks catches a bug left in place beside its fix", async () => {
    // The real failure mode this exists for: the model adds a correct loop but
    // leaves the broken one above it, so a behavioural check could still pass.
    const dir = workspace({ "calc.js": "for (i < n - 1) {}\nfor (i < n) {}" });
    const r = await fileLacks("calc.js", "n - 1")(ctx({ workspaceDir: dir }));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("not removed");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing file fails fileLacks rather than vacuously passing", async () => {
    const dir = workspace();
    const r = await fileLacks("gone.js", "anything")(ctx({ workspaceDir: dir }));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("cannot read");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("commandSucceeds", () => {
  test("passes on exit 0", async () => {
    const dir = workspace();
    const r = await commandSucceeds("node -e \"process.exit(0)\"")(ctx({ workspaceDir: dir }));
    expect(r.passed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fails on non-zero AND captures the output", async () => {
    const dir = workspace();
    const r = await commandSucceeds(
      "node -e \"console.error('BOOM'); process.exit(3)\"",
    )(ctx({ workspaceDir: dir }));
    expect(r.passed).toBe(false);
    // Without the captured output a failing build tells you nothing.
    expect(r.detail).toContain("BOOM");
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs in the workspace, not the project directory", async () => {
    const dir = workspace({ "marker.txt": "x" });
    const r = await commandSucceeds(
      "node -e \"require('fs').statSync('marker.txt')\"",
    )(ctx({ workspaceDir: dir }));
    expect(r.passed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("run assertions", () => {
  test("touchedFiles reads the journal totals", async () => {
    const good = await touchedFiles("a.ts")(
      ctx({ totals: emptyTotals({ filesTouched: ["a.ts", "b.ts"] }) }),
    );
    expect(good.passed).toBe(true);

    const bad = await touchedFiles("c.ts")(
      ctx({ totals: emptyTotals({ filesTouched: ["a.ts"] }) }),
    );
    expect(bad.passed).toBe(false);
    expect(bad.detail).toContain("missing c.ts");
  });

  test("touchedNothingBut catches collateral edits", async () => {
    const r = await touchedNothingBut("a.ts")(
      ctx({ totals: emptyTotals({ filesTouched: ["a.ts", "package.json"] }) }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("package.json");
  });

  test("noFallbackParsing is advisory by default", async () => {
    const r = await noFallbackParsing()(ctx({ totals: emptyTotals({ fallbackParses: 3 }) }));
    expect(r.passed).toBe(false);
    expect(r.advisory).toBe(true);
    expect(r.detail).toContain("3x");
  });

  test("planHasAtLeast reads the plan event", async () => {
    const events = [{ kind: "plan", steps: [{ index: 0 }, { index: 1 }] }];
    expect((await planHasAtLeast(2)(ctx({ events }))).passed).toBe(true);
    expect((await planHasAtLeast(3)(ctx({ events }))).passed).toBe(false);
  });

  test("planHasAtLeast fails clearly when no plan was produced at all", async () => {
    const r = await planHasAtLeast(1)(ctx({ events: [] }));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("no plan event");
  });

  test("statedAssumptions quotes what was stated", async () => {
    const events = [{ kind: "plan", steps: [], assumptions: ["JWT auth", "no OAuth"] }];
    const r = await statedAssumptions(1)(ctx({ events }));
    expect(r.passed).toBe(true);
    expect(r.detail).toContain("JWT auth");
  });

  test("allStepsVerified reports which steps failed", async () => {
    const events = [
      { kind: "verification", stepIndex: 0, verified: true, mismatches: [] },
      { kind: "verification", stepIndex: 1, verified: false, mismatches: ["missing b.ts"] },
    ];
    const r = await allStepsVerified()(ctx({ events }));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("missing b.ts");
  });
});

describe("combinators", () => {
  test("anyOf passes when one branch does, naming the winner", async () => {
    const dir = workspace({ "a.txt": "yes" });
    const r = await anyOf(
      "either file",
      fileExists("missing.txt"),
      fileExists("a.txt"),
    )(ctx({ workspaceDir: dir }));
    expect(r.passed).toBe(true);
    expect(r.detail).toContain("a.txt");
    rmSync(dir, { recursive: true, force: true });
  });

  test("anyOf lists every branch when all fail", async () => {
    const dir = workspace();
    const r = await anyOf("either", fileExists("x.txt"), fileExists("y.txt"))(
      ctx({ workspaceDir: dir }),
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("x.txt");
    expect(r.detail).toContain("y.txt");
    rmSync(dir, { recursive: true, force: true });
  });

  test("advisory downgrades a failure without hiding it", async () => {
    const dir = workspace();
    const r = await advisory(fileExists("nope.txt"))(ctx({ workspaceDir: dir }));
    expect(r.passed).toBe(false);
    expect(r.advisory).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
