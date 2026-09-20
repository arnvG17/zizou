// src/context/build-system-prompt.ts
//
// LAYER: context/. This produces the TEXT injected as the system prompt:
//   1. Behaviour rules for the requesting role
//   2. Session facts (workspace root, OS, shell)
//   3. Project conventions from ZIZOU.md
//   4. Any files the user pinned with /add
//
// THERE IS NO REPO MAP HERE ANY MORE.
//
// It used to inject a pre-computed symbol summary ("Level 1" context, the
// Aider technique) into every prompt. Measured on this project it cost ~5.7k
// tokens, and it was wrong in both directions: about a quarter of its 86
// files came from an unrelated Next.js app under docs/, it listed private
// helpers and local variables as if they were API, and it silently omitted
// every tool declared as `export const x = tool({...})` because the extractor
// is regex-based and cannot tell that from `const x = 5`.
//
// Both roles now FIND things instead of being told them:
//   - executor: has glob, grep, listDir, readFile alongside its write tools
//   - planner:  has the read-only subset (see tools/buildReadOnlyToolMap)
//
// A search returns what is actually on disk right now. That is strictly
// better than a summary that is stale, partial, and paid for on every turn.
//
// repo-map.ts still exists and is still used — by the TUI sidebar, where a
// rough outline is useful to a human and costs no tokens.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { platform } from "os";
import { loadProjectConventions } from "./load-project-conventions.js";

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
//   "ask"       — answers questions about the codebase with read-only tools.
//                  Same discovery needs as the planner, different output:
//                  prose for the user rather than a JSON plan.

export type AgentRole = "clarifier" | "planner" | "executor" | "ask";

/**
 * How many characters of pinned file content may enter the prompt.
 * ~8k characters is roughly 2k tokens — enough for a couple of reference
 * files without letting /add quietly consume the context window.
 */
const PINNED_CHAR_BUDGET = 8000;

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

const EXECUTOR_INSTRUCTIONS = `You are Zizou, an AI coding agent with direct filesystem access through tools.

Rules:
- Use native function-calling protocol only. Never emit raw JSON blocks or pseudo-calls as plain text.
- For general questions / conversation — answer directly, no tool calls.
- Before editFile: always readFile first to get exact whitespace. Never guess.
  If old_string could plausibly match more than one place in the file (common in HTML/JSX with repeated tags or classes, or CSS with repeated selectors), include enough surrounding lines to make it uniquely identifiable BEFORE calling editFile — don't rely on trial and error.
- Before any shell command: briefly state what it does if non-obvious.
- Act immediately on clear requests. Ask only when the intent is genuinely ambiguous.

CRITICAL — File operations:
- To CREATE or WRITE any file: ALWAYS invoke the writeFile tool. Never output full file contents as a markdown code block in your text response.
- To MODIFY an existing file: ALWAYS invoke the editFile tool. Never show modified code as plain text in chat — invoke the tool.
- Your text response is for conversation, explanations, and status updates ONLY. File contents MUST be written using writeFile or editFile tool calls.
- Showing code in a chat text response does NOT create or edit files on disk. You MUST use tool calls to write files.

EDIT, DON'T RECREATE:
- Before writeFile to a path that does not exist: search for the file that already does this job. glob the basename, grep a distinctive string from the request.
- If you find it, edit it. Modifying the existing file is almost always what was meant; a near-duplicate under a new name is almost always wrong, and leaves two files that disagree.
- If you searched and there is genuinely nothing, say so in one line and then create the file.

editFile recovery strategy:
- If editFile fails with "appeared N times", provide near_line (the line number nearest your intended match), e.g.:
  editFile({ path: "app.html", old_string: "...", new_string: "...", near_line: 42 })
- If editFile fails twice on the same file, you will be told to fall back to writeFile with the complete corrected contents. Do this immediately — do not keep retrying editFile with cosmetic variations of old_string.`;

const PLANNER_INSTRUCTIONS_BASE = `You are Zizou, an AI coding agent, currently planning rather than building.

You have READ-ONLY tools: glob, grep, listDir, readFile. You cannot write
files, edit files, or run commands — those belong to the execution phase.

Rules:
- Use the native function-calling protocol only. Never emit raw JSON blocks
  or pseudo-calls as plain text.
- Search before you assert. Never reference a file path you have not seen in
  a glob, grep or listDir result.
- Prefer grep for "does X exist and where", glob for "what files match",
  listDir for "what is in this folder", readFile when you need the contents.
- Stop exploring once you can write the plan. You are not reviewing the
  codebase, you are gathering just enough to order the work correctly.
- targetFiles are shown to the user at the approval gate, marked as new or
  existing. Get the destination right there and the executor inherits it.`;

const ASK_INSTRUCTIONS = `You are Zizou, an AI coding agent, currently answering a question rather than making a change.

You have READ-ONLY tools: glob, grep, listDir, readFile, and openFile.
You cannot write files, edit files, or run commands. Nothing you do in this
turn can change anything on disk.

openFile opens a file in the user's default application — the browser for
HTML, the image viewer for images. If the user says "open it", "show me it"
or "let me see it", CALL openFile. Do not paste the file's contents into the
reply and call that opening it; that is not what they asked for.

Rules:
- Use the native function-calling protocol only. Never emit raw JSON blocks
  or pseudo-calls as plain text.
- Look before you answer. If the question is about this codebase, the answer
  comes from files you actually read — not from what a project like this one
  usually looks like.
- Never reference a file path you have not seen in a glob, grep or listDir
  result. Cite what you found as path:line so it can be checked.
- Prefer grep for "does X exist and where", glob for "what files match",
  listDir for "what is in this folder", readFile when you need the contents.
- Answer the question that was asked, at the length it deserves. A one-line
  question gets a one-line answer.
- Say plainly when you do not know or could not find it. A wrong confident
  answer about someone's own codebase is worse than no answer.
- If the user actually wants a change made, say so and suggest /build — do
  not describe an edit as though you made it. You did not.`;

/**
 * Where new files go.
 *
 * This is in the prompt because the failure it prevents is a real and
 * repeated one: asked for an app, the agent drops chess.html, poker.tsx and
 * notesapp.html into the workspace root next to package.json — sometimes
 * alongside the chess-app/ directory that already existed. This repo carried
 * exactly that litter until it was cleaned out.
 *
 * The old SESSION_CONTEXT made that worse by offering `index.html` at the
 * root as its example of a relative path, so the one concrete placement
 * example the model saw was the wrong one.
 */
const FILE_PLACEMENT_RULES = `
FILE PLACEMENT — decide before you write, and state the destination:
- Look first. Use glob or listDir to find where files of this kind already
  live in this repo, and put the new file beside them.
- Only write to the workspace root when the repo is empty, or when the file
  belongs at the root by convention (README, package.json, tsconfig,
  Dockerfile, .gitignore). A new app, page, component or script does NOT
  belong at the root.
- A multi-file artifact gets its own directory, named for what it is.
- If PROJECT CONVENTIONS below name a layout, that layout wins over every
  rule above. It is not a suggestion.`;

/**
 * Builds the system prompt for one role.
 *
 * Cheap and deterministic: no filesystem walk, no symbol extraction. It is
 * cached per session in Chat.tsx anyway, but it no longer needs to be — the
 * expensive part (the repo map) is gone, and both roles discover the codebase
 * with tools instead.
 *
 * @param projectRoot - Absolute path to the workspace root.
 * @param role - Which role is asking. Selects the behaviour rules; defaults
 *               to executor, which is what the UI's display copy wants.
 */
export async function buildSystemPrompt(
  projectRoot: string,
  role: AgentRole = "executor",
): Promise<string> {
  const instructions =
    role === "planner"
      ? PLANNER_INSTRUCTIONS_BASE
      : role === "ask"
        ? ASK_INSTRUCTIONS
        : EXECUTOR_INSTRUCTIONS;

  // The ask role cannot write anything, so placement rules would be noise.
  // The planner needs them because its targetFiles become the executor's
  // destinations — and the gate preview shows them to the user.
  const placementRules = role === "ask" ? "" : FILE_PLACEMENT_RULES;

  // Project conventions from ZIZOU.md, minus its "## Agent" settings block.
  // Those lines are configuration for Zizou, not guidance for the model, and
  // reading "provider: anthropic" as a project convention is pure noise.
  let projectConventions = "";
  const conventions = await loadProjectConventions(projectRoot);
  if (conventions) {
    const prose = stripAgentSection(conventions).trim();
    if (prose) {
      projectConventions = `\n\n--- PROJECT CONVENTIONS (from ZIZOU.md) ---\n${prose}\n--- END PROJECT CONVENTIONS ---`;
    }
  }

  const { os, shell } = getOSInfo();

  // Injected at runtime so the model always has the real workspace path.
  const SESSION_CONTEXT = `
--- SESSION CONTEXT ---
Workspace root (cwd): ${projectRoot}
Operating system: ${os}
Shell: ${shell}
All relative paths you provide to tools are resolved from this root.
Absolute paths and relative paths both work — a relative path like
src/components/Foo.tsx is resolved against the workspace root automatically.${
    placementRules
      ? "\nBeing able to write to the root is not a reason to: see FILE PLACEMENT below."
      : ""
  }
--- END SESSION CONTEXT ---`;

  const pinnedText = buildPinnedSection();

  const exploreHint =
    role === "planner"
      ? "\n\nYou have not been given a summary of this codebase. Use glob, grep and listDir to find what you need."
      : role === "ask"
        ? "\n\nYou have not been given a summary of this codebase. Use glob, grep, listDir and readFile to find what you need before answering."
        : "\n\nYou have not been given a summary of this codebase. Use glob, grep, listDir and readFile to find what you need before editing.";

  // ORDER MATTERS: the placement rules end by deferring to "PROJECT
  // CONVENTIONS below", so the conventions must actually be below them.
  return `${instructions}${SESSION_CONTEXT}${placementRules}${projectConventions}${pinnedText}${exploreHint}`;
}

/**
 * Renders pinned files, newest cap first.
 *
 * PINNED FILES ARE CAPPED. They are injected verbatim into every prompt for
 * the life of the session, so a single `/add` on a large file used to sit in
 * the context window forever, uncapped, silently crowding out conversation.
 * Over the limit we include the head of the file and say so, which is honest
 * about what the model can actually see.
 */
function buildPinnedSection(): string {
  if (pinnedContextFiles.size === 0) return "";

  let out = "\n\n--- PINNED FILES ---\nThe user has pinned the following files to your permanent context:\n";
  let remaining = PINNED_CHAR_BUDGET;

  for (const file of pinnedContextFiles) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      out += `\nFile: ${file} (Failed to read)\n`;
      continue;
    }

    if (remaining <= 0) {
      out += `\nFile: ${file} (omitted — pinned-file budget exhausted)\n`;
      continue;
    }

    if (contents.length > remaining) {
      const kept = contents.slice(0, remaining);
      out += `\nFile: ${file} (truncated — showing the first ${remaining} of ${contents.length} characters)\n\`\`\`\n${kept}\n\`\`\`\n`;
      remaining = 0;
    } else {
      out += `\nFile: ${file}\n\`\`\`\n${contents}\n\`\`\`\n`;
      remaining -= contents.length;
    }
  }

  out += "--- END PINNED FILES ---";
  return out;
}

/**
 * Removes the `## Agent` settings block from ZIZOU.md, leaving the prose.
 * Mirrors the section-finding in config/zizou-md.ts, which reads the same
 * block for the opposite purpose.
 */
function stripAgentSection(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];

  let skipping = false;
  let headingLevel = 0;

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);

    if (heading) {
      if (skipping && heading[1].length <= headingLevel) {
        skipping = false;
      }
      if (!skipping && /^agent\b/i.test(heading[2].trim())) {
        skipping = true;
        headingLevel = heading[1].length;
        continue;
      }
    }

    if (!skipping) out.push(line);
  }

  return out.join("\n");
}
