// src/tools.ts
//
// Same tool logic as Phase 2 (read_file, edit_file, run_bash), but with
// one key change: instead of calling Node's `readline` directly for the
// y/n confirmation (which only works in a plain terminal), we accept an
// `onConfirm` CALLBACK. The Ink UI will supply this callback so it can
// show its OWN nice confirmation prompt instead of a plain text question.
// This is a common pattern: keep your core logic UI-agnostic, and let
// whatever's rendering (CLI today, maybe a web UI later) plug in how
// confirmations actually get shown to the user.

import { tool } from "ai";
import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

export type ConfirmFn = (description: string) => Promise<boolean>;

export function createReadFileTool() {
  return tool({
    description: "Read the full contents of a file from the local filesystem",
    inputSchema: z.object({
      path: z.string().describe("Relative or absolute path to the file"),
    }),
    execute: async ({ path }) => {
      try {
        return { success: true, contents: readFileSync(path, "utf-8") };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  });
}

export function createEditFileTool() {
  return tool({
    description:
      "Edit a file by replacing an exact piece of existing text with new text. " +
      "old_string must match the file content EXACTLY and must be unique in the file.",
    inputSchema: z.object({
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
    }),
    execute: async ({ path, old_string, new_string }) => {
      let content: string;
      try {
        content = readFileSync(path, "utf-8");
      } catch (err) {
        return { success: false, error: `Could not read file: ${err}` };
      }

      const occurrences = content.split(old_string).length - 1;
      if (occurrences === 0) {
        return { success: false, error: "old_string was not found in the file." };
      }
      if (occurrences > 1) {
        return { success: false, error: `old_string appears ${occurrences} times — must be unique.` };
      }

      writeFileSync(path, content.replace(old_string, new_string), "utf-8");
      return { success: true, message: `Replaced 1 occurrence in ${path}` };
    },
  });
}

export function createRunBashTool(onConfirm: ConfirmFn) {
  return tool({
    description: "Execute a bash shell command and return its stdout/stderr",
    inputSchema: z.object({
      command: z.string(),
    }),
    execute: async ({ command }) => {
      const approved = await onConfirm(`Run command: ${command}`);
      if (!approved) {
        return { success: false, error: "User denied permission to run this command." };
      }
      try {
        const output = execSync(command, {
          encoding: "utf-8",
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        });
        return { success: true, output: output.slice(0, 5000) };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });
}

// Bundle everything into one tools object, ready to hand to generateText/streamText
export function createAllTools(onConfirm: ConfirmFn) {
  return {
    readFile: createReadFileTool(),
    editFile: createEditFileTool(),
    runBash: createRunBashTool(onConfirm),
  };
}
