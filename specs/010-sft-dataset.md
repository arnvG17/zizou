# SFT Dataset for the Zizou Executor — Spec Sheet

How Zizou's fine-tuning dataset is built, what format it targets, which base model it is for, and why the previous attempt (the removed `sft-database.md` prompt doc) could not have worked. Every claim here is checked against source or against a live Ollama server.

---

## Table of Contents

1. [Why this exists](#1-why-this-exists)
2. [The template contract](#2-the-template-contract)
3. [What the previous spec got wrong](#3-what-the-previous-spec-got-wrong)
4. [Which model, and why](#4-which-model-and-why)
5. [Core design: executed results](#5-core-design-executed-results)
6. [Record format](#6-record-format)
7. [Composition](#7-composition)
8. [Validation gate](#8-validation-gate)
9. [Train/val split](#9-trainval-split)
10. [Running it](#10-running-it)
11. [Known limitations](#11-known-limitations)

---

## 1. Why this exists

Local models tool-call badly in Zizou. `src/agent/fallback-tool-parse.ts` exists solely to rescue malformed calls, and its header names the culprits: *"llama-3.3-70b via Groq, and most 3-4B Ollama models"*. `noFallbackParsing()` is already an eval assertion in [evals/assertions/index.ts](../evals/assertions/index.ts).

Two things were wrong, and they are separable:

| Cause | Status |
|---|---|
| **Wiring** — 4096-token context truncation, thinking tokens eating the output budget, no model discovery | Fixed. See [009-local-models.md](./009-local-models.md) |
| **The model** — doesn't know Zizou's 13 tools or this repo's idiom | This document |

> [!IMPORTANT]
> Re-run `bun run evals/run-evals.ts --provider ollama` before investing in training. If the context-truncation diagnosis in 008 was right, `fallbackParses` drops sharply with no fine-tuning at all, and this dataset's job shrinks from "teach tool calling" to "teach this repo's idiom". That changes *how much data is enough*, not whether to build it.

---

## 2. The template contract

**This is the single most important section.** What the model emits is decided by its chat template, not by anything in the AI SDK. The template below was read from a live server:

```bash
curl -s -X POST localhost:11434/api/show -d '{"model":"qwen3:4b"}' | jq -r .template
```

Three facts follow from it, and all three shape the dataset.

### 2.1 A tool call is Hermes-style

```
<tool_call>
{"name": "writeFile", "arguments": {"path": "index.html", "contents": "..."}}
</tool_call>
```

`toolName` / `input` — the shape used throughout the removed `sft-database.md` prompt doc — is the **AI SDK's internal representation**. It appears in `AgentEvent` in [src/agent/run-turn.ts](../src/agent/run-turn.ts) and never reaches the model.

### 2.2 Tool schemas live in the system block

```
<|im_start|>system
{system prompt}

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {...}}
</tools>
...<|im_end|>
```

The system prompt and all 13 tool schemas share one budget — roughly 3.7k tokens together, measured. **This is why Ollama's 4096-token `num_ctx` default was catastrophic**: the prompt alone nearly filled it, and Ollama truncates silently.

### 2.3 Tool results come back as `user` turns

```
<|im_start|>user
<tool_response>
{"success":true,"contents":"..."}
</tool_response><|im_end|>
```

Not a distinct `tool` role. Records still store `role: "tool"` — the template performs the translation, and encoding it in the data would lock the dataset to one model family.

---

## 3. What the previous spec got wrong

the removed `sft-database.md` prompt doc §10 defines a "training signal boundary" of winners and losers. It is inverted on the point that matters most.

| # | the removed prompt doc says | Reality |
|---|---|---|
| W1 | `toolName`/`input` = **WINNER**; `{"name","arguments"}` = **LOSER** | **Exactly backwards.** `{"name","arguments"}` is what the template requires. Training on the stated boundary would produce output Ollama cannot parse. |
| §1 | Lists `editFile` as taking 3 fields | Misses `near_line` ([src/tools/edit-file.ts:103](../src/tools/edit-file.ts#L103)), which the real system prompt teaches as **the** recovery path |
| §2 | Quotes a system prompt with `TOOL GUIDE`, `EXECUTION RULES`, `REPO MAP` | None of those exist. The real `EXECUTOR_INSTRUCTIONS` is at [build-system-prompt.ts:82](../src/context/build-system-prompt.ts#L82); the repo map was deliberately deleted (~5.7k tokens, went stale) |
| §5 | Defines a `cannot-proceed` signal | **Parsed nowhere in `src/`.** Emitting it would render as literal JSON to the user while the orchestrator waits |
| §4 | One tool call per record, `{step_input, file_context, correct_tool_call}` | Not a trainable format, and `runTurn` is a multi-step loop |
| §8 | 30 records | ~50× too few |

The new pipeline fixes each of these structurally rather than by instruction — see §8.

---

## 4. Which model, and why

**Qwen3-4B, non-thinking instruct variant.** Hardware decides this more than quality does.

| | Measured |
|---|---|
| GPU | Intel Iris Xe iGPU — **no CUDA**. Unsloth cannot run locally at all. |
| CPU | i5-1155G7 |
| RAM | 15.8 GB total; 0.8–1.8 GB free during development |

Inference is CPU-only against shared RAM. `qwen3:4b` at Q4_K_M is 2.5 GB and runs. `gemma4:e4b` at 9.6 GB **failed to load during probing** (`failed to allocate CPU_REPACK buffer`). That rules out the 7–8B class on this machine regardless of merit.

Beyond fitting:

1. **Template verified, not assumed** — §2 was read off the running server. `/api/tags` reports `capabilities: ["completion","tools","thinking"]`; tool calling is native.
2. **262144-token context in the weights** — no ceiling problem. `recommendedNumCtx()` clamps to 16384 for memory.
3. **Non-thinking matches runtime** — Zizou now sends `think: false` ([009](./009-local-models.md)). Training the thinking path would contradict that and inflate sequence length.
4. **Trainable on a free T4** — 4B QLoRA at 8192 seq len fits 16 GB with gradient checkpointing. Measured p95 is 4386 tokens, so 8192 is comfortable.
5. **Already the default** — `DEFAULT_MODELS.ollama` in [resolve-model.ts](../src/sdk/resolve-model.ts).

**Upgrade path:** `Qwen2.5-Coder-7B-Instruct` — same Hermes template family, so **the dataset transfers without regeneration**. That portability is a design requirement, not luck: records store neutral OpenAI messages and render late.

---

## 5. Core design: executed results

> [!IMPORTANT]
> **No tool output in this dataset was written by a human or a model.** Every result is produced by running the real tool against a real temp workspace.

the removed hand-written `sft-dataset.json` (the old set) had hand-written `file_context` snippets and hand-written expected calls. The failure mode is quiet: an `old_string` that actually matches twice, a `grep` result that doesn't match what `grep` returns, an error string that is *close to* the real one. Each teaches something false, and nothing in a hand-written pipeline catches any of it.

The generator in [evals/sft/generate.ts](../evals/sft/generate.ts) instead:

1. Seeds a fresh temp workspace from the scenario's `Fixture`
2. `chdir`s into it (tools resolve against `process.cwd()`)
3. Calls the real `execute()` from `buildToolMap()` with an auto-approving `ConfirmFn`
4. Records whatever comes back, verbatim

What this buys, concretely — here is a real record's middle turn, which no one would have written correctly by hand:

```json
{"success":false,"error":"AMBIGUOUS_MATCH: old_string matches 2 locations in
src/config/cache-config.ts. Add more surrounding lines ... \n  Match 1 at line 9:\n
   7: \n     8: export const DEFAULTS: Config = {\n >>> 9:   cache: 10,\n ...
  2. Use the near_line parameter (e.g. near_line: 9) to target a specific occurrence."}
```

The model then learns to answer with `near_line: 9` — the number the error itself supplied.

### Safety properties

| Property | Mechanism |
|---|---|
| Never writes into the repo | Project mtime fingerprinted before/after each record; mismatch throws |
| No leaked temp paths | `scrubPaths()` handles raw, POSIX, Windows **and JSON-escaped** forms → `/workspace` |
| No leaked processes | `runBackground` tasks killed in a `finally` via `killTask()` |
| No pinned-file contamination | `clearPinnedFiles()` per record — `addFileToContext` writes to a module-level Set |
| Scenarios stay honest | `expectFailure` is asserted both ways: a declared failure that succeeds fails the build |
| Byte-for-byte reproducible | Fixed git commit dates; `scrubVolatile()` normalizes pids, timestamps and durations |

Two of those deserve expanding.

**`expectFailure` matters most for durability.** A recovery scenario whose failing step silently starts succeeding is still valid JSON and still passes validation — but has stopped teaching recovery. The assertion is what notices.

**Reproducibility took two fixes.** Running real tools means capturing real machine state, and two kinds leaked in:

- `git log --oneline` returned a new commit SHA every build, because the commit timestamp differed. Fixed by pinning `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`.
- `runBackground` results carried a live `pid` and an ISO `startTime`. `scrubVolatile()` normalizes those. It deliberately **does not** touch `taskId` — that is a sequential counter, already stable, and carrying it from the spawn result into the `kill` call is the entire lesson of those records.

Two consecutive builds now produce identical `train.jsonl` and `val.jsonl`, so a diff between dataset versions means something changed in the source, not in the weather.

---

## 6. Record format

```ts
interface TrainingRecord {
  meta: { id, scenario, band, tools: string[], turns: number };
  system: string;        // buildSystemPrompt(root, "executor"), paths scrubbed
  tools: unknown[];      // JSON Schema, from the AI SDK's own asSchema()
  messages: Array<
    | { role: "user"; content: string }
    | { role: "assistant"; content?: string; tool_calls?: [{ id, type, function: { name, arguments } }] }
    | { role: "tool"; tool_call_id: string; name: string; content: string }
  >;
}
```

Three deliberate choices:

- **`tools` comes from `asSchema()`** (exported by `ai`) — the exact converter used to build a real request. No `zod-to-json-schema` dependency, and no way for the dataset's schemas to drift from the ones the model is served. This is why `near_line` is present without anyone remembering to add it.
- **`arguments` is a JSON string**, matching the wire format and what `apply_chat_template` interpolates. An object renders as `[object Object]`.
- **Neutral OpenAI shape**, rendered late. One dataset, any base model.

---

## 7. Composition

1048 records, 854 train / 194 val. Weighted toward observed failures rather than spread evenly across tools.

| Band | N | What it teaches |
|---|---|---|
| `shell-process` | 180 | runBash, runBackground lifecycle, manageTasks, managePorts. Conditional-required fields. |
| `create-in-place` | 160 | writeFile after looking. FILE PLACEMENT + EDIT-DON'T-RECREATE. |
| `recovery` | 160 | **Real** failures → correct next move. `near_line`, re-read, forced writeFile fallback. |
| `single-edit` | 150 | read → editFile with verbatim `old_string`. The core loop. |
| `search-then-act` | 140 | grep/glob first; never name a path you haven't seen. |
| `fs-ops` | 85 | fileOperations, both branches of its conditional `destination`. |
| `multi-file` | 70 | One symbol across 4 files. Don't stop after the first. |
| `blocked` | 60 | Genuinely ambiguous → one short question, no tool call. |
| `no-tool-chat` | 43 | Ordinary questions answered in prose. |

Tool call distribution: `editFile` 975, `readFile` 690, `glob` 210, `listDir` 160, `writeFile` 150, `grep` 145, `fileOperations` 105, `manageTasks` 85, `managePorts` 70, `runBash` 65, `runBackground` 20, `addFileToContext` 20.

Token length: **p50 3723, p95 4386, max 5405** — comfortable at an 8192 training sequence length.

### Deliberate exclusions

- **`cannot-proceed`** — dropped. Nothing in `src/` parses it. Replaced by `blocked`, which is plain text that `runTurn` already handles.
- **`openFile`** — the only tool with zero coverage, declared in `KNOWN_UNCOVERED` in [build.ts](../evals/sft/build.ts). It shells out to the OS default handler, so generating records would launch a browser per scenario on whoever builds the dataset. Its schema is a single `path` string identical in shape to `readFile`'s, and it is fire-and-forget with no result to learn from. **Any other uncovered tool fails the build.**

---

## 8. Validation gate

[evals/sft/validate.ts](../evals/sft/validate.ts). Nothing is written unless every record passes; the process exits non-zero.

| Rule | Catches |
|---|---|
| `schema` | Every `arguments` blob parsed by the **live Zod schema** via `buildToolMap()[name].inputSchema.safeParse` |
| `known-tool` | A tool name outside `buildToolMap()` |
| `arguments-are-string` | An object where the wire format needs a JSON string |
| `no-pseudo-calls` | `<function/>`, `<tool_call>`, raw `{"name","arguments"}` or `toolName` **inside a content field** |
| `edit-precondition` | `old_string` absent from, or ambiguous in, the file state implied by preceding turns — replayed, not spot-checked |
| `tool-result-has-call` | An orphan result answering a call that was never made |
| `no-empty-assistant` | A turn with neither content nor tool calls |
| `ends-with-assistant` | A record ending on a tool result — teaches stopping mid-loop |
| `token-budget` | Anything over the sequence limit |
| duplicates | Byte-identical records |

> [!IMPORTANT]
> **The removed prompt doc §10.2's wrong-field-name table is now executable.** `filePath`/`content`, `oldString`/`newString`, `port: "3000"`, `action: "stop"` are all caught by the `schema` rule against the live Zod schemas — no hand-maintained list to go stale. Rename a field in `src/tools` and the gate keeps working.

Two rules are subtler than they look:

- **`no-pseudo-calls` checks content fields only.** A tool *result* legitimately contains arbitrary JSON echoed from disk. What is policed is what the model is taught to *say* — because a training set containing these shapes as text teaches the model to emit them as text, which is the precise failure this dataset exists to remove.
- **`edit-precondition` skips calls whose result was a failure.** The ambiguous `old_string` in a recovery record is the *content* of that record, not a defect in it. Only successful edits are checked, and what they are checked for is a stale read.

25 tests in [validate.test.ts](../evals/sft/validate.test.ts) assert each rule fires on a record built to violate it — a gate that passes everything is worse than no gate.

---

## 9. Train/val split

Split **by scenario family, stratified by band**. A family is the scenario id with its trailing index removed: `single-edit-timeout-7` and `single-edit-timeout-12` are the same family.

Two properties, both learned the hard way:

1. **Family-level, not record-level.** Records in a family differ only in a name or a number. Splitting per record puts a record's near-twin on the other side, and validation loss then measures memorization while reporting it as generalization.
2. **Stratified by band.** The first implementation split families globally and produced a validation set covering **4 of 9 bands** — it said nothing whatever about recovery, multi-file work, or knowing when *not* to call a tool. The build now fails if any band is missing from validation.

Families are selected smallest-first per band, so guaranteeing coverage of a two-family band doesn't hand a quarter of the dataset to validation. Result: 18.5% val, all 9 bands. Deterministic — regenerating gives the same split, so two training runs stay comparable.

---

## 10. Running it

```bash
bun run sft:build                          # generate, validate, split, write
bun run sft:check                          # validate without writing
bun run evals/sft/build.ts --band recovery # one band while authoring
bun run sft:render -- --band recovery --limit 1 --completions-only
```

Output in `evals/sft/data/`: `train.jsonl`, `val.jsonl`, `manifest.json`. The JSONL is **gitignored** — ~14 MB, rebuilt in ~80 s. Scenarios and the generator are the source and are committed; the manifest is committed too, for the same reason eval reports are.

`sft:render` shows the literal Qwen3 rendering. It is a **viewer, not the training path** — training must render with the model's own tokenizer:

```python
tokenizer.apply_chat_template(messages, tools=tools, tokenize=False)
```

A hand-written template copy drifts silently, and a model trained on almost-right delimiters is worse than one trained on obviously wrong ones, because it half-works.

---

## 11. Known limitations

**Diversity is bounded by ~34 scenario families.** 1048 records is a lot of examples of a modest number of *shapes*. The parameterization varies names, paths and numbers; it does not vary structure. A model trained on this will be good at the shapes present and unexercised on the rest.

**The band weights encode assumptions.** They come from failure classes documented in `fallback-tool-parse.ts` and `edit-file.ts`, not from measurement of this specific model.

**Both are fixed by the same deferred work:** harvesting real trajectories from a strong hosted model via `RunJournal` ([src/agent/debug/run-journal.ts](../src/agent/debug/run-journal.ts)), rejection-sampled on eval assertions. That records `(prompt, tool-call, input/output, ok, viaFallback, fileChanges)` for real runs — the same record shape, measured instead of assumed. The synthetic set is the floor, not the ceiling.

**No training pipeline here.** Deliberately out of scope: dataset only.
