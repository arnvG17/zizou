"""
test_render_utils.py — guards the two transforms that decide what gets trained.

Pure Python, no transformers or GPU needed:

    python test_render_utils.py

The empty-think case is the one that matters. It was a real defect found by
running verify_render.py against a live tokenizer: Qwen3's HuggingFace
template injected `<think>\\n\\n</think>` before every assistant text turn, in
27 of 27 records, while Ollama's template injected none. Training on that
would have taught the model to prefix every prose answer with empty reasoning
tags that the serving side never showed it.
"""

import sys

from render_utils import (
    normalize_for_compare,
    strip_empty_think,
    tool_call_spans,
)

failures: list[str] = []


def check(name: str, actual, expected) -> None:
    if actual == expected:
        print(f"  ok   {name}")
    else:
        failures.append(name)
        print(f"  FAIL {name}\n       expected: {expected!r}\n       actual:   {actual!r}")


print("strip_empty_think")

check(
    "removes the block Qwen3 injects",
    strip_empty_think("<|im_start|>assistant\n<think>\n\n</think>\n\nDone.<|im_end|>"),
    "<|im_start|>assistant\nDone.<|im_end|>",
)

check(
    "removes a block with no inner whitespace",
    strip_empty_think("<think></think>Done."),
    "Done.",
)

check(
    "KEEPS a block with real reasoning",
    # If a future dataset carries genuine reasoning, deleting it silently
    # would be far worse than leaving an empty block in.
    strip_empty_think("<think>The file has two matches.</think>\n\nDone."),
    "<think>The file has two matches.</think>\n\nDone.",
)

check(
    "leaves text with no think block untouched",
    strip_empty_think("Just an answer."),
    "Just an answer.",
)

check(
    "removes several blocks in one document",
    strip_empty_think("a<think>\n</think>b<think>  </think>c"),
    "abc",
)


print("\nnormalize_for_compare")

# Ollama's Go template emits compact JSON; HuggingFace emits spaced. Same
# meaning, different tokens, and only inside <tools>.
compact = '<tools>\n{"type":"function","function":{"name":"readFile"}}\n</tools>'
spaced = '<tools>\n{"type": "function", "function": {"name": "readFile"}}\n</tools>'
check("JSON key spacing inside <tools> is normalized",
      normalize_for_compare(compact), normalize_for_compare(spaced))

check(
    "trailing whitespace is ignored",
    normalize_for_compare("line one   \nline two\t"),
    "line one\nline two",
)

check(
    "blank-line runs collapse",
    normalize_for_compare("a\n\n\n\n\nb"),
    "a\n\nb",
)

# The negative cases: things that must NOT be normalized away, because each
# one changes what the model emits or how Ollama parses it back.
check(
    "a DIFFERENT tool name is still a difference",
    normalize_for_compare('<tool_call>{"name":"readFile"}</tool_call>')
    == normalize_for_compare('<tool_call>{"name":"writeFile"}</tool_call>'),
    False,
)

check(
    "JSON spacing OUTSIDE <tools> is NOT normalized",
    # Inside a tool_call, spacing is part of the emission contract.
    normalize_for_compare('<tool_call>\n{"name":"readFile"}\n</tool_call>')
    == normalize_for_compare('<tool_call>\n{"name": "readFile"}\n</tool_call>'),
    False,
)

check(
    "missing tags are still a difference",
    normalize_for_compare("<tool_call>x</tool_call>") == normalize_for_compare("x"),
    False,
)


print("\ntool_call_spans")

doc = (
    "<|im_start|>assistant\n"
    '<tool_call>\n{"name": "readFile", "arguments": {"path": "a.ts"}}\n</tool_call><|im_end|>\n'
    "<|im_start|>assistant\n"
    '<tool_call>\n{"name": "editFile", "arguments": {"path": "a.ts"}}\n</tool_call><|im_end|>'
)
spans = tool_call_spans(doc)
check("extracts every call", len(spans), 2)
check("first span is the whole block", spans[0].startswith("<tool_call>"), True)
check("spans exclude surrounding chat markup", "im_start" in spans[0], False)
check("a document with no calls yields none", tool_call_spans("just prose"), [])


print()
if failures:
    print(f"FAILED: {len(failures)} check(s): {', '.join(failures)}")
    sys.exit(1)
print("All checks passed.")
