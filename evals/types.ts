// evals/types.ts
//
// The eval harness contract.
//
// WHAT CHANGED AND WHY (the old contract is gone):
//
//   The previous GoldenTask had a single `expectedCheck(workspaceDir)` that
//   returned `{ passed, detail }`. One function, one boolean, one string. Three
//   problems followed from that shape:
//
//     1. A failing task told you one thing. The first `if (!exists) return`
//        short-circuited, so you learned "hello.txt was not created" and
//        nothing about the four other conditions the task cared about. Every
//        task re-implemented the same early-return ladder by hand.
//
//     2. Tasks could not start from a fixture. The runner made an empty temp
//        directory, so any task needing a starting codebase had to write those
//        files inside its own check function, or — as two tasks did — leave
//        files behind in temp-workspaces/ that then got committed.
//
//     3. Pass/fail was the only output. A model that passed in 3 steps for
//        $0.001 scored identically to one that passed in 28 steps for $0.40
//        after nine failed tool calls. That is the difference that matters when
//        the point is comparing models, and the old shape could not express it.
//
//   The new contract splits those apart: `setup` seeds the workspace,
//   `assertions` is a list that ALL run (no short-circuit), and the runner
//   derives metrics from the run journal rather than from the task.
//
// THE ONE RULE THAT DID NOT CHANGE: assertions are code-executed, never
// LLM-judged. An eval whose grader is itself a sampled model cannot tell you
// whether the agent regressed or the grader drifted.

import type { RunTotals } from "../src/agent/debug/index.js";
import type { Mode } from "../src/agent/mode.js";

// ─── Assertions ──────────────────────────────────────────────────────────────

/**
 * The evidence an assertion gets to look at.
 *
 * Deliberately includes the journal totals and the raw journal events: an
 * assertion may legitimately want to say "and it did this without shelling
 * out" or "without needing the fallback parser", which is a fact about the
 * run, not about the resulting files.
 */
export interface AssertionContext {
  /** Absolute path to this run's disposable workspace. */
  workspaceDir: string;
  /** Totals accumulated by the run journal. */
  totals: RunTotals;
  /** Every journal event, parsed from the run's .jsonl. */
  events: Array<Record<string, any>>;
}

export interface AssertionResult {
  /** Short name shown in the report, e.g. `file exists: hello.txt`. */
  name: string;
  passed: boolean;
  /** What was actually found. Must be useful when passed is false. */
  detail: string;
  /**
   * When false, a failure is reported but does not fail the task.
   * For conditions worth watching that are not yet contractual.
   */
  advisory?: boolean;
}

/** An assertion is a named predicate over the finished run. */
export type Assertion = (ctx: AssertionContext) => Promise<AssertionResult>;

// ─── Tasks ───────────────────────────────────────────────────────────────────

/** Files to write into the workspace before the agent starts. */
export type Fixture = Record<string, string>;

export interface GoldenTask {
  /** Unique id. Used by --task and as the report row label. */
  id: string;

  /** One line on what this task is actually testing. Shows up in the report. */
  intent: string;

  /** The prompt sent to the orchestrator. */
  prompt: string;

  /**
   * Which mode to PIN for this run.
   *
   * "auto" lets the router choose, which is the only way to eval the router
   * itself — pair it with routedTo() to assert what it picked. Every other
   * value pins that route and skips the classification call entirely.
   */
  mode: Mode;

  /**
   * Files seeded into the fresh workspace before the run, keyed by relative
   * path. This is how a task gets a starting codebase without the runner
   * needing to know anything about the task.
   */
  fixture?: Fixture;

  /**
   * ALL of these run, and all of their results are reported. The task passes
   * when every non-advisory assertion passes.
   */
  assertions: Assertion[];

  /**
   * Per-run ceilings. Exceeding one fails the run with a `budget` category,
   * which keeps "it technically passed after 40 steps" from reading as a pass.
   */
  budget?: {
    maxSteps?: number;
    maxToolCalls?: number;
    maxDurationMs?: number;
    maxTotalTokens?: number;
  };

  /** How many times to run. >1 gives a pass rate instead of a boolean. */
  repeat?: number;

  /** Free-form labels for filtering, e.g. ["tool-calling", "plan-mode"]. */
  tags?: string[];
}

// ─── Results ─────────────────────────────────────────────────────────────────

/** Why a run failed, so the report can group failures by cause. */
export type FailureCategory =
  | "assertion"
  | "budget"
  | "verification"
  | "exception"
  | "rate-limit";

export interface RunOutcome {
  /** 0-based index of this run within the task's repeats. */
  runIndex: number;
  passed: boolean;
  /** Every assertion's result, including the ones that passed. */
  assertions: AssertionResult[];
  /** Populated when passed is false. */
  failureCategory?: FailureCategory;
  failureDetail?: string;
  /** Journal totals for this run — the source of every metric below. */
  totals: RunTotals;
  /** Estimated USD, or null when the model has no known rate. */
  costUsd: number | null;
  /** Where the journal for this run was written. Kept on failure. */
  journalPath: string;
  /** Kept only when the run failed, so a failure can be inspected. */
  workspaceDir?: string;
}

export interface TaskResult {
  id: string;
  intent: string;
  runs: RunOutcome[];
  /** Fraction of runs that passed, 0.0 - 1.0. */
  passRate: number;
}

/** One provider/model/effort combination, run across the whole suite. */
export interface MatrixCell {
  provider: string;
  modelId: string;
  effort: string;
}

export interface SuiteReport {
  startedAt: string;
  finishedAt: string;
  gitSha: string;
  zizouVersion: string;
  cell: MatrixCell;
  tasks: TaskResult[];
  /** Whether the project directory was untouched by the suite. */
  integrityOk: boolean;
}
