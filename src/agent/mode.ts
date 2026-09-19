// src/agent/mode.ts
//
// LAYER: agent/
//
// Defines the modes the user can pin, and the routes the orchestration loop
// can actually run.
//
// A MODE IS WHAT THE USER PINS. A ROUTE IS WHAT RUNS.
//   Four of the five modes are also routes — pin "build" and build mode runs.
//   "auto" is the exception: it is a pin that defers the decision, and the
//   router turns it into one of the other four per prompt. Nothing executes
//   as "auto", which is why Route excludes it rather than leaving every
//   switch statement with an unreachable branch to handle.
//
//   "auto"  — The default. A small, fast LLM classification call reads the
//             prompt and picks chat, ask, build or plan. See router.ts.
//
//   "chat"  — Conversation. No file-modifying tools; nothing on disk can
//             change. Pinned with /chat, which also strips the read-only
//             tools — an explicit pin means "just talk". Reached via auto it
//             keeps readFile/glob/grep/listDir, because a routing guess that
//             turns out to need a file should read it rather than invent it.
//
//   "ask"   — Questions about this codebase. Read-only tools (readFile, glob,
//             grep, listDir) and nothing else: the agent can look at anything
//             and change nothing. This is the route for "how does X work",
//             which used to have nowhere to go — chat mode could not read the
//             file and build mode could rewrite it.
//
//   "build" — Synthesizes a single PlanStep from the raw user prompt and
//             hands it straight to the executor. No planner. Fast,
//             low-overhead, one-shot execution with a verification pass.
//
//   "plan"  — The full loop: planner → plan-confirmation gate → per-step
//             execute+verify. For multi-file feature work where you want to
//             review the plan before execution.
//
//             The planner never asks questions. It decides anything the
//             request left open and declares those decisions as assumptions
//             at the top of the plan, which you accept, reject, or correct in
//             free text at the gate.
//
// ON THE LLM CLASSIFICATION CALL:
//   This file used to argue that classifying the prompt upfront was wrong
//   because it "adds latency and cost to EVERY request, even trivial ones".
//   That objection is answered rather than overruled: the call fires only
//   when the pinned mode is "auto". Pin /build, /plan, /chat or /ask and the
//   router is never constructed, so those paths cost exactly what they cost
//   before.
//
//   The second objection — that a classifier "just relocates the ambiguity"
//   because it can be wrong — is real and is handled structurally rather than
//   wished away: the router downgrades low-confidence decisions toward the
//   cheaper route, a plan route still stops at the y/n gate where a misroute
//   is visible and correctable, and every failure path falls back to a
//   deterministic answer instead of throwing.
//
// WHY NOTHING SWITCHES MODE MID-TURN:
//   Build mode used to escalate itself to plan mode on a verification failure
//   or a high file count, via a modal y/n asking whether to restart the whole
//   request. That was a mistake: verification failure is a routine, noisy
//   signal, so the prompt interrupted ordinary successful turns, and accepting
//   discarded the work already written to disk.
//
//   Routing is decided ONCE, before the turn starts, and never revisited
//   inside it. A large build step emits an advisory ScopeHint that the UI
//   prints as one line, and the turn finishes normally.

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * What the user pinned. "auto" defers the choice to the router; the other
 * four name a route directly.
 */
export type Mode = "auto" | "chat" | "ask" | "build" | "plan";

/**
 * What the orchestrator actually runs. Never "auto" — by the time the
 * orchestrator dispatches, auto has been resolved to one of these.
 */
export type Route = Exclude<Mode, "auto">;

/** Every mode, in the order they are presented to the user. */
export const MODES: Mode[] = ["auto", "chat", "ask", "build", "plan"];

/**
 * The active mode and how we got there.
 *
 * "user-flag" means the user asked for this mode explicitly (a CLI flag or a
 * slash command). "default" means nobody chose — which today can only produce
 * "auto", and is worth distinguishing so the UI can tell a deliberate /auto
 * from a session that simply never picked anything.
 */
export interface ModeContext {
  mode: Mode;
  reason: "user-flag" | "default";
}

/** Type guard: is this pinned mode directly runnable? */
export function isRoute(mode: Mode): mode is Route {
  return mode !== "auto";
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Deterministically resolves which mode to run in based on CLI flags.
 *
 * This is intentionally trivial — a pure function with no side effects and no
 * heuristics. The smart part lives in router.ts and runs later, only if this
 * returns "auto".
 *
 * Flags are checked most-specific-first so that a nonsensical combination
 * (`--plan --chat`) resolves predictably rather than by object key order.
 */
export function resolveMode(args: {
  planFlag: boolean;
  chatFlag?: boolean;
  askFlag?: boolean;
  autoFlag?: boolean;
  buildFlag?: boolean;
}): ModeContext {
  if (args.planFlag) return { mode: "plan", reason: "user-flag" };
  if (args.buildFlag) return { mode: "build", reason: "user-flag" };
  if (args.askFlag) return { mode: "ask", reason: "user-flag" };
  if (args.chatFlag) return { mode: "chat", reason: "user-flag" };
  if (args.autoFlag) return { mode: "auto", reason: "user-flag" };

  // No flag at all. Auto is the default: the router reads the prompt and
  // picks, which is almost always better than defaulting every request to a
  // single build step regardless of what was asked.
  return { mode: "auto", reason: "default" };
}
