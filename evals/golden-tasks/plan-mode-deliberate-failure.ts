// evals/golden-tasks/plan-mode-deliberate-failure.ts
//
// GOLDEN TASK: Deliberate verification failure.
//
// Sends a prompt that asks to edit a file that doesn't exist in the
// temp workspace. The orchestrator should detect the failure through
// verification (file claimed-changed-but-missing or verification failed)
// and either:
//   - Emit step-verified with verified: false
//   - Emit a scope-hint
//
// This validates that the system catches failures instead of silently
// reporting success. Tests FIX_PLAN_MODE_STOP_ON_FAILURE behavior.

import type { GoldenTask } from "../types.js";

/**
 * This task's check is special: it inspects the orchestrator events
 * captured by the runner, not just the workspace. The runner will
 * pass event data through the workspace via a sentinel file.
 *
 * But for simplicity in v1, we just check that the workspace does NOT
 * contain a properly edited config.json — if it does, the task "passed"
 * from the orchestrator's perspective but our check should FAIL because
 * there was nothing to edit (the file shouldn't have existed).
 *
 * The REAL check: the runner captures orchestrator events and writes
 * a `__eval_events.json` file to the workspace. We inspect that.
 */
export const planModeDeliberateFailure: GoldenTask = {
  id: "plan-mode-deliberate-failure",
  prompt:
    'Edit the file config.json to add a "version" field with value "1.0.0"',
  mode: "build",

  async expectedCheck(workspaceDir: string) {
    // The runner writes captured orchestrator events to this file
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

      // Look for a verification failure or an advisory scope hint
      const hasVerificationFailure = events.some(
        (e: any) =>
          e.kind === "step-verified" &&
          e.verification &&
          e.verification.verified === false,
      );

      const hasScopeHint = events.some((e: any) => e.kind === "scope-hint");

      if (hasVerificationFailure || hasScopeHint) {
        return {
          passed: true,
          detail: hasVerificationFailure
            ? "Verification correctly detected failure"
            : "Scope hint correctly emitted on failure",
        };
      }

      // If the orchestrator reported success but the file didn't exist
      // initially, that's also acceptable — the model may have created
      // the file from scratch (writeFile, not editFile). Check if the
      // model at least produced a file.
      const configPath = resolve(workspaceDir, "config.json");
      if (existsSync(configPath)) {
        const content = readFileSync(configPath, "utf-8");
        try {
          const parsed = JSON.parse(content);
          if (parsed.version === "1.0.0") {
            return {
              passed: true,
              detail:
                "Model created config.json from scratch with correct content (acceptable recovery)",
            };
          }
        } catch {
          // Invalid JSON
        }
      }

      return {
        passed: false,
        detail:
          "Orchestrator did not detect failure — no verification-failed or escalation event emitted",
      };
    } catch (err) {
      return {
        passed: false,
        detail: `Failed to parse __eval_events.json: ${err}`,
      };
    }
  },
};
