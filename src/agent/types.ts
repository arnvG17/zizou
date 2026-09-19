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

  // NOTE: there is deliberately no `agentEvents` field. executeStep is an
  // async generator and yields each AgentEvent as it happens. Buffering them
  // here as well meant the orchestrator replayed the whole step after it had
  // already finished, which defeated streaming entirely.

  /** Map of file paths to their contents before they were modified in this step. */
  oldFileStates?: Map<string, string | null>;

  /** The fully updated conversation history for this step/turn. */
  conversationHistory?: import("ai").ModelMessage[];

  /** The model tier that handled this step (hosted vs local). */
  modelTier?: "hosted" | "local";
}

// ─── Plan ────────────────────────────────────────────────────────────────────

/**
 * A complete plan: the decisions the planner made, plus the steps.
 *
 * WHY ASSUMPTIONS INSTEAD OF UPFRONT QUESTIONS: plan mode used to run a
 * clarifier first, blocking on a list of abstract questions ("Do you have a
 * preferred UI framework?") before showing anything. That was redundant with
 * the plan-approval gate that follows it, and worse to answer: you were
 * guessing at a plan you could not see.
 *
 * Now the planner picks sensible defaults, states them, and you react to a
 * concrete plan. Rejecting it and saying what is wrong is the clarification.
 */
export interface Plan {
  /**
   * Judgement calls the planner made that the user did not specify —
   * framework choice, scope, storage, and so on. Displayed above the steps.
   * Empty when the request left nothing open.
   */
  assumptions: string[];

  /** The ordered steps to execute. */
  steps: PlanStep[];
}

/**
 * A correction the user typed at the plan gate instead of y/n.
 *
 * The gate used to accept only y/n, so the single way to fix one wrong
 * assumption — a destination directory, a framework, an out-of-scope step —
 * was to reject the plan and retype the entire request. Free text at the gate
 * is a correction, not a rejection, and this is what carries it back to the
 * planner along with the plan it corrects.
 */
export interface PlanRevision {
  /** The plan the user was looking at when they typed the correction. */
  previousSteps: PlanStep[];
  /** The assumptions displayed alongside it. */
  previousAssumptions: string[];
  /** What the user typed, verbatim. */
  feedback: string;
}

// ─── Step Digest ──────────────────────────────────────────────────────

/**
 * A one-line record of a finished plan step, carried forward to later steps.
 *
 * Plan steps each get a fresh prompt — that isolation is deliberate, it stops
 * the model wandering between steps. But full isolation meant step 3 could not
 * see that step 2 had already created the helper it was about to write again,
 * and had to rediscover by searching. This is the minimum that prevents
 * duplicated work: what ran, and which files it touched. Not the transcript.
 */
export interface StepDigest {
  index: number;
  description: string;
  /** Files the step actually created or modified. */
  filesTouched: string[];
  /** False when the verifier found mismatches — later steps should know. */
  verified: boolean;
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

  /** Verbose conversational feedback explaining the verification results. */
  verboseFeedback?: string;
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
   * Cap on tool-call rounds per turn, from the effort level.
   *
   * Replaced a `budget` field that chose how much repo map to paste in.
   * There is no repo map any more — both roles search instead — so the
   * lever is how many searches they get.
   */
  maxSteps: number;

  /**
   * Sampling temperature for inference. From AIConfig.
   * Undefined = use the model provider's default.
   */
  temperature?: number;

  /**
   * Maximum output tokens per response. From AIConfig.
   * Undefined = use the model provider's default.
   */
  maxOutputTokens?: number;
}

// ─── Scope hint ─────────────────────────────────────────────────────────────
//
// A deterministic (non-LLM) observation that a finished build-mode step was
// larger than a single step usually is.
//
// ADVISORY ONLY. The orchestrator prints one line and the turn completes.
//
// This replaces EscalationTrigger, which paused execution with a modal y/n
// offering to restart the request in plan mode. That was wrong twice over:
// one of its two triggers (verification failure) fires on plenty of perfectly
// good turns, so users were interrupted routinely; and saying yes discarded
// the work the build step had already written to disk and started over.
// Nothing now changes the mode except the user.

/**
 * A signal that a build-mode step looked oversized.
 *
 * `reason` values:
 *   "touched-many-files"    — claimed file count exceeded FILE_THRESHOLD
 *   "verification-failed"   — the verifier found mismatches between claimed
 *                             and actual filesystem state
 */
export interface ScopeHint {
  reason: "touched-many-files" | "verification-failed";
  /** How many files the step claimed to touch, for the message. */
  fileCount: number;
}
