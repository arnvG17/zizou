/**
 * tools/index.ts — Barrel file re-exporting all tool definitions.
 *
 * Layer: tools
 * Allowed imports: other files in tools/, config/
 * NOT allowed to import from: agent/, ui/, provider/
 *
 * Every tool gets its own file (e.g. read-file.ts, grep.ts) and is
 * re-exported from here. This is the single import point that the agent
 * layer uses to discover available tools, so adding a new tool never
 * requires touching agent code — just create the file and add one line here.
 */

export { readFile } from "./read-file.js";
export { editFile } from "./edit-file.js";
export { glob } from "./glob.js";
export { grep } from "./grep.js";
export { createRunBashTool } from "./run-bash.js";
export type { ConfirmFn } from "./types.js";
