// src/context/repo-map.ts
//
// LAYER: context/. Per HOUSE_RULES, this layer reads the filesystem
// directly (like tools/ does) but does NOT import from tools/, agent/,
// or ui/ — its only job is "given a project directory, produce a useful
// summary of what's in it," independent of how that summary gets used.
//
// THE TECHNIQUE: this is "Level 1" codebase context, sometimes called a
// "repo map" (Aider popularized this term). The core problem it solves:
// the model has NO persistent memory of your codebase between messages
// — every conversation starts from zero. Two ways to fix that:
//   Level 0 (no indexing): give the model grep/glob tools and let it
//     explore the repo itself, the way a human would with `find`/`rg`.
//     See createGlobTool/createGrepTool in src/tools/ for this.
//   Level 1 (this file): pre-compute a lightweight TEXT SUMMARY of the
//     codebase's structure — just function/class/interface names and
//     line numbers, NOT full file contents — and inject it into the
//     system prompt ONCE per session. The model then starts every
//     conversation already knowing the shape of the repo (similar to
//     glancing at an IDE's outline view before reading code), and only
//     needs to call readFile for the SPECIFIC file it actually needs,
//     rather than blindly grepping around to discover what exists.
//
// WHY REGEX AND NOT A REAL PARSER (tree-sitter): this is a deliberate,
// known-limited implementation, not a finished one. Regex pattern
// matching on source text is fast to write and easy to understand, but
// it WILL miss real code patterns — most notably, it cannot reliably
// distinguish "function-like" declarations that don't start with the
// `function` keyword, e.g. `const fooTool = tool({...})` (a call
// expression assigned to a const) looks identical, syntactically, to
// `const foo = 5` from a regex's point of view without much deeper
// pattern-matching. A real implementation upgrades this file to use
// tree-sitter (a proper incremental parser that understands the
// language's actual grammar) instead of guessing from text patterns —
// that is intentionally NOT done here. Do not "fix" this by stacking
// more and more specific regexes for each missed case; that's a losing
// game against an infinite space of valid syntax. Treat the gap as the
// reason the next upgrade exists, not a bug to patch around.
//
// A SECOND real false-positive class, actually observed while building
// this file (not hypothetical): a multi-line template literal string
// containing PROSE that happens to start a line with a word like
// "interface" — e.g. a sentence "...interface names and their..."
// inside a system-prompt string — gets matched as if it were a real
// `interface` declaration. A regex has no concept of "am I currently
// inside a string literal"; a real parser does. This is a second,
// independent reason tree-sitter is the eventual right answer, not
// just the const-tool() case above.

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

export interface CodeSymbol {
  file: string;
  line: number;
  signature: string;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const CODE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// Patterns for "things that look like a top-level declaration worth
// surfacing in the map." Each one is intentionally narrow — see the
// header comment above for why broadening these is the wrong fix.
const SYMBOL_PATTERNS: RegExp[] = [
  /^\s*(export\s+)?(async\s+)?function\s+(\w+)\s*\(/,
  /^\s*(export\s+)?const\s+(\w+)\s*=\s*(async\s*)?\(/, // const foo = (...) => ...
  /^\s*(export\s+)?class\s+(\w+)/,
  /^\s*(export\s+)?interface\s+(\w+)/,
  /^\s*(export\s+)?type\s+(\w+)\s*=/,
];

/**
 * Extracts a flat list of top-level symbol declarations from one file's
 * source text, using line-by-line regex matching. See the file header
 * for why this is intentionally simple and what it will miss.
 */
export function extractSymbols(filePath: string, content: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = content.split("\n");

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    // Cheap guard against the most common false positive: a // comment
    // line whose text happens to contain a word like "interface" or
    // "function" in prose, which would otherwise match SYMBOL_PATTERNS.
    // This does NOT handle every case (e.g. a /* block comment */
    // spanning multiple lines, or a comment placed after real code on
    // the same line) — fully solving that requires understanding the
    // language's actual syntax, which is exactly the tree-sitter
    // upgrade described in this file's header comment. This guard only
    // removes the cheapest, most common false-positive class.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      return;
    }

    for (const pattern of SYMBOL_PATTERNS) {
      if (pattern.test(line)) {
        symbols.push({
          file: filePath,
          line: idx + 1,
          // Truncate long lines so one weirdly long declaration doesn't
          // blow up the map's size disproportionately.
          signature: line.trim().slice(0, 120),
        });
        break; // one match per line is enough; don't double-count
      }
    }
  });

  return symbols;
}

/**
 * Walks `rootDir`, skipping noisy directories (node_modules, .git, etc),
 * and extracts symbols from every recognized source file. Returns the
 * raw flat list — formatting into a renderable string is a separate
 * step (see formatRepoMap below) so callers that want the raw data
 * (e.g. a future ranking pass) aren't forced to parse text back out of
 * a string.
 */
export function scanRepo(rootDir: string): CodeSymbol[] {
  const allSymbols: CodeSymbol[] = [];

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // permission errors etc — skip rather than crash the whole scan
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (CODE_FILE_PATTERN.test(entry)) {
        const content = readFileSync(fullPath, "utf-8");
        const relPath = relative(rootDir, fullPath);
        allSymbols.push(...extractSymbols(relPath, content));
      }
    }
  }

  walk(rootDir);
  return allSymbols;
}

/**
 * Formats a flat symbol list into the grouped-by-file text block that
 * actually gets injected into the system prompt. Kept separate from
 * scanRepo so future code (e.g. an importance-ranking pass) can work
 * with the raw CodeSymbol[] without needing to re-parse formatted text.
 */
export function formatRepoMap(symbols: CodeSymbol[]): string {
  const byFile = new Map<string, CodeSymbol[]>();
  for (const sym of symbols) {
    if (!byFile.has(sym.file)) byFile.set(sym.file, []);
    byFile.get(sym.file)!.push(sym);
  }

  let map = "";
  for (const [file, syms] of byFile) {
    map += `\n${file}:\n`;
    for (const s of syms) {
      map += `  L${s.line}: ${s.signature}\n`;
    }
  }
  return map.trim();
}

/** Convenience wrapper: scan + format in one call, for the common case. */
export function buildRepoMap(rootDir: string): string {
  return formatRepoMap(scanRepo(rootDir));
}
