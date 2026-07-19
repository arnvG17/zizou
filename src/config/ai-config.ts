/**
 * ai-config.ts — AI inference configuration (provider, model, preset, reasoning,
 * temperature, maxOutputTokens).
 *
 * Layer: config
 * Allowed imports: none from within the project (base layer).
 *
 * TWO sources of truth kept in sync:
 *   1. Conf store (binary, machine-specific) — used at runtime.
 *   2. model_config.md (human-readable, in the workspace root) — editable by
 *      hand; read on every config access so edits take effect without restart.
 *
 * Priority: model_config.md > Conf store. If model_config.md has a value,
 * it wins. If a field is missing from the .md it falls back to Conf, then
 * to the built-in default.
 */

import Conf from "conf";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReasoningLevel = "low" | "medium" | "high";

export type PresetName = "fast" | "balanced" | "high" | "testing";

export interface AIConfig {
  provider: string;
  model: string;
  preset: PresetName;
  reasoning: ReasoningLevel;
  temperature: number;
  maxOutputTokens: number;
}

// ─── Provider Presets ─────────────────────────────────────────────────────────
//
// Each provider maps preset names to model + reasoning pairs.
// Temperature and maxOutputTokens come from PRESET_DEFAULTS below.
// Adding a new provider only requires a new entry here — the /expert
// command logic is fully provider-agnostic.

interface PresetModelConfig {
  model: string;
  reasoning: ReasoningLevel;
}

export const PROVIDER_PRESETS: Record<string, Record<PresetName, PresetModelConfig>> = {
  openai: {
    fast:     { model: "gpt-5-mini",  reasoning: "low"    },
    balanced: { model: "gpt-5-mini",  reasoning: "medium" },
    high:     { model: "gpt-5",       reasoning: "high"   },
    testing:  { model: "gpt-5-mini",  reasoning: "low"    },
  },
  anthropic: {
    fast:     { model: "claude-haiku-4-5",          reasoning: "low"    },
    balanced: { model: "claude-sonnet-4-5",         reasoning: "medium" },
    high:     { model: "claude-opus-4-5",           reasoning: "high"   },
    testing:  { model: "claude-haiku-4-5",          reasoning: "low"    },
  },
  google: {
    fast:     { model: "gemini-2.0-flash",          reasoning: "low"    },
    balanced: { model: "gemini-2.5-flash",          reasoning: "medium" },
    high:     { model: "gemini-2.5-pro",            reasoning: "high"   },
    testing:  { model: "gemini-2.0-flash",          reasoning: "low"    },
  },
  groq: {
    fast:     { model: "llama-3.1-8b-instant",      reasoning: "low"    },
    balanced: { model: "llama-3.3-70b-versatile",   reasoning: "medium" },
    high:     { model: "llama-3.3-70b-versatile",   reasoning: "high"   },
    testing:  { model: "llama-3.1-8b-instant",      reasoning: "low"    },
  },
  openrouter: {
    fast:     { model: "meta-llama/llama-3.1-8b-instruct:free", reasoning: "low"    },
    balanced: { model: "meta-llama/llama-3.3-70b-instruct:free", reasoning: "medium" },
    high:     { model: "deepseek/deepseek-chat",    reasoning: "high"   },
    testing:  { model: "meta-llama/llama-3.1-8b-instruct:free", reasoning: "low"    },
  },
  ollama: {
    fast:     { model: "llama3",      reasoning: "low"    },
    balanced: { model: "llama3",      reasoning: "medium" },
    high:     { model: "llama3",      reasoning: "high"   },
    testing:  { model: "llama3",      reasoning: "low"    },
  },
};

// ─── Preset Defaults ──────────────────────────────────────────────────────────
//
// Temperature and maxOutputTokens are shared across all providers for a preset.

export const PRESET_DEFAULTS: Record<PresetName, { temperature: number; maxOutputTokens: number }> = {
  fast:     { temperature: 0.2, maxOutputTokens: 1024 },
  balanced: { temperature: 0.2, maxOutputTokens: 2048 },
  high:     { temperature: 0.1, maxOutputTokens: 4096 },
  testing:  { temperature: 0,   maxOutputTokens: 512  },
};

// ─── Built-in Defaults ────────────────────────────────────────────────────────

const BUILTIN_DEFAULT: AIConfig = {
  provider: "openai",
  model: "gpt-5-mini",
  preset: "balanced",
  reasoning: "medium",
  temperature: 0.2,
  maxOutputTokens: 2048,
};

// ─── Conf Store ───────────────────────────────────────────────────────────────

interface AIConfigSchema {
  aiConfig?: AIConfig;
}

const conf = new Conf<AIConfigSchema>({ projectName: "zizou" });

// ─── model_config.md path ─────────────────────────────────────────────────────

const MODEL_CONFIG_PATH = join(process.cwd(), "model_config.md");

// ─── model_config.md Parser ───────────────────────────────────────────────────
//
// Parses the human-editable markdown file. The format uses simple
// key: value lines inside a fenced code block OR anywhere in the file.
// Lines starting with # are comments/headings.

function parseModelConfigMd(): Partial<AIConfig> {
  if (!existsSync(MODEL_CONFIG_PATH)) return {};

  try {
    const raw = readFileSync(MODEL_CONFIG_PATH, "utf-8");
    const result: Partial<AIConfig> = {};

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;

      const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
      const val = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, ""); // strip optional quotes

      switch (key) {
        case "provider":
          result.provider = val;
          break;
        case "model":
          result.model = val;
          break;
        case "preset":
          if (["fast", "balanced", "high", "testing"].includes(val)) {
            result.preset = val as PresetName;
          }
          break;
        case "reasoning":
          if (["low", "medium", "high"].includes(val)) {
            result.reasoning = val as ReasoningLevel;
          }
          break;
        case "temperature":
          const temp = parseFloat(val);
          if (!isNaN(temp)) result.temperature = temp;
          break;
        case "maxtokens":
        case "maxoutputtokens":
        case "max_tokens":
        case "max_output_tokens":
          const toks = parseInt(val, 10);
          if (!isNaN(toks)) result.maxOutputTokens = toks;
          break;
      }
    }

    return result;
  } catch {
    return {};
  }
}

// ─── model_config.md Writer ───────────────────────────────────────────────────
//
// Writes the full config back to model_config.md so the user always has
// an up-to-date view of what's active. Preserves the human-readable header.

export function writeModelConfigMd(config: AIConfig): void {
  const providerPresets = PROVIDER_PRESETS[config.provider] || PROVIDER_PRESETS["openai"];
  const presetList = Object.entries(providerPresets)
    .map(([name, p]) => `#   ${name.padEnd(8)} → model: ${p.model}, reasoning: ${p.reasoning}`)
    .join("\n");

  const content = `# model_config.md — Zizou AI Configuration
# Edit this file directly to change inference settings.
# Changes take effect on the next message — no restart needed.
#
# Available presets for provider "${config.provider}":
${presetList}
#
# Reasoning levels: low | medium | high
# Temperature: 0.0 – 1.0  (lower = more deterministic)
# MaxTokens: max output tokens per response

provider: ${config.provider}
model: ${config.model}
preset: ${config.preset}
reasoning: ${config.reasoning}
temperature: ${config.temperature}
maxTokens: ${config.maxOutputTokens}
`;

  writeFileSync(MODEL_CONFIG_PATH, content, "utf-8");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reads the active AI config. model_config.md values always take precedence
 * over the Conf store, which in turn takes precedence over built-in defaults.
 */
export function getAIConfig(): AIConfig {
  const stored = conf.get("aiConfig") ?? { ...BUILTIN_DEFAULT };
  const fromFile = parseModelConfigMd();

  return {
    provider:        fromFile.provider        ?? stored.provider        ?? BUILTIN_DEFAULT.provider,
    model:           fromFile.model           ?? stored.model           ?? BUILTIN_DEFAULT.model,
    preset:          fromFile.preset          ?? stored.preset          ?? BUILTIN_DEFAULT.preset,
    reasoning:       fromFile.reasoning       ?? stored.reasoning       ?? BUILTIN_DEFAULT.reasoning,
    temperature:     fromFile.temperature     ?? stored.temperature     ?? BUILTIN_DEFAULT.temperature,
    maxOutputTokens: fromFile.maxOutputTokens ?? stored.maxOutputTokens ?? BUILTIN_DEFAULT.maxOutputTokens,
  };
}

/**
 * Saves updated config to both the Conf store and model_config.md.
 */
export function setAIConfig(config: AIConfig): void {
  conf.set("aiConfig", config);
  writeModelConfigMd(config);
}

/**
 * Applies a named preset for a given provider, returning the full config.
 * Merges with the current config so non-preset fields (e.g. provider) are kept.
 */
export function applyPreset(provider: string, preset: PresetName): AIConfig {
  const providerPresets = PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS["openai"];
  const presetModel = providerPresets[preset];
  const presetDefaults = PRESET_DEFAULTS[preset];
  const current = getAIConfig();

  return {
    provider,
    model:           presetModel.model,
    preset,
    reasoning:       presetModel.reasoning,
    temperature:     presetDefaults.temperature,
    maxOutputTokens: presetDefaults.maxOutputTokens,
  };
}

/**
 * Initialises model_config.md if it doesn't exist yet.
 * Called once at startup so users can discover the file immediately.
 */
export function ensureModelConfigMd(): void {
  if (!existsSync(MODEL_CONFIG_PATH)) {
    const current = getAIConfig();
    writeModelConfigMd(current);
  }
}
