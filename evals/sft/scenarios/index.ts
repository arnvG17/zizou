// evals/sft/scenarios/index.ts
//
// Every scenario family, in one list.
//
// Adding a band means adding a file here and one line below — the generator,
// validator, renderer and stats all read from allScenarios() and need no
// changes of their own.

import type { Scenario } from "../types.js";
import { singleEditScenarios } from "./single-edit.js";
import { createInPlaceScenarios } from "./create-in-place.js";
import { searchThenActScenarios } from "./search-then-act.js";
import { multiFileScenarios } from "./multi-file.js";
import { recoveryScenarios } from "./recovery.js";
import { shellProcessScenarios, fsOpsScenarios } from "./shell-fs.js";
import { blockedScenarios, noToolChatScenarios } from "./prose.js";

export function allScenarios(): Scenario[] {
  const scenarios = [
    ...singleEditScenarios(),
    ...createInPlaceScenarios(),
    ...searchThenActScenarios(),
    ...multiFileScenarios(),
    ...recoveryScenarios(),
    ...shellProcessScenarios(),
    ...fsOpsScenarios(),
    ...blockedScenarios(),
    ...noToolChatScenarios(),
  ];

  // Ids are the split key — two scenarios sharing one would put near-identical
  // records on both sides of the train/val boundary, which inflates validation
  // scores by exactly the amount that makes them useless.
  const seen = new Set<string>();
  for (const s of scenarios) {
    if (seen.has(s.id)) throw new Error(`duplicate scenario id: ${s.id}`);
    seen.add(s.id);
  }

  return scenarios;
}
