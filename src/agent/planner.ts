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
//   1. NO TOOL ACCESS: The planner sees the repo map and clarifications
//      but cannot call tools (readFile, writeFile, etc.). This is
//      intentional — the planner's job is to DESCRIBE what should happen,
//      not to start doing it. Tool access is the executor's domain.
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

import { generateText, type LanguageModel } from "ai";
import { buildSystemPrompt, type AgentRole } from "../context/build-system-prompt.js";
import type { PlanStep, ProjectContext } from "./types.js";
import { SessionLogger } from "./debug/index.js";

// ─── Planner System Prompt Extension ─────────────────────────────────────────
//
// Appended to the base system prompt to tell the model its specific role
// as a planner. The model must output ONLY a JSON array of PlanStep objects.

const PLANNER_INSTRUCTIONS = `
You are acting as a PLANNER — your job is to create a structured, ordered
plan for implementing the user's request. You do NOT execute anything;
you only describe what should be done.

NEVER ask the user questions. If the request leaves something open, DECIDE
using the most conventional choice for this project, and record that decision
in "assumptions". The user reviews the plan before anything runs, so a stated
assumption they can reject is always better than a question that blocks them.

RULES:
1. Output ONLY a JSON object. No markdown, no explanation.
2. "assumptions" is an array of short strings: decisions you made that the
   user did not specify (framework, scope, storage, styling, and so on).
   Use [] only when the request genuinely left nothing open.
3. "steps" is an array of steps, each with: index, description, targetFiles, dependsOn.
4. Use dependsOn to enforce ordering — if step 3 edits a file created in
   step 1, then step 3 must have dependsOn: [1].
5. Keep steps atomic — each step should do ONE thing (create a file, modify
   a function, install a dependency, etc.).
6. List ALL files each step will create or modify in targetFiles.
7. Include setup steps (create directories, install packages) before code steps.
8. Prefer what already exists in the repo map over introducing new tools.

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
    }
  ]
}

IMPORTANT:
- Index must be sequential starting from 0.
- dependsOn must only reference indices that exist and are lower than the current index.
- targetFiles must be relative paths from the workspace root.
- Output ONLY the JSON object. No text before or after it.
`;

// ─── Main Plan Function ──────────────────────────────────────────────────────

/**
 * Generates a structured execution plan from the user's prompt.
 *
 * Plan mode only — never called in build mode. The orchestrator calls
 * this after the clarifier has finished, passing in any clarification
 * answers the user provided.
 *
 * @param userPrompt - The user's original request text.
 * @param clarifications - Key-value pairs of clarification answers.
 *                         Keys are the question text, values are the
 *                         user's answers. May be empty if no clarification
 *                         was needed.
 * @param context - Ambient project info (root, prompt, budget).
 * @param model - The resolved LLM to use for generation.
 * @returns Array of PlanStep objects in dependency order.
 */
export async function plan(
  userPrompt: string,
  clarifications: Record<string, string>,
  context: ProjectContext,
  model: LanguageModel,
): Promise<PlanStep[]> {
  // Build a system prompt with the planner role — this guarantees the
  // repo map is included even under "light" budget. The planner MUST
  // know the project structure to avoid creating duplicate files or
  // referencing files that don't exist.
  const systemPrompt = await buildSystemPrompt(
    context.projectRoot,
    "planner" as AgentRole,
  );

  // Build the user message with the prompt and any clarifications.
  // Clarifications are included as a structured section so the model
  // can incorporate the user's answers into the plan.
  let userMessage = `Create a detailed implementation plan for the following request:\n\n${userPrompt}`;

  if (Object.keys(clarifications).length > 0) {
    userMessage += "\n\nThe user provided these clarifications:\n";
    for (const [question, answer] of Object.entries(clarifications)) {
      userMessage += `\nQ: ${question}\nA: ${answer}\n`;
    }
  }

  SessionLogger.logPlannerStart(userPrompt, clarifications);

  // Generate the plan. We use generateText (not streamText) because:
  //   1. The output is a complete JSON array that needs full parsing
  //   2. Streaming a JSON plan would require incremental JSON parsing
  //   3. The plan needs to be displayed all-at-once for user review
  const systemText = `${systemPrompt}\n\n${PLANNER_INSTRUCTIONS}`;
  const userText = userMessage;

  const result = await generateText({
    model,
    system: systemText,
    messages: [
      {
        role: "user",
        content: userText,
      },
    ],
  });

  // Parse the model's response as a JSON array of PlanStep objects.
  const responseText = result.text.trim();

  // Log verbatim prompts and response
  SessionLogger.logPlannerLLM(systemText, userText, responseText);

  const steps = parsePlanSteps(responseText);

  // Validate dependency ordering — catch any invalid dependsOn references
  // before the orchestrator tries to execute them.
  validateDependencies(steps);

  SessionLogger.logPlannerEnd(steps);
  return steps;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parses the model's text response into PlanStep objects.
 * Handles common LLM output quirks: markdown code blocks, extra text
 * around the JSON, etc.
 */
function parsePlanSteps(text: string): PlanStep[] {
  // Try direct JSON parse first (ideal case)
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return validateSteps(parsed);
    }
  } catch {
    // Fall through to regex extraction
  }

  // Try extracting JSON array from markdown code blocks or surrounding text
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return validateSteps(parsed);
      }
    } catch {
      // Fall through to error
    }
  }

  // If we can't parse the plan at all, throw rather than returning an
  // empty array — unlike the clarifier (where empty = "no questions"),
  // an empty plan means "do nothing", which is never what the user wants.
  throw new Error(
    "Failed to parse plan from model response. The model did not return a valid JSON plan array.",
  );
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
      dependsOn: (item.dependsOn as unknown[]).filter(
        (d): d is number => typeof d === "number",
      ),
    }));
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
