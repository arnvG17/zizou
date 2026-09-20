// src/config/agent-config.ts
//
// LAYER: config/
//
// THE single place that answers "which provider, which model, how hard".
//
// Settings used to be spread across three stores that could disagree: the
// api-keys Conf store (provider + per-provider model), a second Conf store
// (preset, temperature, maxOutputTokens, reasoning), and model_config.md,
// re-parsed on every access and silently overriding the Conf store. Nothing
// stated which won, and two of the preset's fields never reached the runtime
// at all.
//
// PRECEDENCE, highest first:
//
//   1. Session override    /effort, /model  - what I want right now
//   2. Project ZIZOU.md    committed        - what this project wants
//   3. Conf store          global           - what I usually want
//   4. Built-in default
//
// That order is deliberate: a project's committed setting should beat a
// personal global default, but a command typed a second ago should beat
// everything. It matches how editors treat workspace settings versus a
// runtime toggle.
//
// DEPENDENCY DIRECTION: imports from config/ only.

import {
  getDefaultProvider,
  getProviderModel,
  type ProviderChoice,
} from "./api-keys.js";
import {
  DEFAULT_EFFORT,
  EFFORT_PROFILES,
  modelForEffort,
  type Effort,
} from "./effort.js";
import { loadProjectSettings } from "./zizou-md.js";
import { localModelForEffort } from "./local-catalog.js";

/** Everything the runtime needs to make a model call. */
export interface ResolvedAgentConfig {
  provider: ProviderChoice;
  /** The model id to call. */
  modelId: string;
  effort: Effort;
  temperature: number;
  maxOutputTokens: number;
  /** Cap on tool-call rounds per turn. See EffortProfile.maxSteps. */
  maxSteps: number;
  /**
   * True when the model was pinned explicitly (by /model, /modelid or a
   * `model:` line in ZIZOU.md) rather than chosen by the effort level.
   * The UI shows this so a pinned model isn't mistaken for the effort's.
   */
  modelPinned: boolean;
  /** Where the effort setting came from, for /help and the sidebar. */
  effortSource: "session" | "project" | "global" | "default";
}

// ─── Session overrides ───────────────────────────────────────────────────────
//
// Set by slash commands, held in memory for the life of the process. They are
// deliberately NOT persisted: /effort is "for this session", and ZIZOU.md is
// how you make a choice stick. Persisting them would create a fourth store
// that silently outranks the committed project file.

let sessionEffort: Effort | null = null;

/** Applies an effort level for the rest of this session. */
export function setSessionEffort(effort: Effort): void {
  sessionEffort = effort;
}

/** Drops the session override so project/global settings apply again. */
export function clearSessionEffort(): void {
  sessionEffort = null;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/** Resolves the effective configuration. Cheap enough to call per turn. */
export function resolveAgentConfig(projectRoot?: string): ResolvedAgentConfig {
  const project = loadProjectSettings(projectRoot);

  // ── Provider ──
  const provider = (project.provider ?? getDefaultProvider() ?? "groq") as ProviderChoice;

  // ── Effort ──
  let effort: Effort;
  let effortSource: ResolvedAgentConfig["effortSource"];
  if (sessionEffort) {
    effort = sessionEffort;
    effortSource = "session";
  } else if (project.effort) {
    effort = project.effort;
    effortSource = "project";
  } else {
    effort = DEFAULT_EFFORT;
    effortSource = "default";
  }

  const profile = EFFORT_PROFILES[effort];

  // ── Model ──
  //
  // An explicit pin always wins over the effort's choice: if you asked for
  // a specific model, raising effort must not silently swap it out. Raising
  // effort still widens context and raises the token cap.
  const pinned = project.model ?? getProviderModel(provider) ?? null;

  // Ollama has no model table in the source: the catalogue is whatever the
  // user pulled, so it is read from the server and cached in local-catalog.ts.
  // getActiveModelId() consults the SAME function — the two must never resolve
  // a model by different routes (see sdk/active-model.test.ts for the bug that
  // caused).
  const fromEffort =
    provider === "ollama" ? localModelForEffort(effort) : modelForEffort(provider, effort);

  const modelId = pinned ?? fromEffort ?? fallbackModel(provider);

  return {
    provider,
    modelId,
    effort,
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
    maxSteps: profile.maxSteps,
    modelPinned: pinned !== null,
    effortSource,
  };
}

/**
 * Last resort when a provider has no entry in EFFORT_MODELS — an unknown or
 * newly added provider degrades to its balanced model rather than throwing.
 */
function fallbackModel(provider: string): string {
  return modelForEffort(provider, "balanced") ?? "gpt-5-mini";
}
