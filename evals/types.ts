// evals/types.ts
//
// Shared type definitions for the eval harness.
//
// These types define the contract between golden-task definitions,
// deterministic checks, and the runner. All checks are code-executed,
// never LLM-judged.

/**
 * A golden task is a repeatable scenario with a deterministic pass/fail check.
 *
 * Each task defines:
 *   - A prompt to send to the orchestrator
 *   - Which mode to run in (build or plan)
 *   - Optional pre-canned clarifier answers (for non-interactive plan-mode runs)
 *   - A check function that inspects the workspace after execution
 *   - An optional repeat count for flaky/probabilistic tasks
 */
export interface GoldenTask {
  /** Unique identifier for this task (used in CLI filtering and reports). */
  id: string;

  /** The prompt to send to the orchestrator. */
  prompt: string;

  /** Which orchestrator mode to run in. */
  mode: "build" | "plan";

  /**
   * Pre-canned answers to clarifying questions. If provided, the runner
   * will supply these when the orchestrator emits "clarification-needed"
   * instead of prompting a user. Keys are question indices (as strings).
   */
  clarifierAnswers?: Record<string, string>;

  /**
   * Deterministic check function run against the workspace after the
   * orchestrator completes. Must return { passed, detail } — never
   * involve an LLM in the judgment.
   */
  expectedCheck: (workspaceDir: string) => Promise<{ passed: boolean; detail: string }>;

  /**
   * How many times to run this task. Default 1.
   * Set >1 for known-flaky or probabilistic tasks.
   * The runner reports pass rate, not a single boolean.
   */
  repeat?: number;
}

/**
 * Result of running a single golden task (possibly multiple times).
 */
export interface TaskResult {
  /** The task's unique identifier. */
  id: string;

  /** Fraction of runs that passed (0.0 to 1.0). */
  passRate: number;

  /** Total number of runs executed. */
  runs: number;

  /** Failure details from checks or caught errors — one entry per failed run. */
  failures: string[];
}
