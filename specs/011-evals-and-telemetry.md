# Evals, Telemetry and the Stats Sidebar — Spec Sheet

How Zizou measures itself: what the eval harness checks, how token spend is accounted for, and how both reach the chat sidebar. Every claim here is checked against source.

Supersedes [EVAL.md](./EVAL.md), which describes a harness that no longer exists.

---

## Table of Contents

1. [Why this exists](#1-why-this-exists)
2. [What the old harness could not do](#2-what-the-old-harness-could-not-do)
3. [The task contract](#3-the-task-contract)
4. [The assertion library](#4-the-assertion-library)
5. [The run journal](#5-the-run-journal)
6. [The telemetry ledger](#6-the-telemetry-ledger)
7. [Pricing, and refusing to guess](#7-pricing-and-refusing-to-guess)
8. [The sidebar](#8-the-sidebar)
9. [Running the suite](#9-running-the-suite)
9a. [Running it from inside the chat](#9a-running-it-from-inside-the-chat)
10. [Getting the most out of it](#10-getting-the-most-out-of-it)
11. [Known limitations](#11-known-limitations)

---

## 1. Why this exists

Zizou talks to six providers and roughly twenty models. Two questions follow, and neither can be answered by reading the code:

1. **Did this change break the agent?** Not "does it look right in one session" — did the thing it was supposed to do actually happen on disk.
2. **Which model should a user run, and what will it cost them?** A model that passes every task in 3 tool calls for $0.004 is not the same product as one that passes in 14 for $0.40, and pass rate alone cannot tell them apart.

The harness answers the first. The telemetry ledger answers the second. The sidebar puts both in front of the user at the moment they matter — while they are deciding whether to trust a model with their codebase.

> [!IMPORTANT]
> **Observability is not determinism.** None of this makes an LLM produce the same output twice. What it does is make the variation *measurable*: pass rate over N runs, cost spread, how often the model needed the fallback parser. The honest claim to a user is "auditable and benchmarked", never "deterministic".

The one rule that outranks everything else here: **assertions are code-executed, never LLM-judged.** An eval whose grader is itself a sampled model cannot tell you whether the agent regressed or the grader drifted.

---

## 2. What the old harness could not do

The previous `GoldenTask` carried a single `expectedCheck(workspaceDir)` returning `{ passed, detail }`. One function, one boolean, one string. Three limits followed from that shape.

| Limit | Consequence |
|---|---|
| **Short-circuits on first failure** | Every task hand-rolled an if/return ladder. You learned `hello.txt was not created` and nothing about the four other conditions the task cared about. |
| **No fixtures** | The runner made an empty temp dir, so a task needing a starting codebase had to write those files inside its own check — or leave them behind. Three `temp-workspaces/` directories were committed to the repo this way. |
| **Pass/fail is the only output** | A model passing in 3 steps for $0.001 scored identically to one passing in 28 steps for $0.40 after nine failed tool calls. That difference is the entire point of comparing models. |

| Old | New |
|---|---|
| `evals/checks/` — three bare `boolean` predicates | [`evals/assertions/`](../evals/assertions/index.ts) — named, self-explaining results |
| `evals/golden-tasks/` — one file per task, 40–90 lines each | [`evals/tasks/index.ts`](../evals/tasks/index.ts) — ~15 lines per task |
| `expectedCheck` | `assertions: Assertion[]`, all run |
| empty workspace | `fixture: Record<path, contents>` |
| pass/fail | + steps, tool calls, failures, fallback parses, tokens, cost, duration |
| one provider per invocation | `--matrix anthropic:balanced,groq:fast` |
| trace deleted with the workspace | run journal, kept on failure |

A bug fell out of the rewrite worth recording: `checks/bash-succeeds.ts` hardcoded `spawn("cmd", ["/c", …])` on Windows, and bare `cmd` does not always resolve — under Bun it fails with `Executable not found in $PATH: "cmd"`. That surfaced as a non-zero exit, which the boolean check reported as a plain `false`. **Every command-based assertion would have failed, and the report would have blamed the model.** The replacement uses `shell: true` and lets the runtime pick the interpreter.

---

## 3. The task contract

Defined in [evals/types.ts](../evals/types.ts).

```ts
export interface GoldenTask {
  id: string;
  intent: string;              // one line, shows up in the report
  prompt: string;
  mode: Mode;                  // "auto" lets the router choose — see below
  fixture?: Record<string, string>;
  assertions: Assertion[];     // ALL run; all results reported
  budget?: {
    maxSteps?: number;
    maxToolCalls?: number;
    maxDurationMs?: number;
    maxTotalTokens?: number;
  };
  repeat?: number;             // >1 gives a pass rate, not a boolean
  tags?: string[];
}
```

`mode: "auto"` is the only way to eval the router itself — it skips the pin and lets the classification call run. Pair it with `routedTo()`. Every other value pins that route and skips classification entirely.

A task passes when **every non-advisory assertion passes** and no budget is exceeded. Budget is checked last, so a run that produced the right answer but blew its ceiling fails with a `budget` category rather than reading as a pass.

### The current suite

Eleven tasks in [evals/tasks/index.ts](../evals/tasks/index.ts):

| id | tags | what it protects |
|---|---|---|
| `build-create-file` | `smoke` `tool-calling` | The fastest possible canary. If this fails, tool-calling itself broke. |
| `build-fix-off-by-one` | `editing` `precision` | Fix a seeded bug without collateral damage. |
| `plan-dependency-ordering` | `plan-mode` `multi-file` | The planner builds a dependency before its consumer. |
| `plan-ambiguous-assumptions` | `plan-mode` `ambiguity` | An underspecified prompt still yields a runnable plan with stated assumptions. |
| `build-edit-missing-file` | `error-handling` | Asked to edit a file that is not there, recover or fail visibly — never report success having done nothing. |
| `auto-route-chat` | `router` `auto-mode` | A bare greeting goes to chat and writes nothing. |
| `auto-route-ask` | `router` `auto-mode` | A codebase question goes to ask, which reads but never writes. |
| `auto-route-build` | `router` `auto-mode` | A small concrete change goes to build *even phrased as a question*. |
| `auto-route-plan` | `router` `auto-mode` `plan-mode` | Ordered multi-file work goes to plan and decomposes. |
| `build-file-placement` | `placement` | A new app lands in its own directory, not loose in the root. |
| `build-edit-not-recreate` | `placement` | Asked to change something, edit the file rather than making a twin. |

### Design rules

- **Prefer a fixture to self-setup.** A task that creates its own starting files and then fixes them cannot tell you which half failed.
- **Assert on the process, not only the end state.** `touchedNothingBut` catches "right answer, wrecked three other files", which no content check can see.
- **Pin the specification.** If a test file defines correctness, assert it was not edited — otherwise passing by rewriting the test counts as a pass. `build-fix-off-by-one` does this with `fileContains("test.js", "sum([1, 2, 3]), 6")`.
- **Budgets generous but real.** Loose enough that slow-but-correct passes; tight enough that a model looping to the step cap does not.
- **If you need a model to grade it, the prompt is too vague.** Tighten the prompt until code can settle it.

---

## 4. The assertion library

[evals/assertions/index.ts](../evals/assertions/index.ts). An assertion *is* the reportable result — it names itself and explains what it found whether it passed or failed.

```ts
export type Assertion = (ctx: AssertionContext) => Promise<AssertionResult>;

interface AssertionContext {
  workspaceDir: string;   // the disposable workspace
  totals: RunTotals;      // journal totals
  events: Array<Record<string, any>>;  // parsed journal .jsonl
}
```

| Group | Assertions |
|---|---|
| Filesystem | `fileExists` `fileAbsent` `fileMatches` `fileContains` `fileLacks` |
| Behaviour | `commandSucceeds` `commandFails` |
| About the run | `touchedFiles` `touchedNothingBut` `nothingAtRoot` `noToolFailures` `noFallbackParsing` `planHasAtLeast` `statedAssumptions` `allStepsVerified` `routedTo` |
| Combinators | `anyOf` `not` `advisory` |

Two that carry more weight than their size suggests:

**`noFallbackParsing()`** — advisory by default. Measures whether the model used native tool-calling or had to be rescued by [`fallback-tool-parse.ts`](../src/agent/fallback-tool-parse.ts). It is the sharpest quality signal between frontier and small local models, and it is invisible in a pass rate. Advisory because failing every small model on it would just mark them all red without informing.

**`anyOf()`** — a task list is an AND, but some correct behaviours are genuinely a disjunction. Asked to edit a missing file, an agent may create it or refuse, and both are right. The old harness expressed this by hand-coding the or-branch inside one check, which is how `plan-mode-deliberate-failure` grew a 60-line function with three nested try/catch blocks and two different notions of passing.

---

## 5. The run journal

[src/agent/debug/run-journal.ts](../src/agent/debug/run-journal.ts). Writes two files per run from one event stream: `<runId>.log` for humans, `<runId>.jsonl` for the scorer.

It replaced **both** predecessors. `TurnLogger` was a class of eighteen methods whose bodies were all `// Silenced`. `SessionLogger` worked but was unreadable: it dumped the ~3.7k-token system prompt on every step, re-logged each tool call from the event stream without the diff it caused, and wrote the whole message history again at the end. See [002-debug.md](./002-debug.md) for the full post-mortem and the current event list.

Three properties matter:

1. **Tool calls are paired.** A call and its result are one event with a duration and an ok/failed verdict, so "which calls failed" is a filter rather than a manual scan for a matching id.
2. **File names are resolved.** Every path is recorded as the model wrote it *and* absolute, because "wrote to src/app.ts" is useless when the disagreement is about which directory that was.
3. **Diffs are ground truth.** `journal.wrapTools()` snapshots the filesystem around `execute()`, so the log records what landed, not what the arguments claimed.

That third point is the load-bearing one. A `writeFile` call whose `contents` argument is 400 lines tells you nothing — the tool may have been denied at the confirm prompt, hit a permission error, or resolved its path somewhere unexpected. The journal's test suite pins this: a tool returning `{ success: true }` without writing records **no file change**.

```
  TOOL OK    editFile  (1ms)
  FILE MODIFIED: calc.js  (+1 -1)
       @@ -1,6 +1,6 @@
       -  for(let i=0;i<n.length-1;i++){
       +  for(let i=0;i<n.length;i++){

  TOOL FAIL  editFile  (0ms)
  output: { "success": false, "error": "NO_MATCH: old_string not found" }
  FILES: no filesystem change observed.
```

`runBash` cannot have its targets named from its arguments, so the journal re-checks every path it has already seen and **states in the log that coverage is partial** rather than implying an empty result means nothing changed.

Interactive sessions write to `.zizou/journal/`. Off by default — the journal records file contents, and a tool that silently writes the user's source into a log on every run is not something to opt them into:

```bash
ZIZOU_DEBUG=1        # events, tool calls, real file diffs
ZIZOU_DEBUG=prompts  # the above, plus every prompt verbatim
```

The second level is separate precisely because recording prompts unconditionally is what made `SessionLogger` unusable.

---

## 6. The telemetry ledger

[src/telemetry/usage.ts](../src/telemetry/usage.ts). **This is the section to read if you only read one.**

Zizou makes model calls from four places:

| Call site | Role | When |
|---|---|---|
| [`router.ts:356`](../src/agent/router.ts) | `router` | every auto-mode turn |
| [`planner.ts:271`](../src/agent/planner.ts) | `planner` | every plan-mode turn |
| [`run-turn.ts`](../src/agent/run-turn.ts) | `executor` / `chat` | the agent loop |
| [`verifier.ts:482`](../src/agent/verifier.ts) | `verifier` | **once per step** |

Before the ledger, only the executor's usage reached the UI — `Chat.tsx` accumulated `usageEntries` from the agent `finish` event and nothing else. So the cost readout omitted the router call, the planner call, and one verifier call per step. On a ten-step plan that is twelve invisible calls against one counted loop.

`telemetry.test.ts` pins the size of the gap: on a **single-step** plan the old accounting missed **45%** of the session's tokens. The shortfall grows with step count.

```ts
recordUsage({ role, provider, modelId, usage });   // explicit provider
recordModelUsage(role, model, usage);              // duck-typed from the SDK model
```

`recordModelUsage` exists because the planner and verifier are forbidden by their layer rules from importing `config/` to ask which provider produced their model. Both fields are on the model object; it strips the SDK's `"anthropic.messages"` suffix down to the vendor segment that pricing expects.

The ledger is process-wide, like the journal's active slot, and for the same reason: one interactive session runs at a time, and threading an accumulator through router → planner → executor → verifier would be noise at every layer. Unlike the journal it *is* read back, so the eval harness calls `resetUsage()` per run — without it, every run would inherit the previous one's tokens and the per-task cost column would climb monotonically across the suite.

> [!NOTE]
> Adding a fifth call site cannot silently un-count itself. The call records usage or it does not appear at all, and "missing" is visible in the sidebar as a role with zero calls.

---

## 7. Pricing, and refusing to guess

[src/telemetry/pricing.ts](../src/telemetry/pricing.ts).

The old table in `src/tui/cost-tracker.ts` ended with:

```ts
"default": { input: 1.0, output: 5.0 },
```

…and fell through to it for any unrecognised model. Two problems compounded:

1. It is a made-up number rendered in the same `$0.0421` format as a real one, with nothing to tell them apart.
2. Almost nothing the effort dial selects was in the table. `EFFORT_MODELS` picks `claude-sonnet-4-5`, `gpt-5-mini`, `gemini-2.5-pro`; the table knew `claude-3-5-sonnet-latest` and `gpt-4o`. **The default was not a rare fallback — it was the common path.** The displayed cost was usually fiction.

Now a missing rate returns `null` and every surface renders `unknown`. A gap you can see is worth more than a number you cannot trust.

Three correctness details:

- **Reasoning tokens bill as output** on every provider that exposes them. Counting them as input understates a reasoning model by enough to change which model looks cheaper.
- **Cached input bills at a discount** where offered — roughly a tenth on Anthropic. Counting it as fresh input overstates a long cached session.
- **Local providers cost exactly zero**, decided by provider rather than model id, because Ollama ids are whatever the user pulled.

The guard against this rotting again is a test, not a convention:

```ts
test("every model the effort dial can select has a known rate", () => { … });
```

A new model in `EFFORT_MODELS` fails the build until someone looks up what it costs. **Do not delete that test.** Rates are hand-maintained and go stale silently; `asOf` on each entry records when it was last checked.

---

## 8. The sidebar

[src/ui/SidebarStats.tsx](../src/ui/SidebarStats.tsx). Two panels in the chat's right column, visible at terminal width ≥ 90.

```
Tokens                        Evals
in              12.4k         pass         83% (2/3)
out              1.7k         tools/task   6.3
cached           8.1k         $/task       $0.0031
context      11% of 128k      fallbacks    2
                              failing: build-fix-off-by-one
cost          $0.0412         c7ee198 (stale) · 1d ago
calls               14

by stage
route ×1          510
plan ×1          4.6k
build ×9        12.1k
verify ×3        2.9k
```

**Tokens** subscribes to the ledger live rather than recomputing per turn — the planner and verifier calls land *between* turns, and a figure that only moved on Enter would hide exactly the spend the panel was added for. The `by stage` rows exist because that breakdown was previously invisible.

**Evals** reads the newest `evals/reports/*.json` via [eval-report.ts](../src/telemetry/eval-report.ts) and shows the row for the model actually in use.

Neither panel invents a number:

| Condition | Renders |
|---|---|
| model has no rate | `unknown`, plus `no rate for this model` |
| some calls unpriced | `>$0.0412` — a floor, marked as such |
| suite never run | `never run` + `bun run eval`, not `0%` |
| model not in the report | `<model> not benchmarked` + which models are |
| report predates HEAD | `(stale)` |
| suite reported an integrity violation | `integrity violation` in red |

The UI reads the report as a **file format** and owns defensive parse types rather than importing from `evals/`. The harness imports half the agent to run tasks; pulling that graph into the TUI would mean the chat interface could not start if the eval harness failed to compile. A malformed report yields `null`, not a throw into a render.

---

## 9. Running the suite

```bash
bun run eval                                           # default provider, balanced
bun run eval -- --task build-create-file               # one task
bun run eval -- --tag router                           # one tag
bun run eval -- --provider groq --effort fast
bun run eval -- --matrix anthropic:balanced,groq:fast --repeat 3
bun run eval -- --keep-workspaces                      # keep passing runs' files
bun run eval -- --pause 20                             # seconds between runs
```

Exit code is 0 only when every run passed **and** the project directory was untouched.

| Path | What it is |
|---|---|
| `evals/.artifacts/<runId>/<runId>.log` | Human journal for one run. Open this when a run fails. |
| `evals/.artifacts/<runId>/<runId>.jsonl` | Same events, machine-readable. |
| `evals/.artifacts/<runId>/workspace/` | The disposable workspace. Kept only on failure. |
| `evals/reports/<sha>.md` | Committed comparison table. |
| `evals/reports/<sha>-<ts>.json` | Full raw results. The sidebar reads this. |

Artifacts are gitignored; **reports are not**. A benchmark claim that lives only in a terminal scrollback cannot be reviewed in a diff, and CI cannot gate on it.

### Safety invariant

Every run gets a fresh directory under `evals/.artifacts/`. The project directory is never used as a workspace, and the suite verifies `src/` and `package.json` were untouched before exiting. If that tripwire fires, a tool resolved a path wrongly — **treat it as a bug in the tool, not in the eval**, and treat every other number in that report as suspect.

---

## 9a. Running it from inside the chat

[src/commands/evals.ts](../src/commands/evals.ts) exposes both suites as slash commands, so checking the agent does not mean leaving it.

```
/evals                    every task, current provider
/evals smoke              one tag
/evals build-create-file   one task
/evals report             the last report, without running anything
/evals matrix groq:fast,anthropic:balanced
/evals --repeat 3
/evals help

/test                     bun test over src/ and evals/
/test src/telemetry       one path
```

A bare word is read as a tag when it is one and a task id otherwise, because `/evals smoke` is nicer to type than `/evals --tag smoke`.

**These run as a child process, not an import.** Two reasons, both fatal to the import approach:

1. The harness calls `process.chdir()` into each throwaway workspace. The TUI shares that process, so importing it would move the chat's working directory out from under it and every relative path the user then typed would resolve somewhere else.
2. The harness calls `process.exit()` when it finishes, which would take the chat down with it.

Progress is appended as selected summary lines rather than streamed verbatim — a full suite prints hundreds of lines and would push the conversation off screen for minutes. The full text is on disk.

`/evals report` spawns nothing, so it is free and instant. `/evals` is not: it calls the provider and spends tokens, and the help text says so.

---

## 10. Getting the most out of it

### Before a release: the regression gate

```bash
bun run eval -- --repeat 3
```

Three runs per task converts flaky into visible. A task at 67% is not passing; it is failing a third of the time and the single-run suite would have shown you a coin flip. Commit `evals/reports/<sha>.md` with the release.

### After touching the agent loop: the targeted check

Match the tag to what you changed — this is the whole reason tags exist.

| Changed | Run |
|---|---|
| `router.ts`, routing prompts | `--tag router` |
| `planner.ts`, plan gate | `--tag plan-mode` |
| `edit-file.ts`, `write-file.ts` | `--tag editing` |
| system prompt, file conventions | `--tag placement` |
| tool map, `fallback-tool-parse.ts` | `--tag smoke` |

A tagged run is a minute and a few cents. The full matrix is neither.

### Choosing a default model: the matrix

```bash
bun run eval -- --matrix anthropic:balanced,openai:balanced,groq:balanced,ollama:balanced --repeat 3
```

Read the report's columns in this order:

1. **`pass`** — below ~80% the model is not a candidate, whatever it costs.
2. **`$/pass`** — not `$/run`. Cost per run prices the successes; cost per pass prices the failures in too, which is what you actually pay when a cheap model needs three attempts.
3. **`fallback`** — non-zero means the model is failing at native tool-calling and being rescued by the text parser. It predicts frustration that a pass rate does not.
4. **`tools/run`** — two models both passing at 4 versus 12 tool calls are not the same experience. This is latency and context burn.

### Diagnosing one failure

The report names the category. Go there directly:

| Category | Means | Look at |
|---|---|---|
| `assertion` | did the wrong thing | every failed assertion is listed with what it found |
| `budget` | right answer, too expensive | `toolCalls` in the journal — usually a retry loop |
| `exception` | crashed | the journal's `error` event, with stack |
| `rate-limit` | provider refused | not a quality signal; re-run with `--pause 20` |

Then open `<runId>.log` and read forward. The diffs are ground truth, so a tool that claimed success and changed nothing is visible as `FILES: no filesystem change observed`.

### Adding a task when you fix a bug

The highest-value habit here. When you fix an agent bug, the fix is one commit and the task that would have caught it is ten lines. `build-edit-not-recreate` and `build-file-placement` both exist because the agent did those things wrong in a real session.

Write the task so it **fails before your fix**. A task that passes on both sides of the fix is testing nothing.

### Watching cost without running anything

The sidebar's `by stage` breakdown answers questions the report cannot:

- `plan` large relative to `build` → the planner is over-exploring. Lower `maxSteps` in `EFFORT_PROFILES`.
- `verify` large → verification is running on steps that do not need it.
- `route` non-zero on a pinned mode → a routing call is happening that should not be.
- `cached` climbing → prompt caching is working; a long session is getting cheaper per turn, not more expensive.

---

## 11. Known limitations

1. **`runBash` coverage is partial.** The journal can only re-check paths it has already seen, so a bash command touching a file the run never otherwise referenced goes unrecorded. The log says so rather than implying full coverage.
2. **Rates go stale silently.** The coverage test proves a rate *exists*, never that it is *current*. `asOf` records when each was last checked; verify against the provider before trusting a figure for anything that matters.
3. **Assertion quality is not assertable.** `statedAssumptions()` counts that assumptions were made, never whether they were wise. Judging that needs a model, and assertions may not call one.
4. **The router tasks are probabilistic by nature.** Classification is a sampled call. Run them with `--repeat 3` or the result is a coin flip reported as a fact.
5. **Local models will look bad, correctly.** A 4B model at 25% pass with 60% fallback parses is a real measurement, not a broken harness. See [010-sft-dataset.md](./010-sft-dataset.md) for the work aimed at that.
6. **No live CI wiring yet.** The suite exits non-zero and writes a committed report, so gating is mechanically possible, but nothing runs it automatically.
