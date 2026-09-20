// evals/tasks/index.ts
//
// The golden task suite. Replaces evals/golden-tasks/, one file per task.
//
// They are all in one file now because a task is ~15 lines under the new
// contract: a prompt, a fixture, and a list of named assertions. The old
// per-file layout existed because each task carried 40-90 lines of
// hand-rolled if/return checking that genuinely needed its own file.
//
// TASK DESIGN RULES:
//   - Every assertion must be settleable by code. If you need a model to
//     decide whether the output is good, the prompt is too vague — tighten it.
//   - Prefer a fixture over asking the agent to create its own starting point.
//     A task that both creates and then fixes a file cannot tell you which
//     half failed.
//   - Assert on what the run DID (touchedFiles, touchedNothingBut) as well as
//     on the end state. "Right answer, wrecked three other files" is a fail.
//   - Keep budgets generous enough that a slow-but-correct model passes, tight
//     enough that a model looping to the step cap does not.

import type { GoldenTask } from "../types.js";
import {
  advisory,
  allStepsVerified,
  anyOf,
  commandSucceeds,
  fileContains,
  fileExists,
  fileLacks,
  fileMatches,
  noFallbackParsing,
  noToolFailures,
  nothingAtRoot,
  planHasAtLeast,
  routedTo,
  statedAssumptions,
  touchedFiles,
  touchedNothingBut,
} from "../assertions/index.js";

// ─── 1. Smoke test ───────────────────────────────────────────────────────────

const buildCreateFile: GoldenTask = {
  id: "build-create-file",
  intent: "Build mode can create one file end-to-end. Fails if tool-calling breaks.",
  prompt: "Create a file called hello.txt containing exactly: Hello, World!",
  mode: "build",
  tags: ["smoke", "tool-calling"],
  budget: { maxToolCalls: 8, maxDurationMs: 120_000 },
  assertions: [
    fileExists("hello.txt"),
    fileMatches("hello.txt", /Hello,?\s*World!?/i),
    touchedFiles("hello.txt"),
    touchedNothingBut("hello.txt"),
    advisory(noFallbackParsing()),
  ],
};

// ─── 2. Fix a real bug in a seeded codebase ──────────────────────────────────
//
// The task type the old harness could not express, because it had no way to
// seed a workspace. This is the closest thing here to the work users actually
// do: a file exists, it is wrong, fix it without breaking anything else.

const buildFixBug: GoldenTask = {
  id: "build-fix-off-by-one",
  intent: "Find and fix an off-by-one bug in existing code without collateral damage.",
  prompt:
    "The sum function in calc.js is wrong — it misses the last element of the array. " +
    "Fix it. Do not change anything else.",
  mode: "build",
  tags: ["editing", "precision"],
  budget: { maxToolCalls: 12, maxDurationMs: 180_000 },
  fixture: {
    "calc.js": [
      "// Sums every number in the array.",
      "function sum(numbers) {",
      "  let total = 0;",
      "  for (let i = 0; i < numbers.length - 1; i++) {",
      "    total += numbers[i];",
      "  }",
      "  return total;",
      "}",
      "",
      "module.exports = { sum };",
      "",
    ].join("\n"),
    "test.js": [
      "const assert = require('assert');",
      "const { sum } = require('./calc.js');",
      "assert.strictEqual(sum([1, 2, 3]), 6, 'sum([1,2,3]) should be 6');",
      "assert.strictEqual(sum([5]), 5, 'sum([5]) should be 5');",
      "assert.strictEqual(sum([]), 0, 'sum([]) should be 0');",
      "console.log('all assertions passed');",
      "",
    ].join("\n"),
  },
  assertions: [
    // The behavioural check is the one that matters: the seeded test must pass.
    commandSucceeds("node test.js"),
    // And the bug must be GONE, not shadowed by a second correct loop.
    fileLacks("calc.js", "numbers.length - 1"),
    // The test file is the specification. Editing it to pass is cheating.
    fileContains("test.js", "sum([1, 2, 3]), 6"),
    touchedNothingBut("calc.js"),
    advisory(noToolFailures()),
  ],
};

// ─── 3. Plan mode: dependency ordering ───────────────────────────────────────

const planDependencyOrdering: GoldenTask = {
  id: "plan-dependency-ordering",
  intent: "Plan mode decomposes a two-file feature and builds the dependency before its consumer.",
  prompt:
    "Create a utils.ts that exports a function greet(name) returning a greeting string. " +
    "Then create an app.ts that imports greet from ./utils and calls it with 'World'.",
  mode: "plan",
  tags: ["plan-mode", "multi-file"],
  budget: { maxToolCalls: 20, maxDurationMs: 300_000 },
  assertions: [
    planHasAtLeast(2),
    fileExists("utils.ts"),
    fileMatches("utils.ts", /export\s+(function|const)\s+greet/),
    fileExists("app.ts"),
    fileMatches("app.ts", /import\s+.*greet.*from\s+['"]\.\/utils/),
    fileMatches("app.ts", /greet\s*\(\s*['"]World['"]\s*\)/),
    touchedFiles("utils.ts", "app.ts"),
    advisory(allStepsVerified()),
  ],
};

// ─── 4. Plan mode: underspecified prompt ─────────────────────────────────────

const planAmbiguousAssumptions: GoldenTask = {
  id: "plan-ambiguous-assumptions",
  intent:
    "An underspecified prompt still yields a runnable plan, with the judgement calls " +
    "stated so the user can reject them at the y/n gate.",
  prompt: "Add authentication",
  mode: "plan",
  tags: ["plan-mode", "ambiguity"],
  budget: { maxToolCalls: 25, maxDurationMs: 300_000 },
  assertions: [
    planHasAtLeast(1),
    // We can check THAT assumptions were stated, never whether they were wise —
    // that would need a model, and assertions may not call one.
    statedAssumptions(1),
  ],
};

// ─── 5. Editing a file that does not exist ───────────────────────────────────

const buildMissingTarget: GoldenTask = {
  id: "build-edit-missing-file",
  intent:
    "Asked to edit a file that is not there, the agent must either create it correctly " +
    "or fail visibly. What it must not do is report success having done nothing.",
  prompt: 'Edit config.json to add a "version" field with the value "1.0.0"',
  mode: "build",
  tags: ["error-handling"],
  budget: { maxToolCalls: 12, maxDurationMs: 180_000 },
  assertions: [
    anyOf(
      "recovered by creating the file, or surfaced the failure",
      // Branch A: created it, correctly. A legitimate recovery.
      fileMatches("config.json", /"version"\s*:\s*"1\.0\.0"/),
      // Branch B: did not silently succeed — verification caught the mismatch.
      async (ctx) => {
        const failed = ctx.events.filter((e) => e.kind === "verification" && !e.verified);
        return {
          name: "verification reported a failure",
          passed: failed.length > 0,
          detail:
            failed.length > 0
              ? `${failed.length} verification failure(s) recorded`
              : "no verification failure recorded",
        };
      },
    ),
  ],
};


// ─── 6. Auto mode: the router picks the route ────────────────────────────
//
// Four tasks, one per route, over the seams that actually get misread:
// a question phrased as a task, a task phrased as a question, a greeting
// with nothing attached, and work whose size is the whole point.
//
// Each one asserts the ROUTE, not the answer. A route task that also graded
// the output would fail for two unrelated reasons and tell you neither.

const autoRoutesGreetingToChat: GoldenTask = {
  id: "auto-route-chat",
  intent: "Auto sends a bare greeting to chat, without writing anything.",
  prompt: "hey there",
  mode: "auto",
  tags: ["router", "auto-mode"],
  budget: { maxToolCalls: 4, maxDurationMs: 90_000 },
  assertions: [
    routedTo("chat"),
    // The route's real contract: conversation changes nothing on disk.
    nothingAtRoot(),
    touchedNothingBut(),
  ],
};

const autoRoutesQuestionToAsk: GoldenTask = {
  id: "auto-route-ask",
  intent: "Auto sends a codebase question to ask, which reads but never writes.",
  prompt: "how does the retry logic in this project work?",
  mode: "auto",
  tags: ["router", "auto-mode"],
  fixture: {
    "src/retry.ts": [
      "export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {",
      "  let lastError: unknown;",
      "  for (let i = 0; i < attempts; i++) {",
      "    try {",
      "      return await fn();",
      "    } catch (err) {",
      "      lastError = err;",
      "    }",
      "  }",
      "  throw lastError;",
      "}",
      "",
    ].join("\n"),
  },
  budget: { maxToolCalls: 12, maxDurationMs: 150_000 },
  assertions: [
    routedTo("ask"),
    // Ask mode has no write tools at all, so anything touched here means the
    // route did not actually restrict what it claimed to restrict.
    touchedNothingBut(),
  ],
};

const autoRoutesEditToBuild: GoldenTask = {
  id: "auto-route-build",
  intent: "Auto sends a small concrete change to build, even phrased as a question.",
  prompt: "can you add a trailing newline and a // TODO: tests comment to the end of src/retry.ts?",
  mode: "auto",
  tags: ["router", "auto-mode"],
  fixture: {
    "src/retry.ts": "export const retries = 3;\n",
  },
  budget: { maxToolCalls: 10, maxDurationMs: 150_000 },
  assertions: [
    // Grammar lies: this is phrased as a question and is a change.
    routedTo("build"),
    fileContains("src/retry.ts", "TODO: tests"),
    touchedNothingBut("src/retry.ts"),
  ],
};

const autoRoutesFeatureToPlan: GoldenTask = {
  id: "auto-route-plan",
  intent: "Auto sends ordered multi-file work to plan, and the plan decomposes it.",
  prompt:
    "Add a settings page, a header link to it, and a theme provider that both read from, " +
    "wired together so the header link works.",
  mode: "auto",
  tags: ["router", "auto-mode", "plan-mode"],
  budget: { maxToolCalls: 40, maxDurationMs: 300_000 },
  assertions: [
    routedTo("plan"),
    planHasAtLeast(3),
    advisory(statedAssumptions(1)),
  ],
};

// ─── 7. File placement ─────────────────────────────────────────
//
// The failure this exists to catch: asked for an app, the agent wrote
// chess.html, poker.tsx and notesapp.html into the workspace root next to
// package.json — in one case alongside the chess-app/ directory that already
// existed. This repo carried that litter until it was cleaned out.
//
// The fixture matters as much as the prompt. It establishes that this repo
// puts apps under apps/, so "put it beside its own kind" has something to
// find. A placement rule with nothing to look at is just a preference.

const buildPlacesFilesSensibly: GoldenTask = {
  id: "build-file-placement",
  intent: "A new app goes in a directory of its own, not loose in the workspace root.",
  prompt: "Build me a tic tac toe game I can open in a browser.",
  mode: "build",
  tags: ["placement"],
  fixture: {
    "package.json": '{\n  "name": "fixture",\n  "private": true\n}\n',
    "apps/snake/index.html": "<!doctype html>\n<title>Snake</title>\n",
    "apps/snake/game.js": "// snake game\n",
  },
  budget: { maxToolCalls: 20, maxDurationMs: 240_000 },
  assertions: [
    // package.json is seeded, so an edit to it would be a real offence here
    // rather than an artifact of the fixture.
    nothingAtRoot("package.json"),
  ],
};

const buildEditsRatherThanRecreates: GoldenTask = {
  id: "build-edit-not-recreate",
  intent: "Asked to change something, the agent edits the existing file instead of making a twin.",
  prompt: "The greeting should say Hi instead of Hello.",
  mode: "build",
  tags: ["placement"],
  fixture: {
    "src/lib/greet.ts": [
      "export function greet(name: string) {",
      "  return `Hello, ${name}!`;",
      "}",
      "",
    ].join("\n"),
  },
  budget: { maxToolCalls: 12, maxDurationMs: 150_000 },
  assertions: [
    fileContains("src/lib/greet.ts", "Hi, "),
    fileLacks("src/lib/greet.ts", "Hello, "),
    // The actual point: one file changed, no near-duplicate left behind under
    // a new name for the two to disagree.
    touchedNothingBut("src/lib/greet.ts"),
  ],
};

// ─── Registry ────────────────────────────────────────────────────────────────

export const ALL_TASKS: GoldenTask[] = [
  buildCreateFile,
  buildFixBug,
  planDependencyOrdering,
  planAmbiguousAssumptions,
  buildMissingTarget,
  autoRoutesGreetingToChat,
  autoRoutesQuestionToAsk,
  autoRoutesEditToBuild,
  autoRoutesFeatureToPlan,
  buildPlacesFilesSensibly,
  buildEditsRatherThanRecreates,
];

/** Filters by id or tag. `--task` and `--tag` both land here. */
export function selectTasks(opts: { id?: string; tag?: string }): GoldenTask[] {
  let out = ALL_TASKS;
  if (opts.id) out = out.filter((t) => t.id === opts.id);
  if (opts.tag) out = out.filter((t) => t.tags?.includes(opts.tag!));
  return out;
}
