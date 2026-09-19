/**
 * resolve-model.ts — Resolves a LanguageModel instance based on configuration.
 *
 * Layer: sdk
 * Allowed imports: config/
 * NOT allowed to import from: tools/, ui/, agent/.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { LanguageModel } from "ai";
import {
  getApiKey,
  ProviderChoice,
  getProviderModel,
  getOllamaBaseUrl,
} from "../config/api-keys.js";

/**
 * Default model IDs for each provider (used when no custom override is set).
 */
export const DEFAULT_MODELS: Record<ProviderChoice, string> = {
  anthropic: "claude-3-5-sonnet-latest",
  openrouter: "google/gemma-4-31b-it:free",
  openai: "gpt-4o-mini",
  google: "gemini-2.5-flash",
  groq: "llama-3.3-70b-versatile",
  ollama: "qwen3:4b",
};

/**
 * Returns the active model ID for a provider: custom override → built-in default.
 */
export function getActiveModelId(provider: ProviderChoice): string {
  return getProviderModel(provider) ?? DEFAULT_MODELS[provider];
}

/**
 * Resolves the requested provider to an active LanguageModel instance.
 *
 * @param modelIdOverride - The exact model to call. Callers that have already
 *   resolved configuration (see config/agent-config.ts) pass it explicitly.
 *   Without it we fall back to the per-provider stored model.
 *
 *   This parameter is why the effort dial works. The old preset system chose
 *   a model, stored it, and then never passed it here — resolveModel always
 *   read the value /model had written — so switching preset changed nothing
 *   about which model was actually called.
 */
export function resolveModel(
  provider: ProviderChoice,
  modelIdOverride?: string,
): LanguageModel {
  const modelId = modelIdOverride ?? getActiveModelId(provider);

  if (provider === "anthropic") {
    const apiKey = getApiKey("anthropic");
    if (!apiKey) throw new Error(`No API key for Anthropic. Run /keys to set one.`);
    const anthropic = createAnthropic({ apiKey });
    return anthropic(modelId);
  }

  if (provider === "openrouter") {
    const apiKey = getApiKey("openrouter");
    if (!apiKey) throw new Error(`No API key for OpenRouter. Run /keys to set one.`);
    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey,
      headers: {
        "HTTP-Referer": "https://github.com/arnv/zizou",
        "X-Title": "Zizou CLI",
      },
    });
    return openrouter(modelId);
  }

  if (provider === "openai") {
    const apiKey = getApiKey("openai");
    if (!apiKey) throw new Error(`No API key for OpenAI. Run /keys to set one.`);
    const openai = createOpenAI({ apiKey });
    return openai(modelId);
  }

  if (provider === "google") {
    const apiKey = getApiKey("google");
    if (!apiKey) throw new Error(`No API key for Google Gemini. Run /keys to set one.`);
    const google = createGoogleGenerativeAI({ apiKey });
    return google(modelId);
  }

  if (provider === "groq") {
    const apiKey = getApiKey("groq");
    if (!apiKey) throw new Error(`No API key for Groq. Run /keys to set one.`);
    const groq = createGroq({ apiKey });
    return groq(modelId);
  }

  if (provider === "ollama") {
    // Ollama exposes an OpenAI-compatible REST API at localhost:11434 by default.
    // No real API key is needed for a local instance.
    const baseURL = getOllamaBaseUrl();
    const apiKey = getApiKey("ollama") ?? "ollama"; // placeholder — Ollama ignores it
    const ollama = createOpenAI({
      baseURL: `${baseURL}/v1`,
      apiKey,
    });
    return ollama(modelId);
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

