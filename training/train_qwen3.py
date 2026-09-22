"""
train_qwen3.py — QLoRA fine-tune of Qwen3-4B on Zizou's executor dataset.

WHERE THIS RUNS: Google Colab, free T4 (16GB). Not locally — an Intel Iris Xe
has no CUDA, and Unsloth requires it.

Every cell below is safe to paste into Colab in order, or run as a script
after `pip install` (see README.md).

THE THREE SETTINGS THAT ARE NOT NEGOTIABLE ON A T4
--------------------------------------------------
1. fp16, never bf16. The T4 is Turing (sm_75) and has no bfloat16 unit.
   `is_bfloat16_supported()` returns False and the code below follows it.
   Hardcoding bf16=True is the single most common Colab crash here.

2. Gradient checkpointing = "unsloth". Without it an 8192-token sequence
   will not fit in 16GB at this model size.

3. train_on_responses_only. The system prompt plus 16 tool schemas is ~3.7k
   tokens of every ~4k record — roughly 85% of each sequence. Training on all
   of it spends almost the entire gradient teaching the model to recite its
   own prompt back, and starves the part that matters: the tool call.
"""

# ══════════════════════════════════════════════════════════════════════════
# CELL 1 — Install
# ══════════════════════════════════════════════════════════════════════════
# In Colab, run this as its own cell first, then RESTART THE RUNTIME.
#
#   !pip install -q unsloth
#   !pip install -q --force-reinstall --no-deps \
#       git+https://github.com/unslothai/unsloth.git
#
# The second line pulls the latest Unsloth over the released wheel. Skip it
# if the released version already supports your base model.

# ══════════════════════════════════════════════════════════════════════════
# CELL 2 — Configuration
# ══════════════════════════════════════════════════════════════════════════

# Verify this id on HuggingFace before the first run — Unsloth's mirror names
# move as new variants ship. Qwen3-4B-Instruct is the NON-THINKING variant,
# which is what we want: Zizou sends `think: false` at runtime (spec 009), so
# training the thinking path would contradict what is actually served and
# inflate every sequence with reasoning tokens for nothing.
MODEL_NAME = "unsloth/Qwen3-4B-Instruct-2507"

# Dataset p95 is 4386 tokens and max is 5405, so 8192 has comfortable room.
# Drop to 6144 if you hit OOM — it still clears the max with margin.
MAX_SEQ_LENGTH = 8192

OUTPUT_DIR = "outputs"
DATA_DIR = "data"          # written by prepare_data.py
EPOCHS = 2                 # 854 records is small; watch eval loss
LEARNING_RATE = 2e-4
LORA_RANK = 32

# Colab disconnects. Point this at Drive so a drop costs minutes, not the run.
SAVE_STEPS = 50


# ══════════════════════════════════════════════════════════════════════════
# CELL 3 — Load the model
# ══════════════════════════════════════════════════════════════════════════

def load_model():
    from unsloth import FastLanguageModel

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=MODEL_NAME,
        max_seq_length=MAX_SEQ_LENGTH,
        dtype=None,          # None = let Unsloth pick; on a T4 that means fp16
        load_in_4bit=True,   # QLoRA. Without it a 4B will not train in 16GB.
    )

    model = FastLanguageModel.get_peft_model(
        model,
        r=LORA_RANK,
        # alpha == r is the stable default. Some guides use 2r for a stronger
        # effect; with only ~850 records that mostly buys faster overfitting.
        lora_alpha=LORA_RANK,
        lora_dropout=0,      # Unsloth's fused path is optimized for exactly 0
        bias="none",
        # All seven projections. Attention-only (q,k,v,o) trains faster but
        # the MLP is where a lot of format-following lives, and format is the
        # whole point of this fine-tune.
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        use_gradient_checkpointing="unsloth",   # see header note 2
        random_state=3407,
    )
    return model, tokenizer


# ══════════════════════════════════════════════════════════════════════════
# CELL 4 — Load the data
# ══════════════════════════════════════════════════════════════════════════

def load_data():
    """
    Loads what prepare_data.py wrote.

    Deliberately NOT re-rendering here. prepare_data.py renders once, checks
    the token lengths, and fails if anything would be truncated. Re-rendering
    at train time would skip that gate and reintroduce the possibility of
    silently training on a truncated final turn.
    """
    from datasets import load_from_disk

    train = load_from_disk(f"{DATA_DIR}/train")
    val = load_from_disk(f"{DATA_DIR}/val")
    print(f"train {len(train)} | val {len(val)}")
    print(f"bands: {sorted(set(train['band']))}")
    return train, val


# ══════════════════════════════════════════════════════════════════════════
# CELL 5 — Train
# ══════════════════════════════════════════════════════════════════════════

def build_trainer(model, tokenizer, train_ds, val_ds):
    import torch
    from trl import SFTTrainer, SFTConfig
    from unsloth import is_bfloat16_supported
    from unsloth.chat_templates import train_on_responses_only

    use_bf16 = is_bfloat16_supported()
    print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"bfloat16 supported: {use_bf16}  ->  training in {'bf16' if use_bf16 else 'fp16'}")

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        args=SFTConfig(
            dataset_text_field="text",
            max_seq_length=MAX_SEQ_LENGTH,
            # batch 1 x accum 8 = effective batch 8. On a T4 at 8192 tokens,
            # per_device > 1 will OOM. Raise accumulation, never the batch.
            per_device_train_batch_size=1,
            gradient_accumulation_steps=8,
            num_train_epochs=EPOCHS,
            learning_rate=LEARNING_RATE,
            warmup_ratio=0.03,
            lr_scheduler_type="cosine",
            optim="adamw_8bit",       # paged 8-bit optimizer; saves ~2GB
            weight_decay=0.01,
            # See header note 1. Follow the hardware, do not hardcode.
            fp16=not use_bf16,
            bf16=use_bf16,
            logging_steps=5,
            eval_strategy="epoch",     # 854 records: per-epoch is enough signal
            save_strategy="steps",
            save_steps=SAVE_STEPS,
            save_total_limit=2,
            output_dir=OUTPUT_DIR,
            report_to="none",
            seed=3407,
        ),
    )

    # ── Completion-only loss ──────────────────────────────────────────────
    #
    # Masks everything up to and including `<|im_start|>assistant\n`, so loss
    # is computed only on what the model must GENERATE. These two markers are
    # Qwen3/ChatML specific — a different base model needs different ones, and
    # getting them wrong silently disables the masking rather than erroring.
    trainer = train_on_responses_only(
        trainer,
        instruction_part="<|im_start|>user\n",
        response_part="<|im_start|>assistant\n",
    )
    return trainer


def verify_masking(trainer, tokenizer) -> None:
    """
    Proves the masking actually took.

    If train_on_responses_only silently did nothing — wrong marker strings,
    an Unsloth version change — training still runs and still converges, on
    the wrong objective. The only way to know is to look at the labels.
    """
    import numpy as np

    sample = trainer.train_dataset[0]
    labels = np.array(trainer.data_collator([sample])["labels"][0])
    masked = int((labels == -100).sum())
    total = len(labels)
    pct = 100 * masked / total

    print(f"\nMasking check: {masked}/{total} tokens masked ({pct:.1f}%)")
    trained_ids = [int(t) for t in labels if t != -100]
    print("Model is trained to produce:")
    print("  " + tokenizer.decode(trained_ids)[:400].replace("\n", "\n  "))

    # The prompt is ~85% of a typical record. Anything below ~50% means the
    # masking did not apply and the model is learning to recite its prompt.
    if pct < 50:
        raise SystemExit(
            f"\nFAIL: only {pct:.1f}% masked. train_on_responses_only did not take —\n"
            f"check the instruction_part / response_part markers against this\n"
            f"model's chat template before training."
        )


# ══════════════════════════════════════════════════════════════════════════
# CELL 6 — Smoke test before exporting
# ══════════════════════════════════════════════════════════════════════════

def smoke_test(model, tokenizer, val_ds) -> None:
    """
    Generates against a held-out record and shows what comes out.

    The thing to look for is a SINGLE well-formed <tool_call> block with
    schema-valid arguments and no prose wrapped around it. If this looks wrong,
    exporting a 2.5GB GGUF and wiring it into Ollama will not make it right.
    """
    from unsloth import FastLanguageModel

    FastLanguageModel.for_inference(model)

    text = val_ds[0]["text"]
    # Cut at the first assistant turn and let the model produce the rest.
    marker = "<|im_start|>assistant\n"
    prompt = text.split(marker)[0] + marker

    inputs = tokenizer(prompt, return_tensors="pt").to("cuda")
    out = model.generate(**inputs, max_new_tokens=256, temperature=0.2, do_sample=False)
    completion = tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=False)

    print("\n--- model output on a held-out record ---")
    print(completion)
    print("\nExpected shape:")
    print('  <tool_call>\n  {"name": "readFile", "arguments": {"path": "..."}}\n  </tool_call>')


# ══════════════════════════════════════════════════════════════════════════
# CELL 7 — Export to GGUF for Ollama
# ══════════════════════════════════════════════════════════════════════════

def export_gguf(model, tokenizer, repo: str | None = None) -> None:
    """
    q4_k_m because that is what the base qwen3:4b ships as — comparing a
    q8 fine-tune against a q4 baseline would measure the quantization as much
    as the training.

    This builds llama.cpp inside the session and is the slowest, flakiest step
    in the pipeline (10-20 min, and it does sometimes fail on Colab). If it
    breaks, see README.md for the merged-16bit fallback.
    """
    model.save_pretrained_gguf("zizou-executor", tokenizer, quantization_method="q4_k_m")

    # Pushing beats downloading: the file is ~2.5GB and a browser download
    # from Colab will often die partway.
    if repo:
        model.push_to_hub_gguf(
            repo, tokenizer, quantization_method="q4_k_m", token="hf_..."
        )


# ══════════════════════════════════════════════════════════════════════════
# Script entry point (Colab users call the cells directly instead)
# ══════════════════════════════════════════════════════════════════════════

def main() -> None:
    model, tokenizer = load_model()
    train_ds, val_ds = load_data()
    trainer = build_trainer(model, tokenizer, train_ds, val_ds)

    verify_masking(trainer, tokenizer)

    stats = trainer.train()
    print(f"\nDone in {stats.metrics['train_runtime'] / 60:.1f} min")

    smoke_test(model, tokenizer, val_ds)
    export_gguf(model, tokenizer)


if __name__ == "__main__":
    main()
