"""
prepare_data.py — turn Zizou's SFT JSONL into a HuggingFace Dataset.

WHAT THIS DOES, AND THE ONE THING THAT MATTERS

Each record in evals/sft/data/*.jsonl holds three things: the system prompt,
the tool schemas, and the messages. The model never sees them as three things
— the chat template weaves them into one string, putting the tool schemas
INSIDE the system block. So the only correct way to build the training text
is to hand all three to the tokenizer's own template:

    tokenizer.apply_chat_template(messages, tools=tools, tokenize=False)

Not a hand-written f-string. The tokenizer ships the authoritative template,
and a hand-rolled copy drifts silently — the result is a model trained on
almost-right delimiters, which half-works, which is harder to debug than
something that fails outright. verify_render.py exists to prove the template
we get here matches what Ollama serves.

Usage:
    python prepare_data.py --data-dir ../evals/sft/data --model unsloth/Qwen3-4B-Instruct-2507
"""

import argparse
import json
import os
from pathlib import Path

from datasets import Dataset
from transformers import AutoTokenizer

# Shared with verify_render.py so the text that gets VERIFIED is byte-for-byte
# the text that gets TRAINED on.
from render_utils import render_record


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def build_split(path: Path, tokenizer) -> Dataset:
    records = load_jsonl(path)
    if not records:
        raise SystemExit(f"No records in {path}")

    texts, bands, ids = [], [], []
    for r in records:
        texts.append(render_record(r, tokenizer))
        bands.append(r["meta"]["band"])
        ids.append(r["meta"]["id"])

    return Dataset.from_dict({"text": texts, "band": bands, "id": ids})


def report_lengths(ds: Dataset, tokenizer, name: str) -> int:
    """
    Token-length percentiles from the REAL tokenizer.

    The manifest carries an estimate (chars / 3.6). If these numbers come out
    far from it, the render is wrong — most likely the tools did not make it
    into the template, which would drop ~2k tokens per record and is otherwise
    invisible until the model is served schemas it never trained on.
    """
    lengths = sorted(len(tokenizer(t, add_special_tokens=False)["input_ids"]) for t in ds["text"])
    n = len(lengths)
    p = lambda q: lengths[min(n - 1, int(n * q))]
    print(
        f"  {name}: {n} records | tokens p50 {p(0.50)} p95 {p(0.95)} max {lengths[-1]}"
    )
    return lengths[-1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="../evals/sft/data")
    ap.add_argument("--model", default="unsloth/Qwen3-4B-Instruct-2507")
    ap.add_argument("--out-dir", default="./data")
    ap.add_argument("--max-seq-length", type=int, default=8192)
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    tokenizer = AutoTokenizer.from_pretrained(args.model)

    print(f"Rendering with {args.model}'s chat template...")
    train = build_split(data_dir / "train.jsonl", tokenizer)
    val = build_split(data_dir / "val.jsonl", tokenizer)

    train_max = report_lengths(train, tokenizer, "train")
    val_max = report_lengths(val, tokenizer, "val")

    # A record longer than max_seq_length is silently TRUNCATED by the
    # trainer, and truncation lands on the end of the sequence — which is the
    # assistant's final turn, the part being trained. A truncated record
    # teaches the model to stop mid-answer.
    longest = max(train_max, val_max)
    if longest > args.max_seq_length:
        raise SystemExit(
            f"\nFAIL: longest record is {longest} tokens, over max_seq_length="
            f"{args.max_seq_length}.\nRaise --max-seq-length or drop the outliers — "
            f"do not train with silent truncation."
        )

    os.makedirs(args.out_dir, exist_ok=True)
    train.save_to_disk(f"{args.out_dir}/train")
    val.save_to_disk(f"{args.out_dir}/val")
    print(f"\nSaved to {args.out_dir}/  (max {longest} <= {args.max_seq_length}, OK)")

    # Eyeball the first record's tail: it should end with the assistant's
    # closing turn and an <|im_end|>, with no dangling generation prompt.
    print("\n--- tail of the first training record ---")
    print(train[0]["text"][-400:])


if __name__ == "__main__":
    main()
