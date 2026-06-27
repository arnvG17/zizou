// src/tools/grep.ts — Tool definition for searching file contents.
//
// LAYER: tools
// Allowed imports: config (nothing above — no agent/, ui/, or provider/)
//
// Shells out to the real `grep` binary rather than reimplementing
// search in JS — using a battle-tested existing tool beats hand-rolling
// search logic, both for correctness and for not reinventing something
// the OS already does well.

import { execSync } from "child_process";
import { z } from "zod";
import { tool } from "ai";

export const grep = tool({
  description: "Search file contents for a text pattern across the project (like grep -r)",
  inputSchema: z.object({
    pattern: z.string().describe("Text or regex pattern to search for"),
    fileGlob: z.string().optional().describe("Optional file pattern to limit search, e.g. '*.ts'"),
  }),
  execute: async ({ pattern, fileGlob }) => {
    try {
      const includeFlag = fileGlob ? `--include="${fileGlob}"` : "";
      // Escape double quotes in the user/model-provided pattern so it
      // can't break out of the shell command's quoting.
      const safePattern = pattern.replace(/"/g, '\\"');
      const cmd = `grep -rn ${includeFlag} --exclude-dir=node_modules --exclude-dir=.git "${safePattern}" . || true`;
      const output = execSync(cmd, { encoding: "utf-8", maxBuffer: 1024 * 1024 });
      const lines = output.split("\n").filter(Boolean).slice(0, 30); // cap results
      return { success: true as const, matches: lines };
    } catch (err) {
      return { success: false as const, error: String(err) };
    }
  },
});
