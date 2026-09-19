// evals/golden-tasks/index.ts
//
// Re-exports all golden task definitions for the runner to import.

import type { GoldenTask } from "../types.js";
import { buildSingleFileFix } from "./build-single-file-fix.js";
import { planModeDependencyOrdering } from "./plan-mode-dependency-ordering.js";
import { planModeDeliberateFailure } from "./plan-mode-deliberate-failure.js";
import { ambiguousPromptAssumptions } from "./ambiguous-prompt-assumptions.js";

/**
 * All registered golden tasks. The runner iterates over this array
 * (or filters by --task <id>) to execute the eval suite.
 */
export const ALL_TASKS: GoldenTask[] = [
  buildSingleFileFix,
  planModeDependencyOrdering,
  planModeDeliberateFailure,
  ambiguousPromptAssumptions,
];
