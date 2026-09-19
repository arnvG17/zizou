// src/agent/step-prompt.test.ts
//
// What a plan step is told about the steps before it.
//
// Plan steps get a fresh prompt on purpose — that isolation stops the model
// wandering between steps. But with NO carry-forward at all, step 3 could not
// see that step 2 had already created the file it was about to write, and
// would recreate it. These pin the minimum that prevents that.

import { test, expect } from "bun:test";
import { buildStepPrompt } from "./executor.js";
import type { PlanStep, StepDigest } from "./types.js";

const step: PlanStep = {
  index: 2,
  description: "Wire Auth into the App layout",
  targetFiles: ["src/App.tsx"],
  dependsOn: [0, 1],
};

const priors: StepDigest[] = [
  { index: 0, description: "Create the Auth component", filesTouched: ["src/Auth.tsx"], verified: true },
  { index: 1, description: "Add the useAuth hook", filesTouched: ["src/useAuth.ts"], verified: true },
];

test("a step is told which files earlier steps created", () => {
  const prompt = buildStepPrompt(step, undefined, priors);

  expect(prompt).toContain("Earlier in this plan");
  expect(prompt).toContain("src/Auth.tsx");
  expect(prompt).toContain("src/useAuth.ts");
  // Numbered for humans reading the log, matching the plan display.
  expect(prompt).toContain("Step 1:");
  expect(prompt).toContain("Step 2:");
});

test("the step is told not to recreate those files", () => {
  // The actual failure mode: without this the model writes Auth.tsx again
  // from scratch, discarding what step 1 produced.
  const prompt = buildStepPrompt(step, undefined, priors);
  expect(prompt).toContain("already exist");
  expect(prompt).toContain("do not recreate");
});

test("a failed earlier step is flagged rather than reported as done", () => {
  const withFailure: StepDigest[] = [
    { index: 0, description: "Create the Auth component", filesTouched: ["src/Auth.tsx"], verified: false },
  ];

  const prompt = buildStepPrompt(step, undefined, withFailure);
  expect(prompt).toContain("verification reported problems");
});

test("a step that changed nothing says so", () => {
  const noFiles: StepDigest[] = [
    { index: 0, description: "Check the existing setup", filesTouched: [], verified: true },
  ];

  const prompt = buildStepPrompt(step, undefined, noFiles);
  expect(prompt).toContain("no files changed");
});

test("the first step of a plan gets no carry-forward section", () => {
  const prompt = buildStepPrompt({ ...step, index: 0, dependsOn: [] }, undefined, []);
  expect(prompt).not.toContain("Earlier in this plan");
});

test("build mode is unaffected", () => {
  // Build mode passes conversation history and no digests; its prompt must
  // not grow a plan section.
  const buildStep: PlanStep = { index: 0, description: "fix the typo", targetFiles: [], dependsOn: [] };
  const prompt = buildStepPrompt(buildStep, [{ role: "user", content: "fix the typo" }]);

  expect(prompt).not.toContain("Earlier in this plan");
  expect(prompt).toContain("fix the typo");
});
