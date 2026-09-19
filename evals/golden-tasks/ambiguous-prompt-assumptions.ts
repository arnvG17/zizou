// evals/golden-tasks/ambiguous-prompt-assumptions.ts
//
// GOLDEN TASK: Ambiguous prompt → planner decides and declares assumptions.
//
// Sends a genuinely underspecified prompt ("Add authentication") and checks
// that the planner produced a plan WITH a non-empty assumptions list, rather
// than stalling.
//
// This replaces ambiguous-prompt-clarifier, which asserted the opposite: that
// the agent stopped and asked the user questions. Plan mode no longer has a
// clarifier — an underspecified request must still yield a runnable plan, and
// the judgement calls it required must be visible so the user can reject them
// at the y/n gate.
//
// Like its predecessor this is a lower-confidence check: we cannot verify the
// *quality* of an assumption automatically, only that the planner committed to
// something and said so.

import type { GoldenTask } from "../types.js";

export const ambiguousPromptAssumptions: GoldenTask = {
  id: "ambiguous-prompt-assumptions",
  prompt: "Add authentication",
  mode: "plan",

  async expectedCheck(workspaceDir: string) {
    // The runner writes captured orchestrator events to __eval_events.json
    const { readFileSync, existsSync } = await import("fs");
    const { resolve } = await import("path");

    const eventsPath = resolve(workspaceDir, "__eval_events.json");
    if (!existsSync(eventsPath)) {
      return {
        passed: false,
        detail: "Runner did not write __eval_events.json — runner bug",
      };
    }

    try {
      const events = JSON.parse(readFileSync(eventsPath, "utf-8"));

      const planEvent = events.find((e: any) => e.kind === "plan-ready");
      if (!planEvent) {
        return {
          passed: false,
          detail: 'No "plan-ready" event emitted — the planner produced nothing',
        };
      }

      if (!Array.isArray(planEvent.steps) || planEvent.steps.length === 0) {
        return {
          passed: false,
          detail: '"plan-ready" emitted with no steps',
        };
      }

      if (!Array.isArray(planEvent.assumptions) || planEvent.assumptions.length === 0) {
        return {
          passed: false,
          detail:
            '"plan-ready" emitted with no assumptions for a deliberately ' +
            'underspecified prompt — the planner made silent choices the user ' +
            "cannot review or reject",
        };
      }

      // Nothing should be waiting on the user besides the y/n gate.
      const asked = events.find((e: any) => e.kind === "clarification-needed");
      if (asked) {
        return {
          passed: false,
          detail: 'Orchestrator emitted "clarification-needed" — the clarifier stage should be gone',
        };
      }

      return {
        passed: true,
        detail:
          `Planner produced ${planEvent.steps.length} step(s) and declared ` +
          `${planEvent.assumptions.length} assumption(s) without asking questions`,
      };
    } catch (err) {
      return {
        passed: false,
        detail: `Failed to parse __eval_events.json: ${err}`,
      };
    }
  },
};
