// src/ui/orchestrator-flow.ts
//
// LAYER: ui/
//
// The multi-turn state of one orchestrator interaction: which mode is active,
// whether a plan is awaiting approval, and which steps have already run.
//
// WHY A REDUCER: this lived as eight independent useState hooks in Chat.tsx.
// Plan mode is a conversation that spans several React renders — the
// orchestrator yields, stops, and is re-invoked with what the user supplied —
// so the handlers must pass state BACK INTO a fresh runOrchestrator call.
// Reading those values from the render closure meant reading whatever they
// were when that closure was created, which produced real bugs: completed
// step indices leaking into the next plan and silently skipping steps, and a
// persisted plan re-running finished steps on mount.
//
// WHAT IS DELIBERATELY ABSENT:
//   - No clarification state. Plan mode no longer interrogates the user
//     before it has anything to show; the planner states its assumptions and
//     the y/n gate on a concrete plan is the review step.
//   - No escalation state. The orchestrator never changes mode on its own.
//     Mode changes only via /chat, /build, /plan.
//
// DEPENDENCY DIRECTION: imports types from agent/ only. No React, so it is
// directly unit-testable.

import type { Mode } from "../agent/mode.js";
import type { PlanStep } from "../agent/types.js";

/** The complete multi-turn state of one orchestrator interaction. */
export interface OrchestratorFlowState {
  /** Which mode the next prompt will run in. Only the user changes this. */
  mode: Mode;
  /** The prompt that started this flow, replayed on each re-entry. */
  originalPrompt: string;
  /** A plan waiting at the Y/n gate, or null. */
  pendingPlan: PlanStep[] | null;
  /** The assumptions the planner declared for `pendingPlan`. */
  pendingAssumptions: string[];
  /** True while the plan is displayed awaiting approval. */
  isAwaitingPlanApproval: boolean;
  /** Step indices already executed and verified in THIS flow. */
  completedStepIndices: number[];
}

export const initialFlowState: OrchestratorFlowState = {
  mode: "build",
  originalPrompt: "",
  pendingPlan: null,
  pendingAssumptions: [],
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
  /** The planner produced a plan; it now awaits Y/n. */
  | { type: "plan-received"; steps: PlanStep[]; assumptions: string[] }
  /** The user approved the plan. */
  | { type: "plan-approved" }
  /** The user rejected the plan. */
  | { type: "plan-rejected" }
  /** A step finished verification. */
  | { type: "step-verified"; stepIndex: number; verified: boolean }
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
      return { ...state, mode: action.mode };

    case "prompt-submitted":
      // A new prompt starts a genuinely new flow. Everything except the
      // user's chosen mode resets — in particular completedStepIndices,
      // which used to carry over and skip steps in the next plan.
      return {
        ...initialFlowState,
        mode: state.mode,
        originalPrompt: action.prompt,
      };

    case "mode-reported":
      // The orchestrator may run chat mode for a greeting even though the
      // pinned mode is build. Reflect what actually ran.
      return { ...state, mode: action.mode };

    case "plan-received":
      return {
        ...state,
        pendingPlan: action.steps,
        pendingAssumptions: action.assumptions,
        isAwaitingPlanApproval: true,
      };

    case "plan-approved":
      return { ...state, isAwaitingPlanApproval: false };

    case "plan-rejected":
      return {
        ...state,
        pendingPlan: null,
        pendingAssumptions: [],
        isAwaitingPlanApproval: false,
      };

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

    case "restore":
      return { ...initialFlowState, ...action.state };

    case "reset":
      return initialFlowState;
  }
}
