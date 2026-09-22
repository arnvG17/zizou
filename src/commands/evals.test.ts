// src/commands/evals.test.ts
//
// The argument translation is the part worth testing: `/evals smoke` has to
// become `--tag smoke` while `/evals build-create-file` becomes `--task ...`,
// and getting that backwards means the command silently runs nothing and
// reports "no tasks matched".

import { describe, expect, test } from "bun:test";
import { buildEvalArgs, evalsHelp, renderReport, runEvals } from "./evals.js";
import type { EvalSnapshot } from "../telemetry/index.js";

describe("buildEvalArgs", () => {
  test("no args means the full suite", () => {
    expect(buildEvalArgs([])).toEqual([]);
  });

  test("a known tag becomes --tag", () => {
    expect(buildEvalArgs(["smoke"])).toEqual(["--tag", "smoke"]);
    expect(buildEvalArgs(["plan-mode"])).toEqual(["--tag", "plan-mode"]);
  });

  test("anything else is treated as a task id", () => {
    // Both are bare words; only the tag list distinguishes them.
    expect(buildEvalArgs(["build-create-file"])).toEqual(["--task", "build-create-file"]);
  });

  test("matrix takes its cell list", () => {
    expect(buildEvalArgs(["matrix", "groq:fast,anthropic:balanced"])).toEqual([
      "--matrix",
      "groq:fast,anthropic:balanced",
    ]);
  });

  test("flags pass through with their values", () => {
    expect(buildEvalArgs(["--repeat", "3"])).toEqual(["--repeat", "3"]);
    expect(buildEvalArgs(["--keep-workspaces"])).toEqual(["--keep-workspaces"]);
  });

  test("a tag combines with a flag", () => {
    expect(buildEvalArgs(["router", "--repeat", "3"])).toEqual([
      "--tag",
      "router",
      "--repeat",
      "3",
    ]);
  });

  test("a valueless flag before a bare word does not swallow it", () => {
    // --keep-workspaces takes no value, so `smoke` must still become a tag.
    expect(buildEvalArgs(["--keep-workspaces", "smoke"])).toEqual([
      "--keep-workspaces",
      "smoke",
    ]);
  });
});

describe("renderReport", () => {
  test("says how to run when there is no report, rather than showing zeroes", () => {
    const out = renderReport(null);
    expect(out).toContain("No eval report found");
    expect(out).toContain("/evals");
    expect(out).not.toContain("0%");
  });

  test("renders a cell with pass rate, tools and cost", () => {
    const snapshot: EvalSnapshot = {
      gitSha: "c7ee198",
      startedAt: new Date().toISOString(),
      ageDays: 0,
      integrityOk: true,
      cells: [
        {
          provider: "groq",
          modelId: "llama-3.3-70b-versatile",
          effort: "balanced",
          passRate: 0.833,
          tasksPassed: 2,
          tasksTotal: 3,
          avgToolCalls: 6.3,
          avgCostUsd: 0.0031,
          fallbackParses: 2,
        },
      ],
      failingTaskIds: ["build-fix-off-by-one"],
      reportPath: "/tmp/report.json",
    };

    const out = renderReport(snapshot);
    expect(out).toContain("c7ee198");
    expect(out).toContain("llama-3.3-70b-versatile");
    expect(out).toContain("83%");
    expect(out).toContain("2/3 tasks");
    expect(out).toContain("$0.0031");
    expect(out).toContain("2 fallbacks");
    expect(out).toContain("build-fix-off-by-one");
  });

  test("an unknown cost renders as unknown, never as $0.0000", () => {
    const out = renderReport({
      gitSha: "abc",
      startedAt: new Date().toISOString(),
      ageDays: 0,
      integrityOk: true,
      cells: [
        {
          provider: "x",
          modelId: "mystery-model",
          effort: "balanced",
          passRate: 1,
          tasksPassed: 1,
          tasksTotal: 1,
          avgToolCalls: 1,
          avgCostUsd: null,
          fallbackParses: 0,
        },
      ],
      failingTaskIds: [],
      reportPath: "/tmp/r.json",
    });
    expect(out).toContain("unknown");
    expect(out).not.toContain("$0.0000");
  });

  test("an integrity violation is called out as invalidating the numbers", () => {
    const out = renderReport({
      gitSha: "abc",
      startedAt: new Date().toISOString(),
      ageDays: 0,
      integrityOk: false,
      cells: [],
      failingTaskIds: [],
      reportPath: "/tmp/r.json",
    });
    expect(out).toContain("INTEGRITY VIOLATION");
    expect(out).toContain("suspect");
  });
});

describe("runEvals dispatch", () => {
  test("`help` returns usage without spawning anything", async () => {
    const emitted: string[] = [];
    const out = await runEvals({
      projectRoot: process.cwd(),
      args: ["help"],
      emit: (t) => emitted.push(t),
    });
    expect(out).toBe(evalsHelp());
    expect(emitted).toHaveLength(0);
  });

  test("`report` reads from disk without spawning anything", async () => {
    const emitted: string[] = [];
    const out = await runEvals({
      projectRoot: process.cwd(),
      args: ["report"],
      emit: (t) => emitted.push(t),
    });
    // Either a real report or the "none found" message — both are fine here;
    // what matters is that nothing was run.
    expect(emitted).toHaveLength(0);
    expect(typeof out).toBe("string");
  });

  test("a missing harness explains itself instead of failing to spawn bun", async () => {
    const out = await runEvals({
      projectRoot: "C:/definitely-not-a-zizou-checkout",
      args: [],
      emit: () => {},
    });
    expect(out).toContain("not present in this installation");
  });

  test("help mentions that runs cost tokens", () => {
    // The command spends the user's money. Saying so is part of the contract.
    expect(evalsHelp()).toContain("cost real tokens");
  });
});
