// src/config.ts
//
// Handles where Zizou stores the user's API key on their machine.
//
// `conf` stores a JSON file in the OS's standard config directory
// (e.g. ~/.config/zizou-nodejs/config.json on Linux, ~/Library/Preferences
// on Mac). This is NOT a secrets vault (no encryption) — for a true
// production tool you'd later upgrade to the OS keychain via a library
// like `keytar`. For now, this is the same tier of storage most CLI tools
// (like the `gh` CLI before it added keychain support) start with, and
// it's a huge step up from "API key hardcoded in a script" or "in a
// plaintext .env you might accidentally commit."

import Conf from "conf";

export type ProviderName = "anthropic" | "openai";

interface ZizouConfig {
  apiKeys: Partial<Record<ProviderName, string>>;
  defaultProvider: ProviderName;
}

const store = new Conf<ZizouConfig>({
  projectName: "zizou",
  defaults: {
    apiKeys: {},
    defaultProvider: "anthropic",
  },
});

export function getApiKey(provider: ProviderName): string | undefined {
  // Priority: env var (lets power users / CI override) > saved config
  const envKey = provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (envKey) return envKey;
  return store.get("apiKeys")[provider];
}

export function setApiKey(provider: ProviderName, key: string): void {
  const keys = store.get("apiKeys");
  keys[provider] = key;
  store.set("apiKeys", keys);
}

export function hasAnyApiKey(): boolean {
  return Boolean(getApiKey("anthropic") || getApiKey("openai"));
}

export function getDefaultProvider(): ProviderName {
  return store.get("defaultProvider");
}

export function setDefaultProvider(provider: ProviderName): void {
  store.set("defaultProvider", provider);
}

export function getConfigPath(): string {
  return store.path;
}
