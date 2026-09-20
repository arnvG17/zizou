/**
 * ollama.ts — Discovery and capability probing for a local Ollama server.
 *
 * Layer: sdk
 * Allowed imports: config/
 * NOT allowed to import from: tools/, ui/, agent/.
 *
 * WHY THIS EXISTS
 *
 * Every other provider has a fixed model list that ships with the code. Ollama
 * does not: the catalogue is whatever the user happened to pull, it changes
 * between sessions, and the models differ from each other in ways that decide
 * whether Zizou can work at all — a model without the `tools` capability can
 * never emit a native tool call, no matter how good the prompt is.
 *
 * Guessing at that is what the hardcoded `qwen3:4b` in config/effort.ts was
 * doing, and it is wrong for any user who pulled something else.
 *
 * THE CONTEXT WINDOW IS THE IMPORTANT PART. Ollama defaults num_ctx to 4096
 * unless the server was started with OLLAMA_CONTEXT_LENGTH or the request asks
 * for more. Zizou's executor system prompt plus the serialized JSON Schema for
 * 13 tools is most of that budget before the user's message is added, and
 * Ollama TRUNCATES SILENTLY rather than erroring. The model then gets a prompt
 * with its own tool definitions cut off and is blamed for not calling tools.
 * `recommendedNumCtx()` exists to stop that happening.
 *
 * Everything here fails soft. Ollama being down, slow, or an unexpected
 * version must degrade discovery to "I don't know", never break startup.
 */

import { getOllamaBaseUrl, getOllamaNumCtx } from "../config/api-keys.js";
import { setLocalCatalog, clearLocalCatalog } from "../config/local-catalog.js";

/** How long any single probe may take before we give up and degrade. */
const PROBE_TIMEOUT_MS = 3000;

/**
 * Floor for the context window we ask a local model for.
 *
 * Measured, not guessed: the executor system prompt is ~1-1.5k tokens and the
 * 13 tool schemas serialize to ~1.5-2k more, so anything at or below Ollama's
 * 4096 default cannot hold the prompt plus a file worth reading.
 */
export const MIN_USABLE_NUM_CTX = 8192;

/**
 * Ceiling for the context window we ask a local model for.
 *
 * qwen3:4b advertises 262144. Allocating a KV cache that size on a laptop is
 * how a truncation bug becomes an out-of-memory crash, so the model's own
 * maximum is an upper bound to clamp, not a target to request.
 */
export const DEFAULT_NUM_CTX_CEILING = 16384;

export interface OllamaModelInfo {
  /** Full tag as Ollama knows it, e.g. "qwen3:4b". */
  name: string;
  /** e.g. "4.0B". Empty string when the server does not report it. */
  parameterSize: string;
  /** e.g. "Q4_K_M". Empty string when the server does not report it. */
  quantization: string;
  /** Model family, e.g. "qwen3". Used to find context_length in /api/show. */
  family: string;
  /** Max context the weights support, or null when it could not be determined. */
  contextLength: number | null;
  /** e.g. ["completion","tools","thinking"]. Empty when unreported. */
  capabilities: string[];
  /** On-disk size in bytes. Used to order models by cost. */
  sizeBytes: number;
}

export interface OllamaHealth {
  ok: boolean;
  version?: string;
  /** Human-readable reason, already phrased for display. */
  error?: string;
}

// ─── Low-level fetch helper ──────────────────────────────────────────────────

/**
 * One JSON request against the Ollama REST API.
 *
 * Returns null on any failure — unreachable, timeout, non-2xx, unparseable.
 * Callers decide what "I don't know" means for them; none of them should throw
 * at the user because a local daemon was busy.
 */
async function probe<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T | null> {
  const baseURL = getOllamaBaseUrl().replace(/\/+$/, "");
  try {
    const res = await fetch(`${baseURL}${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Pulls the context length out of an /api/show `model_info` block.
 *
 * The key is family-prefixed and the prefix is not always the family reported
 * in `details` — gemma4:e4b reports family "gemma4" and the key
 * "gemma4.context_length", but that agreement is a convention, not a contract.
 * Matching on the suffix is what survives a family we have never seen.
 *
 * Exported for the tests, which is the only way to cover a payload shape we
 * receive but do not control.
 */
export function extractContextLength(modelInfo: Record<string, unknown> | undefined): number | null {
  if (!modelInfo) return null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
      return value;
    }
  }
  return null;
}

/** Shapes one /api/tags entry into an OllamaModelInfo. */
export function parseTagsEntry(entry: Record<string, any>): OllamaModelInfo {
  const details = (entry?.details ?? {}) as Record<string, any>;
  return {
    name: String(entry?.name ?? entry?.model ?? ""),
    parameterSize: String(details.parameter_size ?? ""),
    quantization: String(details.quantization_level ?? ""),
    family: String(details.family ?? ""),
    // Present on some entries (qwen3:4b) and absent on others (gemma4:e4b).
    // getOllamaModelInfo falls back to /api/show for the absent case.
    contextLength:
      typeof details.context_length === "number" && details.context_length > 0
        ? details.context_length
        : null,
    capabilities: Array.isArray(entry?.capabilities) ? entry.capabilities.map(String) : [],
    sizeBytes: typeof entry?.size === "number" ? entry.size : 0,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Is the server up, and which version? */
export async function checkOllamaHealth(): Promise<OllamaHealth> {
  const res = await probe<{ version?: string }>("/api/version");
  if (!res) {
    return {
      ok: false,
      error: `Ollama is not reachable at ${getOllamaBaseUrl()} — is \`ollama serve\` running?`,
    };
  }
  return { ok: true, version: res.version };
}

/**
 * Every model the user has pulled, largest last.
 *
 * Empty array means "could not find out" as well as "none installed". The
 * difference matters to the caller's wording, so preflight checks health
 * first rather than inferring a down server from an empty list.
 */
export async function listOllamaModels(): Promise<OllamaModelInfo[]> {
  const res = await probe<{ models?: Record<string, any>[] }>("/api/tags");
  if (!res?.models) return [];
  return res.models
    .map(parseTagsEntry)
    .filter((m) => m.name !== "")
    .sort((a, b) => a.sizeBytes - b.sizeBytes);
}

/**
 * One model's details, with `contextLength` filled in from /api/show when
 * /api/tags did not report it.
 *
 * Returns null when the model is not installed, which is what makes the
 * "run `ollama pull x`" message possible instead of a 404 from the stream.
 */
export async function getOllamaModelInfo(name: string): Promise<OllamaModelInfo | null> {
  const models = await listOllamaModels();
  // Ollama treats a bare name as :latest, and that is how users type it.
  const found =
    models.find((m) => m.name === name) ??
    models.find((m) => m.name === `${name}:latest`) ??
    null;
  if (!found) return null;
  if (found.contextLength !== null) return found;

  const show = await probe<{ model_info?: Record<string, unknown>; capabilities?: string[] }>(
    "/api/show",
    { method: "POST", body: { model: found.name } },
  );
  return {
    ...found,
    contextLength: extractContextLength(show?.model_info),
    capabilities: found.capabilities.length
      ? found.capabilities
      : Array.isArray(show?.capabilities)
        ? show.capabilities.map(String)
        : [],
  };
}

/**
 * Can this model emit native tool calls?
 *
 * A false here is the difference between Zizou working and Zizou living
 * permanently in agent/fallback-tool-parse.ts. When capabilities are absent
 * entirely (older Ollama did not report them) we answer true: refusing to run
 * on an old server is worse than trying and falling back.
 */
export function supportsTools(m: OllamaModelInfo): boolean {
  if (m.capabilities.length === 0) return true;
  return m.capabilities.includes("tools");
}

/**
 * Does this model emit reasoning tokens before its answer?
 *
 * This is a budget question, not a quality one. At `fast` effort
 * maxOutputTokens is 1024, and a thinking model can spend all of it reasoning
 * and emit no tool call at all — which looks exactly like a model that cannot
 * call tools. resolveModel turns thinking off for local models for this reason.
 */
export function isThinkingModel(m: OllamaModelInfo): boolean {
  return m.capabilities.includes("thinking");
}

/**
 * The context window to request for this model.
 *
 * Clamped at both ends: never below what the prompt demonstrably needs, never
 * above what the weights support or what a laptop can allocate. A model whose
 * own maximum is below MIN_USABLE_NUM_CTX gets its maximum — asking for more
 * than the weights support is an error, and a warning is the honest response.
 */
export function recommendedNumCtx(
  m: OllamaModelInfo | null,
  ceiling: number = getOllamaNumCtx() ?? DEFAULT_NUM_CTX_CEILING,
): number {
  const max = m?.contextLength ?? null;
  if (max === null) return Math.max(MIN_USABLE_NUM_CTX, Math.min(ceiling, DEFAULT_NUM_CTX_CEILING));
  if (max < MIN_USABLE_NUM_CTX) return max;
  return Math.min(max, ceiling);
}

// ─── Warning bus ─────────────────────────────────────────────────────────────
//
// The sdk layer cannot import from ui/ or agent/, and this is an Ink TUI where
// a stray console.warn corrupts the rendered frame. So findings are published
// here and the UI drains them when it next draws.
//
// Deduplicated by text: these come from a per-request hook, and the same
// warning on every turn of a long session is noise, not emphasis.

const emittedWarnings = new Set<string>();
const warningQueue: string[] = [];

/** Publishes a warning once per session. Repeat calls with the same text are dropped. */
export function emitOllamaWarning(text: string): void {
  if (emittedWarnings.has(text)) return;
  emittedWarnings.add(text);
  warningQueue.push(text);
}

/** Takes every warning published since the last drain, emptying the queue. */
export function drainOllamaWarnings(): string[] {
  return warningQueue.splice(0, warningQueue.length);
}

/** Test seam — forgets which warnings have already been shown. */
export function resetOllamaWarnings(): void {
  emittedWarnings.clear();
  warningQueue.length = 0;
}

/**
 * The context length Ollama ACTUALLY loaded a model with, or null if it is
 * not currently resident.
 *
 * This is the only honest answer to "did our num_ctx request take effect?".
 * Ollama's OpenAI-compatible endpoint unmarshals into a typed struct and
 * silently drops fields it does not recognise — a probe here confirms the
 * unknown field `options.num_ctx` is accepted without a 400, but acceptance is
 * not the same as being honoured, and the two cannot be told apart from the
 * response.
 *
 * So we do not guess. We ask for the window we want, then read back what we
 * got and warn if they differ. That is correct on every Ollama version,
 * including ones released after this code was written.
 */
export async function getLoadedContextLength(modelName: string): Promise<number | null> {
  const res = await probe<{ models?: Record<string, any>[] }>("/api/ps");
  if (!res?.models) return null;
  const loaded = res.models.find(
    (m) => m?.name === modelName || m?.model === modelName,
  );
  const ctx = loaded?.context_length;
  return typeof ctx === "number" && ctx > 0 ? ctx : null;
}

// ─── Session cache ───────────────────────────────────────────────────────────
//
// Model selection has to be synchronous: getActiveModelId() is called from
// render paths and from resolveModel(), neither of which can await a network
// probe. But the catalogue only exists on the server.
//
// So the list is fetched once at startup (and again whenever the user changes
// provider or base URL) and read synchronously thereafter. Before the first
// prime, and whenever Ollama is unreachable, the sync readers return null and
// the caller falls back to its built-in default — the same behaviour as
// before this module existed.

let cachedModels: OllamaModelInfo[] | null = null;

/**
 * Fetches the catalogue and publishes it for synchronous readers.
 *
 * The full records stay here for display; the subset that model resolution
 * needs goes to config/local-catalog.ts, which is where BOTH resolvers read
 * it from. That indirection is deliberate — see the header of that file for
 * the display-vs-runtime divergence it prevents.
 *
 * Safe to call repeatedly.
 */
export async function primeOllamaCache(): Promise<OllamaModelInfo[]> {
  const models = await listOllamaModels();
  cachedModels = models;
  setLocalCatalog(
    models.map((m) => ({
      name: m.name,
      sizeBytes: m.sizeBytes,
      toolCapable: supportsTools(m),
    })),
  );
  return models;
}

/** The cached catalogue, or null if it has not been primed (or Ollama is down). */
export function getCachedOllamaModels(): OllamaModelInfo[] | null {
  return cachedModels;
}

/** Forgets the cache, so the next prime re-reads the server. */
export function clearOllamaCache(): void {
  cachedModels = null;
  clearLocalCatalog();
}

/**
 * Everything that is wrong with the current local setup, in the order it
 * should be fixed.
 *
 * Runs on provider switch and at startup. Each check gates the next: telling
 * someone their model lacks tool support when the server is not even running
 * is noise, and noise trains people to ignore the line that mattered.
 *
 * An empty array means the local setup is sound — which is worth saying out
 * loud, because the failure mode this replaces was silent.
 */
export async function preflightOllama(modelId: string): Promise<string[]> {
  const health = await checkOllamaHealth();
  if (!health.ok) return [health.error!];

  const models = await primeOllamaCache();
  if (models.length === 0) {
    return [
      "Ollama is running but has no models installed. Pull one first, e.g. `ollama pull qwen3:4b`.",
    ];
  }

  const info = await getOllamaModelInfo(modelId);
  if (!info) {
    const available = models.map((m) => m.name).join(", ");
    return [
      `\`${modelId}\` is not installed. Run \`ollama pull ${modelId}\`, or switch to one you have: ${available}.`,
    ];
  }

  const problems: string[] = [];

  if (!supportsTools(info)) {
    const withTools = models.filter(supportsTools).map((m) => m.name);
    problems.push(
      `\`${info.name}\` does not support tool calling, so Zizou cannot make it edit files reliably — ` +
        `it will fall back to parsing tool calls out of plain text. ` +
        (withTools.length
          ? `Models you have that do support tools: ${withTools.join(", ")}.`
          : `None of your installed models support tools; try \`ollama pull qwen3:4b\`.`),
    );
  }

  if (info.contextLength !== null && info.contextLength < MIN_USABLE_NUM_CTX) {
    problems.push(
      `\`${info.name}\` supports only a ${info.contextLength}-token context. ` +
        `Zizou's prompt and tool definitions need about ${MIN_USABLE_NUM_CTX}, so long files will not fit.`,
    );
  }

  return problems;
}

/**
 * Rewrites an Ollama error into one line a user can act on.
 *
 * These arrive as raw llama-server stderr through the OpenAI-compatible
 * endpoint. The allocation failure in particular is common on a laptop and
 * says nothing useful in its original form:
 *
 *   llama-server process has terminated: exit status 1:
 *   ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of
 *   size 1765048320 ... unable to allocate CPU_REPACK buffer
 *
 * Returns null when the message is not one we recognise, so the caller shows
 * the original rather than a worse guess.
 */
export function explainOllamaError(message: string, modelId?: string): string | null {
  const m = message.toLowerCase();
  const model = modelId ? `\`${modelId}\`` : "this model";

  if (m.includes("failed to allocate") || m.includes("unable to allocate")) {
    return `Not enough free memory to load ${model}. Close some applications, or switch to a smaller model with \`/model ollama <name>\` (\`/models\` lists what you have).`;
  }
  if (m.includes("model") && m.includes("not found")) {
    return `${model} is not installed. Run \`ollama pull ${modelId ?? "<name>"}\`, or pick one you already have with \`/models\`.`;
  }
  if (m.includes("process has terminated")) {
    return `Ollama failed to start ${model}. Check \`ollama serve\` output — this is usually memory pressure or a corrupt model file.`;
  }
  if (m.includes("econnrefused") || m.includes("fetch failed")) {
    return `Ollama is not reachable at ${getOllamaBaseUrl()} — is \`ollama serve\` running?`;
  }
  return null;
}
