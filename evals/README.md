# Zizou eval harness

Measures whether the agent still works, and how the models compare on the same
tasks. Every judgement here is made by code. No assertion may call a model: an
eval whose grader is itself sampled cannot tell you whether the agent regressed
or the grader drifted.

## Running

```bash
bun run evals/run-evals.ts                                  # default provider, balanced
bun run evals/run-evals.ts --task build-create-file          # one task
bun run evals/run-evals.ts --tag plan-mode                   # by tag
bun run evals/run-evals.ts --provider groq --effort fast
bun run evals/run-evals.ts --matrix anthropic:balanced,groq:fast --repeat 3
bun run evals/run-evals.ts --keep-workspaces                 # keep passing runs' files too
```

`--matrix provider:effort,...` runs the whole suite once per cell and prints a
comparison table. That is the point of the harness — a single pass rate tells
you far less than the same tasks across three models.

Exit code is 0 only when every run passed and the project directory was
untouched.

## Output

| Path | What it is |
|---|---|
| `evals/.artifacts/<runId>/<runId>.log` | Human-readable journal for one run. Open this when a run fails. |
| `evals/.artifacts/<runId>/<runId>.jsonl` | Same events, machine-readable. The source of every metric. |
| `evals/.artifacts/<runId>/workspace/` | The disposable workspace. Kept only on failure. |
| `evals/reports/<sha>.md` | Committed comparison table. |
| `evals/reports/<sha>-<ts>.json` | Full raw results. |

Artifacts are gitignored; reports are not. A benchmark claim that lives only in
a terminal scrollback cannot be reviewed in a diff.

## Writing a task

```ts
const myTask: GoldenTask = {
  id: "build-fix-off-by-one",
  intent: "Fix an off-by-one bug in existing code without collateral damage.",
  prompt: "The sum function in calc.js misses the last element. Fix it.",
  mode: "build",
  tags: ["editing"],
  budget: { maxToolCalls: 12, maxDurationMs: 180_000 },

  // Seeds the fresh workspace before the agent starts.
  fixture: { "calc.js": "...", "test.js": "..." },

  // ALL of these run. All results are reported. Advisory ones never fail the task.
  assertions: [
    commandSucceeds("node test.js"),        // did it work?
    fileLacks("calc.js", "length - 1"),     // is the bug actually gone?
    fileContains("test.js", "sum([1,2,3])"), // did it cheat by editing the test?
    touchedNothingBut("calc.js"),           // did it break anything else?
    advisory(noToolFailures()),             // how cleanly did it get there?
  ],
};
```

Register it in `evals/tasks/index.ts`.

### Design rules

- **Prefer a fixture to self-setup.** A task that creates its own starting files
  and then fixes them cannot tell you which half failed.
- **Assert on the process, not only the end state.** `touchedNothingBut` and
  `allStepsVerified` catch "right answer, wrecked three other files", which a
  content check cannot see.
- **Pin the specification.** If a test file defines correctness, assert it was
  not edited. Otherwise passing by rewriting the test counts as a pass.
- **Budgets generous but real.** Loose enough that slow-but-correct passes,
  tight enough that a model looping to the step cap does not.
- **If you need a model to grade it, the prompt is too vague.** Tighten the
  prompt until code can settle it.

## Assertions

Filesystem: `fileExists` `fileAbsent` `fileMatches` `fileContains` `fileLacks`

Behaviour: `commandSucceeds` `commandFails`

About the run (read the journal): `touchedFiles` `touchedNothingBut`
`noToolFailures` `noFallbackParsing` `planHasAtLeast` `statedAssumptions`
`allStepsVerified`

Combinators: `anyOf` `not` `advisory`

`noFallbackParsing` is advisory by default. It measures whether the model used
native tool-calling or had to be rescued by the text parser in
`src/agent/fallback-tool-parse.ts` — the sharpest quality signal between
frontier and small local models, but not a contract violation.

## What the metrics mean

Per run, from the journal:

- `toolCalls` / `toolFailures` — how much fumbling it took
- `linesAdded` / `linesRemoved` — from ground-truth diffs, not from what the
  model claimed
- `filesTouched` — what actually changed on disk
- `fallbackParses` — times the model failed to use native tool-calling
- `duplicatesBlocked` — identical failing calls retried unchanged
- tokens, duration, estimated cost

Cost comes from the telemetry ledger (`src/telemetry/usage.ts`), not from the
run journal — the journal only sees calls that go through `runTurn`, so a
journal-derived cost would omit the router, planner and per-step verifier calls.
On a plan-mode task that is most of them.

`$/run` reads `unknown` when any call in the run used a model with no rate in
`src/telemetry/pricing.ts`. It is never defaulted to a guessed rate: a
fabricated figure next to measured ones in the same table is worse than an
admitted gap. `telemetry.test.ts` asserts that every model `EFFORT_MODELS` can
select has a rate, so `unknown` should now only appear for a model set by hand
with `/model`.

`$/pass` divides cost per run by pass rate, pricing in the failures. It is the
column that actually compares a cheap flaky model against an expensive reliable
one.

## Safety

Every run gets a fresh directory under `evals/.artifacts/`. The project
directory is never used as a workspace, and the suite checks that `src/` and
`package.json` were untouched before exiting. If that tripwire fires, a tool
resolved a path wrongly — treat it as a bug in the tool, not in the eval.
