// src/tools/glob.ts — Tool definition for finding files by pattern.
//
// LAYER: tools
// Allowed imports: config (nothing above — no agent/, ui/, or sdk/)
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

// Converts a glob pattern to a proper regex, handling:
//   **  - match any number of path segments (including zero)
//   *   - match anything within a single path segment (no /)
//   ?   - match a single non-/ character
//   .   - escaped to literal dot
//
// Examples:
//   "*.ts"         matches "foo.ts" but not "src/foo.ts"
//   "**/*.ts"      matches "foo.ts", "src/foo.ts", "a/b/c/foo.ts"
//   "**/app.css"   matches "app.css", "src/app.css", "todo-list/src/app.css"
function globToRegex(pattern: string): RegExp {
  // Normalize backslashes to forward slashes
  let p = pattern.replace(/\\/g, "/");

  // If the pattern doesn't contain a path separator and starts with *.,
  // treat it as matching any file with that extension anywhere (common intent)
  // e.g. "*.ts" → user likely means "find all .ts files", not just in root
  const hasSlash = p.includes("/");

  let regexStr = "";
  let i = 0;

  while (i < p.length) {
    const char = p[i];

    if (char === "*" && p[i + 1] === "*") {
      // ** — match any number of directories (including zero)
      // Consume trailing slash if present: **/ → (.*\/)?
      if (p[i + 2] === "/") {
        regexStr += "(.*/)?";
        i += 3;
      } else {
        // ** at end of pattern → match everything
        regexStr += ".*";
        i += 2;
      }
    } else if (char === "*") {
      // * — match anything except path separator
      regexStr += "[^/]*";
      i++;
    } else if (char === "?") {
      // ? — match a single non-/ character
      regexStr += "[^/]";
      i++;
    } else if (char === ".") {
      regexStr += "\\.";
      i++;
    } else if (char === "/" || char === "\\") {
      regexStr += "/";
      i++;
    } else if (".+^${}()|[]\\".includes(char)) {
      // Escape other regex special characters
      regexStr += "\\" + char;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }

  // If the pattern has no path component (e.g. "*.ts"), allow matching
  // at any depth — the user almost certainly means "find all .ts files"
  // not "only .ts files in the root directory".
  const finalPattern = hasSlash ? `^${regexStr}$` : `^(.*/)?${regexStr}$`;

  // Case-insensitive on Windows for better robustness
  const flags = process.platform === "win32" ? "i" : "";
  return new RegExp(finalPattern, flags);
}

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
    } else {
      const relPath = relative(root, fullPath).replace(/\\/g, '/');
      if (pattern.test(relPath) || pattern.test(entry)) {
        results.push(relPath);
      }
    }
  }
  return results;
}

export const glob = tool({
  description: "Find files in the project by filename pattern (e.g. '*.ts', '**/app.css')",
  inputSchema: z.object({
    pattern: z.string().describe("A simple glob-style pattern, e.g. '*.ts' or '**/app.css'"),
  }),
  execute: async ({ pattern }) => {
    try {
      const regex = globToRegex(pattern);
      const matches = simpleGlob(".", regex);
      return { success: true as const, files: matches.slice(0, 50) };
    } catch (err) {
      return { success: false as const, error: String(err) };
    }
  },
});
