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
import { getContextMode } from "../config/api-keys.js";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { platform } from "os";

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

When creating a new file or completely replacing a file's contents, use the writeFile tool. When modifying existing files in a targeted way, use editFile with an old_string that exactly matches existing content and is unique in the file — never rewrite whole files from scratch if you are only making minor edits. Before running any shell command, know that the user will be asked to approve it; explain briefly what a command will do if it's not obvious.

IMPORTANT — "Read Before Edit" Rule:
Before calling editFile, you MUST first readFile the file to see its current contents.
The old_string parameter must EXACTLY match text currently in the file — including all
whitespace, indentation, and line breaks. If you guess at the content without reading
the file first, the edit will almost certainly fail.

For general knowledge questions, conversational chat, or queries that do not require workspace files or terminal command execution, answer directly from your internal knowledge. Do NOT use tools (such as grep, glob, readFile, or runBash) unless the task specifically requires accessing the project codebase or executing commands.

CRITICAL INSTRUCTION FOR TOOL CALLING: You are interacting with a system that supports native tool calling (function calling). You MUST use the native tool calling protocol. 
Do not output raw JSON text blocks to call tools. You must strictly invoke the tool using the API's designated function calling format.

CRITICAL: When calling a tool, you must output the exact, clean name of the tool (e.g., 'runBash' or 'readFile') as a plain string in the tool name field. Do NOT concatenate, append, or embed any JSON arguments or parentheses into the tool name string itself. All arguments must be placed strictly inside the tool arguments object.`;

/**
 * Builds the complete system prompt for a session: base instructions +
 * the project's repo map. Called once per session (not per turn) since
 * walking the filesystem and re-running extraction on every message
 * would be wasteful — see src/ui/Chat.tsx for where this gets cached.
 */
export async function buildSystemPrompt(projectRoot: string): Promise<string> {
  const mode = getContextMode();
  let repoMap = "";
  
  if (mode !== "light") {
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

TOOL GUIDE:
  listDir(path?)     → list immediate children of a directory. Use this FIRST
                       whenever you need to understand the folder structure or
                       decide where a new file should go.
  readFile(path)     → read the full contents of an existing file. ALWAYS call
                       this before editFile so you have the exact current text.
  writeFile(path, contents) → create a NEW file or FULLY REPLACE an existing one.
                       Use this for brand-new files or when you want to overwrite everything.
  editFile(path, old_string, new_string) → make a TARGETED replacement inside an existing
                       file. old_string must match exactly and be unique in the file.
                       IMPORTANT: Always readFile first to get the exact text.
  glob(pattern)      → find files recursively by name pattern (e.g. "*.ts",
                       "**/app.css"). Supports ** for any depth matching.
  grep(pattern)      → search file contents by text or regex pattern across the project.
  runBash(command)   → run a shell command (user must approve first).
                       On ${os} this runs in ${shell}.
                       Has a 120-second timeout — suitable for short/medium installation & builds.
  runBackground(command) → Run a shell command in the background (non-blocking).
                       Perfect for long-running servers (e.g. 'npm run dev' or 'bun run dev').
                       Returns a 'taskId' and 'pid' immediately.
  manageTasks(action, taskId?) → Manage background tasks.
                       - action="list": Return details of all tasks spawned in this session.
                       - action="logs": Return stdout/stderr buffer from a task (helps check server state/logs).
                       - action="kill": Terminate a background task (and its children).
  managePorts(action, port) → Find and terminate processes on ports.
                       - action="find": Find PID and name of process listening on 'port'.
                       - action="kill": Kill the process listening on 'port'.
                       Helps solve 'Address already in use' errors.
  fileOperations(action, source, destination?) → Native file management.
                       - action="delete": Recursively delete a file/folder.
                       - action="createDirectory": Recursively create folders.
                       - action="copy": Recursively copy a file/folder to destination.
                       - action="move": Move/rename a file/folder to destination.
  openFile(path)     → open a file in the OS default app (HTML → browser,
                       images → viewer, etc.). Use after creating a file so the
                       user can immediately preview it.

WORKFLOW FOR FINDING AND EDITING FILES:
When the user asks you to modify a file you haven't seen yet:
  1. Use glob("**/filename") or listDir() to FIND the file path
  2. Use readFile(path) to READ its current contents
  3. Use editFile(path, old_string, new_string) to EDIT it
  Never skip step 2 — editFile needs an exact string match.

PROJECT SCAFFOLDING (React, Next.js, Vite, etc.):
When the user asks you to create a new project with a framework:
  1. Use runBash to scaffold: e.g.
     - React/Vite: npx -y create-vite@latest my-app -- --template react
     - Next.js:    npx -y create-next-app@latest my-app --yes --use-npm
     - Plain React: npx -y create-react-app my-app
  2. Use runBash("cd my-app && npm install") if dependencies weren't auto-installed
  3. Spin up development server in the background:
     - runBackground("cd my-app && npm run dev")
  4. Verify server running using:
     - manageTasks("list")
     - Wait a few seconds, then query logs using manageTasks("logs", taskId) to see server startup details.
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

  if (!repoMap || mode === "light") {
    return `${BASE_INSTRUCTIONS}${SESSION_CONTEXT}${pinnedText}\n\n(Repo map is disabled in '${mode}' mode, or no source files were found. Use tools like listDir to explore.)`;
  }

  return `${BASE_INSTRUCTIONS}${SESSION_CONTEXT}${pinnedText}\n\n--- REPO MAP ---\n${repoMap}\n--- END REPO MAP ---`;
}
