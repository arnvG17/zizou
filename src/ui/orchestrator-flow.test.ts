// src/ui/orchestrator-flow.test.ts
//
// Covers the four stale-closure bugs the reducer replaces (plan Phase 2b).

import { test, expect } from "bun:test";
import { flowReducer, initialFlowState, type OrchestratorFlowState } from "./orchestrator-flow.js";

function reduce(state: OrchestratorFlowState, ...actions: Parameters<typeof flowReducer>[1][]) {
  return actions.reduce(flowReducer, state);
}

test("accepting escalation switches to plan mode and records the reason", () => {
  // Bug: setCurrentMode("plan") followed by an immediate re-invoke read the
  // pre-update mode from the render closure, re-ran build mode, escalated
  // again for the same reason, and ping-ponged.
  const state = reduce(initialFlowState,
    { type: "prompt-submitted", prompt: "refactor everything" },
    { type: "escalation-accepted" },
  );

  expect(state.mode).toBe("plan");
  expect(state.modeReason).toBe("escalated");
});

test("escalation clears any half-applied build-mode progress", () => {
  const state = reduce(initialFlowState,
    { type: "prompt-submitted", prompt: "big change" },
    { type: "step-verified", stepIndex: 0, verified: true },
    { type: "escalation-accepted" },
  );

  expect(state.completedStepIndices).toEqual([]);
  expect(state.clarificationAnswers).toEqual({});
});

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

test("a new prompt keeps the mode the user pinned", () => {
  const state = reduce(initialFlowState,
    { type: "set-mode", mode: "plan" },
    { type: "prompt-submitted", prompt: "next task" },
  );
  expect(state.mode).toBe("plan");
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

test("skipping clarifications keeps the answers already given", () => {
  // Bug: the skip path passed the stale answers object, dropping everything
  // the user had typed so far.
  const state = reduce(initialFlowState,
    { type: "clarifications-received", questions: [
      { question: "Which framework?", required: true },
      { question: "Which directory?", required: false },
    ] },
    { type: "clarification-answered", question: "Which framework?", answer: "React" },
    { type: "clarifications-skipped" },
  );

  expect(state.clarificationAnswers).toEqual({ "Which framework?": "React" });
  expect(state.isInClarificationFlow).toBe(false);
});

test("answering the last question ends the clarification flow", () => {
  const state = reduce(initialFlowState,
    { type: "clarifications-received", questions: [{ question: "Only one?", required: true }] },
    { type: "clarification-answered", question: "Only one?", answer: "yes" },
  );

  expect(state.isInClarificationFlow).toBe(false);
  expect(state.currentClarificationIndex).toBe(1);
  expect(state.clarificationAnswers).toEqual({ "Only one?": "yes" });
});

test("answers accumulate across questions", () => {
  const state = reduce(initialFlowState,
    { type: "clarifications-received", questions: [
      { question: "A?", required: true },
      { question: "B?", required: true },
    ] },
    { type: "clarification-answered", question: "A?", answer: "1" },
    { type: "clarification-answered", question: "B?", answer: "2" },
  );

  expect(state.clarificationAnswers).toEqual({ "A?": "1", "B?": "2" });
  expect(state.isInClarificationFlow).toBe(false);
});

test("rejecting a plan clears it", () => {
  const steps = [{ index: 0, description: "do a thing", targetFiles: [], dependsOn: [] }];
  const state = reduce(initialFlowState,
    { type: "plan-received", steps },
    { type: "plan-rejected" },
  );

  expect(state.pendingPlan).toBeNull();
  expect(state.isAwaitingPlanApproval).toBe(false);
});

test("approving a plan keeps the steps but closes the gate", () => {
  const steps = [{ index: 0, description: "do a thing", targetFiles: [], dependsOn: [] }];
  const state = reduce(initialFlowState,
    { type: "plan-received", steps },
    { type: "plan-approved" },
  );

  expect(state.pendingPlan).toEqual(steps);
  expect(state.isAwaitingPlanApproval).toBe(false);
});

test("mode-reported reflects an auto-detected chat turn without claiming the user chose it", () => {
  const state = reduce(initialFlowState,
    { type: "set-mode", mode: "build" },
    { type: "prompt-submitted", prompt: "hi" },
    { type: "mode-reported", mode: "chat" },
  );

  expect(state.mode).toBe("chat");
  expect(state.modeReason).toBe("user-flag");
});

test("restore fills in defaults for anything the persisted state omits", () => {
  const state = flowReducer(initialFlowState, {
    type: "restore",
    state: { mode: "plan", originalPrompt: "resume me" },
  });

  expect(state.mode).toBe("plan");
  expect(state.originalPrompt).toBe("resume me");
  expect(state.completedStepIndices).toEqual([]);
  expect(state.pendingPlan).toBeNull();
});
