"""
verify_render.py — prove the training format matches the serving format.

THE FAILURE THIS PREVENTS

Two independent things render the same conversation:

  TRAINING    tokenizer.apply_chat_template(...)  — HuggingFace, in Python
  SERVING     Ollama's Go template                — at inference, in Zizou

If they disagree by so much as a newline around <tool_call>, the model is
trained on one format and served another. That does not fail loudly. It
half-works: the model emits something close enough that Ollama's parser
sometimes recovers it and sometimes does not, and the symptom looks like "the
model is bad at tool calling" — which is exactly the conclusion that started
this whole project.

evals/sft/render.ts holds a transcription of the live Ollama template (read
from /api/show). This script renders the same records with HuggingFace and
diffs. Run it BEFORE training, every time the base model changes.

Usage:
    bun run evals/sft/render.ts --out training/reference_renders.json --per-band 3
    python verify_render.py --model unsloth/Qwen3-4B-Instruct-2507
"""

import argparse
import difflib
import json
import sys
from pathlib import Path

from transformers import AutoTokenizer

# The SAME renderer prepare_data.py uses. Importing it rather than
# reimplementing is the point: if this file rendered differently, the check
# would pass while the training data was wrong, which is worse than no check.
from render_utils import (
    normalize_for_compare as normalize,
    render_record,
    tool_call_spans as extract_tool_call_spans,
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="unsloth/Qwen3-4B-Instruct-2507")
    ap.add_argument("--reference", default="./reference_renders.json")
    ap.add_argument("--show", type=int, default=2, help="how many diffs to print in full")
    args = ap.parse_args()

    ref_path = Path(args.reference)
    if not ref_path.exists():
        print(
            f"No reference at {ref_path}.\n"
            f"Generate it first:\n"
            f"  bun run evals/sft/render.ts --out training/reference_renders.json --per-band 3",
            file=sys.stderr,
        )
        return 2

    records = json.loads(ref_path.read_text(encoding="utf-8"))
    tokenizer = AutoTokenizer.from_pretrained(args.model)

    print(f"Comparing {len(records)} records: HuggingFace template vs Ollama template")
    print(f"Model: {args.model}\n")

    exact, span_only, mismatched = 0, 0, []

    for rec in records:
        hf = render_record(rec, tokenizer)

        if normalize(hf) == normalize(rec["rendered"]):
            exact += 1
            continue

        # A whole-document mismatch is not automatically fatal: the two
        # templates can legitimately differ in the system preamble's wording
        # while agreeing perfectly on what the model must EMIT. The tool-call
        # spans are the part that has to be byte-identical, because they are
        # the training target and the thing Ollama's parser reads back.
        if extract_tool_call_spans(hf) == extract_tool_call_spans(rec["rendered"]):
            span_only += 1
            continue

        mismatched.append((rec, hf))

    print(f"  exact match          : {exact}")
    print(f"  tool-call spans match: {span_only}  (preamble differs, emission identical)")
    print(f"  MISMATCHED           : {len(mismatched)}")

    if not mismatched:
        bands = sorted({r["band"] for r in records})
        print(f"\nPASS — {len(bands)} bands checked: {', '.join(bands)}")
        if span_only:
            print(
                "\nNote: some preambles differ. That is tolerable — it changes the\n"
                "prompt the model reads, not the text it is trained to produce.\n"
                "Worth eyeballing once with --show if you have not before."
            )
        return 0

    print("\nFAIL — the model would be trained on a format Ollama does not serve.\n")
    for rec, hf in mismatched[: args.show]:
        print("=" * 78)
        print(f"{rec['id']}  [{rec['band']}]")
        print("=" * 78)
        diff = difflib.unified_diff(
            normalize(rec["rendered"]).split("\n"),
            normalize(hf).split("\n"),
            fromfile="ollama (serving)",
            tofile="huggingface (training)",
            lineterm="",
            n=2,
        )
        for line in list(diff)[:60]:
            print(line)
        print()

    if len(mismatched) > args.show:
        print(f"... and {len(mismatched) - args.show} more")

    print(
        "\nWhat to do:\n"
        "  - If HuggingFace is right, update renderQwen3() in evals/sft/render.ts.\n"
        "  - If Ollama is right, you are on a base model whose HF template does\n"
        "    not match the GGUF's. Pick a different base, or set the Modelfile\n"
        "    TEMPLATE explicitly from `ollama show --modelfile <base>`.\n"
        "  - Do not 'fix' this by loosening normalize()."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
