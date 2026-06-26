/**
 * provider/index.ts — Model provider abstraction layer.
 *
 * Layer: provider
 * Allowed imports: config/
 * NOT allowed to import from: agent/, ui/, tools/
 *
 * This file configures the underlying LLM providers (e.g., Anthropic, OpenRouter, Google, Groq)
 * and exports a uniform way to obtain the configured model for the agent.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { getApiKey, ProviderName } from "../config/index.js";

/**
 * Creates and configures the OpenRouter provider instance using the
 * OpenAI compatibility layer.
 */
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: getApiKey("openrouter") ?? "NO_KEY",
  // OpenRouter specific headers recommended for logging/routing
  headers: {
    "HTTP-Referer": "https://github.com/arnv/zizou",
    "X-Title": "Zizou CLI",
  },
});

/**
 * Creates and configures the Google Generative AI provider instance.
 */
const google = createGoogleGenerativeAI({
  apiKey: getApiKey("google") ?? "NO_KEY",
});

/**
 * Creates and configures the Groq provider instance.
 */
const groq = createGroq({
  apiKey: getApiKey("groq") ?? "NO_KEY",
});

/**
 * getModel — Returns a language model instance for Zizou.
 * Can be dynamically configured via parameter.
 */
export function getModel(provider: ProviderName = "openrouter") {
  switch (provider) {
    case "google":
      // Using Gemini 2.0 Flash
      return google("gemini-2.0-flash");
    case "groq":
      // Using LLaMA 3.3 70B on Groq
      return groq("llama-3.3-70b-versatile");
    case "openrouter":
    default:
      // Using a popular free model on OpenRouter
      return openrouter("google/gemma-4-26b-a4b-it:free");
  }
}
