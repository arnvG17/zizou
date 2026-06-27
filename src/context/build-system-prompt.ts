// src/context/build-system-prompt.ts
//
// LAYER: context/. This is the bridge between the repo-map generator
// (repo-map.ts) and the agent loop (src/agent/run-turn.ts) — it produces
// the actual TEXT that gets injected as the system prompt, combining:
//   1. General instructions about how to behave as a coding agent
//   2. The pre-computed repo map (Level 1 context — see repo-map.ts)
//   3. A pointer telling the model it ALSO has glob/grep/readFile tools
//      for Level 0 exploration when the map isn't enough (e.g. the map
//      missed a symbol due to its known regex limitations, or the model
//      needs to see actual file CONTENTS, which the map deliberately
//      excludes to keep it small)
//
// WHY THIS IS ITS OWN FILE rather than inlined into Chat.tsx: per
// HOUSE_RULES, agent/ and ui/ should not need to know HOW context gets
// built, only that they can ask for "the system prompt" and get a
// string back. If context-building later grows more steps (e.g. an
// importance-ranking pass, tree-sitter extraction, embedding-based
// retrieval of specific files relevant to the user's actual question),
// every one of those changes is isolated to this file and repo-map.ts —
// neither Chat.tsx nor run-turn.ts need to change at all.

import { buildRepoMap } from "./repo-map.js";

const BASE_INSTRUCTIONS = `You are Zizou, an AI coding agent operating inside a user's terminal,
with direct access to their project's filesystem through tools.

You have two complementary ways to understand the codebase:
1. A REPO MAP is included below — a structural summary (function/class/
   interface names and their file:line locations) of this project,
   generated automatically. Use it to orient yourself before diving in.
2. You also have readFile, glob, and grep tools. The repo map is
   generated with simple pattern matching and WILL occasionally miss
   real symbols (e.g. tools defined as \`const foo = tool({...})\` may
   not appear) — if something you expect to exist isn't in the map,
   use glob/grep to look for it directly rather than assuming it
   doesn't exist.

When editing files, use editFile with an old_string that exactly
matches existing content and is unique in the file — never rewrite
whole files from scratch. Before running any shell command, know that
the user will be asked to approve it; explain briefly what a command
will do if it's not obvious.`;

/**
 * Builds the complete system prompt for a session: base instructions +
 * the project's repo map. Called once per session (not per turn) since
 * walking the filesystem and re-running extraction on every message
 * would be wasteful — see src/ui/Chat.tsx for where this gets cached.
 */
export async function buildSystemPrompt(projectRoot: string): Promise<string> {
  const repoMap = buildRepoMap(projectRoot);

  if (!repoMap) {
    // Empty project, or scanRepo found nothing matching its file
    // patterns — still return valid instructions rather than an empty
    // string, so the agent isn't left with zero guidance.
    return `${BASE_INSTRUCTIONS}\n\n(No repo map could be generated — the project may be empty or contain no recognized source files.)`;
  }

  return `${BASE_INSTRUCTIONS}\n\n--- REPO MAP ---\n${repoMap}\n--- END REPO MAP ---`;
}
