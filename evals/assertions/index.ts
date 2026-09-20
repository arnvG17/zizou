// evals/assertions/index.ts
//
// The assertion library. Replaces evals/checks/, which was three bare
// predicates returning `boolean` — `fileExists`, `grepContains`,
// `bashSucceeds`. Every task then had to wrap each call in its own
// if/return ladder to turn a boolean into a reportable result, and a `false`
// carried no explanation, so the ladder also had to hand-write the message.
//
// Here, an assertion IS the reportable result: it names itself, and it
// explains what it found whether it passed or failed. A task is a list of
// these, which is why the runner can report five conditions instead of the
// first one that broke.
//
// EVERY ASSERTION IS CODE-EXECUTED. No assertion may call a model. If you
// find yourself wanting an LLM judge, the task is under-specified — narrow
// the prompt until a deterministic check can settle it.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Assertion } from "../types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function read(workspaceDir: string, relPath: string): string | null {
  try {
    return readFileSync(resolve(workspaceDir, relPath), "utf-8");
  } catch {
    return null;
  }
}

/** Squashes whitespace so formatting differences don't fail a content check. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ─── Combinators ─────────────────────────────────────────────────────────────

/**
 * Passes when ANY branch passes. Reports every branch either way.
 *
 * Needed because a task list is an AND, and some correct behaviours are
 * genuinely a disjunction: asked to edit a file that does not exist, an agent
 * may either create it or refuse, and both are right. The old harness expressed
 * this by hand-coding the or-branch inside one check function, which is how
 * `plan-mode-deliberate-failure` grew a 60-line check with three nested
 * try/catch blocks and two different notions of passing.
 */
export function anyOf(label: string, ...branches: Assertion[]): Assertion {
  return async (ctx) => {
    const results = await Promise.all(branches.map((b) => b(ctx)));
    const winner = results.find((r) => r.passed);
    return {
      name: `any of: ${label}`,
      passed: Boolean(winner),
      detail: winner
        ? `satisfied by "${winner.name}" (${winner.detail})`
        : `no branch passed:\n${results.map((r) => `      - ${r.name}: ${r.detail}`).join("\n")}`,
    };
  };
}

/** Inverts an assertion, keeping its detail so a failure is still explained. */
export function not(label: string, inner: Assertion): Assertion {
  return async (ctx) => {
    const r = await inner(ctx);
    return { name: `not: ${label}`, passed: !r.passed, detail: r.detail };
  };
}

/** Marks an assertion advisory: reported, but never fails the task. */
export function advisory(inner: Assertion): Assertion {
  return async (ctx) => ({ ...(await inner(ctx)), advisory: true });
}

// ─── Filesystem assertions ───────────────────────────────────────────────────

/** The file exists and is a regular file. */
export function fileExists(relPath: string): Assertion {
  return async ({ workspaceDir }) => {
    const abs = resolve(workspaceDir, relPath);
    if (!existsSync(abs)) {
      return { name: `exists: ${relPath}`, passed: false, detail: `not found at ${abs}` };
    }
    try {
      if (!statSync(abs).isFile()) {
        return { name: `exists: ${relPath}`, passed: false, detail: `${relPath} exists but is not a file` };
      }
    } catch (e) {
      return { name: `exists: ${relPath}`, passed: false, detail: `stat failed: ${String(e)}` };
    }
    return { name: `exists: ${relPath}`, passed: true, detail: `found at ${abs}` };
  };
}

/** The path does NOT exist. For "did not touch what it was not asked to". */
export function fileAbsent(relPath: string): Assertion {
  return async ({ workspaceDir }) => {
    const abs = resolve(workspaceDir, relPath);
    const there = existsSync(abs);
    return {
      name: `absent: ${relPath}`,
      passed: !there,
      detail: there ? `unexpectedly present at ${abs}` : "correctly absent",
    };
  };
}

/** The file's contents match a pattern. Reports a content preview on failure. */
export function fileMatches(relPath: string, pattern: RegExp): Assertion {
  return async ({ workspaceDir }) => {
    const name = `matches ${pattern}: ${relPath}`;
    const content = read(workspaceDir, relPath);
    if (content === null) {
      return { name, passed: false, detail: `cannot read ${relPath}` };
    }
    if (pattern.test(content)) {
      return { name, passed: true, detail: `pattern found in ${content.length} bytes` };
    }
    const preview = content.slice(0, 300).replace(/\n/g, "\\n");
    return { name, passed: false, detail: `pattern absent. content starts: "${preview}"` };
  };
}

/** The file contains this literal text, ignoring whitespace differences. */
export function fileContains(relPath: string, needle: string): Assertion {
  return async ({ workspaceDir }) => {
    const name = `contains "${needle.slice(0, 40)}": ${relPath}`;
    const content = read(workspaceDir, relPath);
    if (content === null) return { name, passed: false, detail: `cannot read ${relPath}` };
    const found = normalize(content).includes(normalize(needle));
    return {
      name,
      passed: found,
      detail: found ? "present" : `absent from ${content.length} bytes`,
    };
  };
}

/** The file does NOT contain this text — for "removed the bug, not just added a fix". */
export function fileLacks(relPath: string, needle: string): Assertion {
  return async ({ workspaceDir }) => {
    const name = `lacks "${needle.slice(0, 40)}": ${relPath}`;
    const content = read(workspaceDir, relPath);
    if (content === null) return { name, passed: false, detail: `cannot read ${relPath}` };
    const found = normalize(content).includes(normalize(needle));
    return {
      name,
      passed: !found,
      detail: found ? "still present — the old text was not removed" : "correctly absent",
    };
  };
}

// ─── Behavioural assertions ──────────────────────────────────────────────────

/**
 * A shell command in the workspace exits 0.
 *
 * Captures stdout/stderr and puts them in the detail, because "the build
 * failed" without the compiler's message costs you the whole debugging session.
 */
export function commandSucceeds(command: string, timeoutMs = 60_000): Assertion {
  return async ({ workspaceDir }) => {
    const name = `exits 0: ${command}`;
    const { code, out } = await runCommand(command, workspaceDir, timeoutMs);
    return {
      name,
      passed: code === 0,
      detail:
        code === 0
          ? "exit 0"
          : `exit ${code ?? "timeout/error"}. output:\n${out.slice(0, 1200)}`,
    };
  };
}

/** A shell command exits non-zero — for asserting a test still fails. */
export function commandFails(command: string, timeoutMs = 60_000): Assertion {
  return async ({ workspaceDir }) => {
    const name = `exits non-zero: ${command}`;
    const { code, out } = await runCommand(command, workspaceDir, timeoutMs);
    return {
      name,
      passed: code !== 0,
      detail: code !== 0 ? `exit ${code}` : `unexpectedly exited 0. output:\n${out.slice(0, 600)}`,
    };
  };
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolvePromise) => {
    // `shell: true` rather than spawning an explicit interpreter.
    //
    // The old checks/bash-succeeds.ts hardcoded `spawn("cmd", ["/c", ...])` on
    // Windows, and bare "cmd" does not always resolve — under Bun here it fails
    // with `Executable not found in $PATH: "cmd"`. That surfaced as the command
    // exiting non-zero, which the old boolean-returning check reported as a
    // plain `false`. Every command-based assertion would have failed, and the
    // report would have blamed the model. Letting the runtime pick the platform
    // shell removes the guess.
    const child = spawn(command, {
      cwd,
      stdio: "pipe",
      shell: true,
    });

    let out = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.stderr?.on("data", (d) => {
      out += String(d);
    });

    // Own the timeout rather than using spawn's `timeout` option, which does
    // not reliably fire for shell children on Windows.
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ code: null, out: `${out}\n[assertion] killed after ${timeoutMs}ms` });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({ code: null, out: `${out}\n[assertion] spawn error: ${String(e)}` });
    });
  });
}

// ─── Assertions about the run itself ─────────────────────────────────────────
//
// These read the journal, not the workspace. They are how a task says something
// about HOW the work was done, which is most of what distinguishes models on
// agentic tasks.

/** The run actually changed these files — per the journal's ground-truth diffs. */
export function touchedFiles(...expected: string[]): Assertion {
  return async ({ totals }) => {
    const actual = new Set(totals.filesTouched);
    const missing = expected.filter((f) => !actual.has(f));
    return {
      name: `touched: ${expected.join(", ")}`,
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `all present. run touched: ${totals.filesTouched.join(", ") || "(nothing)"}`
          : `missing ${missing.join(", ")}. run touched: ${totals.filesTouched.join(", ") || "(nothing)"}`,
    };
  };
}

/** The run changed nothing outside this set. Catches collateral edits. */
export function touchedNothingBut(...allowed: string[]): Assertion {
  return async ({ totals }) => {
    const extra = totals.filesTouched.filter((f) => !allowed.includes(f));
    return {
      name: `touched nothing but: ${allowed.join(", ")}`,
      passed: extra.length === 0,
      detail: extra.length === 0 ? "no collateral changes" : `also changed: ${extra.join(", ")}`,
    };
  };
}

/** No tool call failed. Advisory by default — a recovered failure is not a bug. */
export function noToolFailures(advisory = true): Assertion {
  return async ({ totals }) => ({
    name: "no failed tool calls",
    passed: totals.toolFailures === 0,
    detail: `${totals.toolFailures} of ${totals.toolCalls} tool calls failed`,
    advisory,
  });
}

/**
 * The model used native tool-calling throughout, never the text-parsing
 * fallback. Advisory by default: it is a model-capability measurement, and
 * failing small models on it would just mark them all red without informing.
 */
export function noFallbackParsing(advisory = true): Assertion {
  return async ({ totals }) => ({
    name: "native tool-calling only",
    passed: totals.fallbackParses === 0,
    detail:
      totals.fallbackParses === 0
        ? "no pseudo-call parsing needed"
        : `fell back to text parsing ${totals.fallbackParses}x`,
    advisory,
  });
}

/** The plan had at least this many steps — for plan-mode decomposition tasks. */
export function planHasAtLeast(n: number): Assertion {
  return async ({ events }) => {
    const plan = events.find((e) => e.kind === "plan");
    const count = Array.isArray(plan?.steps) ? plan.steps.length : 0;
    return {
      name: `plan has >= ${n} steps`,
      passed: count >= n,
      detail: plan ? `plan had ${count} steps` : "no plan event in journal",
    };
  };
}

/**
 * The agent stated its assumptions rather than silently guessing.
 *
 * Deliberately only counts THAT assumptions exist, not what they say — judging
 * their content would need a model, and this file does not get to call one.
 */
export function statedAssumptions(min = 1): Assertion {
  return async ({ events }) => {
    const plan = events.find((e) => e.kind === "plan");
    const count = Array.isArray(plan?.assumptions) ? plan.assumptions.length : 0;
    return {
      name: `stated >= ${min} assumption(s)`,
      passed: count >= min,
      detail: count > 0 ? `stated ${count}: ${(plan!.assumptions as string[]).join(" | ")}` : "none stated",
    };
  };
}

/** Every verification step the orchestrator ran came back clean. */
export function allStepsVerified(): Assertion {
  return async ({ events }) => {
    const checks = events.filter((e) => e.kind === "verification");
    const failed = checks.filter((e) => !e.verified);
    return {
      name: "all steps verified",
      passed: failed.length === 0,
      detail:
        checks.length === 0
          ? "no verification events recorded"
          : failed.length === 0
            ? `${checks.length}/${checks.length} verified`
            : `${failed.length} failed: ${failed.map((f) => (f.mismatches ?? []).join(",")).join(" | ")}`,
    };
  };
}

// ─── Routing ─────────────────────────────────────────────────────────────────

/**
 * Auto mode routed this prompt to the expected route.
 *
 * Reads the phase event the runner writes from "mode-info", which carries the
 * route the orchestrator actually ran. Deterministic: it inspects a recorded
 * fact about the run, not the quality of the answer.
 *
 * Note this does NOT assert the route was a good choice — only that the
 * classifier and the dispatch agree with the task's expectation. A task that
 * wants to claim more should also assert on what the run touched.
 */
export function routedTo(expected: string): Assertion {
  return async ({ events }) => {
    const phases = events.filter(
      (e) => e.kind === "phase" && typeof e.detail === "string" && e.detail.startsWith("mode="),
    );
    const actual = phases[0]?.detail?.match(/^mode=(\w+)/)?.[1];

    return {
      name: `routed to ${expected}`,
      passed: actual === expected,
      detail: actual
        ? `routed to ${actual}${actual === expected ? "" : ` (${phases[0].detail})`}`
        : "no route recorded in journal",
    };
  };
}

/**
 * Nothing was written directly into the workspace root.
 *
 * The failure this exists for: asked for an app, the agent drops a pile of
 * loose .html and .tsx files at the top level next to package.json. A file one
 * directory down is fine; a bare filename at the root is not.
 *
 * `allowed` names the root files a task legitimately expects (a README, a
 * package.json), so the assertion stays about misplacement rather than about
 * writing to the root at all.
 */
export function nothingAtRoot(...allowed: string[]): Assertion {
  return async ({ totals }) => {
    // Windows journals report backslashes, so a path check that only knows
    // about "/" would see every nested file as a bare root filename.
    const toPosix = (f: string) => f.split("\\").join("/");

    const permitted = new Set(allowed.map(toPosix));
    const offenders = (totals.filesTouched ?? [])
      .map(toPosix)
      .filter((f) => !f.includes("/") && !permitted.has(f));

    return {
      name: "nothing written at the workspace root",
      passed: offenders.length === 0,
      detail:
        offenders.length === 0
          ? "all new files placed in a directory"
          : `written at the root: ${offenders.join(", ")}`,
    };
  };
}
