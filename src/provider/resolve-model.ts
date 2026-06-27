/**
 * resolve-model.ts — Resolves a LanguageModel instance based on configuration.
 *
 * Layer: provider
 * Allowed imports: config/
 * NOT allowed to import from: tools/, ui/, agent/.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { LanguageModel } from "ai";
import { getApiKey, ProviderChoice } from "../config/api-keys.js";

/**
 * Resolves the requested provider to an active LanguageModel instance.
 */
export function resolveModel(provider: ProviderChoice): LanguageModel {
  const apiKey = getApiKey(provider);

  if (!apiKey) {
    throw new Error(
      `No API key found for provider "${provider}". ` +
      `Please ensure it is set via the CLI setup or environment variables.`
    );
  }

  if (provider === "anthropic") {
    // Claude 3.5 Sonnet is the recommended model for coding tasks
    const anthropic = createAnthropic({ apiKey });
    return anthropic("claude-3-5-sonnet-latest");
  }

  if (provider === "openrouter") {
    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey,
    });
    return openrouter("anthropic/claude-3.5-sonnet"); // default fallback for openrouter
  }

  if (provider === "openai") {
    // GPT-4o is the recommended model for OpenAI
    const openai = createOpenAI({ apiKey });
    return openai("gpt-4o");
  }

  if (provider === "google") {
    // Gemini 2.0 Flash is the recommended model for Google
    const google = createGoogleGenerativeAI({ apiKey });
    return google("gemini-2.0-flash");
  }

  if (provider === "groq") {
    // LLaMA 3.3 70B on Groq
    const groq = createGroq({ apiKey });
    return groq("llama-3.3-70b-versatile");
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
