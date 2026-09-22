// evals/sft/scenarios/recovery.ts
//
// BAND: recovery — a REAL failure, followed by the correct next move.
//
// The most valuable band, and the one that cannot be faked. Every failing
// step here is marked expectFailure, and generate.ts asserts the tool really
// did fail — so the error text in the record is byte-exact, produced by the
// same code path the model will hit at runtime. Hand-written error strings
// drift, and a model trained on "appeared 2 times" will not recognise the
// real message if it says something else.
//
// What the real system prompt asks for, and what this band teaches:
//
//   "If editFile fails with 'appeared N times', provide near_line (the line
//    number nearest your intended match)"
//   "If editFile fails twice on the same file, you will be told to fall back
//    to writeFile with the complete corrected contents. Do this immediately —
//    do not keep retrying editFile with cosmetic variations of old_string."
//
// near_line was missing entirely from specs/010-sft-dataset.md's schema list
// even though it is in the real Zod schema and the real prompt. It is the
// primary recovery path, so it gets first-class coverage here.
//
// Note there is also a duplicate-call blocker in run-turn.ts that returns
// "BLOCKED: this exact call already failed once" on an identical retry. The
// no-cosmetic-retry records below are what keep the model out of it.

import type { Scenario } from "../types.js";
import {
  baseProject,
  repeatedSymbolFile,
  serviceFile,
  lineOf,
  pick,
  SERVICE_NAMES,
} from "../fixtures.js";

export function recoveryScenarios(): Scenario[] {
  const out: Scenario[] = [];

  // ── "appeared N times" → near_line ─────────────────────────────────────
  //
  // repeatedSymbolFile puts the symbol on several lines on purpose, so a
  // bare old_string genuinely matches more than once. The model learns to
  // read the line numbers out of the error and answer with near_line rather
  // than guessing at wider context.
  for (let i = 0; i < 50; i++) {
    const symbol = pick(SERVICE_NAMES, i);
    const path = `src/config/${symbol}-config.ts`;
    const contents = repeatedSymbolFile(symbol);
    // Computed, not hardcoded — see lineOf() in fixtures.ts for why.
    const defaultsLine = lineOf(contents, `  ${symbol}: 10,`, 1);
    out.push({
      id: `recovery-near-line-${i}`,
      band: "recovery",
      prompt: `In ${path}, change the default ${symbol} from 10 to 25.`,
      fixture: { ...baseProject(), [path]: contents },
      steps: [
        { tool: "readFile", args: { path } },
        {
          // Matches in both DEFAULTS and TEST_DEFAULTS — a real ambiguity,
          // and the error the model sees lists both line numbers.
          tool: "editFile",
          args: { path, old_string: `  ${symbol}: 10,`, new_string: `  ${symbol}: 25,` },
          expectFailure: true,
        },
        {
          tool: "editFile",
          args: {
            path,
            old_string: `  ${symbol}: 10,`,
            new_string: `  ${symbol}: 25,`,
            near_line: defaultsLine,
          },
        },
      ],
      finalText: `The value appears in both DEFAULTS and TEST_DEFAULTS, so I targeted the DEFAULTS block by line. Default ${symbol} is now 25.`,
    });
  }

  // ── "not found" → re-read, then edit what is actually there ────────────
  //
  // The failure is a guessed old_string. The recovery is NOT a cosmetic
  // variation of the guess — it is going back to the file. That distinction
  // is the whole lesson.
  for (let i = 0; i < 45; i++) {
    const name = pick(SERVICE_NAMES, i + 4);
    const path = `src/services/${name}.ts`;
    out.push({
      id: `recovery-not-found-${i}`,
      band: "recovery",
      prompt: `Turn on verbose logging by default for ${name}.`,
      fixture: { ...baseProject(), [path]: serviceFile(name) },
      steps: [
        {
          // Plausible from the request, absent from the file: the exact
          // mistake the prompt's "never guess" rule is aimed at.
          tool: "editFile",
          args: { path, old_string: `verbose: true`, new_string: `verbose: false` },
          expectFailure: true,
        },
        { tool: "readFile", args: { path } },
        {
          tool: "editFile",
          args: { path, old_string: `  verbose: false,`, new_string: `  verbose: true,` },
        },
      ],
      finalText: `Verbose logging is on by default for ${name}.`,
    });
  }

  // ── reading a file that does not exist → find the real one ─────────────
  for (let i = 0; i < 35; i++) {
    const name = pick(SERVICE_NAMES, i + 9);
    const realPath = `src/services/${name}.ts`;
    const guessPath = `src/${name}.ts`;
    out.push({
      id: `recovery-missing-file-${i}`,
      band: "recovery",
      prompt: `Bump the ${name} retry count to 6.`,
      fixture: { ...baseProject(), [realPath]: serviceFile(name) },
      steps: [
        { tool: "readFile", args: { path: guessPath }, expectFailure: true },
        { tool: "glob", args: { pattern: `**/${name}.ts` } },
        { tool: "readFile", args: { path: realPath } },
        {
          tool: "editFile",
          args: { path: realPath, old_string: `  retries: 3,`, new_string: `  retries: 6,` },
        },
      ],
      finalText: `It lives in ${realPath}, not at the src root. Retries raised to 6.`,
    });
  }

  // ── two failures on one file → writeFile the whole corrected contents ──
  //
  // editFile tracks failures per file and, on the second, tells the model to
  // switch to writeFile (see the recordFailure path in src/tools/edit-file.ts).
  // These records make the model take that advice immediately instead of
  // burning the remaining step budget on a third variation.
  for (let i = 0; i < 30; i++) {
    const symbol = pick(SERVICE_NAMES, i + 6);
    const path = `src/config/${symbol}-config.ts`;
    const rewritten = repeatedSymbolFile(symbol).replace(
      `export const DEFAULTS: Config = {\n  ${symbol}: 10,`,
      `export const DEFAULTS: Config = {\n  ${symbol}: 42,`,
    );
    out.push({
      id: `recovery-two-fails-rewrite-${i}`,
      band: "recovery",
      prompt: `Set the default ${symbol} to 42 in ${path}.`,
      fixture: { ...baseProject(), [path]: repeatedSymbolFile(symbol) },
      steps: [
        { tool: "readFile", args: { path } },
        {
          tool: "editFile",
          args: { path, old_string: `  ${symbol}: 10,`, new_string: `  ${symbol}: 42,` },
          expectFailure: true,
        },
        {
          // A second ambiguous attempt — this is the one that trips the
          // two-failure counter and produces the "use writeFile" guidance.
          tool: "editFile",
          args: { path, old_string: `${symbol}: 10,`, new_string: `${symbol}: 42,` },
          expectFailure: true,
        },
        { tool: "writeFile", args: { path, contents: rewritten } },
      ],
      finalText: `The string was ambiguous twice, so I rewrote the file with the corrected default. ${symbol} now defaults to 42.`,
    });
  }

  return out;
}
