// src/ui/orchestrator-flow.test.ts
//
// Covers the stale-closure bugs the reducer replaces, and the invariant that
// the orchestrator never changes mode on its own.

import { test, expect } from "bun:test";
import { flowReducer, initialFlowState, type OrchestratorFlowState } from "./orchestrator-flow.js";

function reduce(state: OrchestratorFlowState, ...actions: Parameters<typeof flowReducer>[1][]) {
  return actions.reduce(flowReducer, state);
}

const oneStep = [{ index: 0, description: "do a thing", targetFiles: [], dependsOn: [] }];

test("a new prompt resets completedStepIndices", () => {
  // Bug: indices were only ever appended, so plan A's completed steps caused
  // plan B to silently skip the steps at those indices.
  const afterPlanA = reduce(initialFlowState,
    { type: "prompt-submitted", prompt: "plan A" },
    { type: "step-verified", stepIndex: 0, verified: true },
    { type: "step-verified", stepIndex: 1, verified: true },
  );
  expect(afterPlanA.completedStepIndices).toEqual([0, 1]);

  const afterPlanB = flowReducer(afterPlanA, { type: "prompt-submitted", prompt: "plan B" });
  expect(afterPlanB.completedStepIndices).toEqual([]);
  expect(afterPlanB.originalPrompt).toBe("plan B");
});

test("a new prompt clears any plan left at the approval gate", () => {
  const state = reduce(initialFlowState,
    { type: "plan-received", steps: oneStep, assumptions: ["React"] },
    { type: "prompt-submitted", prompt: "something else" },
  );
  expect(state.pendingPlan).toBeNull();
  expect(state.pendingAssumptions).toEqual([]);
  expect(state.isAwaitingPlanApproval).toBe(false);
});

test("a new prompt keeps the mode the user pinned", () => {
  const state = reduce(initialFlowState,
    { type: "set-mode", mode: "plan" },
    { type: "prompt-submitted", prompt: "next task" },
  );
  expect(state.pinnedMode).toBe("plan");
});

test("step-verified does not double-count an already completed step", () => {
  // The orchestrator yields a synthetic step-verified for steps it SKIPPED
  // because they are already in this list; re-appending grew duplicates.
  const state = reduce(initialFlowState,
    { type: "step-verified", stepIndex: 2, verified: true },
    { type: "step-verified", stepIndex: 2, verified: true },
  );
  expect(state.completedStepIndices).toEqual([2]);
});

test("a failed step is not recorded as completed", () => {
  const state = flowReducer(initialFlowState, { type: "step-verified", stepIndex: 0, verified: false });
  expect(state.completedStepIndices).toEqual([]);
});

test("a plan carries its assumptions to the approval gate", () => {
  const state = flowReducer(initialFlowState, {
    type: "plan-received",
    steps: oneStep,
    assumptions: ["React + Vite", "No backend"],
  });

  expect(state.isAwaitingPlanApproval).toBe(true);
  expect(state.pendingAssumptions).toEqual(["React + Vite", "No backend"]);
});

test("rejecting a plan clears it and its assumptions", () => {
  const state = reduce(initialFlowState,
    { type: "plan-received", steps: oneStep, assumptions: ["React"] },
    { type: "plan-rejected" },
  );

  expect(state.pendingPlan).toBeNull();
  expect(state.pendingAssumptions).toEqual([]);
  expect(state.isAwaitingPlanApproval).toBe(false);
});

test("approving a plan keeps the steps but closes the gate", () => {
  const state = reduce(initialFlowState,
    { type: "plan-received", steps: oneStep, assumptions: [] },
    { type: "plan-approved" },
  );

  expect(state.pendingPlan).toEqual(oneStep);
  expect(state.isAwaitingPlanApproval).toBe(false);
});

test("route-reported records what ran without touching the pin", () => {
  const state = reduce(initialFlowState,
    { type: "set-mode", mode: "build" },
    { type: "prompt-submitted", prompt: "hi" },
    { type: "route-reported", route: "chat", reason: "greeting" },
  );

  expect(state.lastRoute).toBe("chat");
  expect(state.lastRouteReason).toBe("greeting");
  expect(state.pinnedMode).toBe("build");
});

test("auto survives a turn that routed somewhere else", () => {
  // THE REGRESSION THIS FILE EXISTS FOR. mode and lastRoute used to be one
  // field, so a single auto turn that routed to plan overwrote the pin with
  // "plan" and the session never routed again.
  const state = reduce(initialFlowState,
    { type: "prompt-submitted", prompt: "add dark mode everywhere" },
    { type: "route-reported", route: "plan", reason: "multi-file work" },
    { type: "plan-received", steps: oneStep, assumptions: [] },
    { type: "plan-approved" },
    { type: "step-verified", stepIndex: 0, verified: true },
  );

  expect(state.pinnedMode).toBe("auto");
  expect(state.lastRoute).toBe("plan");
});

test("a new prompt clears the last route but keeps the pin", () => {
  // The badge reads "Auto -> Plan" from lastRoute. Carrying it into the next
  // prompt would claim a route that has not been chosen yet.
  const state = reduce(initialFlowState,
    { type: "route-reported", route: "plan", reason: "multi-file work" },
    { type: "prompt-submitted", prompt: "now something else" },
  );

  expect(state.pinnedMode).toBe("auto");
  expect(state.lastRoute).toBeNull();
});

test("pinning a mode clears a stale route from the badge", () => {
  const state = reduce(initialFlowState,
    { type: "route-reported", route: "plan", reason: "multi-file work" },
    { type: "set-mode", mode: "build" },
  );

  expect(state.pinnedMode).toBe("build");
  expect(state.lastRoute).toBeNull();
});

test("a correction at the gate keeps the gate open", () => {
  // The revised plan lands back at the same gate. Closing the flag here would
  // let the next keystroke be read as a brand-new prompt while the revision
  // is still generating.
  const state = reduce(initialFlowState,
    { type: "plan-received", steps: oneStep, assumptions: [] },
    { type: "plan-revision-requested" },
  );

  expect(state.isAwaitingPlanApproval).toBe(true);
  expect(state.pendingPlan).toEqual(oneStep);
});

test("nothing in the reducer can switch a build flow into plan mode", () => {
  // The orchestrator used to escalate build -> plan mid-turn behind the
  // user's back. Mode is now the user's decision alone: no action other than
  // an explicit set-mode (or the orchestrator reporting what it ran) moves it.
  const build = flowReducer(initialFlowState, { type: "set-mode", mode: "build" });

  const afterEverything = reduce(build,
    { type: "prompt-submitted", prompt: "refactor the entire app" },
    { type: "step-verified", stepIndex: 0, verified: false },
    { type: "plan-received", steps: oneStep, assumptions: [] },
    { type: "plan-rejected" },
  );

  expect(afterEverything.pinnedMode).toBe("build");
});

test("restore fills in defaults for anything the persisted state omits", () => {
  const state = flowReducer(initialFlowState, {
    type: "restore",
    state: { pinnedMode: "plan", originalPrompt: "resume me" },
  });

  expect(state.pinnedMode).toBe("plan");
  expect(state.originalPrompt).toBe("resume me");
  expect(state.completedStepIndices).toEqual([]);
  expect(state.pendingPlan).toBeNull();
  expect(state.pendingAssumptions).toEqual([]);
});
