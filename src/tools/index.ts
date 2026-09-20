/**
 * tools/index.ts — Barrel file re-exporting all tool definitions.
 *
 * Layer: tools
 * Allowed imports: other files in tools/, config/
 * NOT allowed to import from: agent/, ui/, sdk/
 *
 * Every tool gets its own file (e.g. read-file.ts, grep.ts) and is
 * re-exported from here. This is the single import point that the agent
 * layer uses to discover available tools, so adding a new tool never
 * requires touching agent code — just create the file and add one line here.
 */

import { createReadFileTool, readFile } from "./read-file.js";
import { createWriteFileTool } from "./write-file.js";
import { createEditFileTool } from "./edit-file.js";
import { glob } from "./glob.js";
import { grep } from "./grep.js";
import { listDir } from "./list-dir.js";
import { openFile } from "./open-file.js";
import { addFileToContext } from "./add-context.js";
import { createRunBashTool } from "./run-bash.js";
import { createRunBackgroundTool } from "./run-background.js";
import { manageTasks } from "./manage-tasks.js";
import { managePorts } from "./manage-ports.js";
import { createFileOperationsTool } from "./file-operations.js";
import type { ConfirmFn } from "./types.js";

/**
 * The read-only subset: look, never touch.
 *
 * Used by the planner, which must be able to find out what exists without
 * being able to change anything. It takes no ConfirmFn because nothing here
 * can modify the filesystem or run a command, so there is nothing to approve
 * — `readFile` is the unconfirmed variant for exactly this reason.
 *
 * WHY THE PLANNER GOT TOOLS: it previously had none, and was handed a
 * pre-computed repo map instead. That map cost ~5.7k tokens on this repo, a
 * quarter of which described a separate project under docs/, while missing
 * every tool defined as `export const x = tool({...})` — a pattern the
 * regex-based extractor cannot see. Grepping for a symbol finds it; a map
 * that never listed it cannot.
 */
export function buildReadOnlyToolMap(
  opts: { canOpen?: boolean } = {},
): Record<string, any> {
  return {
    readFile,
    glob,
    grep,
    listDir,
    // openFile launches the OS viewer and cannot modify anything, so it is
    // read-only by this map's own definition. It is still OPT-IN, because
    // "changes nothing" and "appropriate here" are different questions:
    //
    //   - The PLANNER must not have it. Its whole contract is to describe
    //     work rather than start it, and a planner that pops open a browser
    //     while deciding what to do has begun doing it.
    //   - The ASK and CHAT routes DO get it. They are talking to the user in
    //     real time, and "open it" is a thing a user says mid-conversation.
    //     Without this, a route that cannot open the file answers by dumping
    //     the file's contents into the terminal instead — which is what
    //     happened, and is not what anyone asked for.
    ...(opts.canOpen ? { openFile } : {}),
  };
}

/**
 * Builds the complete map of tools exposed to the model.
 *
 * THIS IS THE ONLY PLACE THE TOOL MAP IS DEFINED. It used to be spelled out
 * by hand in both agent/run-turn.ts and agent/executor.ts (for the fallback
 * pseudo-call path), which meant a tool added to one and not the other was
 * invisible on half the code paths — and silently so, because an unknown
 * tool name simply fails to match.
 *
 * Tools that can modify the filesystem or run commands are factories taking
 * a ConfirmFn; read-only tools are plain definitions.
 */
export function buildToolMap(onConfirm: ConfirmFn): Record<string, any> {
  return {
    readFile: createReadFileTool(onConfirm),
    writeFile: createWriteFileTool(onConfirm),
    editFile: createEditFileTool(onConfirm),
    glob,
    grep,
    listDir,
    openFile,
    addFileToContext,
    runBash: createRunBashTool(onConfirm),
    runBackground: createRunBackgroundTool(onConfirm),
    manageTasks,
    managePorts,
    fileOperations: createFileOperationsTool(onConfirm),
  };
}

export { readFile, createReadFileTool } from "./read-file.js";
export { createWriteFileTool } from "./write-file.js";
export { createEditFileTool } from "./edit-file.js";
export { glob } from "./glob.js";
export { grep } from "./grep.js";
export { listDir } from "./list-dir.js";
export { openFile } from "./open-file.js";
export { addFileToContext } from "./add-context.js";
export { createRunBashTool } from "./run-bash.js";
export { createRunBackgroundTool } from "./run-background.js";
export { manageTasks } from "./manage-tasks.js";
export { managePorts } from "./manage-ports.js";
export { createFileOperationsTool } from "./file-operations.js";
export { sessionPermissions, SessionPermissionManager } from "./permissions.js";
export type { ConfirmFn } from "./types.js";

