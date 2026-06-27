/**
 * api-keys.ts — Configuration storage for API keys and defaults.
 *
 * Layer: config
 * Allowed imports: none from within the project (this is the base layer).
 * NOT allowed to import from: tools/, context/, provider/, ui/, agent/.
 */

import Conf from "conf";

export type ProviderChoice = "anthropic" | "openai" | "openrouter" | "google" | "groq";

interface ConfigSchema {
  apiKeys: {
    anthropic?: string;
    openai?: string;
    openrouter?: string;
    google?: string;
    groq?: string;
  };
  defaultProvider?: ProviderChoice;
}

const config = new Conf<ConfigSchema>({
  projectName: "zizou",
  defaults: {
    apiKeys: {},
  },
});

/**
 * Retrieves the API key for a given provider.
 * Environment variables ALWAYS take precedence over the saved config.
 */
export function getApiKey(provider: ProviderChoice): string | undefined {
  if (provider === "anthropic") {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    return config.get("apiKeys.anthropic");
  }
  if (provider === "openai") {
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
    return config.get("apiKeys.openai");
  }
  if (provider === "openrouter") {
    if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
    return config.get("apiKeys.openrouter");
  }
  if (provider === "google") {
    if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
    return config.get("apiKeys.google");
  }
  if (provider === "groq") {
    if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
    return config.get("apiKeys.groq");
  }
  return undefined;
}

/**
 * Saves the API key for a given provider to disk.
 */
export function setApiKey(provider: ProviderChoice, key: string): void {
  config.set(`apiKeys.${provider}`, key);
}

/**
 * Checks if ANY provider has a valid API key (either in env or on disk).
 */
export function hasAnyApiKey(): boolean {
  return !!(
    getApiKey("anthropic") ||
    getApiKey("openai") ||
    getApiKey("openrouter") ||
    getApiKey("google") ||
    getApiKey("groq")
  );
}

/**
 * Retrieves the default provider choice. Defaults to "groq" if not set.
 */
export function getDefaultProvider(): ProviderChoice {
  if (process.env.GROQ_API_KEY && !config.get("defaultProvider")) {
    return "groq";
  }
  return config.get("defaultProvider") || "groq";
}

/**
 * Saves the default provider choice.
 */
export function setDefaultProvider(provider: ProviderChoice): void {
  config.set("defaultProvider", provider);
}

/**
 * Resets/clears all stored configuration keys and provider choice.
 */
export function clearApiKeys(): void {
  config.clear();
}
