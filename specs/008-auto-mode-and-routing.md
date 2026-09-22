# Auto Mode, Routing & Scope Control — Deep Dive

Supersedes the mode sections of [007-modes-tools-context.md](./007-modes-tools-context.md), which describes two modes, three context budgets, three reasoning levels, a clarifier stage and build→plan escalation. None of those exist any more.

Every claim below links to source.

> [!TIP]
> **New here?** Read [012-how-the-router-works.md](./012-how-the-router-works.md) first — the same system in plain English, with examples. This document is the implementation reference.

---

## Table of Contents

1. [What Changed and Why](#what-changed-and-why)
2. [Modes vs Routes](#modes-vs-routes)
3. [The Router](#the-router)
4. [The Four Routes](#the-four-routes)
5. [Tool Availability Per Route](#tool-availability-per-route)
6. [The Plan Gate](#the-plan-gate)
7. [Scope Control](#scope-control)
8. [File Placement](#file-placement)
9. [Cancellation](#cancellation)
10. [Model Resolution](#model-resolution)
11. [Session Log Restore](#session-log-restore)
12. [Flow State](#flow-state)
13. [Failure Modes and Their Handling](#failure-modes-and-their-handling)
14. [Test Coverage](#test-coverage)

---

## What Changed and Why

| Before | After |
|---|---|
| User picks the mode; `build` is the default | `auto` is the default; a classifier picks per prompt |
| Three modes: chat, build, plan | Five pinned modes, four executable routes |
| A codebase question ran in build mode, with write tools | New read-only `ask` route |
| `disableTools: boolean` — tools all-or-nothing | `toolMode: "full" \| "readonly" \| "none"` |
| Plan gate accepted `y`/`n` only | Gate takes `y`/`n`/`b`/`a`, and free text as a **correction** |
| Plan mode never saw the conversation | History reaches the planner and every step |
| No way to stop a run but Ctrl+C | `Esc` aborts at the provider |
| Displayed model ≠ called model for 3 of 6 providers | One resolution path for display and runtime |
| Persisted log `JSON.parse`d and cast | Validated and repaired on restore |
| Router judged size only | Judges size **and** how specified the request is |

---

## Modes vs Routes

[mode.ts L75-L84](../src/agent/mode.ts#L75-L84):

```typescript
export type Mode  = "auto" | "chat" | "ask" | "build" | "plan";
export type Route = Exclude<Mode, "auto">;
export const MODES: Mode[] = ["auto", "chat", "ask", "build", "plan"];
```

A **mode** is what the user pins. A **route** is what executes. `auto` is the only mode that is not a route — it defers the decision, and `Route` excludes it so no switch statement carries an unreachable branch.

`resolveMode()` stays a pure flag check with no heuristics. The classifier runs later, in the orchestrator, and **only** when this returns `auto`:

| Flag | Mode | | Slash command | Mode |
|---|---|---|---|---|
| *(none)* | `auto` | | `/auto` | `auto` |
| `--auto` | `auto` | | `/chat` | `chat` |
| `--chat` | `chat` | | `/ask` | `ask` |
| `--ask` | `ask` | | `/build` | `build` |
| `--build` | `build` | | `/plan` | `plan` |
| `--plan`, `zizou plan "…"` | `plan` | | | |

---

## The Router

[router.ts](../src/agent/router.ts). One `generateText` call, no tools, returning:

```typescript
interface RouteDecision {
  route: Route;
  confidence: number;            // 0..1
  reason: string;                // shown in the UI
  source: "llm" | "fallback";
}
```

### Tuning

| Constant | Value | Why |
|---|---|---|
| `ROUTER_TIMEOUT_MS` | `12_000` | Measured 2.6–4.3s on gpt-5-mini. The first value, 5s, sat *inside* that range, so ordinary calls raced their own timeout. |
| `ROUTER_MAX_TOKENS` | `800` | The answer is ~30 tokens, but **reasoning models draw reasoning tokens from this same budget**. At 150 the measured result was 128 reasoning / 0 text / `finishReason: "length"` / empty string — every prompt silently took the fallback. |
| `LOW_CONFIDENCE` | `0.4` | Below this the label is a guess; see the policy below. |
| `HISTORY_TURNS` / `HISTORY_CHARS` | `3` / `600` | Enough to resolve "now add tests for it". |

No `temperature` is sent: reasoning models reject it outright, and a four-way label choice is not where sampling matters.

### Cost

**The router is only constructed in auto mode.** A pinned mode never imports it, never calls it, never pays for it — verified by observing zero `route-decided` events for pinned `build`, `chat` and `ask`. This is the direct answer to the objection [mode.ts](../src/agent/mode.ts) used to record against upfront classification.

### Confidence policy

Uncertainty resolves toward the **recoverable** mistake, which is why the two rules point in opposite directions:

| Low-confidence route | Becomes | Reasoning |
|---|---|---|
| `plan` | `build` | A wrong plan costs a planning round trip and a gate to decline. A wrong build costs one undoable step. |
| `chat` | `ask` | A wrong chat answers a real question from nothing. A wrong ask reads a few files it did not need. |

### Fallback

Any failure — timeout, API error, unparseable JSON, an invented route string — returns a deterministic decision. `routePrompt` **never throws and never blocks a turn**:

```typescript
fallbackRoute(prompt, reason) // → isConversational(prompt) ? "chat" : "build"
```

`isConversational` is the old greeting regex, moved out of the orchestrator where it used to fire on *every* turn and hijack even a pinned build mode. It now has exactly one job: answering "what would we have picked without an LLM?"

### Routing is decided once

`resolveRoute()` in [orchestrator.ts](../src/agent/orchestrator.ts) is the only caller. Three rules:

1. **Mid-flow re-entries never re-route.** Approving or correcting a plan continues the turn already in progress.
2. **A pinned mode passes straight through.**
3. **Auto asks the router**, which always answers.

The decision is never revisited inside a turn. Mid-turn switching is what build→plan escalation did, and it was removed for interrupting ordinary turns and discarding work already on disk.

---

## The Four Routes

| Route | Badge | Purpose | Executor | Verifier | Checkpoint |
|---|---|---|---|---|---|
| `chat` | `○ Chat` | Greetings, small talk | — | — | — |
| `ask` | `? Ask` | Questions about the codebase | — | — | — |
| `build` | `● Build` | One concrete action | ✓ | ✓ | ✓ |
| `plan` | `◆ Plan` | Ordered multi-file work | ✓ per step | ✓ per step | ✓ per step |

`ask` has no verifier or checkpoint because nothing changed on disk — there is nothing to snapshot, verify or undo.

### Classifier criteria

The split is **understand vs. do**, not *changes code vs. doesn't*. That distinction matters: framing `build` as "a change to the codebase" left `open it` and `run the tests` belonging to neither bucket, and the classifier picked `ask`.

- `chat` — greeting, thanks, a question about Zizou itself.
- `ask` — the user wants to **understand**. The reply is what they wanted.
- `build` — the user wants an **action**. Includes actions that change no code: opening a file, running a script, starting a server, installing a package.
- `plan` — see the two triggers below.

> Grammar lies. *"can you add a dark mode toggle"* is phrased as a question and is a build. *"should I be using useEffect here"* is phrased as a question and is an ask.

### Two axes, not one

The classifier judges **size** and **specification** separately. It originally judged only size, and that was the gap:

| Trigger | Condition | Example |
|---|---|---|
| **(a) Size** | Multi-file, ordered steps, order matters | *"migrate us from express to fastify"* |
| **(b) Open decisions** | Creating something NEW whose behaviour is unstated — **even one file** | *"create a new todoapp.html"* |

`create a new todoapp.html` is a single file, so a size-only classifier called it a build — and the agent silently invented storage, editing, filtering and styling, then wrote 200 lines of them. The user saw the decisions only by reading the finished file.

Plan mode's `assumptions` array plus the gate is precisely the machinery for that case. A guess caught at the gate costs one line of typing; the same guess caught after execution costs the whole file.

**(b) is about creating something underspecified — not about the word "create", and not about brevity.** The discriminating pair, both single-file creates:

| Prompt | Specified? | Route |
|---|---|---|
| `create hello.txt containing exactly: hi` | yes — contents given | `build` |
| `create a new todoapp.html` | no — an artifact named, nothing more | `plan` |

Locked in by the paired evals `auto-route-build-specified` / `auto-route-plan-underspecified`. Either alone would pass a naive "route anything saying *create* to plan" rule; together they do not.

---

## Tool Availability Per Route

[run-turn.ts L72](../src/agent/run-turn.ts#L72) — `toolMode` replaced a `disableTools` boolean, which could only express "everything" or "nothing". That two-state flag is precisely why a codebase question had to choose between guessing and full write access.

| Route | `toolMode` | Tools |
|---|---|---|
| pinned `/chat` | `none` | *(none — `tools: undefined`)* |
| auto → `chat` | `readonly` | readFile, glob, grep, listDir, openFile |
| `ask` | `readonly` | readFile, glob, grep, listDir, openFile |
| `build`, `plan` step | `full` | all 13 |
| **planner** | *(own map)* | readFile, glob, grep, listDir |

`"none"` passes `tools: undefined`, which is genuinely different from an empty map — the model is never told tools exist.

### Why auto → chat keeps tools

The router is guessing. A "chat" guess that turns out to need a file (*"hey, is this repo on React 19?"*) should read it rather than invent an answer. Read-only tools cannot touch disk, so the mode's real promise still holds. A **pinned** `/chat` means "just talk" and stays the one zero-tool path.

### Why openFile is opt-in

[tools/index.ts](../src/tools/index.ts) — `buildReadOnlyToolMap({ canOpen })`. `openFile` launches the OS viewer and cannot modify the filesystem, so it is read-only by this map's definition. But *"changes nothing"* and *"appropriate here"* are different questions:

- **The planner must not have it.** Its contract is to describe work rather than begin it; a planner that opens a browser has begun.
- **ask and chat do get it.** Without it, a user who says "open it" gets the file's contents pasted into the terminal instead.

---

## The Plan Gate

A routed plan must never execute unreviewed. The gate shows the route reason, the assumptions, and **every file each step will touch**, marked `+` (new) or `~` (existing) — computed with `existsSync` against `projectRoot`.

Those markers are the point: *"it is about to create `game.html` at the repo root"* becomes visible **before** approval, while a correction still costs one line of typing.

| Input | Action |
|---|---|
| `y` / `yes` / `continue` | Execute |
| `n` / `no` / `cancel` | Cancel; nothing written |
| `b` / `build` | Re-run the original prompt as a single build step |
| `a` / `ask` | Answer the original prompt instead |
| **anything else** | **A correction** — re-plan with it, re-gate |

Free text is a correction, not a rejection. The gate previously took `y`/`n` only, so fixing one wrong destination directory meant cancelling and retyping the whole request.

A correction carries [`PlanRevision`](../src/agent/types.ts) — the previous steps, the previous assumptions, and the feedback verbatim. Showing the previous plan matters: without it the model re-derives everything from the prompt and the correction has nothing to attach to, so a note about one step's destination silently rewrites all of them.

`plan-revision-requested` keeps `isAwaitingPlanApproval` true, so a keystroke during regeneration is not read as a new prompt.

---

## Scope Control

### The planner sees the conversation

`runOrchestrator` did not pass `history` to `runPlanMode`, and `runPlanMode` did not pass `conversationHistory` to `executeStep` — though build mode did, and the field is documented *"so the step prompt can resolve 'that file' / 'it'"*.

The planner therefore received referring expressions with no antecedent. Measured, same prompt (*"the layout is very bad and the pieces are not working well"*), same repo, after the user had opened a chess file:

| | `targetFiles` |
|---|---|
| without history | `src/ui/App.tsx, src/ui/Chat.tsx, src/ui/App.tsx` |
| with history | `achess.html, achess.html` |

Without a subject the planner went looking for one, found the repo it was standing in, and planned a redesign of Zizou's own TUI.

History now reaches [`plan()`](../src/agent/planner.ts) and every `executeStep`. Capped at `HISTORY_TURNS = 6` / `HISTORY_CHARS = 1500` — the planner needs the *subject*, not a transcript.

### The planner is told to stay in scope

`PLANNER_INSTRUCTIONS` gained a `STAY INSIDE THE REQUEST` block:

- The subject is what the user just mentioned — not the surrounding repository.
- Tidying directory layout, renaming unrelated files, reorganising docs, adding test folders, centralising config are **not in scope** unless asked for.
- A step not traceable to the request is dropped.
- **No look-only steps.** *"Analyze the current X"* is not a step; it is what the read-only tools are for, before the plan is written.

### Scope hint (build only)

`FILE_THRESHOLD = 3`. A build step touching more files emits one advisory line. It does not prompt, block or restart — the work is already on disk.

---

## File Placement

Three changes, most to least leverage.

**The session context was teaching root-dumping.** It offered `index.html` at the root as its example of a relative path, so the one concrete placement example the model saw was the wrong one. Replaced with binding `FILE PLACEMENT` rules: look first, put new files beside their own kind, root is for root-by-convention files (README, package.json, tsconfig), a multi-file artifact gets its own directory, and **ZIZOU.md layout wins over all of it**.

Ordering matters — the rules end by deferring to "PROJECT CONVENTIONS below", so the conventions must actually be below them. There is [a test](../src/context/build-system-prompt.test.ts) asserting that.

**Edit, don't recreate.** `EXECUTOR_INSTRUCTIONS` gained an `EDIT, DON'T RECREATE` block, backed by a mechanical signal in [write-file.ts](../src/tools/write-file.ts): creating a *new* file globs for same-basename siblings and appends them to the confirmation line. Advisory — a similarly-named file is evidence, not proof.

**ZIZOU.md gained a `## Layout` section** in the `/init` template, so there is somewhere to declare conventions in the first place.

Verified: in a repo containing `apps/snake/`, *"Build me a tic tac toe game"* ran `listDir` and wrote `apps/tic-tac-toe/` rather than the root.

---

## Cancellation

**Esc stops the turn.** There was no cancel path at all; Escape only closed menus, so Ctrl+C was the only exit and it killed the session.

A real `AbortSignal` is threaded orchestrator → planner → executor → `runTurn` → `streamText`. Walking away from the generator would leave the model streaming and tools firing invisibly — **cancelling has to reach the provider**.

```
Chat.tsx  AbortController (one per turn, in a ref)
   ├─ Esc  → controller.abort()
   ├─ runOrchestrator({ abortSignal })
   │    ├─ plan({ abortSignal })          → generateText
   │    └─ executeStep({ abortSignal })   → runTurn → streamText
   └─ event loop breaks on signal.aborted, calls orchestrator.return()
```

Two details:

- **Esc is checked before the permission prompt.** That dialog is exactly where a user realises the agent is doing the wrong thing, and "deny this one write" is not "stop" — denying leaves it running, free to try something else. Esc there also resolves the pending confirmation so the aborted turn does not hang on a promise.
- **The stopped notice lives in `finally`**, not `catch`. Aborting between events breaks the loop cleanly and never throws, so a `catch`-only notice would be silent in the common case. `controller.signal.aborted` is the reliable signal — the SDK surfaces an abort as `AbortError` or `APICallError` depending on where it lands.

The spinner reads `esc to stop`. A cancel key nobody knows about is the same as no cancel key.

Verified: a "write a 3000-word essay" run aborted at 1542ms against a 1500ms timer.

---

## Model Resolution

**One resolution path for display and runtime.** `resolveAgentConfig().modelId` and `getActiveModelId()` must agree. They did not, and fell through to two different tables when nothing was pinned:

```
getActiveModelId  →  getProviderModel() ?? DEFAULT_MODELS[provider]
the runtime       →  pinned ?? modelForEffort(provider, effort)
```

| Provider | Displayed | Actually called |
|---|---|---|
| anthropic | `claude-3-5-sonnet-latest` | `claude-sonnet-4-5` |
| openai | `gpt-4o-mini` | `gpt-5-mini` |
| openrouter | `google/gemma-4-31b-it:free` | `meta-llama/llama-3.3-70b-instruct:free` |

Three of six providers displayed a model never contacted. [effort.ts](../src/config/effort.ts) documents this exact failure being fixed once on the *execution* path; it survived on the display path, where the agent works fine and only the label lies.

### Precedence

```
ZIZOU.md model  →  /model or /modelid pin  →  effort tier  →  DEFAULT_MODELS
```

An explicit pin always wins: raising effort widens the budget without silently swapping the model.

`getActiveModelId` uses the **resolved** effort (session `/effort` → ZIZOU.md → default). Using `DEFAULT_EFFORT` would reintroduce the same lie at one remove — `/effort max` would raise the model with the display never saying so.

### Ollama

Ollama has no build-time table: its catalogue is whatever the user pulled, read from the server into [local-catalog.ts](../src/config/local-catalog.ts). Both resolvers call `localModelForEffort()` — a provider whose table lives on a server is the easiest way to reopen this bug. Before the cache is primed, or with Ollama down, it returns `null` and falls through to `DEFAULT_MODELS` like everything else.

### The router honours a pin

The router normally uses the fast tier, **but an explicit pin wins**. Someone on Ollama who pulled a single model and pinned it would otherwise get a 404 on *every* auto turn — silently falling back to the greeting regex after paying the timeout each time. A working router on a pricier model beats a broken one on a cheap model that is never reached.

### Where it resolves

`resolveModel(provider, agentConfig.modelId)` is the only runtime consumer and re-resolves **per turn**, so `/model` takes effect on the very next prompt.

---

## Session Log Restore

The chat log is persisted as a JSON string. It was `JSON.parse`d and cast straight to `LogEntry[]` — a lie the type system cannot catch, because the parsed value is whatever an earlier version of Zizou wrote.

`LogEntry` has gained fields over time (`plan-display` gained `assumptions`, then `routeReason` and `projectRoot`). A session saved before a field existed restored an entry without it, the renderer read `.length` off `undefined`, and **the throw unmounted the whole Ink tree — leaving that session permanently unopenable**. Six of thirteen sessions on the development machine were carrying this.

Two layers:

1. **`parseRestoredLog`** ([commands/index.ts](../src/commands/index.ts)) validates and repairs every entry. Missing arrays become `[]`, missing strings `""`, unknown `kind`s are dropped. Never throws; an unparseable log returns `[]` and the caller rebuilds a transcript from the conversation.
2. **`LogLine` catches**, rendering `[unreadable log entry: …]` for one line rather than killing the app. Ink has no error boundary there, so it is a try/catch.

> A log entry is display history. One unreadable line is worth a dropped line, never a dead session.

---

## Flow State

[orchestrator-flow.ts](../src/ui/orchestrator-flow.ts). **`pinnedMode` and `lastRoute` are separate fields.**

They were one field, and `mode-reported` overwrote it with whatever ran. That was survivable when only a greeting regex could disagree with the pin. It is not survivable with auto: one prompt routed to `plan` would overwrite the pin with `plan`, and **the session would never route again**.

| Action | Touches `pinnedMode`? |
|---|---|
| `set-mode` | ✓ — the only one |
| `route-reported` | ✗ — sets `lastRoute` / `lastRouteReason` |
| `prompt-submitted` | ✗ — preserves it, clears `lastRoute` |

The badge renders `Auto → Build` from both: the route is what just happened, the pin is what happens next time. Showing only the route would make auto look like it silently switched the user's mode.

`currentMode` persists the **pin**, not the route. Session schema bumped to **v4**; sessions without a stored mode get `auto`, sessions with one keep it.

---

## Failure Modes and Their Handling

| Failure | Handling |
|---|---|
| Router times out / provider down | Deterministic fallback; turn continues |
| Router returns unparseable output | `parseRouteDecision` returns `null` → fallback |
| Router invents a route string | Rejected by the `VALID_ROUTES` check → fallback |
| Router low confidence | Downgraded toward the recoverable mistake |
| Router misroutes to `ask` for "open it" | `ask` has `openFile`, so it still works |
| Reasoning model eats the token budget | `ROUTER_MAX_TOKENS = 800` headroom |
| Pinned model unreachable by the fast tier | Router honours the pin |
| User stops mid-run | `Esc` → abort at provider; work on disk stays, `/undo` available |
| Persisted log from an older version | Repaired on restore; bad entries dropped |
| A log entry still unrenderable | One line shows an error; the app survives |
| Plan routed wrongly | Visible at the gate; `b` / `a` / free-text correction |
| Build step oversized | Advisory scope hint; turn completes |

---

## Test Coverage

| File | Covers |
|---|---|
| [router.test.ts](../src/agent/router.test.ts) | Parsing all four routes, fenced JSON, buried objects, invented routes, malformed metadata, confidence policy, fallback, greeting detection |
| [active-model.test.ts](../src/sdk/active-model.test.ts) | Display ≡ runtime across providers and efforts, pin precedence, Ollama catalogue path, unprimed fallback |
| [restore-log.test.ts](../src/commands/restore-log.test.ts) | Repairing pre-field entries, preserving newer fields, unparseable logs, junk dropping, unknown mode-switch values |
| [readonly-map.test.ts](../src/tools/readonly-map.test.ts) | Planner map is look-only, `canOpen` adds only `openFile`, full map is a superset |
| [orchestrator-flow.test.ts](../src/ui/orchestrator-flow.test.ts) | Auto surviving a routed turn, pin never overwritten, gate held open during revision |
| [build-system-prompt.test.ts](../src/context/build-system-prompt.test.ts) | Ask role is read-only, placement rules present, conventions ordered after them |
| [evals/tasks](../evals/tasks/index.ts) | One golden task per route (`routedTo`), plus placement (`nothingAtRoot`) and edit-don't-recreate |

`active-model.test.ts` fails 2/6 against the pre-fix code, and `restore-log.test.ts` was written against the real shapes found in session files on disk — both catch their bug rather than merely describing it.
