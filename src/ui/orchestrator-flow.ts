// src/ui/orchestrator-flow.ts
//
// LAYER: ui/
//
// The multi-turn state of one orchestrator interaction: which mode is pinned,
// which route last ran, whether a plan is awaiting approval, and which steps
// have already run.
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
// PINNED MODE IS NOT THE SAME THING AS THE ROUTE THAT RAN.
//   These were one field, and "mode-reported" overwrote it with whatever the
//   orchestrator ran. That was survivable when only a greeting regex could
//   disagree with the pin. It is not survivable with auto mode: one prompt
//   routed to plan would have overwritten the pin with "plan" and the session
//   would never route again. The user's pin is theirs; only "set-mode"
//   touches it.
//
// WHAT IS DELIBERATELY ABSENT:
//   - No clarification state. Plan mode no longer interrogates the user
//     before it has anything to show; the planner states its assumptions and
//     the gate on a concrete plan is the review step.
//   - No escalation state. Routing is decided once, before the turn starts,
//     and never changes inside it.
//
// DEPENDENCY DIRECTION: imports types from agent/ only. No React, so it is
// directly unit-testable.

import type { Mode, Route } from "../agent/mode.js";
import type { PlanStep } from "../agent/types.js";

/** The complete multi-turn state of one orchestrator interaction. */
export interface OrchestratorFlowState {
  /**
   * What the user pinned. "auto" means the router decides per prompt.
   * ONLY the "set-mode" action changes this.
   */
  pinnedMode: Mode;
  /** What the last turn actually ran. Null before the first turn. */
  lastRoute: Route | null;
  /** Why that route ran — the router's reason, or the pinned-mode blurb. */
  lastRouteReason: string | null;
  /** The prompt that started this flow, replayed on each re-entry. */
  originalPrompt: string;
  /** A plan waiting at the gate, or null. */
  pendingPlan: PlanStep[] | null;
  /** The assumptions the planner declared for `pendingPlan`. */
  pendingAssumptions: string[];
  /** True while the plan is displayed awaiting a decision. */
  isAwaitingPlanApproval: boolean;
  /** Step indices already executed and verified in THIS flow. */
  completedStepIndices: number[];
}

export const initialFlowState: OrchestratorFlowState = {
  // Auto is the default: the router reads the prompt and picks, which beats
  // defaulting every request to a single build step regardless of what was
  // asked. /build, /plan, /chat and /ask still pin.
  pinnedMode: "auto",
  lastRoute: null,
  lastRouteReason: null,
  originalPrompt: "",
  pendingPlan: null,
  pendingAssumptions: [],
  isAwaitingPlanApproval: false,
  completedStepIndices: [],
};

export type FlowAction =
  /** The user pinned a mode via /auto, /chat, /ask, /build or /plan. */
  | { type: "set-mode"; mode: Mode }
  /** A new user prompt begins a fresh flow, keeping only the pinned mode. */
  | { type: "prompt-submitted"; prompt: string }
  /** The orchestrator reported which route it actually ran. */
  | { type: "route-reported"; route: Route; reason: string }
  /** The planner produced a plan; it now awaits a decision at the gate. */
  | { type: "plan-received"; steps: PlanStep[]; assumptions: string[] }
  /** The user approved the plan. */
  | { type: "plan-approved" }
  /** The user rejected the plan. */
  | { type: "plan-rejected" }
  /** The user typed a correction at the gate; a revised plan is coming. */
  | { type: "plan-revision-requested" }
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
      // Pinning a mode clears the last route: the badge should not keep
      // showing "→ Plan" from the previous turn once the user has pinned
      // something else.
      return { ...state, pinnedMode: action.mode, lastRoute: null, lastRouteReason: null };

    case "prompt-submitted":
      // A new prompt starts a genuinely new flow. Everything except the
      // user's pinned mode resets — in particular completedStepIndices,
      // which used to carry over and skip steps in the next plan.
      return {
        ...initialFlowState,
        pinnedMode: state.pinnedMode,
        originalPrompt: action.prompt,
      };

    case "route-reported":
      // Records what ran WITHOUT touching pinnedMode. This is the whole
      // reason the two are separate fields: in auto mode they disagree on
      // every turn, and letting the route win would un-pin auto after one
      // prompt.
      return { ...state, lastRoute: action.route, lastRouteReason: action.reason };

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

    case "plan-revision-requested":
      // The gate stays open. A correction produces a revised plan that lands
      // back at the same gate, so clearing the flag here would let the next
      // keystroke be read as a brand-new prompt while the revision is still
      // generating.
      return { ...state, isAwaitingPlanApproval: true };

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
