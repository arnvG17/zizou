# Fine-tuning the Zizou executor

Fine-tune `Qwen3-4B` on the dataset in `evals/sft/`, get a GGUF back, serve it
through Ollama, and measure whether it actually helped.

**Where this runs: Google Colab, free T4.** Not on this machine — an Intel
Iris Xe has no CUDA, and Unsloth requires it. Nothing here needs Colab Pro.

Total time: roughly 90 minutes, most of it waiting.

---

## Before you start

**Read this first, because it changes how to interpret the result.**

The dataset currently covers **12 of the 16 tools**. `terminal`, `service` and
`checkUrl` — the new process layer — have no scenarios, so the tuned model
will not know they exist and will reach for the superseded `runBackground`.
`bun run sft:build` fails its coverage gate for exactly this reason.

If you train now, treat run 1 as **a test of the pipeline, not a model to
ship.** That is a reasonable thing to do; it just needs to be a decision
rather than a surprise.

---

## Step 0 — Baseline, on your machine

Measure before you change anything. Without this number, the after number
means nothing.

```bash
ollama pull qwen3:4b
bun run eval -- --provider ollama --repeat 5
```

Write down `pass rate`, `fallbackParses`, `toolFailures`. Keep the report at
`evals/reports/<sha>.md`.

> Spec [009-local-models.md](../specs/009-local-models.md) found Ollama was
> silently truncating prompts to 4096 tokens — a better explanation of bad
> tool calls than model size. That is fixed but has never been measured. If
> the baseline is already good, fine-tuning has less to add than expected,
> and it is better to learn that now than after training.

---

## Step 1 — Build the dataset and the render reference

```bash
bun run evals/sft/render.ts --out training/reference_renders.json --per-band 3
```

That writes 27 records (3 per band) rendered the way **Ollama** will render
them at inference. Step 3 diffs HuggingFace's rendering against it.

> **`bun run sft:build` currently fails**, and correctly so — the coverage
> gate refuses to write a dataset that has no scenarios for `terminal`,
> `service` and `checkUrl`. The dataset already on disk at `evals/sft/data/`
> is what you will train on; it was built before those tools existed.
>
> To regenerate, either add the missing scenarios (the real fix) or add the
> three names to `KNOWN_UNCOVERED` in `evals/sft/build.ts` with a note saying
> why. Do not delete the gate.
>
> A full build takes **~9 minutes** (measured: 548s), of which the
> `shell-process` band alone is ~144s. That is the cost of executing every
> tool result rather than writing it — the band spawns real processes, runs
> real git commands and scans real ports. Use `--band <name>` while authoring
> scenarios; the full run is for when you actually need the dataset.

---

## Step 2 — Upload to Colab

`train.jsonl` and `val.jsonl` are ~14MB and gitignored.

```bash
cd evals/sft/data && zip sft-data.zip train.jsonl val.jsonl
```

Upload `sft-data.zip` and `training/reference_renders.json` to Google Drive,
then in Colab:

```python
from google.colab import drive
drive.mount('/content/drive')
!cp /content/drive/MyDrive/sft-data.zip /content/ && cd /content && unzip -o sft-data.zip
```

Also upload `render_utils.py`, `prepare_data.py`, `verify_render.py` and
`train_qwen3.py` — all four, since the first is imported by two of the others.

---

## Step 3 — Install, and check the render agrees

In Colab, first cell:

```python
!pip install -q unsloth
```

**Restart the runtime** (Runtime → Restart), then:

```python
!python prepare_data.py --data-dir /content --model unsloth/Qwen3-4B-Instruct-2507
!python verify_render.py --model unsloth/Qwen3-4B-Instruct-2507 \
    --reference /content/reference_renders.json
```

`prepare_data.py` renders every record with the tokenizer's own chat template
and **refuses to continue if anything would be truncated** — truncation lands
on the end of a sequence, which is the assistant turn being trained, so a
truncated record teaches the model to stop mid-answer.

`verify_render.py` must print **PASS** with **27 exact matches**. This is the
highest-value check in the pipeline: it proves the format you train on is the
format Ollama serves. A mismatch does not fail loudly at inference — it
half-works, which is much harder to debug than an outright break.

`prepare_data.py` prints real token percentiles. Measured on a 200-record
sample with Qwen3's actual tokenizer: **p50 3287, p95 3388, max 3412** — the
manifest's char-based estimate (p50 3723 / p95 4386 / max 5405) is
deliberately conservative.

Everything fits `max_seq_length=8192` with large margin, and 6144 is
comfortable too. If the numbers come back *much lower* than this, the tool
schemas did not make it into the template — that would drop ~2k tokens per
record and is otherwise invisible until the model is served schemas it never
trained on.

> **One real defect this check already caught.** Qwen3's HuggingFace template
> injects an empty `<think>\n\n</think>` block before every assistant *text*
> turn — 27 of 27 records — while Ollama's template injects none. Training on
> that would have taught the model to prefix every prose answer with empty
> reasoning tags the serving side never showed it, on a model where Zizou
> explicitly sends `think: false`. `render_utils.strip_empty_think()` removes
> them; non-empty reasoning blocks are deliberately preserved, so a future
> dataset carrying real reasoning is not silently gutted.
>
> Run `python test_render_utils.py` to check that logic without a GPU.

---

## Step 4 — Train

```python
!python train_qwen3.py
```

Or paste cells 3–5 from `train_qwen3.py` into the notebook to keep the model
in memory for the export step.

What to watch:

| | |
|---|---|
| **Masking check** | Must report **>50% masked**. The script hard-fails below that — it means `train_on_responses_only` did not take and the model is learning to recite its own prompt. |
| **`bfloat16 supported: False`** | Correct on a T4. It is Turing; there is no bf16 unit. The script follows the hardware rather than hardcoding. |
| **Eval loss** | Falls, then flattens. If it **rises after epoch 1, stop at 1 epoch** — 854 records is a small set and a 4B model memorizes it quickly. |
| **Speed** | ~107 steps/epoch, ~214 total, roughly 20–40 min on a T4. |

Colab free disconnects. The script checkpoints every 50 steps; point
`OUTPUT_DIR` at Drive if you want a drop to cost minutes rather than the run.

**If you hit OOM:** drop `MAX_SEQ_LENGTH` to 6144 (still clears the 5405 max),
or raise `gradient_accumulation_steps`. Do **not** raise
`per_device_train_batch_size` — at 8192 tokens on 16GB it will not fit.

---

## Step 5 — Smoke test, then export

The script runs a generation against a held-out record before exporting. You
want a **single** well-formed block, no prose around it:

```
<tool_call>
{"name": "readFile", "arguments": {"path": "src/services/cache.ts"}}
</tool_call>
```

If that looks wrong, stop. Exporting 2.5GB and wiring it into Ollama will not
fix it.

Then:

```python
model.save_pretrained_gguf("zizou-executor", tokenizer, quantization_method="q4_k_m")
```

`q4_k_m` because that is what the base `qwen3:4b` ships as — exporting q8 and
comparing it to a q4 baseline would measure the quantization as much as the
training.

This builds llama.cpp in-session: 10–20 minutes, and the flakiest step here.

**If it fails**, save merged weights and convert separately:

```python
model.save_pretrained_merged("zizou-merged", tokenizer, save_method="merged_16bit")
```

```bash
!git clone https://github.com/ggerganov/llama.cpp && cd llama.cpp && pip install -r requirements.txt
!python llama.cpp/convert_hf_to_gguf.py zizou-merged --outfile zizou.gguf --outtype f16
!cd llama.cpp && cmake -B build && cmake --build build -j --target llama-quantize
!./llama.cpp/build/bin/llama-quantize zizou.gguf zizou-executor.Q4_K_M.gguf Q4_K_M
```

**Get it out of Colab** by pushing to the HuggingFace Hub. A 2.5GB browser
download from Colab frequently dies partway:

```python
model.push_to_hub_gguf("your-username/zizou-executor", tokenizer,
                       quantization_method="q4_k_m", token="hf_...")
```

---

## Step 6 — Serve it from Ollama

Back on your machine, after downloading the GGUF.

**Do not hand-write the Modelfile template.** Take the stock one and swap only
the weights — that guarantees the template, stop tokens and parameters match
what the dataset was rendered against:

```bash
ollama show --modelfile qwen3:4b > Modelfile
```

Edit the first line:

```
FROM ./zizou-executor.Q4_K_M.gguf
```

Leave `TEMPLATE`, `PARAMETER` and `SYSTEM` exactly as they are, then:

```bash
ollama create zizou-executor -f Modelfile
ollama run zizou-executor "test"
```

A hand-written `TEMPLATE` is the most common way tool calling silently breaks
after a fine-tune.

---

## Step 7 — Did it work?

```bash
bun run eval -- --provider ollama --repeat 5
```

after `/model ollama zizou-executor`, compared against Step 0.

| Metric | What you want | Why |
|---|---|---|
| `fallbackParses` | **0** | The model is emitting native tool calls instead of being rescued by the text parser. This is the headline. |
| `toolFailures` | down | Fewer wrong field names and bad `old_string` guesses. |
| pass rate | up | |
| `auto-route-*` tasks | **no regression** | A heavily SFT'd executor can lose general instruction-following. If routing degrades, keep the router on a hosted model. |

> **A caveat on this comparison.** Running the suite twice, hours apart,
> against two different pins is not a controlled experiment. `--matrix`
> compares models in one invocation but currently only accepts
> `provider:effort` and derives the model from the effort table — which for
> Ollama resolves both cells to the same model. Making baseline-vs-tuned a
> single run is a small parser change in `evals/run-evals.ts`, and it is
> worth doing before you trust a small delta.

---

## Files

| File | What it does |
|---|---|
| `render_utils.py` | **The one place a record becomes training text.** Shared by the next two so they cannot diverge — if they did, verification would pass while the data was wrong. |
| `prepare_data.py` | JSONL → HF Dataset. Fails on truncation. |
| `verify_render.py` | Diffs the HF rendering against Ollama's. **Gate — must pass.** |
| `test_render_utils.py` | 16 checks on the transforms. No GPU or network needed. |
| `train_qwen3.py` | Load, LoRA, train with completion-only loss, smoke test, export. Cell-structured for Colab. |
| `reference_renders.json` | 27 records (3 per band) as Ollama renders them. Regenerate with `render.ts --out`. |

Upload `render_utils.py` alongside the other scripts — `prepare_data.py` and
`verify_render.py` both import it.

## Reference

- [specs/010-sft-dataset.md](../specs/010-sft-dataset.md) — what the dataset contains and why
- [specs/009-local-models.md](../specs/009-local-models.md) — the Ollama wiring this depends on
- [specs/011-evals-and-telemetry.md](../specs/011-evals-and-telemetry.md) — how the eval harness works
