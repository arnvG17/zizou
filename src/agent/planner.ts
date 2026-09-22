// src/agent/planner.ts
//
// LAYER: agent/
//
// Structured plan generator — invoked in PLAN MODE ONLY.
//
// PURPOSE:
//   Takes the user's prompt + project context and produces a structured JSON
//   plan: the assumptions it had to make, plus an array of PlanStep objects
//   with explicit dependency ordering. The orchestrator then executes those
//   steps one at a time in dependsOn order.
//
//   There is no clarifier stage. The planner DECIDES and declares what it
//   decided; the user reviews a concrete plan at the y/n gate and rejects it
//   with a reason if an assumption is wrong. See the Plan type in types.ts.
//
// KEY DESIGN DECISIONS:
//   1. READ-ONLY TOOL ACCESS: the planner can glob, grep, listDir and
//      readFile, but cannot write, edit, or run commands. Its job is to
//      DESCRIBE what should happen, not to start doing it — so it can look
//      at anything and change nothing.
//
//      It previously had no tools at all and was handed a pre-computed repo
//      map instead. That map cost ~5.7k tokens on this project, a quarter of
//      it describing an unrelated app under docs/, and it silently omitted
//      every tool declared as `export const x = tool({...})` because the
//      extractor is regex-based. Searching finds what exists; a stale
//      summary can only report what its regexes happened to match.
//   2. DEPENDENCY ORDERING: Each PlanStep has a `dependsOn` array
//      referencing other step indices. This prevents the write-before-
//      scaffold ordering bug where a step tries to edit a file that
//      hasn't been created yet by a prior step.
//   3. JSON-ONLY OUTPUT: The planner must output ONLY a JSON array of
//      PlanStep objects. No markdown, no prose, no explanation. The
//      orchestrator parses this and displays it to the user for Y/n
//      confirmation before execution begins.
//
// CONTEXT:
//   Calls buildSystemPrompt({ role: "planner" }) — repo map is ALWAYS
//   included regardless of budget level, because the planner needs to
//   know the project structure to create a valid plan.
//
// DEPENDENCY DIRECTION: imports from agent/types.ts, context/, sdk/.
// Must NOT import from ui/, config/, or provider/.

import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import { recordModelUsage } from "../telemetry/index.js";
import { buildReadOnlyToolMap } from "../tools/index.js";
import { buildSystemPrompt, type AgentRole } from "../context/build-system-prompt.js";
import type { Plan, PlanRevision, PlanStep, ProjectContext, StepCheck } from "./types.js";
import { getActiveJournal } from "./debug/index.js";

// ─── Planner System Prompt Extension ─────────────────────────────────────────
//
// Appended to the base system prompt to tell the model its specific role
// as a planner. The model must output ONLY a JSON array of PlanStep objects.

const PLANNER_INSTRUCTIONS = `
You are acting as a PLANNER — your job is to create a structured, ordered
plan for implementing the user's request. You do NOT execute anything;
you only describe what should be done.

FIRST, LOOK. You have read-only tools: glob, grep, listDir and readFile.
Use them before planning. Find the files the request touches, check what
already exists, and read anything you intend to modify. A plan written
without looking invents file paths and duplicates code that is already
there. Do not guess at a path you have not seen.

Keep exploration proportionate: a handful of targeted searches, not a tour
of the repo. When you know enough, stop and output the plan.

STAY INSIDE THE REQUEST. Plan the thing that was asked for and nothing else.
- If the user is talking about a file or project they just mentioned, that is
  the subject. Do not plan changes to the surrounding repository because it
  happens to be what you are standing in.
- Every step must be something the user asked for. Tidying the directory
  layout, renaming unrelated files, reorganising docs, adding test folders or
  centralising config are NOT in scope unless the user asked for them.
- If a step is not clearly traceable to the request, drop it.
- Do not add a step whose only action is to look at something. "Analyze the
  current X" is not a step; it is what you are doing right now, with the
  read-only tools, before you write the plan.

You cannot write, edit, or run commands. Do not try.

NEVER ask the user questions. If the request leaves something open, DECIDE
using the most conventional choice for this project, and record that decision
in "assumptions". The user reviews the plan before anything runs, so a stated
assumption they can reject is always better than a question that blocks them.

RULES:
1. Output ONLY a JSON object. No markdown, no explanation.
2. "assumptions" is an array of short strings: decisions you made that the
   user did not specify (framework, scope, storage, styling, and so on).
   Use [] only when the request genuinely left nothing open.
3. "steps" is an array of steps, each with: index, description, targetFiles, dependsOn,
   and optionally check.
4. Use dependsOn to enforce ordering — if step 3 edits a file created in
   step 1, then step 3 must have dependsOn: [1].
5. Keep steps atomic — each step should do ONE thing (create a file, modify
   a function, install a dependency, etc.).
6. targetFiles is your best guess at what the step will touch, used to focus
   the work. It is NOT a contract. For a step that runs a command or invokes a
   scaffolder (npm create, a generator, a package manager), you cannot know the
   files it produces — leave targetFiles EMPTY rather than inventing plausible
   paths.
7. "check" states how to tell the step actually worked. Prefer it to guessed
   file paths:
     - { "kind": "command", "command": "npm run build", "cwd": "frontend" }
       for a step whose success is an exit code.
     - { "kind": "url", "url": "http://localhost:5173" }
       for a step that brings a server up.
     - { "kind": "files", "files": ["src/App.tsx"] }
       only for files you are genuinely authoring by hand.
   Omit check when the step has no meaningful automated check.
8. Include setup steps (create directories, install packages) before code steps.
   If the plan produces something runnable, END it with a step that starts the
   app and checks its URL.
9. Prefer what already exists in this repo over introducing new tools.

OUTPUT FORMAT — respond with ONLY this JSON object:
{
  "assumptions": [
    "React with Vite, matching the existing frontend",
    "No backend — state is held in memory only"
  ],
  "steps": [
    {
      "index": 0,
      "description": "Create the new component file with boilerplate",
      "targetFiles": ["src/components/Auth.tsx"],
      "dependsOn": []
    },
    {
      "index": 1,
      "description": "Add authentication hook",
      "targetFiles": ["src/hooks/useAuth.ts"],
      "dependsOn": []
    },
    {
      "index": 2,
      "description": "Wire Auth component into the main App layout",
      "targetFiles": ["src/App.tsx"],
      "dependsOn": [0, 1]
    },
    {
      "index": 3,
      "description": "Install dependencies",
      "targetFiles": [],
      "check": { "kind": "command", "command": "npm install" },
      "dependsOn": [2]
    },
    {
      "index": 4,
      "description": "Start the dev server and confirm the app serves",
      "targetFiles": [],
      "check": { "kind": "url", "url": "http://localhost:5173" },
      "dependsOn": [3]
    }
  ]
}

IMPORTANT:
- Index must be sequential starting from 0.
- dependsOn must only reference indices that exist and are lower than the current index.
- targetFiles must be relative paths from the workspace root.
- Output ONLY the JSON object. No text before or after it.
`;

// ─── Conversation context ──────────────────────────────────────

/** How much prior conversation the planner sees. */
const HISTORY_TURNS = 6;
const HISTORY_CHARS = 1500;

/**
 * Renders recent turns so the planner can resolve what the user is
 * referring to.
 *
 * Capped on both axes. The planner needs the SUBJECT of the conversation,
 * not a transcript — and a long history pasted into a planning prompt
 * crowds out the plan itself.
 */
function renderHistory(history: ModelMessage[] | undefined): string {
  if (!history || history.length === 0) return "";

  const lines: string[] = [];
  for (const message of history.slice(-HISTORY_TURNS)) {
    if (message.role !== "user" && message.role !== "assistant") continue;

    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
            .join(" ");

    const trimmed = text.trim();
    if (trimmed) lines.push(`${message.role}: ${trimmed.slice(0, HISTORY_CHARS)}`);
  }

  if (lines.length === 0) return "";

  return `Recent conversation, so you can tell what the user is referring to:

${lines.join("\n")}

The request below continues THAT conversation. If it says "the layout", "it",
"the pieces" or similar, the referent is in the lines above — not something
you should go looking for in the repository.

`;
}

// ─── Main Plan Function ──────────────────────────────────────────────────────

/**
 * Generates a structured execution plan from the user's prompt.
 *
 * Plan mode only — never called in build mode.
 *
 * @param userPrompt - The user's original request text.
 * @param context - Ambient project info (root, prompt, budget).
 * @param model - The resolved LLM to use for generation.
 * @returns The assumptions the planner made plus its steps, in dependency order.
 */
export async function plan(
  userPrompt: string,
  context: ProjectContext,
  model: LanguageModel,
  revision?: PlanRevision,
  history?: ModelMessage[],
  abortSignal?: AbortSignal,
): Promise<Plan> {
  const systemPrompt = await buildSystemPrompt(
    context.projectRoot,
    "planner" as AgentRole,
  );

  // WHY THE PLANNER SEES THE CONVERSATION:
  //
  // It used to get the raw prompt and nothing else, which made every
  // referring expression unresolvable. "the layout is bad and the pieces are
  // not working" has no subject on its own, so the planner went looking for
  // one, found this repo's own src/ui/App.tsx and src/styles/board.css, and
  // confidently planned a redesign of Zizou's TUI — while the user was
  // talking about a chess game they had just opened.
  //
  // That is the scope drift. It is not the model being careless; it is the
  // model being handed a pronoun with no antecedent and having to guess.
  const conversationContext = renderHistory(history);

  // A revision is the same request, re-planned with the user's correction in
  // hand. Showing the previous plan matters: without it the model re-derives
  // everything from the prompt and the correction has nothing to attach to,
  // so a note about one step's destination silently rewrites all of them.
  const userMessage = revision
    ? `${conversationContext}Create a detailed implementation plan for the following request:

${userPrompt}

You previously produced this plan:

Assumptions:
${revision.previousAssumptions.map((a) => `- ${a}`).join("\n") || "- (none stated)"}

Steps:
${revision.previousSteps
  .map(
    (s) =>
      `${s.index}. ${s.description}\n   files: ${s.targetFiles.join(", ") || "(none listed)"}${
        s.dependsOn.length ? `\n   depends on: ${s.dependsOn.join(", ")}` : ""
      }`,
  )
  .join("\n")}

The user reviewed that plan and asked for this change:

${revision.feedback}

Produce a REVISED plan. Keep every step the correction does not touch, and
apply the correction exactly as asked — it overrides any assumption you made
before, including anything in your project conventions. Re-index from 0 and
fix up dependsOn accordingly.`
    : `${conversationContext}Create a detailed implementation plan for the following request:

${userPrompt}`;

  const journal = getActiveJournal();
  journal.phase("planner", `planning: ${userPrompt.slice(0, 120)}`);

  // generateText, not streamText: the output is one JSON object that must be
  // parsed whole, and the plan is displayed all at once for review.
  //
  // stopWhen caps the explore loop. The planner calls read-only tools for a
  // few rounds, then produces the plan as its final text. The cap matters:
  // without it a model that keeps grepping never emits a plan at all.
  const systemText = `${systemPrompt}

${PLANNER_INSTRUCTIONS}`;
  const userText = userMessage;

  const result = await generateText({
    model,
    system: systemText,
    tools: buildReadOnlyToolMap(),
    stopWhen: stepCountIs(context.maxSteps),
    ...(abortSignal ? { abortSignal } : {}),
    messages: [
      {
        role: "user",
        content: userText,
      },
    ],
  });

  // The planner's own spend. It explores with read-only tools over several
  // rounds before emitting the plan, so this is not a trivial call — and it was
  // entirely absent from the cost readout before.
  recordModelUsage("planner", model, result.usage);

  // Parse the model's response into a Plan.
  const responseText = result.text.trim();

  journal.note("planner", `explored in ${result.steps.length} step(s) before planning`);
  journal.prompt({ role: "planner", system: systemText, user: userText });

  const parsed = parsePlan(responseText);

  // Validate dependency ordering — catch any invalid dependsOn references
  // before the orchestrator tries to execute them.
  validateDependencies(parsed.steps);

  // Journaled here rather than by the orchestrator, so a plan that fails
  // validateDependencies above never reaches the log as though it were accepted.
  journal.plan(
    parsed.steps.map((s) => ({
      index: s.index,
      description: s.description,
      targetFiles: s.targetFiles,
    })),
    parsed.assumptions,
  );
  return parsed;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parses the model's text response into a Plan.
 *
 * Handles common LLM output quirks: markdown code blocks, extra text around
 * the JSON, and — because weaker models routinely ignore the object shape —
 * a bare array of steps with no assumptions wrapper.
 */
function parsePlan(text: string): Plan {
  const candidates: string[] = [text];

  // Extract a JSON object or array from inside prose / code fences.
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) candidates.push(arrayMatch[0]);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    // The documented shape: { assumptions, steps }.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as { assumptions?: unknown; steps?: unknown };
      if (Array.isArray(obj.steps)) {
        return {
          assumptions: validateAssumptions(obj.assumptions),
          steps: validateSteps(obj.steps),
        };
      }
      continue;
    }

    // Tolerated fallback: a bare step array. Small models drop the wrapper.
    if (Array.isArray(parsed)) {
      return { assumptions: [], steps: validateSteps(parsed) };
    }
  }

  // If we can't parse the plan at all, throw rather than returning an empty
  // plan — an empty plan means "do nothing", which is never what was wanted.
  throw new Error(
    "Failed to parse plan from model response. The model did not return a valid JSON plan.",
  );
}

/** Keeps only non-empty strings, so a malformed assumptions field is harmless. */
function validateAssumptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validates and normalizes individual plan steps from parsed JSON.
 * Filters out malformed entries and ensures type safety.
 */
function validateSteps(raw: unknown[]): PlanStep[] {
  return raw
    .filter((item): item is Record<string, unknown> => {
      if (typeof item !== "object" || item === null) return false;
      const obj = item as Record<string, unknown>;
      return (
        typeof obj.index === "number" &&
        typeof obj.description === "string" &&
        Array.isArray(obj.targetFiles) &&
        Array.isArray(obj.dependsOn)
      );
    })
    .map((item) => ({
      index: item.index as number,
      description: item.description as string,
      targetFiles: (item.targetFiles as unknown[]).filter(
        (f): f is string => typeof f === "string",
      ),
      ...(normalizeCheck(item.check) ? { check: normalizeCheck(item.check)! } : {}),
      dependsOn: (item.dependsOn as unknown[]).filter(
        (d): d is number => typeof d === "number",
      ),
    }));
}

/**
 * Accepts a step's `check` only if it is actually usable.
 *
 * A check is optional, so a malformed one is dropped rather than throwing —
 * the same tolerance validateSteps already applies to everything else. A
 * check that survives here will be RUN, so "kind: command" with no command
 * must not get through.
 */
function normalizeCheck(raw: unknown): StepCheck | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (obj.kind === "command" && typeof obj.command === "string" && obj.command.trim()) {
    return {
      kind: "command",
      command: obj.command.trim(),
      ...(typeof obj.cwd === "string" ? { cwd: obj.cwd } : {}),
    };
  }

  if (obj.kind === "url" && typeof obj.url === "string" && obj.url.trim()) {
    return { kind: "url", url: obj.url.trim() };
  }

  if (obj.kind === "files" && Array.isArray(obj.files)) {
    const files = obj.files.filter((f): f is string => typeof f === "string");
    if (files.length) return { kind: "files", files };
  }

  return null;
}

/**
 * Validates dependency ordering: ensures no step references a non-existent
 * step or a step with a higher/equal index (which would create a cycle
 * or forward reference).
 *
 * Throws if invalid dependencies are found — this is a hard error because
 * executing a plan with broken dependencies could produce the exact
 * write-before-scaffold bug we're trying to prevent.
 */
function validateDependencies(steps: PlanStep[]): void {
  const indices = new Set(steps.map((s) => s.index));

  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!indices.has(dep)) {
        throw new Error(
          `Plan step ${step.index} depends on non-existent step ${dep}`,
        );
      }
      if (dep >= step.index) {
        throw new Error(
          `Plan step ${step.index} depends on step ${dep} (same or higher index — would create a cycle or forward reference)`,
        );
      }
    }
  }
}
