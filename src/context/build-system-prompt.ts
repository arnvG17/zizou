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
//
// ROLE-AWARE REPO MAP (new):
//   The repo-map inclusion decision is now gated by WHICH AGENT ROLE is
//   requesting context, not just by the budget level alone:
//     - "clarifier" / "planner": ALWAYS include the repo map, even under
//       "light" budget. Taking the repo map away from planning causes the
//       write-before-scaffold ordering bug — the planner needs a project
//       overview to know what files already exist.
//     - "executor": follows the existing budget-scaled behavior. Under
//       "light", the executor works from an explicit target file supplied
//       by the plan step, so it doesn't need the repo overview.
//     - undefined (backward compat): treated as executor, so existing
//       call sites (Chat.tsx) continue to work without changes.

import { buildRepoMap } from "./repo-map.js";
import { getContextMode } from "../config/api-keys.js";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { platform } from "os";

// ─── Agent Role Type ─────────────────────────────────────────────────────────
//
// Identifies which orchestrator module is requesting context. Each role
// has different context needs:
//   "clarifier" — needs the repo map to ask informed questions about the
//                  project structure.
//   "planner"   — needs the repo map to generate a plan that respects
//                  existing file layout and avoids write-before-scaffold.
//   "executor"  — works from an explicit PlanStep with targetFiles,
//                  so the repo map is optional (follows budget setting).

export type AgentRole = "clarifier" | "planner" | "executor";

export const pinnedContextFiles = new Set<string>();

export function addPinnedFile(projectRoot: string, filePath: string): string {
  const absolutePath = resolve(projectRoot, filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }
  pinnedContextFiles.add(absolutePath);
  return absolutePath;
}

export function clearPinnedFiles(): void {
  pinnedContextFiles.clear();
}

/**
 * Detect the current operating system and shell for the system prompt.
 */
function getOSInfo(): { os: string; shell: string } {
  const p = process.platform;
  if (p === "win32") return { os: "Windows", shell: "PowerShell" };
  if (p === "darwin") return { os: "macOS", shell: "bash/zsh" };
  return { os: "Linux", shell: "bash" };
}

const BASE_INSTRUCTIONS = `You are Zizou, an AI coding agent operating inside a user's terminal, with direct access to their project's filesystem through tools.

## Tool-calling protocol — read first, follow exactly
- You MUST call tools using the native function-calling protocol. Never output a raw JSON block or pseudo-call as plain text.
- The tool name field must contain ONLY the exact tool name (e.g. \`readFile\`), never JSON, arguments, or parentheses appended to it. All arguments belong strictly in the arguments object.
- For general knowledge questions, casual conversation, or anything that doesn't require touching this project's files or running a command — answer directly, in plain text, with no tool calls at all.

## Understanding this codebase
You have two complementary ways to orient yourself:
1. A REPO MAP is included below — function/class/interface names with file:line locations, generated automatically.
2. \`readFile\`, \`glob\`, and \`grep\` tools for anything the map doesn't show. The map uses simple pattern matching and will occasionally miss real symbols (e.g. \`const foo = tool({...})\` style definitions often don't appear) — if something you expect to exist isn't in the map, search for it directly rather than assuming it's missing.

## Editing files
- New file, or fully replacing one: \`writeFile\`.
- Targeted change to an existing file: \`editFile\`, with an \`old_string\` that exactly matches current content and is unique in the file.
- Before ANY \`editFile\` call: \`readFile\` the file first. \`old_string\` must match exactly — including whitespace and line breaks — or the edit fails. Never guess at existing content.
- Before running a shell command: the user approves it first. If what it does isn't obvious, say so briefly before running it.

## Finding and editing an unfamiliar file
1. \`glob("**/filename")\` or \`listDir()\` to find it.
2. \`readFile(path)\` to read current contents.
3. \`editFile(path, old_string, new_string)\` to change it.
Never skip step 2.

## Scaffolding a new project (React, Next.js, Vite, etc.)
1. \`runBash\` to scaffold — e.g. \`npx -y create-vite@latest my-app -- --template react\`, or \`npx -y create-next-app@latest my-app --yes --use-npm\`.
2. \`runBash("cd my-app && npm install")\` if dependencies weren't auto-installed.
3. \`runBackground("cd my-app && npm run dev")\` to start the dev server without blocking.
4. \`manageTasks("list")\`, then \`manageTasks("logs", taskId)\` after a few seconds to confirm the server started cleanly.

## Available tools
\`readFile\`, \`writeFile\`, \`editFile\`, \`glob\`, \`grep\`, \`listDir\` — filesystem access.
\`runBash\` (needs approval, 120s timeout), \`runBackground\` (non-blocking, for servers), \`manageTasks\`, \`managePorts\` — process control.
\`fileOperations\` — delete/copy/move/create directories natively.
\`openFile\` — open a file in its default OS app (e.g. preview an HTML file in the browser) after creating it.
Full parameter schemas are provided alongside this prompt — this list is for orientation, not a substitute for the schema.`;

// ─── Role-Aware Repo Map Decision ────────────────────────────────────────────
//
// This is the core fix for the "Light budget strips repo map from
// planner" bug. The decision tree is:
//
//   role = clarifier or planner?
//     → YES: always include repo map, regardless of budget.
//            These roles NEED the project overview to do their job.
//     → NO (executor or undefined):
//            Follow the existing budget-scaled behavior:
//            - "light"   → no repo map
//            - "default" → include repo map
//            - "max"     → include repo map
//
// This function is pure — no side effects, no LLM call.

function shouldIncludeRepoMap(
  role: AgentRole | undefined,
  budget: string,
  targetFiles?: string[],
): boolean {
  // Clarifier and planner always need the repo map to understand project
  // structure. Without it, the planner generates plans that reference
  // files that don't exist or miss existing scaffolding.
  if (role === "clarifier" || role === "planner") return true;

  // Executor with an empty targetFiles list (e.g. build-mode conversational
  // input) has nothing to orient a map around — skip it entirely.
  if (role === "executor" && targetFiles !== undefined && targetFiles.length === 0) {
    return false;
  }

  // Executor (or undefined for backward compat): existing budget behavior.
  // Under "light", the executor has explicit targetFiles from the plan step
  // and doesn't need the full repo overview.
  return budget !== "light";
}

/**
 * Builds the complete system prompt for a session: base instructions +
 * the project's repo map. Called once per session (not per turn) since
 * walking the filesystem and re-running extraction on every message
 * would be wasteful — see src/ui/Chat.tsx for where this gets cached.
 *
 * @param projectRoot - Absolute path to the workspace root.
 * @param role - Which agent role is requesting context. Determines whether
 *               the repo map is included. Defaults to undefined (treated
 *               as executor for backward compatibility with existing call
 *               sites in Chat.tsx that don't pass a role).
 */
export async function buildSystemPrompt(
  projectRoot: string,
  role?: AgentRole,
  targetFiles?: string[],
): Promise<string> {
  const mode = getContextMode();
  let repoMap = "";
  
  // Use the role-aware decision function instead of the old blanket
  // `mode !== "light"` check. This ensures clarifier and planner always
  // get the repo map even when the user has set --context light.
  // Also gates executor on targetFiles — empty list means no map needed.
  if (shouldIncludeRepoMap(role, mode, targetFiles)) {
    repoMap = buildRepoMap(projectRoot);
  }

  const { os, shell } = getOSInfo();

  // Injected at runtime so the model always has the real workspace path.
  const SESSION_CONTEXT = `
--- SESSION CONTEXT ---
Workspace root (cwd): ${projectRoot}
Operating system: ${os}
Shell: ${shell}
All relative paths you provide to tools are resolved from this root.
When creating or writing a file, you can use either:
  - An absolute path  (e.g. ${projectRoot}/index.html)
  - A relative path   (e.g. index.html  or  src/components/Foo.tsx)
Both will work — relative paths are resolved to the workspace root automatically.
--- END SESSION CONTEXT ---`;

  let pinnedText = "";
  if (pinnedContextFiles.size > 0) {
    pinnedText = "\n\n--- PINNED FILES ---\nThe user has pinned the following files to your permanent context:\n";
    for (const file of pinnedContextFiles) {
      try {
        const contents = readFileSync(file, "utf8");
        pinnedText += `\nFile: ${file}\n\`\`\`\n${contents}\n\`\`\`\n`;
      } catch (err) {
        pinnedText += `\nFile: ${file} (Failed to read)\n`;
      }
    }
    pinnedText += "--- END PINNED FILES ---";
  }

  // If we didn't build a repo map (either because the role-aware check
  // said "no" or because scanRepo found no source files), tell the model
  // to use tools for exploration instead.
  if (!repoMap) {
    return `${BASE_INSTRUCTIONS}${SESSION_CONTEXT}${pinnedText}\n\n(Repo map is disabled for this context configuration, or no source files were found. Use tools like listDir to explore.)`;
  }

  return `${BASE_INSTRUCTIONS}${SESSION_CONTEXT}${pinnedText}\n\n--- REPO MAP ---\n${repoMap}\n--- END REPO MAP ---`;
}
