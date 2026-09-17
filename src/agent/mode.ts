// src/agent/mode.ts
//
// LAYER: agent/
//
// Defines the three operating modes for the orchestration loop:
//
//   "chat"  — Conversation only. Tools are disabled entirely; nothing on
//             disk can change. Entered automatically for greetings and
//             chit-chat (a deterministic regex, see orchestrator.ts), or
//             pinned explicitly with /chat.
//
//             This path always existed, but it reported itself to the UI as
//             mode "build", so the badge claimed a file-modifying mode was
//             running when tools were switched off. A mode the user can see
//             and pin is worth more than a hidden branch.
//
//   "build" — The default. Synthesizes a single PlanStep from the raw user
//             prompt and hands it straight to the executor. No clarifier,
//             no planner. This is how every `zizou "<prompt>"` invocation
//             works: fast, low-overhead, one-shot execution with a
//             verification pass at the end.
//
//   "plan"  — Activated by `zizou plan "<prompt>"` or `--plan`. Runs the
//             full loop: clarifier → planner → plan-confirmation gate →
//             per-step execute+verify. Designed for multi-file feature
//             work where you want to review the plan before execution.
//
// WHY NOT AN LLM CLASSIFICATION CALL:
//   The naive approach — ask the LLM upfront whether this prompt is
//   "simple" or "complex" — is explicitly rejected because:
//   1. It adds latency and cost to EVERY request, even trivial ones.
//   2. It just relocates the ambiguity (the LLM's classification can be
//      wrong) rather than resolving it.
//   Instead: the user picks the mode explicitly, and if a build-mode
//   request turns out to be more complex than expected mid-execution,
//   the orchestrator detects this DETERMINISTICALLY (by counting touched
//   files or catching verification failures) and offers to escalate to
//   plan mode — never silently, always with a user prompt.
//
// The `reason` field in ModeContext tracks HOW we ended up in this mode:
//   "user-flag"  — the user explicitly chose it (CLI flag or command)
//   "escalated"  — the orchestrator switched from build to plan because
//                  deterministic escalation logic triggered (e.g., too
//                  many files touched, verification failure)

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The three operating modes for the orchestration loop.
 * "chat" = conversation, tools disabled. "build" = single-step, no planning.
 * "plan" = full multi-step with review.
 */
export type Mode = "chat" | "build" | "plan";

/**
 * Captures both the active mode AND how we got there — important because
 * escalation from build → plan needs to be distinguishable from the user
 * originally choosing plan mode (e.g., for logging, or to decide whether
 * to show "escalated from build" messaging in the UI).
 */
export interface ModeContext {
  mode: Mode;
  reason: "user-flag" | "escalated";
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Deterministically resolves which mode to run in based on CLI flags.
 *
 * This is intentionally trivial — a pure function with no side effects,
 * no LLM call, no heuristics. The complexity lives in the orchestrator's
 * escalation logic (see orchestrator.ts), not here.
 *
 * @param args.planFlag - true if the user passed `--plan` or used
 *                        `zizou plan "<prompt>"` as a positional command.
 * @returns A ModeContext with reason "user-flag" — escalation is handled
 *          separately by the orchestrator after execution begins.
 */
export function resolveMode(args: { planFlag: boolean }): ModeContext {
  return {
    mode: args.planFlag ? "plan" : "build",
    reason: "user-flag",
  };
}
