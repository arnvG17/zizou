# model_config.md — Zizou AI Configuration
# Edit this file directly to change inference settings.
# Changes take effect on the next message — no restart needed.
#
# Available presets for provider "openai":
#   fast     → model: gpt-5-mini, reasoning: low
#   balanced → model: gpt-5-mini, reasoning: medium
#   high     → model: gpt-5, reasoning: high
#   testing  → model: gpt-5-mini, reasoning: low
#
# Reasoning levels: low | medium | high
# Temperature: 0.0 – 1.0  (lower = more deterministic)
# MaxTokens: max output tokens per response

provider: openai
model: gpt-5-mini
preset: balanced
reasoning: medium
temperature: 0.2
maxTokens: 2048
