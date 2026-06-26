// src/provider.ts
//
// This is the actual "multi-provider" piece you asked about way back.
// The AI SDK's `tool()` definitions and the agent LOOP (generateText/
// streamText) are IDENTICAL regardless of provider — that's the whole
// point of using the AI SDK instead of hand-rolling this. The ONLY
// thing that differs is which `model` object you pass in. Everything
// downstream (tools, loop, UI) doesn't know or care which provider
// it's talking to.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { getApiKey, getDefaultProvider, type ProviderName } from "./config.js";
import type { LanguageModel } from "ai";

export function resolveModel(providerOverride?: ProviderName): LanguageModel {
  const provider = providerOverride ?? getDefaultProvider();
  const key = getApiKey(provider);

  if (!key) {
    throw new Error(
      `No API key found for ${provider}. Run "zizou config" to set one, ` +
        `or set ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} as an env var.`
    );
  }

  // IMPORTANT: the plain `anthropic` / `openai` exports from these packages
  // are pre-built singletons that read the API key from an env var ONLY.
  // To pass a key explicitly (which we must, since it comes from our own
  // config file, not necessarily an env var) you need the `create*` factory
  // function instead. This is a real, easy-to-miss gotcha — verified against
  // the actual package types, not guessed.
  if (provider === "anthropic") {
    const anthropicProvider = createAnthropic({ apiKey: key });
    return anthropicProvider("claude-sonnet-4-6");
  }
  const openaiProvider = createOpenAI({ apiKey: key });
  return openaiProvider("gpt-4o");
}
