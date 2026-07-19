// src/agent/orchestrator.ts
//
// LAYER: agent/
//
// The orchestration harness — owns plan state, drives the execution loop
// differently per mode, and handles deterministic escalation.
//
// THIS IS THE INTEGRATION POINT where all the other agent/ modules
// (clarifier, planner, executor, verifier) get composed into a working
// pipeline. No other module should drive the full loop — the orchestrator
// is the single owner of execution flow.
//
// TWO MODES:
//   Build mode (default):
//     1. Synthesize a single PlanStep from the raw user prompt
//     2. Execute it via executeStep()
//     3. Verify it via verifyStep()
//     4. Check shouldEscalate() — if triggered, surface a prompt to the
//        user asking whether to switch to plan mode. NEVER auto-switch.
//
//   Plan mode (--plan flag):
//     1. Run the clarifier to gather questions
//     2. Present questions to user, collect answers
//     3. Run the planner to generate a structured plan
//     4. Display the full plan for user review (Y/n gate)
//     5. For each step in dependsOn order:
//        a. capturePreSnapshot()
//        b. executeStep()
//        c. verifyStep()
//        d. Record result
//     6. Report completion
//
// ESCALATION LOGIC (build mode only):
//   Deterministic, not LLM-judged. Two triggers:
//     - Verification failed → the executor's claims don't match reality
//     - Too many files touched → FILE_THRESHOLD exceeded
//   On trigger: STOP immediately, ask the user. If they say yes,
//   re-enter as plan mode FROM SCRATCH (fresh clarifier run, do NOT
//   reuse partial build-mode state — that state may be corrupted).
//
// EVENT STREAMING:
//   The orchestrator is an async generator that yields OrchestratorEvents.
//   The UI (Chat.tsx) consumes these events to render progress, prompts,
//   plan displays, and verification results.
//
// DEPENDENCY DIRECTION: imports from agent/ modules, context/, sdk/, tools/.
// Must NOT import from ui/ or directly from config/provider/.

import type { LanguageModel, ModelMessage } from "ai";
import type { ConfirmFn } from "../tools/types.js";
import type { Mode, ModeContext } from "./mode.js";
import type {
  PlanStep,
  StepResult,
  VerificationResult,
  ProjectContext,
  ClarifyingQuestion,
  EscalationTrigger,
} from "./types.js";
import { clarify } from "./clarifier.js";
import { plan } from "./planner.js";
import { executeStep } from "./executor.js";
import { capturePreSnapshot, verifyStep } from "./verifier.js";
import { type AgentEvent } from "./run-turn.js";
import { SessionLogger } from "./debug/index.js";
import { createCheckpoint } from "../checkpoint/manager.js";
import { captureFileState } from "../checkpoint/patcher.js";
import { resolve } from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum number of files a build-mode step can touch before escalation
 * is triggered. Set conservatively — a "simple" one-file fix should touch
 * 1-2 files. If it touches 4+, it's probably a multi-file feature that
 * deserves a plan.
 *
 * This is a tuning parameter, not a hard architectural constant. Adjust
 * based on observed behavior in real usage.
 */
const FILE_THRESHOLD = 3;

// ─── Orchestrator Events ─────────────────────────────────────────────────────
//
// The event types the orchestrator yields to the UI. These are a superset
// of AgentEvent — the orchestrator wraps raw agent events and adds its
// own control-flow events (plan display, escalation prompts, etc.).

export type OrchestratorEvent =
  // Wraps a raw AgentEvent from the executor (text-delta, tool-call, etc.)
  // so the UI can render them the same way it already does.
  | { kind: "agent-event"; event: AgentEvent }

  // Emitted when the current mode is determined or changes. The UI uses
  // this to update the mode badge in the input footer.
  | { kind: "mode-info"; mode: Mode; reason: string }

  // Plan mode: the clarifier generated questions for the user.
  // The UI presents these one at a time and collects answers.
  | { kind: "clarification-needed"; questions: ClarifyingQuestion[] }

  // Plan mode: the planner generated a structured plan.
  // The UI displays it for user review before execution begins.
  | { kind: "plan-ready"; steps: PlanStep[] }

  // Both modes: a step is about to begin execution.
  // The UI shows progress like "Step 2/5: Create component file".
  | { kind: "step-start"; step: PlanStep; totalSteps: number }

  // Both modes: a step has been verified after execution.
  // The UI shows whether verification passed or failed.
  | { kind: "step-verified"; step: PlanStep; verification: VerificationResult }

  // Emitted when the conversation history is updated (e.g. at the end of a build-mode step)
  | { kind: "history-updated"; history: ModelMessage[] }

  // Build mode only: escalation triggered — the executor exceeded
  // expected scope. The UI shows a Y/n prompt.
  | { kind: "escalation-prompt"; trigger: EscalationTrigger }

  // The orchestration loop has finished (all steps complete, or
  // escalation was offered and declined).
  | { kind: "complete" };

// ─── Escalation Logic ────────────────────────────────────────────────────────
//
// Deterministic (non-LLM) check for whether a build-mode step exceeded
// the expected scope of a "simple" one-shot fix.

/**
 * Checks if a build-mode execution result should trigger escalation.
 *
 * Returns null if no escalation is needed (the step looks simple enough).
 * Returns an EscalationTrigger if the step exceeded expected scope.
 *
 * IMPORTANT: This is called ONLY in build mode. Plan mode steps are
 * already scoped by the plan — escalation doesn't apply.
 */
function shouldEscalate(
  result: StepResult,
  verification: VerificationResult,
): EscalationTrigger | null {
  // Trigger 1: Verification failed — the executor's claims don't match
  // filesystem reality. Something went wrong during execution.
  if (!verification.verified) {
    return { reason: "verification-failed" };
  }

  // Trigger 2: Too many files touched — a "simple" fix shouldn't need
  // to modify 4+ files. If it does, this is probably a multi-file
  // feature that would benefit from a structured plan.
  if (result.claimedFiles.length > FILE_THRESHOLD) {
    return { reason: "touched-too-many-files" };
  }

  // No escalation needed — the step looks appropriately scoped.
  return null;
}

// ─── Dependency Ordering ─────────────────────────────────────────────────────
//
// Topological sort of plan steps by their dependsOn relationships.
// Ensures steps are executed in an order that respects dependencies.

/**
 * Returns plan steps in a valid execution order (topological sort).
 * Steps with no dependencies come first; steps that depend on others
 * come after their dependencies.
 *
 * Throws if the dependency graph contains cycles (which should have
 * been caught by the planner's validateDependencies, but we check
 * again here as a safety net).
 */
function topologicalSort(steps: PlanStep[]): PlanStep[] {
  const stepMap = new Map<number, PlanStep>();
  for (const step of steps) {
    stepMap.set(step.index, step);
  }

  const sorted: PlanStep[] = [];
  const visited = new Set<number>();
  const visiting = new Set<number>(); // cycle detection

  function visit(index: number): void {
    if (visited.has(index)) return;
    if (visiting.has(index)) {
      throw new Error(`Cycle detected in plan dependencies at step ${index}`);
    }

    visiting.add(index);
    const step = stepMap.get(index);
    if (!step) return;

    // Visit all dependencies first
    for (const dep of step.dependsOn) {
      visit(dep);
    }

    visiting.delete(index);
    visited.add(index);
    sorted.push(step);
  }

  for (const step of steps) {
    visit(step.index);
  }

  return sorted;
}

// ─── Build Mode Orchestration ────────────────────────────────────────────────
//
// The simple path: synthesize a single step from the user's prompt,
// execute it, verify it, check for escalation.

/**
 * Runs the build-mode orchestration: single step, execute, verify.
 *
 * This is an async generator that yields OrchestratorEvents as the
 * execution progresses. The UI consumes these to render progress.
 */
async function* runBuildMode(
  userPrompt: string,
  context: ProjectContext,
  model: LanguageModel,
  onConfirm: ConfirmFn,
  history?: ModelMessage[],
  provider?: string,
): AsyncGenerator<OrchestratorEvent> {
  // Emit mode info so the UI can update the badge
  yield { kind: "mode-info", mode: "build", reason: "Direct execution — single step" };

  // Synthesize a single PlanStep from the raw user prompt.
  // In build mode, there's no clarifier or planner — we go straight
  // to execution. The step description IS the user's prompt.
  const syntheticStep: PlanStep = {
    index: 0,
    description: userPrompt,
    targetFiles: [], // unknown upfront in build mode — verifier will check claimed files
    dependsOn: [],
  };

  // Signal that we're starting the (only) step
  yield { kind: "step-start", step: syntheticStep, totalSteps: 1 };

  // Capture pre-execution filesystem state.
  // In build mode, targetFiles is empty, so this captures nothing upfront.
  // The verifier will still check claimedFiles from the StepResult.
  const preSnapshots = capturePreSnapshot(syntheticStep, context.projectRoot);

  // Capture old file states for checkpoint creation
  // We need to capture content before execution to create proper patches
  const oldFileStates = new Map<string, string | null>();
  // Execute the step via the executor
  const stepResult = await executeStep(
    syntheticStep,
    context,
    model,
    onConfirm,
    undefined,
    provider,
    history,
  );

  // Forward all agent events (including finish with usage) to the UI
  for (const event of stepResult.agentEvents) {
    yield { kind: "agent-event", event };
  }

  // Yield the updated conversation history to preserve memory
  if (stepResult.conversationHistory) {
    yield { kind: "history-updated", history: stepResult.conversationHistory };
  }

  // Verify the execution result against filesystem state
  const verification = await verifyStep(
    syntheticStep,
    stepResult,
    context.projectRoot,
    preSnapshots,
    model,
  );

  // Report verification result
  yield { kind: "step-verified", step: syntheticStep, verification };

  if (verification.verified) {
    try {
      createCheckpoint(syntheticStep.description, stepResult.claimedFiles, stepResult.oldFileStates);
    } catch (error) {
      // Log but don't fail the step if checkpoint creation fails
      console.warn("Failed to create checkpoint for step:", error);
    }
  }

  // ── Escalation check ─────────────────────────────────────────────────
  //
  // The key build-mode safety net: if the step touched too many files
  // or verification failed, we don't silently continue — we surface
  // a prompt asking the user to switch to plan mode.
  const escalation = shouldEscalate(stepResult, verification);
  if (escalation) {
    SessionLogger.logEscalation(escalation.reason);
    yield { kind: "escalation-prompt", trigger: escalation };
    // The UI will handle the Y/n prompt and potentially re-invoke
    // the orchestrator in plan mode. We stop here.
    return;
  }

  SessionLogger.logSessionComplete();
  yield { kind: "complete" };
}

// ─── Plan Mode Orchestration ─────────────────────────────────────────────────
//
// The full path: clarify → plan → confirm → execute each step → verify each.

/**
 * Runs the plan-mode orchestration: clarify → plan → execute → verify.
 *
 * Yields OrchestratorEvents for the UI to render. The UI must handle
 * specific events interactively:
 *   - "clarification-needed": present questions and collect answers
 *   - "plan-ready": display the plan and get Y/n confirmation
 *   - "escalation-prompt": not used in plan mode (plan steps are pre-scoped)
 *
 * @param clarificationAnswers - Pre-collected answers to clarifying questions.
 *                               Pass empty record on first invocation; the
 *                               orchestrator will yield "clarification-needed"
 *                               if questions are generated.
 * @param approvedPlan - If provided, skip clarification and planning phases
 *                       and go straight to execution. Used when the user
 *                       has already approved a plan (e.g., after answering
 *                       clarifications and reviewing the plan).
 * @param completedStepIndices - Indices of steps that have already been
 *                               completed and verified. These steps will be
 *                               skipped during execution.
 */
async function* runPlanMode(
  userPrompt: string,
  context: ProjectContext,
  model: LanguageModel,
  onConfirm: ConfirmFn,
  clarificationAnswers: Record<string, string> = {},
  approvedPlan?: PlanStep[],
  completedStepIndices: number[] = [],
  provider?: string,
): AsyncGenerator<OrchestratorEvent> {
  // Emit mode info
  yield { kind: "mode-info", mode: "plan", reason: "Full planning pipeline" };

  let steps: PlanStep[];

  if (approvedPlan) {
    // Skip clarification and planning — use the pre-approved plan
    steps = approvedPlan;
  } else {
    // ── Phase 1: Clarification ───────────────────────────────────────────
    //
    // Ask the clarifier to generate questions. If it returns any,
    // yield them to the UI and STOP — the UI collects answers and
    // re-invokes the orchestrator with the answers.
    if (Object.keys(clarificationAnswers).length === 0) {
      const questions = await clarify(userPrompt, context, model);

      if (questions.length > 0) {
        yield { kind: "clarification-needed", questions };
        // STOP HERE — the UI will collect answers and call runOrchestrator
        // again with the answers. We don't continue to planning until
        // all required questions are answered.
        return;
      }
    }

    // ── Phase 2: Planning ────────────────────────────────────────────────
    //
    // Generate the structured plan. The planner sees the repo map
    // (always, regardless of budget) and the clarification answers.
    steps = await plan(userPrompt, clarificationAnswers, context, model);

    // Yield the plan for user review. The UI displays it as a
    // structured list and presents a Y/n confirmation gate.
    yield { kind: "plan-ready", steps };
    // STOP HERE — the UI will show the plan and collect Y/n.
    // If the user approves, they re-invoke with approvedPlan = steps.
    return;
  }

  // ── Phase 3: Execution ───────────────────────────────────────────────
  //
  // Execute each step in dependency order (topological sort).
  // Each step gets its own execute → verify cycle.
  const sortedSteps = topologicalSort(steps);
  const totalSteps = sortedSteps.length;

  for (const step of sortedSteps) {
    // Skip steps that have already been completed and verified
    if (completedStepIndices.includes(step.index)) {
      yield { kind: "step-start", step, totalSteps };
      yield { 
        kind: "step-verified", 
        step, 
        verification: { verified: true, mismatches: [] } 
      };
      continue;
    }

    // Signal step start
    yield { kind: "step-start", step, totalSteps };

    // Capture pre-execution filesystem state for this step's target files
    const preSnapshots = capturePreSnapshot(step, context.projectRoot);



    // Execute the step
    const stepResult = await executeStep(
      step,
      context,
      model,
      onConfirm,
      undefined,
      provider,
    );

    // Forward all agent events (including finish with usage) to the UI
    for (const event of stepResult.agentEvents) {
      yield { kind: "agent-event", event };
    }

    // Verify the step's execution
    const verification = await verifyStep(
      step,
      stepResult,
      context.projectRoot,
      preSnapshots,
      model,
    );

    // Report verification result — in plan mode we continue even if
    // verification fails (the user already approved the plan), but we
    // still report the result so they can see what went wrong.
    yield { kind: "step-verified", step, verification };

    // ── Checkpoint creation on successful verification ─────────────────
    //
    // If verification succeeded, create a checkpoint for this step.
    // This tracks the changes locally via the file-based checkpoint system.
    if (verification.verified) {
      try {
        createCheckpoint(step.description, stepResult.claimedFiles, stepResult.oldFileStates);
      } catch (error) {
        // Log but don't fail the step if checkpoint creation fails
        console.warn("Failed to create checkpoint for step:", error);
      }
    }
  }

  SessionLogger.logSessionComplete();
  yield { kind: "complete" };
}

// ─── Conversational Mode Helper & Heuristics ───────────────────────────────

function isConversational(prompt: string): boolean {
  const p = prompt.trim().toLowerCase();

  // A greeting-only message: the greeting word is immediately followed by
  // punctuation or end-of-string — NOT by more words that form a task.
  // "hi" → conversational   "hi build me a file" → NOT conversational
  const greetingOnly = /^(hi|hello|hey|yo|hola|greetings|good morning|good afternoon|good evening|howdy|sup|whats up|what's up)[.,!?\s]*$/i.test(p);
  if (!greetingOnly) return false;

  // Even if it looks like a greeting, bail out if there are task-intent keywords.
  // This is a safety net for "hi, can you write me..." style messages.
  const taskKeywords = /\b(build|make|create|write|generate|add|edit|fix|update|run|install|refactor|implement|change|delete|remove|file|code|function|component|page|app|script|test|html|css|ts|js|tsx|jsx)\b/i;
  if (taskKeywords.test(p)) return false;

  if (greetingOnly) return true;

  // Pure chit-chat phrases (exact match only)
  return p === "test" || p === "ping" || p === "how are you" || p === "who are you" || p === "what is your name";
}

async function* runConversationalMode(
  history: ModelMessage[],
  context: ProjectContext,
  model: LanguageModel,
  onConfirm: ConfirmFn,
  provider?: string,
): AsyncGenerator<OrchestratorEvent> {
  yield { kind: "mode-info", mode: "build", reason: "Casual conversation" };

  const { runTurn } = await import("./run-turn.js");

  const systemPrompt = "You are Zizou, an AI pair programming agent. Keep your response helpful, concise, and friendly. Since this is a casual conversation, do not mention or invoke any file-modifying tools.";

  const turn = runTurn({
    history,
    model,
    provider,
    onConfirm,
    systemPrompt,
    disableTools: true,
  });

  let result = await turn.next();
  while (!result.done) {
    yield { kind: "agent-event", event: result.value };
    result = await turn.next();
  }

  yield { kind: "complete" };
}

// ─── Public Entry Point ──────────────────────────────────────────────────────

/**
 * Main orchestrator entry point. Routes to build or plan mode based on
 * the ModeContext, and returns an async generator of OrchestratorEvents
 * for the UI to consume.
 *
 * @param userPrompt - The user's original request text.
 * @param modeContext - Which mode to run in and why (user flag or escalation).
 * @param context - Ambient project info (root, prompt, budget).
 * @param model - The resolved LLM to use.
 * @param onConfirm - Callback for user confirmation of shell commands.
 * @param clarificationAnswers - Pre-collected clarification answers (plan mode).
 * @param approvedPlan - Pre-approved plan to execute (plan mode, after Y/n).
 * @param completedStepIndices - Indices of steps already completed (plan mode).
 * @param history - Full conversation history (used for casual conversation mode).
 */
export async function* runOrchestrator(
  userPrompt: string,
  modeContext: ModeContext,
  context: ProjectContext,
  model: LanguageModel,
  onConfirm: ConfirmFn,
  clarificationAnswers?: Record<string, string>,
  approvedPlan?: PlanStep[],
  completedStepIndices?: number[],
  history?: ModelMessage[],
  provider?: string,
): AsyncGenerator<OrchestratorEvent> {
  // Only log session start on the very first entry of the conversation turn
  if (!approvedPlan && (!clarificationAnswers || Object.keys(clarificationAnswers).length === 0)) {
    SessionLogger.logSessionStart(userPrompt, modeContext.mode, context.projectRoot);
  }

  // Casual conversational path: greetings / chit-chat
  if (!approvedPlan && (!clarificationAnswers || Object.keys(clarificationAnswers).length === 0) && isConversational(userPrompt)) {
    const activeHistory = history || [{ role: "user", content: userPrompt }];
    yield* runConversationalMode(
      activeHistory,
      context,
      model,
      onConfirm,
      provider,
    );
    return;
  }

  if (modeContext.mode === "plan") {
    // Plan mode: full clarify → plan → execute → verify pipeline
    yield* runPlanMode(
      userPrompt,
      context,
      model,
      onConfirm,
      clarificationAnswers || {},
      approvedPlan,
      completedStepIndices || [],
      provider,
    );
  } else {
    // Build mode: single step → execute → verify → escalation check
    yield* runBuildMode(
      userPrompt,
      context,
      model,
      onConfirm,
      history,
      provider,
    );
  }
}
