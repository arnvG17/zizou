# SFT Training — Spec Sheet

How the Zizou executor gets fine-tuned: where it runs, what each step does, and which settings are load-bearing. Companion to [010-sft-dataset.md](./010-sft-dataset.md), which covers the dataset itself.

Everything asserted here was verified against a live tokenizer or a live Ollama server, not inferred.

---

## Table of Contents

1. [Where this runs, and why](#1-where-this-runs-and-why)
2. [The pipeline](#2-the-pipeline)
3. [The render-parity gate](#3-the-render-parity-gate)
4. [The empty-think defect](#4-the-empty-think-defect)
5. [Training settings that are not optional](#5-training-settings-that-are-not-optional)
6. [Export and serving](#6-export-and-serving)
7. [Measuring the result](#7-measuring-the-result)
8. [What run 1 cannot tell you](#8-what-run-1-cannot-tell-you)

---

## 1. Where this runs, and why

**Google Colab, free T4.** Not locally.

| | |
|---|---|
| Local GPU | Intel Iris Xe — **no CUDA**. Unsloth requires it; this is not a tuning problem, it simply cannot run. |
| Local RAM | 15.8 GB, frequently under 2 GB free |
| Colab T4 | 16 GB VRAM, Turing (sm_75): **no bf16**, no Flash Attention 2 |

Colab Pro is not needed. Kaggle (P100 / 2×T4, 30 h/week) works identically and has longer uninterrupted sessions if Colab's disconnects become annoying.

Token lengths, measured two ways:

| Source | p50 | p95 | max |
|---|---|---|---|
| Manifest estimate (chars / 3.6) | 3723 | 4386 | 5405 |
| **Qwen3 tokenizer, 200-record sample** | **3287** | **3388** | **3412** |

The char-based estimate is deliberately conservative. Either way `max_seq_length = 8192` has large margin; 6144 is comfortable too. `prepare_data.py` reports the real numbers on every run and **refuses to continue if anything would be truncated** — truncation lands on the end of a sequence, which is the assistant turn being trained, so a truncated record teaches the model to stop mid-answer.

---

## 2. The pipeline

```
[0] baseline eval       (local, before anything)
[1] build + reference   bun run sft:build; render.ts --out
[2] upload              zip → Drive → Colab
[3] prepare + VERIFY    prepare_data.py; verify_render.py   ← gate
[4] train               train_qwen3.py
[5] export              GGUF q4_k_m → HF Hub
[6] ollama create       stock Modelfile, swapped FROM line
[7] compare to [0]
```

Step 3 is a gate: it exits non-zero and nothing proceeds.

Full commands in [training/README.md](../training/README.md).

---

## 3. The render-parity gate

Two independent things render the same conversation:

| | Renderer | Where |
|---|---|---|
| **Training** | `tokenizer.apply_chat_template(messages, tools=tools)` | HuggingFace, Python, in Colab |
| **Serving** | Ollama's Go template | at inference, in Zizou |

If those disagree — even in whitespace around `<tool_call>` — the model is trained on one format and served another. **That does not fail loudly.** It half-works: Ollama's parser recovers some outputs and not others, and the symptom reads as "the model is bad at tool calling", which is the exact wrong conclusion and the one this whole project started from.

[evals/sft/render.ts](../evals/sft/render.ts) holds a transcription of the live Ollama template, read from `/api/show`. `render.ts --out` writes a reference file of 27 records (3 per band); `training/verify_render.py` renders the same records with HuggingFace and diffs.

**Current status: 27/27 exact matches across all 9 bands.**

### What is tolerated, and what is not

`normalize_for_compare()` in [training/render_utils.py](../training/render_utils.py) ignores exactly two things:

- trailing whitespace and collapsed blank-line runs
- JSON key spacing **inside `<tools>`** — Ollama's Go template emits compact JSON, HuggingFace emits spaced. Same meaning, different tokens. It is a real difference in the prompt the model reads, but not in the text it is trained to produce.

Everything else is a failure, including JSON spacing *inside a `<tool_call>`*, because there it is part of the emission contract. `test_render_utils.py` asserts each of these negative cases so the normalizer cannot quietly grow.

> [!IMPORTANT]
> `render_utils.py` is imported by both `prepare_data.py` and `verify_render.py`. That is deliberate. If the verifier rendered differently from the preparer, the check would pass while the training data was wrong — a misleading green tick, worse than no check at all.

---

## 4. The empty-think defect

A real defect, found by running the gate rather than reasoning about it.

Qwen3's HuggingFace chat template injects an **empty reasoning block** before every assistant *text* turn — not before tool-call turns:

```
<|im_start|>assistant
<think>

</think>

Updated the cache timeout to 10000ms.<|im_end|>
```

Measured: **27 of 27** reference records, exactly once each, on the final text message. Ollama's template injects none.

Training on that would have taught the model to prefix every prose answer with empty reasoning tags the serving side never showed it — on a model where Zizou explicitly sends `think: false` ([009-local-models.md](./009-local-models.md) §4). Best case Ollama strips them; worst case `<think></think>` appears verbatim in the user's chat.

`strip_empty_think()` removes them. It matches **whitespace-only** contents, so a future dataset carrying genuine reasoning is preserved rather than silently gutted — deleting real reasoning would be a much worse failure than leaving an empty block in, so the regex is written to fail safe in that direction.

Before the fix: 0 exact matches, 27 tool-call-span matches. After: 27 exact.

---

## 5. Training settings that are not optional

### fp16, never bf16

The T4 is Turing and has no bfloat16 unit. The script reads the hardware:

```python
use_bf16 = is_bfloat16_supported()   # False on a T4
fp16 = not use_bf16
bf16 = use_bf16
```

Hardcoding `bf16=True` — which most tutorials do, because they assume an A100 — is the most common crash here.

### Gradient checkpointing

`use_gradient_checkpointing="unsloth"`. Without it, an 8192-token sequence will not fit in 16 GB at 4B parameters.

### Completion-only loss

```python
train_on_responses_only(
    trainer,
    instruction_part="<|im_start|>user\n",
    response_part="<|im_start|>assistant\n",
)
```

**This is the setting with the largest effect on the result.** The system prompt plus 16 tool schemas is ~3.7k tokens of every ~4k record — roughly **85% of each sequence**. Training on all of it spends almost the entire gradient teaching the model to recite its own prompt back, and starves the part that matters.

Those two markers are ChatML/Qwen3-specific. A different base model needs different ones, and getting them wrong **silently disables the masking** rather than erroring — training still runs, still converges, on the wrong objective.

So `train_qwen3.py` verifies it: it decodes one batch's labels, reports the masked percentage, prints what the model is actually trained to produce, and **hard-fails below 50%**.

### The rest

| Setting | Value | Note |
|---|---|---|
| LoRA rank / alpha | 32 / 32 | `alpha == r` is the stable default; `2r` mostly buys faster overfitting on ~850 records |
| target_modules | all 7 projections | MLP included — a lot of format-following lives there, and format is the point |
| batch × accum | 1 × 8 | At 8192 tokens on 16 GB, `per_device > 1` OOMs. Raise accumulation, never batch. |
| LR / schedule | 2e-4 cosine, warmup 0.03 | |
| Epochs | 2 | ~107 steps/epoch. **Watch eval loss — a 4B memorizes 854 records fast.** Stop at 1 epoch if it rises. |
| optim | `adamw_8bit` | saves ~2 GB |

---

## 6. Export and serving

`q4_k_m`, because that is what the base `qwen3:4b` ships as. Exporting q8 and comparing it against a q4 baseline would measure the quantization as much as the training.

GGUF conversion builds llama.cpp inside the Colab session: 10–20 minutes and the flakiest step in the pipeline. The README carries a merged-16-bit fallback. Push to the HF Hub rather than downloading 2.5 GB through a browser, which frequently dies partway.

### The Modelfile

> [!IMPORTANT]
> **Do not hand-write the `TEMPLATE`.** Take the stock one and swap only the weights:
>
> ```bash
> ollama show --modelfile qwen3:4b > Modelfile
> # change only the FROM line
> ollama create zizou-executor -f Modelfile
> ```

This guarantees the template, stop tokens and parameters match what the dataset was rendered against. A hand-written template is the most common way tool calling silently breaks after a fine-tune — and the render-parity gate in step 3 cannot catch it, because it checks the *base* model's template, not whatever you typed into a Modelfile afterwards.

---

## 7. Measuring the result

```bash
bun run eval -- --provider ollama --repeat 5     # before, and after
```

| Metric | Target | Why it is the one to watch |
|---|---|---|
| `fallbackParses` | **0** | The model is emitting native tool calls instead of being rescued by the text parser ([fallback-tool-parse.ts](../src/agent/fallback-tool-parse.ts)). The headline. |
| `toolFailures` | down | Fewer wrong field names, fewer bad `old_string` guesses |
| pass rate | up | |
| `auto-route-*` | **no regression** | A heavily SFT'd executor can lose general instruction-following. If routing degrades, the router stays hosted. |

### Two gaps in this measurement, both real

**Malformed arguments are invisible.** When a model emits `{"filePath": ...}` instead of `{"path": ...}`, the AI SDK rejects it *before* `execute()` runs. `RunJournal` has no `toolError()` method, and `RunTotals.toolFailures` counts only journal `tool-call` records with `ok: false` — a rejected call produces no such record. So the single failure mode this fine-tune exists to fix is **not currently counted anywhere**.

**Two models cannot be compared in one run.** `--matrix` parses `provider:effort` and derives `modelId` from the effort table ([run-evals.ts](../evals/run-evals.ts)). Spec 009 removed `EFFORT_MODELS.ollama`, so for Ollama both cells resolve to the same pinned model. Baseline vs tuned therefore requires two invocations, hours apart, which is not a controlled comparison. `MatrixCell` already carries `modelId`; making this work is a parser change, not a redesign.

Both are worth closing before trusting a small delta.

---

## 8. What run 1 cannot tell you

The dataset covers **12 of the 16 tools**. `terminal`, `service` and `checkUrl` — the process layer that `buildToolMap()` describes as "the order the model should reach for it" — have **zero scenarios**, and `bun run sft:build` fails its own coverage gate because of it.

So a model trained today will not know those tools exist and will reach for the superseded `runBackground`. Run 1 is **a test of the pipeline, not a model to ship**, and its eval numbers are a verdict on whether the machinery works — not on whether the dataset design is right.

Closing that gap means a process-layer scenario band covering `terminal` (create/send/sendKeys/read/close), `service` (start with `autoPort`/`readyRegex`/`exit`, then status/logs/restart/stop) and `checkUrl`, plus a drift guard in `generate.test.ts` so `bun test` catches the next tool addition instead of a build run discovering it four tools later.

That drift guard matters more than it sounds, because of what the gate costs to run: a full build is **~9 minutes** (measured 548s), since every tool result is executed rather than written — the `shell-process` band alone is ~144s of spawning processes, running git and scanning ports. A check that slow will not be run casually, so the cheap version belongs in `bun test`.

### The other thing that might be true

If the baseline in step 0 already shows `fallbackParses` near zero, then the [009](./009-local-models.md) wiring fix — Ollama was silently truncating every prompt to 4096 tokens — already won most of what was available, and fine-tuning has less to add than expected. That is a real possible outcome. Naming it in advance is what stops it being explained away afterwards.
