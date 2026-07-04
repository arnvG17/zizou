// src/agent/clarifier.ts
//
// LAYER: agent/
//
// Pre-planning agent — invoked in PLAN MODE ONLY, never in build mode.
//
// PURPOSE:
//   Before the planner generates a structured plan, the clarifier examines
//   the user's prompt and the project context to identify ambiguities that
//   would cause the planner to make wrong assumptions. For example:
//     - "Add auth" → which auth provider? session-based or JWT?
//     - "Refactor the API" → which endpoints? all of them?
//     - "Add dark mode" → CSS variables? Tailwind? styled-components?
//
//   The clarifier generates a list of questions, the UI presents them one
//   at a time, the user answers, and then the planner receives both the
//   original prompt AND the clarification answers as input.
//
// WHY NOT SKIP THIS AND LET THE PLANNER ASK:
//   The planner's output is a structured JSON plan array. Mixing free-text
//   questions into that output format would complicate parsing and create
//   ambiguity about whether the planner is generating a plan or asking
//   questions. Separating concerns: clarifier asks questions (free text),
//   planner generates plans (structured JSON).
//
// CONTEXT:
//   Calls buildSystemPrompt({ role: "clarifier" }) — repo map is ALWAYS
//   included regardless of budget level, because the clarifier needs to
//   know what already exists in the project to ask relevant questions.
//
// DEPENDENCY DIRECTION: imports from agent/types.ts, context/, sdk/.
// Must NOT import from ui/, config/, or provider/.

import { generateText, type LanguageModel } from "ai";
import { buildSystemPrompt, type AgentRole } from "../context/build-system-prompt.js";
import type { ClarifyingQuestion, ProjectContext } from "./types.js";

// ─── Clarifier System Prompt Extension ───────────────────────────────────────
//
// Appended to the base system prompt to tell the model its specific role.
// The model should output ONLY a JSON array of questions, nothing else.

const CLARIFIER_INSTRUCTIONS = `
You are acting as a CLARIFIER — your job is to identify ambiguities in
the user's request that need to be resolved before a plan can be created.

RULES:
1. Examine the user's prompt and the project structure (repo map).
2. Identify 1-5 questions that would significantly change the implementation
   approach if answered differently.
3. Do NOT ask obvious questions that have clear answers from context.
4. Do NOT ask about implementation details that the planner can decide.
5. Focus on architectural choices, scope boundaries, and user preferences.
6. If the request is clear enough to plan without questions, return an
   empty array.

OUTPUT FORMAT — respond with ONLY a JSON array, no markdown, no explanation:
[
  { "question": "Which auth provider should we use?", "required": true },
  { "question": "Should this support SSR?", "required": false }
]

"required": true means planning cannot proceed without an answer.
"required": false means the planner can make a reasonable default assumption.

IMPORTANT: Output ONLY the JSON array. No text before or after it.
`;

// ─── Main Clarify Function ───────────────────────────────────────────────────

/**
 * Generates clarifying questions for a user prompt before planning.
 *
 * Plan mode only — never called in build mode. The orchestrator calls
 * this, presents the questions to the user, collects answers, and then
 * passes both the original prompt and answers to the planner.
 *
 * @param userPrompt - The user's original request text.
 * @param projectContext - Ambient project info (root, prompt, budget).
 * @param model - The resolved LLM to use for generation.
 * @returns Array of clarifying questions. May be empty if the prompt is
 *          clear enough to plan directly.
 */
export async function clarify(
  userPrompt: string,
  projectContext: ProjectContext,
  model: LanguageModel,
): Promise<ClarifyingQuestion[]> {
  // Build a system prompt with the clarifier role — this guarantees the
  // repo map is included even under "light" budget, because the clarifier
  // needs to understand the project structure to ask relevant questions.
  const systemPrompt = await buildSystemPrompt(
    projectContext.projectRoot,
    "clarifier" as AgentRole,
  );

  // Ask the model to generate clarifying questions. We use generateText
  // (not streamText) because:
  //   1. The output is small (a JSON array of questions)
  //   2. We need the complete response to parse JSON
  //   3. There's no value in streaming a JSON array to the user
  const result = await generateText({
    model,
    system: `${systemPrompt}\n\n${CLARIFIER_INSTRUCTIONS}`,
    messages: [
      {
        role: "user",
        content: `Please analyze this request and generate clarifying questions if needed:\n\n${userPrompt}`,
      },
    ],
  });

  // Parse the model's response as a JSON array of questions.
  // The model should return ONLY a JSON array, but we handle common
  // formatting issues (markdown code blocks, extra text around JSON).
  const responseText = result.text.trim();

  try {
    // Try direct JSON parse first (ideal case)
    const parsed = JSON.parse(responseText);
    if (Array.isArray(parsed)) {
      return validateQuestions(parsed);
    }
  } catch {
    // Model may have wrapped the JSON in markdown code blocks
    // e.g. ```json\n[...]\n```
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          return validateQuestions(parsed);
        }
      } catch {
        // Fall through to empty array — if the model can't produce
        // valid JSON, it's safer to skip clarification than to crash.
      }
    }
  }

  // If parsing fails entirely, return empty array. The planner will
  // proceed without clarifications, making its own assumptions. This
  // is better than blocking the entire flow on a parse error.
  return [];
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validates and normalizes the parsed question array.
 * Filters out malformed entries and ensures type safety.
 */
function validateQuestions(raw: unknown[]): ClarifyingQuestion[] {
  return raw
    .filter((item): item is { question: string; required: boolean } => {
      if (typeof item !== "object" || item === null) return false;
      const obj = item as Record<string, unknown>;
      return typeof obj.question === "string" && typeof obj.required === "boolean";
    })
    .map((item) => ({
      question: item.question,
      required: item.required,
    }));
}
