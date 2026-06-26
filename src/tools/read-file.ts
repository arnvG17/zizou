/**
 * read-file.ts — Tool definition for reading a file's contents from disk.
 *
 * Layer: tools
 * Allowed imports: config (nothing above — no agent/, ui/, or provider/)
 *
 * This is the first tool in Zizou's toolbelt. An LLM agent uses it to inspect
 * files on the user's machine. The tool receives a file path from the model,
 * reads the file synchronously, and returns the contents (or an error object
 * if the read fails). We intentionally NEVER throw inside execute — errors
 * are always returned as structured data so the LLM can decide what to do
 * with them instead of crashing the agent loop.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { tool } from "ai";

/**
 * readFile — AI SDK tool that lets the model read a file from the local filesystem.
 *
 * HOW TOOL-CALLING WORKS (for beginners):
 * When we give an LLM a "tool", we're telling it: "here's a function you can
 * ask me to call, along with a schema describing what arguments it expects."
 * The model doesn't run the function itself — it outputs a structured JSON
 * request like { tool: "readFile", args: { path: "package.json" } }, and the
 * AI SDK intercepts that, calls our `execute` function with those args, then
 * feeds the result back to the model so it can continue its response.
 *
 * The `inputSchema` (a Zod schema) serves two purposes:
 *   1. It tells the LLM what shape the arguments should be (via JSON Schema conversion).
 *   2. It validates the LLM's output at runtime, catching malformed tool calls.
 *
 * We use `tool()` from the AI SDK as a type-safe helper that wires up the
 * schema to the execute function and ensures the types stay in sync.
 */
export const readFile = tool({
  description:
    "Read the contents of a file at the given path. " +
    "Returns the full file contents as a string on success, " +
    "or an error message if the file cannot be read.",
  inputSchema: z.object({
    path: z
      .string()
      .describe("Absolute or relative path to the file to read"),
  }),

  /**
   * Execute is called by the AI SDK when the model requests this tool.
   * We catch all errors and return them as data — never throw — so the
   * agent loop can continue and the model can decide how to recover.
   */
  execute: async ({ path }) => {
    try {
      const contents = readFileSync(path, "utf-8");
      return { success: true as const, contents };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error reading file";
      return { success: false as const, error: message };
    }
  },
});
