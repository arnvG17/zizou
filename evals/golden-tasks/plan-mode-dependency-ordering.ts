// evals/golden-tasks/plan-mode-dependency-ordering.ts
//
// GOLDEN TASK: Plan-mode dependency ordering.
//
// Creates a multi-file feature with a clear dependency chain:
// utils.ts must be created before app.ts (app imports from utils).
// Checks that the planner generates correct dependsOn ordering.

import type { GoldenTask } from "../types.js";
import { fileExists } from "../checks/file-exists.js";
import { grepContains } from "../checks/grep-contains.js";

export const planModeDependencyOrdering: GoldenTask = {
  id: "plan-mode-dependency-ordering",
  prompt:
    "Create a utils.ts file that exports a function called greet which takes a name parameter and returns a greeting string. Then create an app.ts file that imports the greet function from utils.ts and calls it with 'World'.",
  mode: "plan",

  // No pre-canned answers are needed: plan mode never asks questions. The
  // planner decides and declares its assumptions, and the runner
  // auto-approves at the y/n gate.

  async expectedCheck(workspaceDir: string) {
    // Check utils.ts exists and exports greet
    const utilsExists = await fileExists(workspaceDir, "utils.ts");
    if (!utilsExists) {
      return { passed: false, detail: "utils.ts was not created" };
    }

    const utilsExportsGreet = await grepContains(
      workspaceDir,
      "utils.ts",
      /export\s+(function|const)\s+greet/,
    );
    if (!utilsExportsGreet) {
      return {
        passed: false,
        detail: "utils.ts exists but doesn't export a 'greet' function",
      };
    }

    // Check app.ts exists and imports from utils
    const appExists = await fileExists(workspaceDir, "app.ts");
    if (!appExists) {
      return { passed: false, detail: "app.ts was not created" };
    }

    const appImportsUtils = await grepContains(
      workspaceDir,
      "app.ts",
      /import\s+.*greet.*from\s+['"]\.\/utils/,
    );
    if (!appImportsUtils) {
      return {
        passed: false,
        detail: "app.ts exists but doesn't import greet from utils",
      };
    }

    return {
      passed: true,
      detail: "Both files created with correct dependency structure",
    };
  },
};
