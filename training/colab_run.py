"""
colab_run.py — the whole fine-tune, one file, one command.

    !python colab_run.py

Replaces pasting eleven cells by hand. Runs every stage in one process, which
also means the model stays in memory between training and export instead of
being reloaded.

BEFORE YOU RUN THIS, two things must already be true:

  1. The runtime has a GPU.
     Runtime -> Change runtime type -> T4 GPU

  2. Unsloth is installed AND the runtime has been restarted since.
         !pip install -q unsloth
     then Runtime -> Restart session. The restart is not optional: Unsloth
     patches libraries at import time, and a session that imported torch
     before the install will silently use the unpatched version.

This script checks both and tells you which one is missing rather than dying
in a stack trace forty lines later.

STAGES, and what stops the run:

    1 environment    no GPU            -> stop
    2 data           truncation        -> stop
    3 render parity  format mismatch   -> stop   <- the important one
    4 train          masking failure   -> stop
    5 smoke test     never stops; you read it
    6 export         failure is recoverable, see README step 5

Re-run with --skip-train to do everything except the training itself, which is
the fast way to check the pipeline works before committing 40 minutes to it.
"""

import argparse
import os
import shutil
import sys
import time
from pathlib import Path


# ══════════════════════════════════════════════════════════════════════════
# Presentation
# ══════════════════════════════════════════════════════════════════════════

_t0 = time.time()


def stage(n: int, title: str) -> None:
    mins = (time.time() - _t0) / 60
    print(f"\n{'=' * 70}")
    print(f"  STAGE {n} — {title}    [{mins:.1f} min elapsed]")
    print(f"{'=' * 70}")


def die(message: str, fix: str = "") -> None:
    """Stops with an explanation and, where there is one, the actual fix."""
    print(f"\n{'!' * 70}")
    print(f"  STOPPED: {message}")
    if fix:
        print(f"\n  FIX: {fix}")
    print(f"{'!' * 70}")
    sys.exit(1)


# ══════════════════════════════════════════════════════════════════════════
# Stage 1 — environment
# ══════════════════════════════════════════════════════════════════════════


def check_environment(args) -> None:
    stage(1, "Environment")

    try:
        import torch
    except ImportError:
        die("PyTorch is not installed.", "!pip install -q unsloth   (then restart the runtime)")

    if not torch.cuda.is_available():
        die(
            "No GPU. Unsloth cannot run on CPU.",
            "Runtime -> Change runtime type -> T4 GPU, then re-run this script.",
        )

    name = torch.cuda.get_device_name(0)
    vram = torch.cuda.get_device_properties(0).total_memory / 1e9
    bf16 = torch.cuda.is_bf16_supported()

    print(f"  GPU            : {name}")
    print(f"  VRAM           : {vram:.1f} GB")
    print(f"  bf16 supported : {bf16}")
    if not bf16:
        # Expected on a T4 and not a problem — but people see "False" and
        # assume something is broken, so say so before they ask.
        print("                   (correct for a T4 — training will use fp16)")

    try:
        import unsloth  # noqa: F401
    except ImportError:
        die(
            "Unsloth is not importable.",
            "!pip install -q unsloth   THEN Runtime -> Restart session, then re-run.",
        )

    if vram < 14:
        print(f"\n  WARNING: {vram:.1f} GB is less than this script is tuned for (16 GB).")
        print(f"  If training OOMs, re-run with --max-seq-length 4096")

    # Every path is resolved relative to the working directory, so a wrong cwd
    # produces confusing "file not found" errors three stages later.
    for f in ["train.jsonl", "val.jsonl", "reference_renders.json"]:
        if not Path(args.data_dir, f).exists() and not Path(f).exists():
            die(
                f"{f} not found in {args.data_dir} or the current directory.",
                "Unzip the bundle first:\n"
                "       !cp /content/drive/MyDrive/zizou-sft-colab.zip /content/\n"
                "       %cd /content\n"
                "       !unzip -o -q zizou-sft-colab.zip",
            )
    print(f"\n  Data and scripts found. Ready.")


# ══════════════════════════════════════════════════════════════════════════
# Stage 2 — data
# ══════════════════════════════════════════════════════════════════════════


def prepare(args):
    stage(2, "Preparing data")

    from transformers import AutoTokenizer
    from prepare_data import build_split, report_lengths

    tokenizer = AutoTokenizer.from_pretrained(args.model)
    data_dir = Path(args.data_dir)

    print(f"  Rendering with {args.model}'s chat template...\n")
    train = build_split(data_dir / "train.jsonl", tokenizer)
    val = build_split(data_dir / "val.jsonl", tokenizer)

    train_max = report_lengths(train, tokenizer, "train")
    val_max = report_lengths(val, tokenizer, "val")
    longest = max(train_max, val_max)

    # Truncation lands on the END of a sequence, which is the assistant turn
    # being trained. A truncated record teaches the model to stop mid-answer,
    # and nothing downstream would flag it.
    if longest > args.max_seq_length:
        die(
            f"Longest record is {longest} tokens, over max_seq_length={args.max_seq_length}.",
            f"Re-run with --max-seq-length {2 ** (longest - 1).bit_length()}",
        )

    print(f"\n  Longest record {longest} <= {args.max_seq_length}. No truncation.")
    return train, val


# ══════════════════════════════════════════════════════════════════════════
# Stage 3 — the gate
# ══════════════════════════════════════════════════════════════════════════


def check_render_parity(args) -> None:
    stage(3, "Render parity  (the gate)")

    print("  Training renders with HuggingFace's chat template.")
    print("  Inference renders with Ollama's Go template.")
    print("  If they disagree, the model is trained on one format and served")
    print("  another — which half-works, and is far harder to debug than a")
    print("  clean failure.\n")

    from verify_render import verify

    reference = args.reference
    if not Path(reference).exists() and Path(args.data_dir, "reference_renders.json").exists():
        reference = str(Path(args.data_dir, "reference_renders.json"))

    code = verify(args.model, reference, show=1)
    if code != 0:
        die(
            "The training format does not match the serving format.",
            "Read the diff above. Do NOT train through this — see\n"
            "       specs/012-sft-training.md section 3 for what each case means.",
        )


# ══════════════════════════════════════════════════════════════════════════
# Stages 4-6 — train, check, export
# ══════════════════════════════════════════════════════════════════════════


def train(args, train_ds, val_ds):
    stage(4, "Training")

    import train_qwen3 as T

    # The runner's CLI args win over the module defaults, so everything is
    # controllable from one command line.
    T.MODEL_NAME = args.model
    T.MAX_SEQ_LENGTH = args.max_seq_length
    T.EPOCHS = args.epochs
    T.OUTPUT_DIR = args.output_dir

    print(f"  model      : {T.MODEL_NAME}")
    print(f"  seq length : {T.MAX_SEQ_LENGTH}")
    print(f"  epochs     : {T.EPOCHS}")
    print(f"  checkpoints: {T.OUTPUT_DIR}")
    if not args.output_dir.startswith("/content/drive"):
        # Colab free disconnects, and the local disk goes with the session.
        print(f"               (not on Drive — a disconnect loses these)")
    print()

    model, tokenizer = T.load_model()
    trainer = T.build_trainer(model, tokenizer, train_ds, val_ds)

    # Hard-fails under 50% masked. Without masking, ~85% of the gradient goes
    # into teaching the model to recite its own system prompt.
    T.verify_masking(trainer, tokenizer)

    if args.skip_train:
        print("\n  --skip-train: stopping before the training loop.")
        print("  Everything up to here passed, so the pipeline is sound.")
        return model, tokenizer, None

    print(f"\n  Starting. Expect 20-40 min on a T4. Keep this tab open.\n")
    stats = trainer.train()
    runtime = stats.metrics["train_runtime"] / 60
    print(f"\n  Trained in {runtime:.1f} min.")
    print(f"  Check eval_loss above: falling then flat is good. Rising after")
    print(f"  epoch 1 means overfitting — use the epoch-1 checkpoint.")
    return model, tokenizer, stats


def smoke(model, tokenizer, val_ds) -> None:
    stage(5, "Smoke test")
    print("  Want ONE well-formed block and nothing wrapped around it:\n")
    print('      <tool_call>')
    print('      {"name": "readFile", "arguments": {"path": "..."}}')
    print('      </tool_call>\n')

    import train_qwen3 as T

    T.smoke_test(model, tokenizer, val_ds)


def export(args, model, tokenizer) -> None:
    stage(6, "Export to GGUF")
    print(f"  Building llama.cpp in-session. 10-20 min, and the flakiest step.")
    print(f"  If it fails, the merged-16bit fallback is in README.md step 5.\n")

    try:
        model.save_pretrained_gguf(
            args.gguf_name, tokenizer, quantization_method="q4_k_m"
        )
    except Exception as err:  # noqa: BLE001 — anything here is worth reporting whole
        print(f"\n  GGUF export failed: {type(err).__name__}: {err}")
        print(f"  The LoRA adapters are safe in {args.output_dir} — nothing is lost.")
        print(f"  See README.md step 5 for the fallback path.")
        return

    # Getting the file OUT is a separate failure mode from producing it, so it
    # gets its own handling: a 2.5GB browser download from Colab often dies.
    drive = Path("/content/drive/MyDrive")
    if drive.exists():
        copied = 0
        for gguf in Path(".").glob(f"{args.gguf_name}*/*.gguf"):
            shutil.copy(gguf, drive / gguf.name)
            print(f"  Copied {gguf.name} -> Drive")
            copied += 1
        for gguf in Path(".").glob("*.gguf"):
            shutil.copy(gguf, drive / gguf.name)
            print(f"  Copied {gguf.name} -> Drive")
            copied += 1
        if copied == 0:
            print(f"  No .gguf found to copy — look for it under ./{args.gguf_name}/")
    else:
        print(f"  Drive not mounted. Mount it and copy the .gguf out, or it dies")
        print(f"  with the session:")
        print(f"      from google.colab import drive; drive.mount('/content/drive')")


# ══════════════════════════════════════════════════════════════════════════


def main() -> None:
    ap = argparse.ArgumentParser(description="End-to-end SFT run for the Zizou executor.")
    ap.add_argument("--model", default="unsloth/Qwen3-4B-Instruct-2507")
    ap.add_argument("--data-dir", default="/content")
    ap.add_argument("--reference", default="/content/reference_renders.json")
    ap.add_argument("--output-dir", default="/content/drive/MyDrive/zizou-training")
    ap.add_argument("--gguf-name", default="zizou-executor")
    ap.add_argument("--max-seq-length", type=int, default=8192)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--skip-train", action="store_true",
                    help="run every stage except the training loop — verifies the pipeline in ~6 min")
    ap.add_argument("--skip-export", action="store_true")
    args = ap.parse_args()

    # Imports resolve relative to this file, so the script works whether it is
    # run from /content or anywhere else.
    sys.path.insert(0, str(Path(__file__).resolve().parent))

    check_environment(args)
    train_ds, val_ds = prepare(args)
    check_render_parity(args)

    model, tokenizer, stats = train(args, train_ds, val_ds)

    if stats is not None:
        smoke(model, tokenizer, val_ds)
        if not args.skip_export:
            export(args, model, tokenizer)

    stage(7, "Done")
    print(f"  Total: {(time.time() - _t0) / 60:.1f} min\n")
    print(f"  Next, back on your own machine:")
    print(f"    1. Download the .gguf from Drive")
    print(f"    2. ollama show --modelfile qwen3:4b > Modelfile")
    print(f"       (edit only the FROM line to point at the .gguf)")
    print(f"    3. ollama create {args.gguf_name} -f Modelfile")
    print(f"    4. bun run eval -- --provider ollama --repeat 5")
    print(f"\n  Step 4 is the one that answers whether any of this worked.")


if __name__ == "__main__":
    main()
