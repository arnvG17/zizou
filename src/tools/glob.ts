// src/tools/glob.ts — Tool definition for finding files by pattern.
//
// LAYER: tools
// Allowed imports: config (nothing above — no agent/, ui/, or provider/)
//
// This is "Level 0" codebase context (see src/context/repo-map.ts for
// the bigger picture of the levels). Instead of pre-computing anything
// about the repo, this tool lets the MODEL explore it directly, the
// same way a person would use `find` or their editor's fuzzy-file
// finder. No indexing step, no staleness risk if files change mid-
// conversation — the tradeoff is the model has to spend a turn
// "looking" before it can act, instead of already knowing where things are.

import { readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { z } from "zod";
import { tool } from "ai";

function simpleGlob(dir: string, pattern: RegExp, results: string[] = [], root = dir): string[] {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next"]);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results; // unreadable directory — skip rather than crash
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      simpleGlob(fullPath, pattern, results, root);
    } else if (pattern.test(entry)) {
      results.push(relative(root, fullPath));
    }
  }
  return results;
}

export const glob = tool({
  description: "Find files in the project by filename pattern (e.g. '*.ts', 'test*.js')",
  inputSchema: z.object({
    pattern: z.string().describe("A simple glob-style pattern, e.g. '*.ts'"),
  }),
  execute: async ({ pattern }) => {
    // Turn "*.ts" into a real regex: escape dots, turn * into .*
    const regexPattern = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
    const matches = simpleGlob(".", new RegExp(regexPattern));
    return { success: true as const, files: matches.slice(0, 50) }; // cap so results stay small
  },
});
