// src/tools/grep.ts — Tool definition for searching file contents.
//
// LAYER: tools
// Allowed imports: config (nothing above — no agent/, ui/, or provider/)
//
// Shells out to the real `grep` binary rather than reimplementing
// search in JS — using a battle-tested existing tool beats hand-rolling
// search logic, both for correctness and for not reinventing something
// the OS already does well.

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { z } from "zod";
import { tool } from "ai";

function simpleGrep(dir: string, regex: RegExp, filePattern: RegExp | null, results: string[] = [], root = dir): string[] {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
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
      simpleGrep(fullPath, regex, filePattern, results, root);
    } else {
      if (stat.size > 1024 * 1024) continue; // skip files > 1MB
      const relPath = relative(root, fullPath).replace(/\\/g, '/');
      if (filePattern && !filePattern.test(relPath) && !filePattern.test(entry)) {
        continue;
      }
      try {
        const content = readFileSync(fullPath, "utf-8");
        // quick check if it's likely a binary file by looking for null bytes
        if (content.indexOf('\0') !== -1) continue; 
        
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${relPath}:${i + 1}:${lines[i].trim()}`);
            if (results.length >= 50) return results;
          }
        }
      } catch {
        // ignore unreadable
      }
    }
    if (results.length >= 50) break;
  }
  return results;
}

export const grep = tool({
  description: "Search file contents for a text pattern across the project (like grep -r)",
  inputSchema: z.object({
    pattern: z.string().describe("Text or regex pattern to search for"),
    fileGlob: z.string().optional().describe("Optional file pattern to limit search, e.g. '*.ts'"),
  }),
  execute: async ({ pattern, fileGlob }) => {
    try {
      const searchRegex = new RegExp(pattern);
      let fileRegex: RegExp | null = null;
      if (fileGlob) {
        const fp = "^" + fileGlob.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
        fileRegex = new RegExp(fp);
      }
      const matches = simpleGrep(".", searchRegex, fileRegex);
      return { success: true as const, matches };
    } catch (err) {
      return { success: false as const, error: String(err) };
    }
  },
});
