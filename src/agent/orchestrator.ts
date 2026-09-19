// src/agent/orchestrator.ts
//
// LAYER: agent/
//
// The orchestration harness — owns plan state, drives the execution loop
// differently per mode.
//
// THIS IS THE INTEGRATION POINT where all the other agent/ modules
// (planner, executor, verifier) get composed into a working
// pipeline. No other module should drive the full loop — the orchestrator
// is the single owner of execution flow.
//
// ROUTING HAPPENS HERE, ONCE PER TURN:
//   resolveRoute() turns the pinned mode into the route that runs. A pinned
//   mode passes straight through; "auto" — the default — asks router.ts.
//   The decision is made before anything executes and is never revisited
//   inside the turn. See mode.ts for why nothing switches mid-turn.
//
// FOUR ROUTES:
//   Chat:
//     Conversation. No tools when the user pinned /chat; read-only tools
//     when auto routed here, so a guess that needs a file can read it.
//     Nothing on disk can change either way.
//
//   Ask:
//     Questions about the codebase. Read-only tools, no executor, no
//     verifier, no checkpoint — nothing changed, so there is nothing to
//     snapshot or undo.
//
//   Build (the route auto picks most often):
//     1. Synthesize a single PlanStep from the raw user prompt
//     2. Execute it via executeStep()
//     3. Verify it via verifyStep()
//     4. Emit a scope hint if the step looked oversized. Advisory only.
//
//   Plan (--plan flag, /plan, or auto on multi-step work):
//     1. Run the planner to generate a structured plan plus the assumptions
//        it had to make
//     2. Display the plan for user review at the gate. The gate takes y, n,
//        a redirect to another route, or free text — which is a CORRECTION,
//        re-planned and re-gated rather than a rejection.
//     3. For each step in dependsOn order:
//        a. capturePreSnapshot()
//        b. executeStep()
//        c. verifyStep()
//        d. Record result
//     4. Report completion
//
// WHAT IS DELIBERATELY ABSENT:
//   - No clarifier. Plan mode does not interrogate the user before it has
//     anything to show. The planner decides, states its assumptions, and the
//     y/n gate on a concrete plan IS the clarification step.
//   - No mid-turn mode switching. Routing is decided once, up front. A build
//     step that looks too big emits an advisory hint and finishes — it does
//     not interrupt with a modal prompt, and it does not discard work already
//     on disk. This previously escalated on verification failure, which the
//     verifier reports routinely, so ordinary turns were interrupted by a
//     modal asking whether to restart the entire request. The router replaces
//     that guess-late-and-restart design with a guess-early-and-commit one.
//   - No router call outside auto mode. A pinned mode never constructs it.
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
import type { Mode, ModeContext, Route } from "./mode.js";
import type {
  PlanStep,
  StepResult,
  StepDigest,
  VerificationResult,
  ProjectContext,
  ScopeHint,
  PlanRevision,
} from "./types.js";
import { plan } from "./planner.js";
import { routePrompt, type RouteDecision } from "./router.js";
import { executeStep } from "./executor.js";
import { buildSystemPrompt } from "../context/build-system-prompt.js";
import { capturePreSnapshot, verifyStep } from "./verifier.js";
import { type AgentEvent } from "./run-turn.js";
import { SessionLogger } from "./debug/index.js";
import { createCheckpoint } from "../checkpoint/manager.js";
import { getActiveSessionId } from "../session/registry.js";
import { resolve } from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Number of files a build-mode step can touch before we mention that plan
 * mode exists. Advisory only — nothing is blocked or restarted.
 *
 * This is a tuning parameter, not a hard architectural constant.
 */
const FILE_THRESHOLD = 3;

// ─── Orchestrator Events ─────────────────────────────────────────────────────
//
// The event types the orchestrator yields to the UI. These are a superset
// of AgentEvent — the orchestrator wraps raw agent events and adds its
// own control-flow events (plan display, scope hints, etc.).

export type OrchestratorEvent =
  // Wraps a raw AgentEvent from the executor (text-delta, tool-call, etc.)
  // so the UI can render them the same way it already does.
  | { kind: "agent-event"; event: AgentEvent }

  // Emitted once per turn, as soon as the route is known. The UI uses this
  // to update the mode badge in the input footer. `mode` is the ROUTE that
  // ran, which in auto mode is not the mode the user pinned — hence the
  // separate pinnedMode, so the badge can render "Auto → Build" rather than
  // silently replacing the user's pin.
  | { kind: "mode-info"; mode: Route; pinnedMode?: Mode; reason: string }

  // Auto mode only: the router's decision, before anything runs. Carried
  // separately from mode-info because the UI prints it differently — a
  // routing guess the user may want to override is not the same thing as a
  // mode announcement.
  | { kind: "route-decided"; decision: RouteDecision }

  // Plan mode: the planner generated a structured plan.
  // The UI displays the assumptions and steps for review before execution.
  // `routeReason` is set when auto chose plan, so the gate can say why.
  | { kind: "plan-ready"; steps: PlanStep[]; assumptions: string[]; routeReason?: string }

  // Both modes: a step is about to begin execution.
  // The UI shows progress like "Step 2/5: Create component file".
  | { kind: "step-start"; step: PlanStep; totalSteps: number; modelTier?: "hosted" | "local" }

  // Both modes: a step has been verified after execution.
  // The UI shows whether verification passed or failed.
  | { kind: "step-verified"; step: PlanStep; verification: VerificationResult; modelTier?: "hosted" | "local" }

  // Emitted when the conversation history is updated (e.g. at the end of a build-mode step)
  | { kind: "history-updated"; history: ModelMessage[] }

  // Build mode only: the step looked larger than a single step should be.
  // ADVISORY — the UI prints a line and moves on. It does not prompt, does
  // not block, and the turn still completes normally.
  | { kind: "scope-hint"; hint: ScopeHint }

  // The orchestration loop has finished.
  | { kind: "complete" };

// ─── Step helpers ────────────────────────────────────────────────────────────

/**
 * Runs a step to completion, re-yielding each AgentEvent wrapped as an
 * OrchestratorEvent and handing back the StepResult.
 *
 * `yield*` alone would forward the raw AgentEvents, but the UI consumes the
 * orchestrator's own event union — so each one needs wrapping on the way out.
 */
async function* streamStep(
  steps: AsyncGenerator<AgentEvent, StepResult>,
): AsyncGenerator<OrchestratorEvent, StepResult> {
  let result = await steps.next();
  while (!result.done) {
    yield { kind: "agent-event", event: result.value };
    result = await steps.next();
  }
  return result.value;
}

/**
 * Records a verified step in the checkpoint history.
 *
 * ONE call site's worth of logic, called from both modes. Build and plan mode
 * each had their own near-identical copy of this block, and each wrote to TWO
 * stores: the checkpoint history and a separate undo/redo snapshot stack that
 * knew nothing about it. There is now a single chain; /undo and /redo move a
 * head pointer along it (see checkpoint/manager.ts).
 */
function recordStepCheckpoint(step: PlanStep, stepResult: StepResult): void {
  try {
    createCheckpoint(
      step.description,
      stepResult.claimedFiles,
      stepResult.oldFileStates,
      getActiveSessionId() ?? undefined,
    );
  } catch (error) {
    // A failed checkpoint must not fail the step — the work on disk is real
    // either way, we just lose the ability to undo it.
    console.warn("Failed to create checkpoint for step:", error);
  }
}

// ─── Scope assessment ────────────────────────────────────────────────────────
//
// Deterministic (non-LLM) check for whether a build-mode step turned out
// bigger than a single step usually is.
//
// This was shouldEscalate(), and a hit interrupted the user with a modal y/n
// offering to restart the whole request in plan mode. Two problems with that:
// verification failure is a routine, noisy signal, so ordinary turns got
// interrupted; and accepting discarded work already written to disk.
// It is now advisory.

/**
 * Returns a hint when a build-mode step looked oversized, or null.
 *
 * Build mode only — plan mode steps are already scoped by the plan.
 */
function assessStepScope(
  result: StepResult,
  verification: VerificationResult,
): ScopeHint | null {
  // Note the ORDER: file count is checked first. It is the more meaningful
  // signal — verification failure says the verifier was unhappy, which on
  // its own says little about how large the change was.
  if (result.claimedFiles.length > FILE_THRESHOLD) {
    return { reason: "touched-many-files", fileCount: result.claimedFiles.length };
  }

  if (!verification.verified) {
    return { reason: "verification-failed", fileCount: result.claimedFiles.length };
  }

  // Appropriately scoped — say nothing.
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
// execute it, verify it, and note if it looked oversized.

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
  reason: string = "Direct execution — single step",
): AsyncGenerator<OrchestratorEvent> {
  // Emit mode info so the UI can update the badge
  yield { kind: "mode-info", mode: "build", reason };

  // Synthesize a single PlanStep from the raw user prompt.
  // In build mode there's no planner — we go straight to execution.
  // The step description IS the user's prompt.
  const syntheticStep: PlanStep = {
    index: 0,
    description: userPrompt,
    targetFiles: [], // unknown upfront in build mode — verifier will check claimed files
    dependsOn: [],
  };

  // Signal that we're starting the (only) step
  const startModelTier: "hosted" | "local" = provider === "ollama" ? "local" : "hosted";
  yield { kind: "step-start", step: syntheticStep, totalSteps: 1, modelTier: startModelTier };

  // Capture pre-execution filesystem state.
  // In build mode, targetFiles is empty, so this captures nothing upfront.
  // The verifier will still check claimedFiles from the StepResult.
  const preSnapshots = capturePreSnapshot(syntheticStep, context.projectRoot);

  // Capture old file states for checkpoint creation and undo/redo
  // We need to capture content before execution to create proper patches
  const oldFileStates = new Map<string, string | null>();
  // In build mode, we don't know targetFiles upfront, so we capture an empty before state
  // The snapshot will be built after execution using claimedFiles
  const beforeStates = new Map<string, string | null>();
  
  // Execute the step, streaming its events to the UI as they happen.
  const stepResult = yield* streamStep(
    executeStep({
      step: syntheticStep,
      context,
      model,
      onConfirm,
      provider,
      conversationHistory: history,
    }),
  );

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
  yield { kind: "step-verified", step: syntheticStep, verification, modelTier: stepResult.modelTier };

  if (verification.verified) {
    recordStepCheckpoint(syntheticStep, stepResult);
  }

  // ── Scope hint ────────────────────────────────────────────
  //
  // Advisory only. The turn is finished and its work is on disk either way;
  // this just mentions that plan mode exists. It does NOT prompt, block, or
  // switch modes — that is the user's call and only the user's.
  const hint = assessStepScope(stepResult, verification);
  if (hint) {
    SessionLogger.logScopeHint(hint.reason);
    yield { kind: "scope-hint", hint };
  }

  SessionLogger.logSessionComplete();
  yield { kind: "complete" };
}

// ─── Plan Mode Orchestration ─────────────────────────────────────────────────
//
// The full path: plan → confirm → execute each step → verify each.

/**
 * Runs the plan-mode orchestration: plan → confirm → execute → verify.
 *
 * Yields OrchestratorEvents for the UI to render. Exactly one of them is
 * interactive:
 *   - "plan-ready": display the assumptions and plan, and get Y/n. The
 *     generator STOPS here; the UI re-invokes with approvedPlan on yes.
 *
 * @param approvedPlan - If provided, skip planning and go straight to
 *                       execution. Used when the user has approved a plan.
 * @param completedStepIndices - Indices of steps that have already been
 *                               completed and verified. These steps will be
 *                               skipped during execution.
 */
async function* runPlanMode(
  userPrompt: string,
  context: ProjectContext,
  model: LanguageModel,
  onConfirm: ConfirmFn,
  approvedPlan?: PlanStep[],
  completedStepIndices: number[] = [],
  provider?: string,
  reason: string = "Plan, review, then execute",
  routeReason?: string,
  planRevision?: PlanRevision,
): AsyncGenerator<OrchestratorEvent> {
  // Emit mode info
  yield { kind: "mode-info", mode: "plan", reason };

  let steps: PlanStep[];

  if (approvedPlan) {
    steps = approvedPlan;
  } else {
    // ── Phase 1: Planning ────────────────────────────────────────────────
    //
    // Generate the structured plan. The planner sees the repo map (always,
    // regardless of budget) and DECIDES anything the request left open,
    // declaring those decisions as assumptions.
    //
    // There is no clarifier stage. Asking a list of abstract questions and
    // THEN showing a plan for approval was two gates for one decision, and
    // the questions came before the user had anything concrete to react to.
    //
    // `planRevision` carries the previous plan plus what the user typed at
    // the gate instead of y/n. Free text there is a correction, not a
    // rejection — "put it in src/games/ not the root" should produce a fixed
    // plan, not make the user retype the whole request.
    const generated = await plan(userPrompt, context, model, planRevision);
    steps = generated.steps;

    // Yield the plan for user review. The UI displays the assumptions and
    // steps, then presents the confirmation gate.
    yield { kind: "plan-ready", steps, assumptions: generated.assumptions, routeReason };
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

  // Each step still gets a fresh prompt; this carries forward only what the
  // next step needs to avoid redoing earlier work. See StepDigest.
  const priorSteps: StepDigest[] = [];

  for (const step of sortedSteps) {
    // Skip steps that have already been completed and verified
    if (completedStepIndices.includes(step.index)) {
      yield { kind: "step-start", step, totalSteps };
      yield { 
        kind: "step-verified", 
        step, 
        verification: { verified: true, mismatches: [] },
        modelTier: "hosted" // Default for skipped steps
      };
      // A skipped step still produced files in an earlier run, so later steps
      // must be told about it or they will recreate its work.
      priorSteps.push({
        index: step.index,
        description: step.description,
        filesTouched: step.targetFiles,
        verified: true,
      });
      continue;
    }

    // Signal step start
    const stepModelTier: "hosted" | "local" = provider === "ollama" ? "local" : "hosted";
    yield { kind: "step-start", step, totalSteps, modelTier: stepModelTier };

    // Capture pre-execution filesystem state for this step's target files
    const preSnapshots = capturePreSnapshot(step, context.projectRoot);

    // Execute the step, streaming its events to the UI as they happen.
    const stepResult = yield* streamStep(
      executeStep({ step, context, model, onConfirm, provider, priorSteps }),
    );

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
    yield { kind: "step-verified", step, verification, modelTier: stepResult.modelTier };

    // ── Checkpoint creation on successful verification ─────────────────
    //
    // If verification succeeded, create a checkpoint for this step.
    // This tracks the changes locally via the file-based checkpoint system.
    if (verification.verified) {
      recordStepCheckpoint(step, stepResult);
    }

    // Record what this step did, for the steps that follow. claimedFiles is
    // what the executor actually touched, which is more honest than the
    // plan's targetFiles guess.
    priorSteps.push({
      index: step.index,
      description: step.description,
      filesTouched: stepResult.claimedFiles,
      verified: verification.verified,
    });
  }

  SessionLogger.logSessionComplete();
  yield { kind: "complete" };
}

// ─── Chat Mode ───────────────────────────────────────────────────────────────
//
// Conversation. Nothing here can change the filesystem under any tool mode —
// "readonly" is readFile/glob/grep/listDir, which look and do not touch.

/**
 * Runs the chat route.
 *
 * @param toolMode - "none" when the user pinned /chat: an explicit pin means
 *   "just talk", and this is the one genuinely tool-free path. "readonly"
 *   when auto ROUTED here: the router is guessing, and a guess that turns out
 *   to need a file ("hey, is this repo on React 19?") should read it rather
 *   than invent an answer. Nothing on disk changes either way.
 */
async function* runChatMode(
  history: ModelMessage[],
  context: ProjectContext,
  model: LanguageModel,
  onConfirm: ConfirmFn,
  toolMode: "none" | "readonly",
  reason: string,
  provider?: string,
): AsyncGenerator<OrchestratorEvent> {
  yield { kind: "mode-info", mode: "chat", reason };

  const { runTurn } = await import("./run-turn.js");

  const conversational =
    "You are Zizou, an AI pair programming agent, in casual conversation. " +
    "Keep your response helpful, concise, and friendly.";

  // With tools, the prompt is built from the ask role so the read-only rules
  // (search before asserting, cite what you found, never name an unseen path)
  // live in ONE place rather than a second hand-written copy that drifts.
  const systemPrompt =
    toolMode === "readonly"
      ? `${conversational}\n\n${await buildSystemPrompt(context.projectRoot, "ask")}\n\n` +
        "This is conversation, not a formal question. Only reach for a tool " +
        "when the answer genuinely depends on what is in this repo; for a " +
        "greeting or small talk, just reply."
      : `${conversational} Do not mention or invoke any tools — you have none this turn.`;

  const turn = runTurn({
    history,
    model,
    provider,
    onConfirm,
    systemPrompt,
    toolMode,
    journalRole: "chat",
  });

  let result = await turn.next();
  while (!result.done) {
    yield { kind: "agent-event", event: result.value };
    result = await turn.next();
  }

  yield { kind: "history-updated", history: result.value };
  yield { kind: "complete" };
}

// ─── Ask Mode ────────────────────────────────────────────────────────────────
//
// Questions about the codebase. Read-only tools and nothing else.
//
// This route exists because the two it sits between could not answer a
// question honestly: chat mode had no tools, so it answered from the system
// prompt alone and guessed; build mode could answer, but it could also
// rewrite the file it was asked about.
//
// No executor, no verifier, no checkpoint — nothing changed on disk, so there
// is nothing to snapshot, verify or undo.

async function* runAskMode(
  history: ModelMessage[],
  context: ProjectContext,
  model: LanguageModel,
  onConfirm: ConfirmFn,
  reason: string,
  provider?: string,
): AsyncGenerator<OrchestratorEvent> {
  yield { kind: "mode-info", mode: "ask", reason };

  const { runTurn } = await import("./run-turn.js");

  const systemPrompt = await buildSystemPrompt(context.projectRoot, "ask");

  const turn = runTurn({
    history,
    model,
    provider,
    onConfirm,
    systemPrompt,
    toolMode: "readonly",
    maxSteps: context.maxSteps,
    temperature: context.temperature,
    maxOutputTokens: context.maxOutputTokens,
    journalRole: "ask",
  });

  let result = await turn.next();
  while (!result.done) {
    yield { kind: "agent-event", event: result.value };
    result = await turn.next();
  }

  // The generator's RETURN value is the updated history. Ask mode reads files
  // to answer, and that reading is how the conversation gains context —
  // dropping it would make the follow-up question start from nothing.
  yield { kind: "history-updated", history: result.value };

  yield { kind: "complete" };
}

// ─── Public Entry Point ──────────────────────────────────────────────────────

/** Everything runOrchestrator needs, as one object. */
export interface RunOrchestratorOptions {
  /** The user's original request text. */
  userPrompt: string;
  /** Which mode to run in and why (user flag or escalation). */
  modeContext: ModeContext;
  /** Ambient project info (root, prompt, budget). */
  context: ProjectContext;
  /** The resolved LLM to use. */
  model: LanguageModel;
  /** Callback for user confirmation of shell commands and file writes. */
  onConfirm: ConfirmFn;
  /** Pre-collected clarification answers (plan mode). */
  clarificationAnswers?: Record<string, string>;
  /** Pre-approved plan to execute (plan mode, after the Y/n gate). */
  approvedPlan?: PlanStep[];
  /** Indices of steps already completed (plan mode). */
  completedStepIndices?: number[];
  /**
   * A correction typed at the plan gate instead of y/n, with the plan it
   * corrects. Re-enters plan mode to produce a revised plan.
   */
  planRevision?: PlanRevision;
  /** Full conversation history (used for build, ask and chat modes). */
  history?: ModelMessage[];
  /** Provider name, e.g. "ollama" — selects provider options and model tier. */
  provider?: string;
}

/**
 * Resolves the pinned mode to the route that will actually run.
 *
 * The ONLY place auto mode is turned into something executable, and the only
 * place the router is called from. Three rules:
 *
 *   1. A mid-flow re-entry NEVER re-routes. Approving a plan or correcting
 *      one continues the turn already in progress; re-classifying "y" would
 *      be both wasteful and wrong.
 *   2. A pinned mode is honoured exactly. It never touches the router, so it
 *      costs what it always cost — the answer to the objection this repo
 *      recorded against upfront classification (see mode.ts).
 *   3. Auto asks the router, which never throws and always answers.
 */
async function resolveRoute(args: {
  mode: Mode;
  userPrompt: string;
  history?: ModelMessage[];
  provider?: string;
  projectRoot: string;
  isMidFlow: boolean;
}): Promise<{ route: Route; reason: string; decision?: RouteDecision }> {
  const { mode, isMidFlow, userPrompt, history, provider, projectRoot } = args;

  if (isMidFlow) {
    // Only plan mode has mid-flow re-entries, so an "auto" pin arriving here
    // can only have routed to plan on the entry that produced the gate.
    return {
      route: mode === "auto" ? "plan" : mode,
      reason: "Continuing the turn in progress",
    };
  }

  if (mode !== "auto") {
    return { route: mode, reason: PINNED_REASONS[mode] };
  }

  const decision = await routePrompt({
    userPrompt,
    history,
    provider: (provider ?? "groq") as any,
    projectRoot,
  });

  return {
    route: decision.route,
    reason: `Auto → ${decision.route}: ${decision.reason}`,
    decision,
  };
}

/** What the badge says when the user pinned the mode themselves. */
const PINNED_REASONS: Record<Route, string> = {
  chat: "Conversation — tools disabled",
  ask: "Read-only — questions about this codebase",
  build: "Direct execution — single step",
  plan: "Plan, review, then execute",
};

/**
 * Main orchestrator entry point. Resolves the pinned mode to a route — via
 * the router when that mode is "auto" — and returns an async generator of
 * OrchestratorEvents for the UI to consume.
 *
 * Takes an options object rather than positional arguments: there were ten
 * parameters, three of them optional and adjacent, so call sites were a row
 * of `undefined`s and a mis-slotted argument would type-check fine.
 */
export async function* runOrchestrator(
  options: RunOrchestratorOptions,
): AsyncGenerator<OrchestratorEvent> {
  const {
    userPrompt,
    modeContext,
    context,
    model,
    onConfirm,
    clarificationAnswers,
    approvedPlan,
    completedStepIndices,
    planRevision,
    history,
    provider,
  } = options;

  // A re-entry that carries an approved plan, a plan correction, or
  // clarification answers is a continuation of the turn already in progress,
  // not a new one.
  const isMidFlow =
    !!approvedPlan ||
    !!planRevision ||
    (!!clarificationAnswers && Object.keys(clarificationAnswers).length > 0);

  // Only log session start on the very first entry of the conversation turn
  if (!isMidFlow) {
    SessionLogger.logSessionStart(userPrompt, modeContext.mode, context.projectRoot);
  }

  // ── Routing ──────────────────────────────────────────────────────────
  //
  // Decided ONCE, here, before anything runs — and never revisited inside
  // the turn. Mode switching mid-turn is exactly what was removed when
  // build-mode escalation was deleted; a router that changed its mind
  // halfway would reintroduce it.
  const { route, reason, decision } = await resolveRoute({
    mode: modeContext.mode,
    userPrompt,
    history,
    provider,
    projectRoot: context.projectRoot,
    isMidFlow,
  });

  if (decision) {
    SessionLogger.logRouteDecision(decision.route, decision.reason, decision.confidence, decision.source);
    yield { kind: "route-decided", decision };
  }

  // The route reason is worth showing at the plan gate only when the router
  // picked it. "Plan, review, then execute" tells a user who typed /plan
  // nothing they don't know.
  const routeReason = decision ? reason : undefined;

  switch (route) {
    case "chat": {
      const activeHistory = history || [{ role: "user", content: userPrompt }];
      // Pinned /chat means "just talk" and gets no tools. Routed-to chat is
      // a guess, so it keeps read-only tools to check itself.
      yield* runChatMode(
        activeHistory,
        context,
        model,
        onConfirm,
        modeContext.mode === "chat" ? "none" : "readonly",
        reason,
        provider,
      );
      return;
    }

    case "ask": {
      const activeHistory = history || [{ role: "user", content: userPrompt }];
      yield* runAskMode(activeHistory, context, model, onConfirm, reason, provider);
      return;
    }

    case "plan":
      yield* runPlanMode(
        userPrompt,
        context,
        model,
        onConfirm,
        approvedPlan,
        completedStepIndices || [],
        provider,
        reason,
        routeReason,
        planRevision,
      );
      return;

    case "build":
      yield* runBuildMode(userPrompt, context, model, onConfirm, history, provider, reason);
      return;
  }
}
