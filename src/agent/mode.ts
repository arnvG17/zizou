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
//             prompt and hands it straight to the executor. No planner.
//             This is how every `zizou "<prompt>"` invocation
//             works: fast, low-overhead, one-shot execution with a
//             verification pass at the end.
//
//   "plan"  — Activated by `zizou plan "<prompt>"` or `--plan`. Runs the
//             full loop: planner → plan-confirmation gate → per-step
//             execute+verify. Designed for multi-file feature work where you
//             want to review the plan before execution.
//
//             The planner never asks questions. It decides anything the
//             request left open and declares those decisions as assumptions
//             at the top of the plan, which you accept or reject at the gate.
//
// WHY NOT AN LLM CLASSIFICATION CALL:
//   The naive approach — ask the LLM upfront whether this prompt is
//   "simple" or "complex" — is explicitly rejected because:
//   1. It adds latency and cost to EVERY request, even trivial ones.
//   2. It just relocates the ambiguity (the LLM's classification can be
//      wrong) rather than resolving it.
//
// WHY NOTHING SWITCHES MODE BUT THE USER:
//   Build mode used to escalate itself to plan mode mid-turn: on a
//   verification failure or a high file count it stopped and asked, via a
//   modal y/n, whether to restart the whole request as a plan. That was a
//   mistake. Verification failure is a routine, noisy signal, so the prompt
//   interrupted ordinary successful turns; and accepting discarded the work
//   already written to disk to start over.
//
//   Now a large build step emits an advisory ScopeHint that the UI prints as
//   one line, and the turn finishes normally. Switching to plan mode is the
//   user's call, via /plan.

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The three operating modes for the orchestration loop.
 * "chat" = conversation, tools disabled. "build" = single-step, no planning.
 * "plan" = full multi-step with review.
 */
export type Mode = "chat" | "build" | "plan";

/**
 * The active mode and how we got there.
 *
 * `reason` is always "user-flag" today: the mode is whatever the user chose,
 * and nothing else can change it. The field is kept because the orchestrator
 * threads a ModeContext through and a future non-user source (a project
 * config default, say) would belong here rather than as a second parameter.
 */
export interface ModeContext {
  mode: Mode;
  reason: "user-flag";
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Deterministically resolves which mode to run in based on CLI flags.
 *
 * This is intentionally trivial — a pure function with no side effects,
 * no LLM call, no heuristics.
 *
 * @param args.planFlag - true if the user passed `--plan` or used
 *                        `zizou plan "<prompt>"` as a positional command.
 * @returns A ModeContext with reason "user-flag".
 */
export function resolveMode(args: { planFlag: boolean }): ModeContext {
  return {
    mode: args.planFlag ? "plan" : "build",
    reason: "user-flag",
  };
}
