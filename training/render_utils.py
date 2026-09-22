"""
render_utils.py — the one place a record becomes training text.

WHY THIS IS A SHARED MODULE AND NOT A FUNCTION IN EACH SCRIPT

prepare_data.py renders the text that gets trained on. verify_render.py
renders text to compare against what Ollama serves. If those two ever render
differently, the verification passes while the training data is wrong — the
check would be actively misleading rather than merely useless. One function,
imported by both, makes that impossible.
"""

import json
import re

# ──────────────────────────────────────────────────────────────────────────
# The empty-think problem
# ──────────────────────────────────────────────────────────────────────────
#
# Qwen3's HuggingFace chat template injects an empty reasoning block before
# every assistant TEXT turn (not before tool-call turns):
#
#     <|im_start|>assistant
#     <think>
#
#     </think>
#
#     Updated the cache timeout to 10000ms.<|im_end|>
#
# This was measured, not assumed: it appears in 27 of 27 reference records,
# exactly once each, on the final text message.
#
# Ollama's template emits no such block, so training on it would teach the
# model to prefix every prose answer with empty think tags that the serving
# side never showed it — and Zizou sends `think: false` at runtime (spec 009),
# so the model would be producing reasoning scaffolding for a mode that is
# switched off. Best case Ollama strips it; worst case `<think></think>`
# appears verbatim in the user's chat.
#
# We are training a non-thinking model on a non-thinking dataset, so the
# blocks are removed. Train what you intend to serve.

EMPTY_THINK = re.compile(r"<think>\s*</think>\s*", re.DOTALL)


def strip_empty_think(text: str) -> str:
    """
    Removes empty reasoning blocks, leaving non-empty ones alone.

    The emptiness check matters. If a future dataset carries real reasoning,
    this must not silently delete it — so the pattern requires whitespace only
    between the tags.
    """
    return EMPTY_THINK.sub("", text)


def render_record(record: dict, tokenizer) -> str:
    """
    One dataset record → the exact string the model is trained on.

    `system` is stored separately in the record because that is how Zizou's
    runtime holds it (buildSystemPrompt returns a string; the AI SDK takes it
    as its own parameter). Chat templates want it as the first message, so the
    translation happens here rather than in the stored data.

    `add_generation_prompt=False` because the record already ends on an
    assistant turn. True would append a dangling `<|im_start|>assistant` with
    nothing after it, teaching the model that conversations end by starting to
    speak and then stopping.
    """
    messages = [{"role": "system", "content": record["system"]}] + record["messages"]
    text = tokenizer.apply_chat_template(
        messages,
        tools=record["tools"],
        tokenize=False,
        add_generation_prompt=False,
    )
    return strip_empty_think(text)


# ──────────────────────────────────────────────────────────────────────────
# Comparison
# ──────────────────────────────────────────────────────────────────────────


def _respace_json_objects(text: str) -> str:
    """
    Re-serializes JSON objects inside <tools> with one consistent spacing.

    Ollama's Go template emits compact JSON (`{"name":"readFile"`), HuggingFace
    emits spaced (`{"name": "readFile"`). Semantically identical, different
    tokens. It is a genuine difference in the PROMPT the model reads, but not
    in the text it is trained to PRODUCE, so it is normalized for comparison
    rather than treated as a failure.

    Only lines inside the <tools> block are touched, so a difference anywhere
    else still shows up as a mismatch.
    """
    out = []
    in_tools = False
    for line in text.split("\n"):
        if line.strip() == "<tools>":
            in_tools = True
            out.append(line)
            continue
        if line.strip() == "</tools>":
            in_tools = False
            out.append(line)
            continue
        if in_tools and line.strip().startswith("{"):
            try:
                out.append(json.dumps(json.loads(line.strip()), sort_keys=True))
                continue
            except json.JSONDecodeError:
                pass  # not JSON after all — compare it literally
        out.append(line)
    return "\n".join(out)


def normalize_for_compare(text: str) -> str:
    """
    Removes differences that provably cannot change what the model emits.

    Kept deliberately small: every entry here is a difference we choose to
    tolerate, and each one is somewhere a real bug could hide.

      - trailing whitespace, collapsed blank runs
      - JSON key spacing inside <tools> (see above)

    NOT normalized: the <tool_call> delimiters, the tag wording, message
    order, or where the tool schemas sit. Those are the contract.
    """
    text = _respace_json_objects(text)
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def tool_call_spans(text: str) -> list[str]:
    """
    The spans the model is actually trained to emit.

    These must match byte for byte. Everything else is prompt; this is the
    output contract, and it is what Ollama's parser reads back.
    """
    return [
        normalize_for_compare(m)
        for m in re.findall(r"<tool_call>.*?</tool_call>", text, re.DOTALL)
    ]
