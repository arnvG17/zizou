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
import { modelForEffort } from "../config/effort.js";
import { localModelForEffort } from "../config/local-catalog.js";
import { resolveAgentConfig } from "../config/agent-config.js";
import {
  getOllamaModelInfo,
  getLoadedContextLength,
  recommendedNumCtx,
  isThinkingModel,
  emitOllamaWarning,
  type OllamaModelInfo,
} from "./ollama.js";

/**
 * The fetch shape createOpenAI accepts. Derived from the provider's own
 * options rather than `typeof fetch` so it stays correct across SDK versions
 * and does not demand extras like `preconnect` that a middleware never has.
 */
type ProviderFetch = NonNullable<NonNullable<Parameters<typeof createOpenAI>[0]>["fetch"]>;

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
 * Returns the model ID that will ACTUALLY be called for this provider.
 *
 * This is the display counterpart to resolveAgentConfig().modelId, and it
 * must agree with it. It did not, and the disagreement was invisible:
 *
 *   getActiveModelId  →  getProviderModel() ?? DEFAULT_MODELS[provider]
 *   the runtime       →  pinned ?? modelForEffort(provider, effort)
 *
 * With no model explicitly pinned those fall through to different tables, so
 * /model, /help and the sidebar reported claude-3-5-sonnet-latest while the
 * agent called claude-sonnet-4-5 — and likewise gpt-4o-mini vs gpt-5-mini,
 * and gemma-4-31b vs llama-3.3-70b. Three of six providers displayed a model
 * that was never contacted.
 *
 * effort.ts records this exact failure being fixed once before, on the
 * execution path. It survived on the display path, where it is arguably
 * worse: a wrong model that runs correctly is a bug you cannot see.
 *
 * DEFAULT_MODELS remains for resolveModel's own last-resort fallback.
 */
export function getActiveModelId(provider: ProviderChoice): string {
  const pinned = getProviderModel(provider);
  if (pinned) return pinned;

  // The EFFORT the user is actually running at — session /effort, then
  // ZIZOU.md, then the default. Using DEFAULT_EFFORT here instead would
  // reintroduce the same lie at one remove: /effort max would raise the
  // model without the display ever saying so.
  const { effort } = resolveAgentConfig();

  // Ollama has no build-time model table: the catalogue is whatever the user
  // pulled, read from the server and cached in config/local-catalog.ts. This
  // is the SAME call resolveAgentConfig() makes — resolving the model by two
  // different routes is the exact bug this function's comment describes, and
  // a provider whose table lives on a server is the easiest way to reopen it.
  //
  // Before the cache is primed, or with Ollama down, it returns null and we
  // fall through to the built-in default like every other provider.
  const fromEffort =
    provider === "ollama" ? localModelForEffort(effort) : modelForEffort(provider, effort);

  return fromEffort ?? DEFAULT_MODELS[provider];
}

/**
 * Builds a fetch that shapes each request for a local Ollama model.
 *
 * TWO THINGS ARE WRONG BY DEFAULT, and both are invisible.
 *
 * 1. num_ctx defaults to 4096 unless the server was started with
 *    OLLAMA_CONTEXT_LENGTH. The executor system prompt is ~1-1.5k tokens and
 *    the serialized JSON Schema for 13 tools is ~1.5-2k more, so most of the
 *    budget is gone before the user's message. Ollama then TRUNCATES SILENTLY
 *    — the model receives its own tool definitions cut in half and gets blamed
 *    for emitting `<function/writeFile>{...}</function>` instead of a real
 *    tool call. This is a far better explanation of local-model tool failures
 *    than model size is.
 *
 * 2. Thinking models (qwen3, gemma4, ...) spend output tokens reasoning before
 *    they answer. At `fast` effort maxOutputTokens is 1024, which a thinking
 *    model can consume entirely without ever reaching the tool call.
 *
 * WE DO NOT ASSUME THE FIX LANDS. Ollama's OpenAI-compatible handler
 * unmarshals into a typed struct and drops fields it does not recognise, so
 * `options.num_ctx` is accepted without complaint whether or not it is
 * honoured, and the response cannot tell you which happened. So we ask, then
 * read back the loaded window from /api/ps and warn with the exact fix if we
 * did not get it. That stays correct across Ollama versions instead of
 * encoding what one version did on one day.
 */
function createLocalModelFetch(modelId: string): ProviderFetch {
  // Resolved once per provider instance. The probe is cheap but it is on the
  // request path, and the answer cannot change without a restart.
  let infoPromise: Promise<OllamaModelInfo | null> | null = null;
  let verified = false;

  // Cast because the provider types this slot as the full `typeof fetch`,
  // which carries Bun's `preconnect` — a property a middleware has no way to
  // supply and the SDK never calls.
  const impl = async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    let body: Record<string, any> | null = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = null; // Not ours to rewrite. Pass it through untouched.
    }

    if (body) {
      infoPromise ??= getOllamaModelInfo(modelId);
      const info = await infoPromise;

      // Ollama reads num_ctx from `options`, its native knob. Merged rather
      // than assigned so anything the SDK already put there survives.
      body.options = { ...(body.options ?? {}), num_ctx: recommendedNumCtx(info) };

      // Only for models that actually think — sending it to others is a
      // meaningless field, and meaningless fields are how bugs hide.
      if (info && isThinkingModel(info)) body.think = false;

      init = { ...init, body: JSON.stringify(body) };
    }

    const res = await fetch(input, init);

    // Read back what we actually got, once per session. Fire-and-forget: a
    // diagnostic must never delay or fail the request it is diagnosing.
    if (!verified && res.ok) {
      verified = true;
      void (async () => {
        const info = await (infoPromise ?? Promise.resolve(null));
        const wanted = recommendedNumCtx(info);
        const actual = await getLoadedContextLength(modelId);
        if (actual !== null && actual < wanted) {
          emitOllamaWarning(
            `${modelId} is running with a ${actual}-token context, but Zizou asked for ${wanted}. ` +
              `Your Ollama version ignores per-request num_ctx, so long prompts are being silently truncated — ` +
              `which is the usual cause of malformed tool calls. Fix: restart Ollama with OLLAMA_CONTEXT_LENGTH=${wanted}.`,
          );
        }
      })();
    }

    return res;
  };

  return impl as ProviderFetch;
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
    // .chat() for the same reason as Ollama below: OpenRouter's stable
    // surface is /v1/chat/completions, and the callable form would send
    // /v1/responses.
    return openrouter.chat(modelId);
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
      fetch: createLocalModelFetch(modelId),
    });
    // .chat() and NOT ollama(modelId). The callable form resolves to
    // createResponsesModel — the /v1/responses API — which Ollama only
    // started implementing recently and which LM Studio, llama.cpp's server
    // and vLLM do not implement at all. /v1/chat/completions is the endpoint
    // every OpenAI-compatible local server actually supports, and the one
    // their tool-calling is tested against.
    return ollama.chat(modelId);
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

