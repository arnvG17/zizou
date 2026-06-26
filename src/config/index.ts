/**
 * config/index.ts — Configuration and credential management.
 *
 * Layer: config
 * Allowed imports: none (from within Zizou).
 *
 * Manages configuration and API keys using `conf`. It provides
 * environment variable fallbacks for power users/CI.
 */
import Conf from "conf";

export type ProviderName = "openrouter" | "anthropic" | "openai" | "google" | "groq";

interface ZizouConfig {
  apiKeys: Partial<Record<ProviderName, string>>;
  defaultProvider: ProviderName;
}

const store = new Conf<ZizouConfig>({
  projectName: "zizou",
  defaults: {
    apiKeys: {},
    defaultProvider: "openrouter",
  },
});

/**
 * Retrieves the API key for a given provider.
 * Environment variables take precedence over saved config.
 */
export function getApiKey(provider: ProviderName): string | undefined {
  if (provider === "openrouter" && process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY;
  }
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  if (provider === "google" && process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY;
  }
  if (provider === "groq" && process.env.GROQ_API_KEY) {
    return process.env.GROQ_API_KEY;
  }
  return store.get("apiKeys")[provider];
}

/**
 * Saves the API key for a given provider into the persistent config file.
 */
export function setApiKey(provider: ProviderName, key: string): void {
  const keys = store.get("apiKeys");
  keys[provider] = key;
  store.set("apiKeys", keys);
}
