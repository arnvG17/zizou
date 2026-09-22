// src/agent/router.ts
//
// LAYER: agent/
//
// The smart router. Reads the user's prompt and decides which route runs:
// chat, ask, build or plan.
//
// ONLY CALLED IN AUTO MODE. A pinned mode (/build, /plan, /chat, /ask, or the
// --plan flag) never constructs this module, never makes the call, and never
// pays for it. That is the whole answer to the objection this repo used to
// record against upfront classification — see the comment block in mode.ts.
//
// THE CALL IS DELIBERATELY SMALL:
//   - the fast-tier model for the active provider, regardless of the session's
//     effort level. Picking between four labels does not need the max model,
//     and the router sits in front of every auto turn, so its latency is the
//     user's latency.
//   - no tools. The router does not get to explore; it reads the prompt and
//     answers. Exploration is the route's job, not the routing decision's.
//   - a hard output cap and a hard timeout. A router that hangs is worse than
//     a router that guesses.
//   - maxRetries: 0, the house convention (see run-turn.ts). A retry here
//     doubles the latency of the cheapest possible decision.
//
// IT MUST NEVER THROW. Every failure path — timeout, API error, unparseable
// output, a route string the model invented — resolves to a deterministic
// fallback. A broken router degrades auto mode to "the old default"; it does
// not break the user's turn.
//
// DEPENDENCY DIRECTION: imports from config/ and sdk/ only. Must NOT import
// from ui/, tools/, or the rest of agent/ (mode.ts is types only).

import { generateText, type ModelMessage } from "ai";
import { recordUsage } from "../telemetry/index.js";
import type { Route } from "./mode.js";
import { resolveModel } from "../sdk/resolve-model.js";
import { modelForEffort } from "../config/effort.js";
import { resolveAgentConfig } from "../config/agent-config.js";
import type { ProviderChoice } from "../config/api-keys.js";

// ─── Tuning ──────────────────────────────────────────────────────────────────

/**
 * How long the router gets before we stop waiting and fall back.
 *
 * A ceiling on added latency, not an expected duration. It is set well above
 * the observed time because a fallback that fires on a merely slow call is
 * worse than waiting: it throws away a good answer that was about to arrive
 * and routes on a greeting regex instead.
 *
 * Measured on gpt-5-mini (a reasoning model, the slow end of the fast tier):
 * 2.6s–4.3s per classification. Non-reasoning fast-tier models answer in well
 * under a second. 5s was the first value here and sat inside that range, so
 * ordinary calls would have raced the timeout.
 */
const ROUTER_TIMEOUT_MS = 12_000;

/**
 * Output cap.
 *
 * The answer is one small JSON object — roughly 30 tokens — so this looks
 * absurdly generous. It is not: several fast-tier models (gpt-5-mini among
 * them) are REASONING models, and their reasoning tokens are drawn from this
 * same budget before any visible text is produced.
 *
 * At 150 the measured behaviour was 128 reasoning tokens, 0 text tokens,
 * finishReason "length", and an empty string — so every prompt silently took
 * the fallback route and the router did nothing but add latency. The headroom
 * is what makes the call work at all; models that do not reason simply stop
 * after their ~30 tokens and are never billed for the rest.
 */
const ROUTER_MAX_TOKENS = 800;

/**
 * Below this, the model is guessing and we say so by moving toward the
 * cheaper mistake rather than trusting the label.
 */
const LOW_CONFIDENCE = 0.4;

/** How many prior turns the router sees, and how much of each. */
const HISTORY_TURNS = 3;
const HISTORY_CHARS = 600;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RouteDecision {
  /** The route to run. */
  route: Route;
  /** 0..1. The model's own confidence, or 0 for a fallback. */
  confidence: number;
  /** One short clause, shown to the user so a misroute is legible. */
  reason: string;
  /** Whether an LLM actually decided this, or we degraded to the fallback. */
  source: "llm" | "fallback";
}

export interface RoutePromptArgs {
  userPrompt: string;
  history?: ModelMessage[];
  provider: ProviderChoice;
  projectRoot: string;
}

// ─── Deterministic fallback ──────────────────────────────────────────────────

/**
 * The greeting/chit-chat detector.
 *
 * This used to live in orchestrator.ts and fire on EVERY turn, hijacking even
 * a pinned build mode for anything greeting-shaped. It now has exactly one
 * job: answering "what route would we have picked without an LLM?" when the
 * router cannot reach one.
 */
export function isConversational(prompt: string): boolean {
  const p = prompt.trim().toLowerCase();

  // A greeting-only message: the greeting word is immediately followed by
  // punctuation or end-of-string — NOT by more words that form a task.
  // "hi" → conversational   "hi build me a file" → NOT conversational
  const greetingOnly =
    /^(hi|hello|hey|yo|hola|greetings|good morning|good afternoon|good evening|howdy|sup|whats up|what's up)[.,!?\s]*$/i.test(
      p,
    );

  if (greetingOnly) {
    // Even if it looks like a greeting, bail out if there are task-intent
    // keywords. A safety net for "hi, can you write me..." style messages.
    const taskKeywords =
      /\b(build|make|create|write|generate|add|edit|fix|update|run|install|refactor|implement|change|delete|remove|file|code|function|component|page|app|script|test|html|css|ts|js|tsx|jsx)\b/i;
    if (taskKeywords.test(p)) return false;
    return true;
  }

  // Pure chit-chat phrases (exact match only)
  return (
    p === "test" ||
    p === "ping" ||
    p === "how are you" ||
    p === "who are you" ||
    p === "what is your name"
  );
}

/**
 * The route we take when the LLM is unavailable or unintelligible.
 *
 * Build, not ask: without a classifier we cannot tell a question from a task,
 * and silently answering instead of doing is the more surprising failure.
 */
export function fallbackRoute(prompt: string, reason: string): RouteDecision {
  return {
    route: isConversational(prompt) ? "chat" : "build",
    confidence: 0,
    reason,
    source: "fallback",
  };
}

// ─── The classifier prompt ───────────────────────────────────────────────────

const ROUTER_SYSTEM = `You are the router for Zizou, an AI coding agent. You read the user's message and choose which of four execution routes should handle it. You do nothing else — you never answer the user, never write code, and never call tools.

THE FOUR ROUTES:

"chat" — Greetings, thanks, small talk, or a question about Zizou itself (what can you do, what mode am I in). No knowledge of the user's codebase is needed to respond.

"ask" — The user wants to UNDERSTAND something. Questions about their codebase ("how does auth work", "where is the retry logic", "why is this test failing", "explain this function") and general technical questions. Choose it when the reply itself is what the user wanted. If they want something DONE — even something small, even something that changes no code — it is not this route.

"build" — The user wants an ACTION performed. Usually one concrete change, plausibly one to three files: "fix the typo in the header", "add a --verbose flag", "rename this function", "make the button blue", "write a test for parseConfig".

    It is ALSO build when the action changes no code at all — opening a file, running a script, starting the dev server, installing a package, formatting, launching something in the browser. "Changes no code" does not make it a question. If the user is telling you to DO a thing rather than to EXPLAIN a thing, it is build.

"plan" — Choose plan for EITHER of two reasons.

    (a) SIZE. Multi-file feature work, a migration, a refactor spanning modules, or any request with several ordered parts that must happen in sequence. Signals: multiple named surfaces, "across", "and then", "refactor", "migrate", "set up". Choose plan when getting the order wrong would mean redoing work.

    (b) OPEN DECISIONS. The user asked you to CREATE something new, and did not say what it should do. Even a single file. "make a todo app", "build a chess game", "create a dashboard", "write me a scraper" name an artifact and nothing else — the features, the data storage, the framework and the styling are all unstated, so building it means silently inventing a dozen product decisions the user never saw.

    Plan mode exists for exactly this: the planner states its assumptions and the user corrects them at the gate BEFORE anything is written. A wrong guess caught at the gate costs one line of typing; the same guess caught after execution costs the whole file.

    (b) applies to CREATING something new and underspecified. It does NOT apply to a small, clear change to something that already exists — "fix the typo", "rename this function", "add a --verbose flag" leave nothing open, however short they are.

HOW TO DECIDE:
- Is the user asking or telling? Asking → chat or ask. Telling → build or plan.
- An imperative verb is telling, even a short one. "open it", "run it", "show me the file", "try it" are all build — the user wants the thing done, not described.
- If telling, ask TWO questions, not one:
    1. How big is it? Several ordered steps → plan.
    2. How specified is it? Creating something new with its behaviour unstated → plan, even if it is one file.
  Only when the answer to both is "small and clear" is it build.
- "Small" and "specified" are different things. A one-file request can still leave every product decision open. Do not let a short prompt read as a simple one.
- Grammar lies. "can you add a dark mode toggle" is phrased as a question but is a build. "should I be using useEffect here" is phrased as a question and is an ask.
- A greeting attached to a task is the task. Route on the task.
- Follow-ups inherit context. After a build, "now add tests for it" is another build, not a question.

EXAMPLES:
"hey" -> {"route":"chat","confidence":0.98,"reason":"greeting"}
"what can you do?" -> {"route":"chat","confidence":0.9,"reason":"question about the agent itself"}
"how does the checkpoint system work?" -> {"route":"ask","confidence":0.95,"reason":"wants an explanation of existing code"}
"why is my build failing" -> {"route":"ask","confidence":0.85,"reason":"diagnosis, no change requested yet"}
"where do we handle rate limits?" -> {"route":"ask","confidence":0.95,"reason":"locating existing code"}
"open it" -> {"route":"build","confidence":0.9,"reason":"imperative action, not a question"}
"open index.html in my browser" -> {"route":"build","confidence":0.95,"reason":"perform an action, changes no code"}
"run the tests" -> {"route":"build","confidence":0.95,"reason":"perform an action"}
"fix the typo in the README" -> {"route":"build","confidence":0.95,"reason":"single small edit"}
"can you add a --verbose flag to the CLI" -> {"route":"build","confidence":0.85,"reason":"question-phrased, but one concrete change"}
"hi, make the header sticky" -> {"route":"build","confidence":0.9,"reason":"greeting plus one task"}
"add dark mode across the settings page, the header and the theme provider" -> {"route":"plan","confidence":0.9,"reason":"three named surfaces, ordered work"}
"migrate us from express to fastify" -> {"route":"plan","confidence":0.95,"reason":"migration spanning the codebase"}
"build me a chess app with a timer and move history" -> {"route":"plan","confidence":0.85,"reason":"whole application, several components"}
"create a new todoapp.html" -> {"route":"plan","confidence":0.8,"reason":"new app, behaviour unspecified"}
"make me a scraper" -> {"route":"plan","confidence":0.85,"reason":"new tool, nothing specified"}
"create hello.txt containing exactly: hi" -> {"route":"build","confidence":0.95,"reason":"new file, contents fully specified"}
"add a --verbose flag to the CLI" -> {"route":"build","confidence":0.9,"reason":"small change, nothing left open"}
"now write tests for that" -> {"route":"build","confidence":0.8,"reason":"follow-up change to what was just built"}

OUTPUT:
Respond with ONLY this JSON object and nothing else — no prose, no code fence:
{"route": "chat" | "ask" | "build" | "plan", "confidence": <number between 0 and 1>, "reason": "<at most 8 words, lowercase, no trailing period>"}`;

/**
 * Renders the recent conversation so follow-ups route correctly.
 *
 * Without this, "now add tests for it" has no referent and classifies as an
 * ask. Truncated hard — the router needs the shape of the conversation, not
 * its contents.
 */
function renderHistory(history: ModelMessage[] | undefined): string {
  if (!history || history.length === 0) return "";

  const recent = history.slice(-HISTORY_TURNS * 2);
  const lines: string[] = [];

  for (const message of recent) {
    if (message.role !== "user" && message.role !== "assistant") continue;

    // Content is a string or an array of parts; we only want the text.
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
            .join(" ");

    const trimmed = text.trim();
    if (!trimmed) continue;

    lines.push(`${message.role}: ${trimmed.slice(0, HISTORY_CHARS)}`);
  }

  if (lines.length === 0) return "";
  return `Recent conversation (oldest first), for context only:\n${lines.join("\n")}\n\n`;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

const VALID_ROUTES: readonly Route[] = ["chat", "ask", "build", "plan"];

/**
 * Pulls a RouteDecision out of the model's raw text, or returns null.
 *
 * Tolerant on the way in, strict on the way out: strips a code fence, finds
 * the first JSON object anywhere in the text, and rejects anything that is
 * not one of the four known routes. Returning null (rather than a guess) is
 * what lets the caller fall back deterministically.
 */
export function parseRouteDecision(raw: string): RouteDecision | null {
  let text = raw.trim();
  if (!text) return null;

  // Strip a markdown fence if the model added one despite being told not to.
  if (text.includes("```")) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) text = fenced[1].trim();
  }

  // Some models prepend a sentence. Take the first balanced-looking object.
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    text = text.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const route = typeof obj.route === "string" ? obj.route.trim().toLowerCase() : "";
  if (!VALID_ROUTES.includes(route as Route)) return null;

  // Confidence is advisory metadata, so a missing or malformed value is not
  // worth discarding a valid route over — treat it as "no strong opinion".
  const rawConfidence = typeof obj.confidence === "number" ? obj.confidence : 0.5;
  const confidence = Number.isFinite(rawConfidence)
    ? Math.min(1, Math.max(0, rawConfidence))
    : 0.5;

  const reason =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim().slice(0, 80)
      : "no reason given";

  return { route: route as Route, confidence, reason, source: "llm" };
}

/**
 * Nudges low-confidence decisions toward the cheaper mistake.
 *
 * The asymmetry is deliberate. A wrong "plan" costs the user a planning round
 * trip and a gate they have to decline; a wrong "build" costs one step they
 * can undo. A wrong "chat" answers a real question from thin air; a wrong
 * "ask" reads a few files it did not need to. In both pairs one side is
 * recoverable and the other is annoying, so uncertainty resolves toward
 * recoverable.
 */
export function applyConfidencePolicy(decision: RouteDecision): RouteDecision {
  if (decision.confidence >= LOW_CONFIDENCE) return decision;

  if (decision.route === "plan") {
    return { ...decision, route: "build", reason: `${decision.reason} (low confidence, using build)` };
  }

  if (decision.route === "chat") {
    return { ...decision, route: "ask", reason: `${decision.reason} (low confidence, reading first)` };
  }

  return decision;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Classifies one user prompt into a route.
 *
 * Never throws. Never blocks longer than ROUTER_TIMEOUT_MS.
 */
export async function routePrompt(args: RoutePromptArgs): Promise<RouteDecision> {
  const { userPrompt, history, provider } = args;

  // An empty prompt has nothing to classify, and the chat route handles it
  // gracefully. Not worth an API call.
  if (!userPrompt.trim()) {
    return { route: "chat", confidence: 1, reason: "empty prompt", source: "fallback" };
  }

  try {
    // Normally the fast tier explicitly, NOT the session's effort model: the
    // router is a four-way label choice that runs in front of every auto turn.
    //
    // BUT AN EXPLICIT PIN WINS. If the user pinned a model with /model or
    // /modelid, that is the model we know they can actually reach. Overriding
    // it with a fast-tier guess breaks exactly the people most likely to have
    // pinned one — someone on Ollama who has pulled a single model would get
    // a 404 here on EVERY auto turn, silently falling back to the greeting
    // regex after paying the timeout each time.
    //
    // A working router on an expensive model beats a broken one on a cheap
    // model that is never reached.
    const { modelPinned, modelId: pinnedModelId } = resolveAgentConfig();
    const modelId = modelPinned
      ? pinnedModelId
      : (modelForEffort(provider, "fast") ?? undefined);
    const model = resolveModel(provider, modelId);

    const prompt = `${renderHistory(history)}Classify this message:\n${userPrompt.slice(0, 4000)}`;

    const { text, usage } = await generateText({
      model,
      system: ROUTER_SYSTEM,
      prompt,
      maxOutputTokens: ROUTER_MAX_TOKENS,
      maxRetries: 0,
      // No temperature: reasoning models reject it outright, and the few
      // tokens of a four-way label choice are not where sampling matters.
      abortSignal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
    });

    // The router runs on EVERY auto-mode turn before anything else does. It is
    // cheap per call and entirely invisible without this line.
    recordUsage({ role: "router", provider, modelId: modelId ?? "unknown", usage });

    const decision = parseRouteDecision(text);
    if (!decision) {
      return fallbackRoute(userPrompt, "router returned unparseable output");
    }

    return applyConfidencePolicy(decision);
  } catch (err) {
    // Timeout, missing API key, provider outage, malformed request — all the
    // same from here. The turn continues on the fallback route.
    const message = err instanceof Error ? err.message : String(err);
    return fallbackRoute(userPrompt, `router unavailable: ${message.slice(0, 60)}`);
  }
}
