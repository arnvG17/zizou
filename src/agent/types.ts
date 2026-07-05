// src/agent/types.ts
//
// LAYER: agent/
//
// Shared type definitions used across the orchestration loop modules:
//   orchestrator.ts, clarifier.ts, planner.ts, executor.ts, verifier.ts
//
// These types are the CONTRACT between modules — changing a field here
// affects all consumers. Keep interfaces focused and stable.
//
// DEPENDENCY DIRECTION: this file imports from NOTHING in the project.
// It defines pure data shapes only. If you need to reference types from
// tools/ or sdk/, import them in the consuming module, not here.

// ─── Plan Step ───────────────────────────────────────────────────────────────
//
// A single unit of work in a multi-step plan. The planner generates these;
// the executor receives one at a time; the verifier checks each one after
// execution.

/**
 * Represents one atomic step in a plan.
 *
 * In plan mode, the planner generates an array of these with explicit
 * dependency ordering. In build mode, the orchestrator synthesizes a
 * single PlanStep directly from the user's raw prompt.
 *
 * The `dependsOn` field is critical for preventing the write-before-scaffold
 * ordering bug: step 3 ("write component code") must declare dependsOn: [2]
 * ("create component file") so the orchestrator processes them in order.
 */
export interface PlanStep {
  /** Zero-based index within the plan array. */
  index: number;

  /** Human-readable description of what this step does. */
  description: string;

  /**
   * Files this step expects to create or modify.
   * Used by the verifier to check filesystem state after execution.
   */
  targetFiles: string[];

  /**
   * Indices of other PlanSteps that must complete before this one.
   * Enforced by the orchestrator to guarantee correct execution order.
   * Empty array means no dependencies (can run immediately).
   */
  dependsOn: number[];
}

// ─── Tool Call Record ────────────────────────────────────────────────────────
//
// A lightweight record of a tool invocation made during step execution.
// The executor captures these as the LLM calls tools; the verifier uses
// them as a secondary signal (but does NOT trust them as sole evidence
// of what changed — filesystem state is ground truth).

/**
 * Record of a single tool invocation during step execution.
 * Captured by the executor, consumed by the verifier.
 */
export interface ToolCall {
  toolName: string;
  toolCallId: string;
  input: unknown;
  output: unknown;
}

// ─── Step Result ─────────────────────────────────────────────────────────────
//
// What the executor returns after running a single PlanStep. Contains
// both the model's CLAIMS (which files it says it changed) and the
// raw tool call log. The verifier cross-references these against actual
// filesystem state.

/**
 * Result of executing a single PlanStep.
 *
 * IMPORTANT: `claimedFiles` is what the model SAYS it changed. The
 * verifier independently checks the filesystem to confirm — never trust
 * the model's self-report alone.
 */
export interface StepResult {
  /** Which PlanStep this result corresponds to. */
  stepIndex: number;

  /**
   * Files the model claims to have created or modified during this step.
   * Extracted from writeFile/editFile tool calls in the execution trace.
   */
  claimedFiles: string[];

  /** Full log of every tool call made during this step's execution. */
  toolCallsMade: ToolCall[];

  /** All agent events emitted during execution (including finish with usage). */
  agentEvents: import("./run-turn.js").AgentEvent[];
}

// ─── Verification Result ─────────────────────────────────────────────────────
//
// Output of the verifier. Tells the orchestrator whether the executor's
// claimed changes actually match filesystem reality.

/**
 * Result of verifying a step's execution against filesystem state.
 *
 * `verified` is true only when every claimed file actually changed AND
 * no unexpected files were modified. `mismatches` lists specific
 * discrepancies for debugging.
 */
export interface VerificationResult {
  /** true if filesystem state matches the executor's claims. */
  verified: boolean;

  /**
   * Human-readable descriptions of what went wrong. Examples:
   *   - "claimed-changed-but-unchanged: src/foo.ts"
   *   - "changed-but-not-claimed: src/bar.ts"
   * Empty when verified is true.
   */
  mismatches: string[];
}

// ─── Project Context ─────────────────────────────────────────────────────────
//
// The ambient project information that every agent role needs. Passed
// through the orchestrator to clarifier, planner, and executor. Does NOT
// contain the system prompt itself — that's built fresh per role by
// context-assembler using the `role` parameter.

/**
 * Ambient project information passed to every agent role.
 */
export interface ProjectContext {
  /** Absolute path to the workspace root (process.cwd()). */
  projectRoot: string;

  /**
   * The pre-built system prompt for this role's context.
   * Built by build-system-prompt.ts with the appropriate AgentRole.
   */
  systemPrompt: string;

  /**
   * Context budget level. Affects how much information is included
   * in the system prompt. "light" excludes repo map for executor
   * (but NOT for clarifier/planner — see build-system-prompt.ts).
   */
  budget: "light" | "default" | "max";
}

// ─── Clarifying Question ─────────────────────────────────────────────────────
//
// Produced by the clarifier in plan mode. The orchestrator presents these
// to the user before invoking the planner.

/**
 * A question the clarifier wants to ask before planning begins.
 *
 * `required` questions block planning until answered. Optional questions
 * can be skipped — the planner will make reasonable assumptions.
 */
export interface ClarifyingQuestion {
  /** The question text to display to the user. */
  question: string;

  /**
   * If true, the planner cannot proceed without an answer.
   * If false, the user can skip and the planner will assume defaults.
   */
  required: boolean;
}

// ─── Escalation ──────────────────────────────────────────────────────────────
//
// Deterministic (non-LLM) triggers that cause the orchestrator to pause
// build-mode execution and ask the user whether to switch to plan mode.
//
// This is the alternative to the rejected "upfront LLM classification"
// approach: instead of guessing complexity before execution, we detect
// it DURING execution based on concrete signals.

/**
 * A deterministic signal that a build-mode step exceeded the expected
 * scope of a "simple" one-shot fix. The orchestrator surfaces this to
 * the user as a prompt to switch to plan mode.
 *
 * `reason` values:
 *   "verification-failed"      — the verifier found mismatches between
 *                                 claimed and actual filesystem state
 *   "touched-too-many-files"   — the executor's claimed file count
 *                                 exceeded FILE_THRESHOLD (default 3)
 *   "step-implies-dependency"  — reserved for future use: the step's
 *                                 tool calls suggest it needs to create
 *                                 files that don't exist yet (scaffolding)
 */
export interface EscalationTrigger {
  reason: "verification-failed" | "touched-too-many-files" | "step-implies-dependency";
}
