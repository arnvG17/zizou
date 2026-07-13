// evals/golden-tasks/ambiguous-prompt-clarifier.ts
//
// GOLDEN TASK: Ambiguous prompt → clarifier should ask questions.
//
// Sends a genuinely underspecified prompt ("Add authentication") and
// checks that the clarifier returns a non-empty questions array.
// This is a lower-confidence check — we can't verify question *quality*
// automatically, just that the clarifier path works end-to-end.

import type { GoldenTask } from "../types.js";

export const ambiguousPromptClarifier: GoldenTask = {
  id: "ambiguous-prompt-clarifier",
  prompt: "Add authentication",
  mode: "plan",
  // Deliberately NO clarifierAnswers — we want to see if the clarifier
  // generates questions. The runner will check for the
  // "clarification-needed" event.

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

      // Check for clarification-needed event with non-empty questions
      const clarificationEvent = events.find(
        (e: any) => e.kind === "clarification-needed",
      );

      if (!clarificationEvent) {
        return {
          passed: false,
          detail:
            'No "clarification-needed" event emitted — clarifier skipped questions for an ambiguous prompt',
        };
      }

      if (
        !clarificationEvent.questions ||
        clarificationEvent.questions.length === 0
      ) {
        return {
          passed: false,
          detail:
            '"clarification-needed" emitted but with empty questions array',
        };
      }

      return {
        passed: true,
        detail: `Clarifier generated ${clarificationEvent.questions.length} question(s) for ambiguous prompt`,
      };
    } catch (err) {
      return {
        passed: false,
        detail: `Failed to parse __eval_events.json: ${err}`,
      };
    }
  },
};
