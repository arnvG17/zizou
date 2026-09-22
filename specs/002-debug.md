# The Run Journal — Spec Sheet

Zizou's debug logging: what it records, where it writes, and why both predecessors were deleted.

The original request for this file asked for "literally every thing as it goes to the llm verbatim... also for the tool call system prompt and the agent orchestrator type — is it a planner, executor or verifier, and if yes what exactly does it use and output... in a chat type form that is easy to read... only one full session per run, named with the date and time."

That is all delivered, with one deliberate change: **verbatim prompts are behind a flag.** The reason is in §3 — recording them unconditionally is precisely what made the previous attempt unreadable, and "easy to read" was the other half of the request.

---

## Table of Contents

1. [Where it writes](#1-where-it-writes)
2. [Turning it on](#2-turning-it-on)
3. [Why the two predecessors were deleted](#3-why-the-two-predecessors-were-deleted)
4. [What gets recorded](#4-what-gets-recorded)
5. [Ground-truth diffs](#5-ground-truth-diffs)
6. [The instrumentation choke point](#6-the-instrumentation-choke-point)
7. [Reading a journal](#7-reading-a-journal)
8. [Known limitations](#8-known-limitations)

---

## 1. Where it writes

[src/agent/debug/run-journal.ts](../src/agent/debug/run-journal.ts). Two files per run, from one event stream:

| File | For |
|---|---|
| `.zizou/journal/<runId>.log` | Humans. The file you open when a run went wrong. |
| `.zizou/journal/<runId>.jsonl` | Machines. One JSON event per line; the eval harness scores from it. |

`runId` is `session-<ISO timestamp>` for an interactive session, so each process gets its own pair and nothing is overwritten. The eval harness passes its own id per task run.

Under `.zizou/` rather than a fixed `zizou-debug.log` at the repo root, because a debug file dropped beside the user's source is one they then have to gitignore themselves.

## 2. Turning it on

```bash
ZIZOU_DEBUG=1        zizou    # events, tool calls, real file diffs
ZIZOU_DEBUG=prompts  zizou    # the above, plus every prompt verbatim
```

**Off by default.** The journal records file contents and diffs; a tool that silently writes the user's source into a log on every run is not something to opt them into.

## 3. Why the two predecessors were deleted

### TurnLogger

Eighteen methods whose bodies were all `// Silenced`. Every agent event paid a method call to reach a comment. It had been disabled to stop it duplicating SessionLogger and never removed.

### SessionLogger

This one worked, which is what made it worth studying. It failed on legibility, in four specific ways:

| Problem | Effect |
|---|---|
| Wrote the full system prompt on **every** step, unconditionally | The executor prompt is ~3.7k tokens of tool schemas ([009 §1](./009-local-models.md)). A ten-step plan repeated it eleven times. |
| Re-logged each tool call from the **event stream** | So it printed the arguments the model *sent*, with no way to know what actually landed on disk. |
| Dumped the whole message history again at the end (`logLLMConversation`) | Every tool call appeared twice in the same file. |
| Fixed filename at the repo root | One session overwrote the last, and the user had to gitignore it. |

The compound effect: a log where the same boilerplate appeared eleven times and the three lines explaining the failure were buried in it. The information was all present and none of it was findable.

> [!IMPORTANT]
> The lesson generalises. A debug log's constraint is the reader's attention, not the disk. Recording more is not the same as recording better, and a log nobody reads is worth less than no log, because its existence discourages writing one that works.

## 4. What gets recorded

Each event is a `JournalPayload` plus a `{ seq, t }` envelope — `seq` is monotonic, so ordering survives equal timestamps.

| Event | Records |
|---|---|
| `run-start` | prompt, mode, provider, model |
| `route` | auto mode's decision, confidence and reason, **before** anything runs |
| `phase` | which role is speaking: `router`, `planner`, `executor`, `verifier`, `chat` |
| `plan` | the steps and the planner's stated assumptions |
| `prompt` | verbatim system and user text — **only** with `ZIZOU_DEBUG=prompts` |
| `llm-call` | model, finish reason, per-step token usage |
| `assistant-text` | the reply, once, not per delta |
| `tool-call` | name, args, output, ok/failed, duration, **and the file diffs it caused** |
| `fallback-parse` | the model emitted a tool call as text and had to be rescued |
| `duplicate-blocked` | an identical failing call was retried unchanged |
| `verification` | per-step verdict and mismatches |
| `step-end` | which files the model **claims** it touched, and which tools it used |
| `note` | scope hints, text-only replies, planner exploration counts |
| `error` | message and stack |
| `run-end` | totals: calls, tools, failures, fallbacks, lines +/-, files touched |

The request asked for the orchestrator role and its inputs and outputs. `phase` answers which role; `prompt` answers what it was given; `step-end` answers what it claims it produced; `run-end`'s `files touched` answers what it *actually* produced. **The gap between the last two is usually the bug** — a file named in `claimed files` and absent from `files touched` is a claim the filesystem did not support.

## 5. Ground-truth diffs

The single most important property. From [file-diff.ts](../src/agent/debug/file-diff.ts):

> The debug log used to record what the model SAID it did. That is a claim, not a fact. A `writeFile` call whose `contents` argument is 400 lines tells you nothing about what actually landed on disk — the tool may have been denied at the confirm prompt, hit a permission error, or written to a path that resolved somewhere unexpected.

So the journal snapshots the file from the filesystem immediately before and immediately after `execute()`. If the diff is empty, nothing changed, whatever the model claimed:

```
  TOOL OK    editFile  (1ms)
  FILE MODIFIED: calc.js  (+1 -1)
       abs: C:\...\workspace\calc.js
       @@ -1,6 +1,6 @@
        function sum(n){
          let t=0;
       -  for(let i=0;i<n.length-1;i++){
       +  for(let i=0;i<n.length;i++){

  TOOL FAIL  editFile  (0ms)
  output: { "success": false, "error": "NO_MATCH: old_string not found" }
  FILES: no filesystem change observed.
```

A test pins this: a tool returning `{ success: true }` without writing anything must record **no file change**, and the human log must say `no filesystem change observed`.

Paths are recorded both relative and absolute, because "wrote to src/app.ts" is useless when the disagreement is about which directory that was.

## 6. The instrumentation choke point

`journal.wrapTools()` is the only place diffs are produced. Tools do not report their own changes — a tool that failed halfway, or was denied at the confirm prompt, would still describe what it meant to do.

The wrapper is transparent: it returns exactly what `execute()` returned, and a throw propagates unchanged after being recorded.

Wrapper order in [run-turn.ts](../src/agent/run-turn.ts) is load-bearing:

```
wrapToolsWithTrace(        // outermost — undo/redo ledger, always on
  journal.wrapTools(       // debug diffs, only when ZIZOU_DEBUG is set
    duplicateDetection(    // innermost
      buildToolMap(...))))
```

Trace is outermost so it sees the same before-state the tool will act on, and so a duplicate-block refusal never reaches it as a file change — correctly, since nothing was written.

> [!CAUTION]
> The executor's fallback path built its **own** unwrapped `buildToolMap()`, so a pseudo-call parsed out of model text bypassed both wrappers. The journal never saw the call, and — the real damage — neither did the trace ledger, so a file written that way was invisible to `/undo` and `/changes`. Fixed; the fallback map is now wrapped identically. Worth remembering as the shape of the bug: a second, parallel tool map is a second, silent code path.

## 7. Reading a journal

Start at `RUN END` and work backwards. It carries the totals that tell you where to look:

```
  duration      : 41.2s
  llm calls     : 12
  tool calls    : 9 (2 failed)
  fallback parse: 1
  dupes blocked : 0
  files         : +1 created, 2 modified, 0 deleted
  lines         : +84 -12
  tokens        : in=48210 out=3140 cached=31000
  files touched :
      calc.js
      test.js
```

- **`tool calls` failures > 0** — grep `TOOL FAIL` and read the output.
- **`fallback parse` > 0** — the model is not using native tool-calling. A model-capability signal, not a Zizou bug.
- **`dupes blocked` > 0** — the model retried an identical failing call; it is stuck in a loop.
- **`files touched` missing something `step-end` claimed** — the model believes it wrote a file it did not.
- **Nothing obviously wrong** — re-run with `ZIZOU_DEBUG=prompts` and read what the model was actually given.

For machine queries, use the `.jsonl`:

```bash
# every failed tool call
cat .zizou/journal/session-*.jsonl | jq 'select(.kind=="tool-call" and .ok==false)'
# what actually changed
cat .zizou/journal/session-*.jsonl | jq -r 'select(.kind=="tool-call").fileChanges[]?.path' | sort -u
```

## 8. Known limitations

1. **`runBash` coverage is partial.** The journal cannot name a shell command's targets from its arguments, so it re-checks every path it has already seen and reports any that moved. A file the run never otherwise referenced goes unrecorded. The log states this rather than implying full coverage — an honest partial answer beats a clean list that quietly omits things.
2. **The active journal is process-wide.** One interactive session runs at a time, so a single registered journal is enough and avoids threading one through router → planner → executor → verifier. Acceptable only because the journal is write-only: a stale slot misfiles log lines and cannot change behaviour. The eval harness passes its own explicitly.
3. **Diffs are capped.** Patches stop at 400 lines and files over 512 KB are summarized rather than diffed. Binary content is detected by a NUL sniff and never diffed line by line.
4. **Nothing rotates or expires `.zizou/journal/`.** One file pair per debug session, kept until deleted by hand.
