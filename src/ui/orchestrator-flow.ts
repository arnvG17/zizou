// src/ui/orchestrator-flow.ts
//
// LAYER: ui/
//
// The multi-turn state of one orchestrator interaction: which mode is active,
// which clarifying question we are on, whether a plan is awaiting approval,
// and which steps have already been verified.
//
// WHY A REDUCER: this lived as eight independent useState hooks in Chat.tsx.
// Plan mode is a conversation that spans several React renders — the
// orchestrator yields, stops, and is re-invoked with what the user supplied —
// so the handlers must pass state BACK INTO a fresh runOrchestrator call.
// Reading those values from the render closure meant reading whatever they
// were when that closure was created, which produced four distinct bugs:
//
//   1. Accepting escalation called setCurrentMode("plan") and then immediately
//      re-invoked the flow, which still read mode "build" from its closure. It
//      re-ran build mode, escalated again for the same reason, and ping-ponged.
//   2. completedStepIndices was only ever appended to, never reset for a new
//      prompt, so indices from one plan silently skipped steps in the next.
//   3. The clarification "skip" path passed the stale answers object rather
//      than the accumulated one, dropping every answer given so far.
//   4. A persisted plan auto-resumed on mount via setTimeout with
//      completedStepIndices still empty, re-running finished steps.
//
// Reducing to one object and passing it explicitly makes all four
// unrepresentable rather than fixing them one at a time.
//
// DEPENDENCY DIRECTION: imports types from agent/ only. No React, so it is
// directly unit-testable.

import type { Mode } from "../agent/mode.js";
import type { PlanStep, ClarifyingQuestion } from "../agent/types.js";

/** The complete multi-turn state of one orchestrator interaction. */
export interface OrchestratorFlowState {
  /** Which mode the next prompt will run in. */
  mode: Mode;
  /** How we arrived in that mode. Drives ModeContext.reason. */
  modeReason: "user-flag" | "escalated";
  /** The prompt that started this flow, replayed on each re-entry. */
  originalPrompt: string;
  /** Questions the clarifier asked, presented one at a time. */
  pendingClarifications: ClarifyingQuestion[];
  /** Index of the question currently being shown. */
  currentClarificationIndex: number;
  /** Answers gathered so far, keyed by question text. */
  clarificationAnswers: Record<string, string>;
  /** True while the user is working through clarifying questions. */
  isInClarificationFlow: boolean;
  /** A plan waiting at the Y/n gate, or null. */
  pendingPlan: PlanStep[] | null;
  /** True while the plan is displayed awaiting approval. */
  isAwaitingPlanApproval: boolean;
  /** Step indices already executed and verified in THIS flow. */
  completedStepIndices: number[];
}

export const initialFlowState: OrchestratorFlowState = {
  mode: "build",
  modeReason: "user-flag",
  originalPrompt: "",
  pendingClarifications: [],
  currentClarificationIndex: 0,
  clarificationAnswers: {},
  isInClarificationFlow: false,
  pendingPlan: null,
  isAwaitingPlanApproval: false,
  completedStepIndices: [],
};

export type FlowAction =
  /** The user pinned a mode via /chat, /build or /plan. */
  | { type: "set-mode"; mode: Mode }
  /** A new user prompt begins a fresh flow, keeping only the mode. */
  | { type: "prompt-submitted"; prompt: string }
  /** The orchestrator reported which mode it actually ran in. */
  | { type: "mode-reported"; mode: Mode }
  /** The clarifier produced questions. */
  | { type: "clarifications-received"; questions: ClarifyingQuestion[] }
  /** The user answered the question currently on screen. */
  | { type: "clarification-answered"; question: string; answer: string }
  /** The user typed "skip" — stop asking, keep what we already have. */
  | { type: "clarifications-skipped" }
  /** The planner produced a plan; it now awaits Y/n. */
  | { type: "plan-received"; steps: PlanStep[] }
  /** The user approved the plan. */
  | { type: "plan-approved" }
  /** The user rejected the plan. */
  | { type: "plan-rejected" }
  /** A step finished verification. */
  | { type: "step-verified"; stepIndex: number; verified: boolean }
  /** The user accepted escalation from build mode to plan mode. */
  | { type: "escalation-accepted" }
  /** Restore a persisted flow from session state. */
  | { type: "restore"; state: Partial<OrchestratorFlowState> }
  /** Wipe everything (/clear, new session). */
  | { type: "reset" };

export function flowReducer(
  state: OrchestratorFlowState,
  action: FlowAction,
): OrchestratorFlowState {
  switch (action.type) {
    case "set-mode":
      return { ...state, mode: action.mode, modeReason: "user-flag" };

    case "prompt-submitted":
      // A new prompt starts a genuinely new flow. Everything except the
      // user's chosen mode resets — in particular completedStepIndices,
      // which used to carry over and skip steps in the next plan.
      return {
        ...initialFlowState,
        mode: state.mode,
        modeReason: state.modeReason,
        originalPrompt: action.prompt,
      };

    case "mode-reported":
      // The orchestrator may run chat mode for a greeting even though the
      // pinned mode is build. Reflect what actually ran without claiming the
      // user chose it.
      return { ...state, mode: action.mode };

    case "clarifications-received":
      return {
        ...state,
        pendingClarifications: action.questions,
        currentClarificationIndex: 0,
        isInClarificationFlow: action.questions.length > 0,
      };

    case "clarification-answered": {
      const clarificationAnswers = {
        ...state.clarificationAnswers,
        [action.question]: action.answer,
      };
      const nextIndex = state.currentClarificationIndex + 1;
      const done = nextIndex >= state.pendingClarifications.length;
      return {
        ...state,
        clarificationAnswers,
        currentClarificationIndex: nextIndex,
        isInClarificationFlow: !done,
      };
    }

    case "clarifications-skipped":
      // Keep the answers already collected. The old code replaced them with
      // a stale copy, silently discarding everything the user had typed.
      return {
        ...state,
        isInClarificationFlow: false,
        pendingClarifications: [],
        currentClarificationIndex: 0,
      };

    case "plan-received":
      return { ...state, pendingPlan: action.steps, isAwaitingPlanApproval: true };

    case "plan-approved":
      return { ...state, isAwaitingPlanApproval: false };

    case "plan-rejected":
      return { ...state, pendingPlan: null, isAwaitingPlanApproval: false };

    case "step-verified": {
      if (!action.verified) return state;
      // Guard against duplicates: the orchestrator yields a synthetic
      // step-verified for steps it SKIPPED because they were already in this
      // list, which would otherwise re-append the same index every run.
      if (state.completedStepIndices.includes(action.stepIndex)) return state;
      return {
        ...state,
        completedStepIndices: [...state.completedStepIndices, action.stepIndex],
      };
    }

    case "escalation-accepted":
      // Escalation restarts planning from scratch on purpose: build-mode
      // state may be half-applied, so clarification answers are dropped.
      return {
        ...state,
        mode: "plan",
        modeReason: "escalated",
        clarificationAnswers: {},
        pendingClarifications: [],
        currentClarificationIndex: 0,
        isInClarificationFlow: false,
        pendingPlan: null,
        isAwaitingPlanApproval: false,
        completedStepIndices: [],
      };

    case "restore":
      return { ...initialFlowState, ...action.state };

    case "reset":
      return initialFlowState;
  }
}
