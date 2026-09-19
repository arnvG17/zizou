/**
 * api-keys.ts — Configuration storage for API keys and defaults.
 *
 * Layer: config
 * Allowed imports: none from within the project (this is the base layer).
 * NOT allowed to import from: tools/, context/, sdk/, ui/, agent/.
 */

import Conf from "conf";

export type ProviderChoice = "anthropic" | "openai" | "openrouter" | "google" | "groq" | "ollama";

interface ConfigSchema {
  apiKeys: {
    anthropic?: string;
    openai?: string;
    openrouter?: string;
    google?: string;
    groq?: string;
    /** Optional — Ollama doesn't require a real API key by default */
    ollama?: string;
  };
  defaultProvider?: ProviderChoice;
  /** Custom model overrides per provider (e.g. "llama3:latest" for ollama) */
  providerModels?: Partial<Record<ProviderChoice, string>>;
  /** Ollama base URL — defaults to http://localhost:11434 */
  ollamaBaseUrl?: string;
}

const config = new Conf<ConfigSchema>({
  projectName: "zizou",
  defaults: {
    apiKeys: {},
    providerModels: {},
  },
});

/**
 * Retrieves the API key for a given provider.
 * Environment variables ALWAYS take precedence over the saved config.
 */
export function getApiKey(provider: ProviderChoice): string | undefined {
  if (provider === "anthropic") {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    return config.get("apiKeys.anthropic") as string | undefined;
  }
  if (provider === "openai") {
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
    return config.get("apiKeys.openai") as string | undefined;
  }
  if (provider === "openrouter") {
    if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
    return config.get("apiKeys.openrouter") as string | undefined;
  }
  if (provider === "google") {
    if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
    return config.get("apiKeys.google") as string | undefined;
  }
  if (provider === "groq") {
    if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
    return config.get("apiKeys.groq") as string | undefined;
  }
  if (provider === "ollama") {
    if (process.env.OLLAMA_API_KEY) return process.env.OLLAMA_API_KEY;
    return (config.get("apiKeys.ollama") as string | undefined) ?? "ollama";
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
 * Removes the API key for a single provider (without affecting other keys).
 */
export function removeApiKey(provider: ProviderChoice): void {
  const keys = config.get("apiKeys") ?? {};
  delete keys[provider];
  config.set("apiKeys", keys);
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
    getApiKey("groq") ||
    // Ollama is always "available" if chosen — no real key required
    getDefaultProvider() === "ollama"
  );
}

/**
 * Retrieves the default provider choice.
 * Priority when no defaultProvider is saved:
 *   1. OPENAI_API_KEY env var  → "openai"
 *   2. GROQ_API_KEY env var    → "groq"
 *   3. Fallback                → "groq"
 */
export function getDefaultProvider(): ProviderChoice {
  const saved = config.get("defaultProvider");
  if (saved) return saved;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GROQ_API_KEY) return "groq";
  return "groq";
}

/**
 * Saves the default provider choice.
 */
export function setDefaultProvider(provider: ProviderChoice): void {
  config.set("defaultProvider", provider);
}

/**
 * Gets the active model override for a provider (or undefined = use built-in default).
 */
export function getProviderModel(provider: ProviderChoice): string | undefined {
  const models = config.get("providerModels") ?? {};
  return models[provider];
}

/**
 * Sets a custom model string for a provider.
 */
export function setProviderModel(provider: ProviderChoice, model: string): void {
  const models = config.get("providerModels") ?? {};
  models[provider] = model;
  config.set("providerModels", models);
}

/**
 * Gets the Ollama base URL (defaults to http://localhost:11434).
 */
export function getOllamaBaseUrl(): string {
  if (process.env.OLLAMA_BASE_URL) return process.env.OLLAMA_BASE_URL;
  return config.get("ollamaBaseUrl") ?? "http://localhost:11434";
}

/**
 * Sets the Ollama base URL.
 */
export function setOllamaBaseUrl(url: string): void {
  config.set("ollamaBaseUrl", url);
}

/**
 * Resets/clears all stored configuration keys and provider choice.
 */
export function clearApiKeys(): void {
  config.clear();
}

