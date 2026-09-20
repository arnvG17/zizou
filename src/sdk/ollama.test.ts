// src/sdk/ollama.test.ts
//
// Covers the parts of Ollama discovery that decide whether Zizou works at all:
// reading a catalogue we do not control, and choosing a model from it.
//
// The payloads below are REAL — captured from Ollama 0.32.1 — because the
// shape is the whole problem. /api/tags reports details.context_length for
// qwen3:4b and omits it for gemma4:e4b, which is exactly the inconsistency
// that a hand-written fixture would have smoothed over and the code would
// then have got wrong.
//
// No live server: every probe goes through a stubbed global fetch.

import { test, expect, afterEach } from "bun:test";
import {
  extractContextLength,
  parseTagsEntry,
  supportsTools,
  isThinkingModel,
  recommendedNumCtx,
  explainOllamaError,
  emitOllamaWarning,
  drainOllamaWarnings,
  resetOllamaWarnings,
  listOllamaModels,
  getOllamaModelInfo,
  checkOllamaHealth,
  clearOllamaCache,
  primeOllamaCache,
  MIN_USABLE_NUM_CTX,
  DEFAULT_NUM_CTX_CEILING,
  type OllamaModelInfo,
} from "./ollama.js";
import { localModelForEffort, setLocalCatalog, clearLocalCatalog } from "../config/local-catalog.js";

// ─── Real captured payloads ──────────────────────────────────────────────────

const QWEN_TAG = {
  name: "qwen3:4b",
  model: "qwen3:4b",
  size: 2497293931,
  details: {
    family: "qwen3",
    parameter_size: "4.0B",
    quantization_level: "Q4_K_M",
    context_length: 262144,
    embedding_length: 2560,
  },
  capabilities: ["completion", "tools", "thinking"],
};

/** Note: no details.context_length. This is what the real server returns. */
const GEMMA_TAG = {
  name: "gemma4:e4b",
  model: "gemma4:e4b",
  size: 9608350718,
  details: {
    family: "gemma4",
    parameter_size: "8.0B",
    quantization_level: "Q4_K_M",
  },
  capabilities: ["completion", "vision", "audio", "tools", "thinking"],
};

const realFetch = globalThis.fetch;

/** Routes each probe path to a canned body. Any unrouted path 404s. */
function stubFetch(routes: Record<string, unknown>, onCall?: (path: string) => void) {
  globalThis.fetch = (async (input: any) => {
    const path = new URL(String(input)).pathname;
    onCall?.(path);
    if (!(path in routes)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[path]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetOllamaWarnings();
  clearOllamaCache();
});

function model(over: Partial<OllamaModelInfo> = {}): OllamaModelInfo {
  return {
    name: "m",
    parameterSize: "4.0B",
    quantization: "Q4_K_M",
    family: "qwen3",
    contextLength: 262144,
    capabilities: ["completion", "tools"],
    sizeBytes: 1000,
    ...over,
  };
}

// ─── extractContextLength ────────────────────────────────────────────────────

test("finds the family-prefixed context_length key", () => {
  expect(extractContextLength({ "gemma4.context_length": 131072 })).toBe(131072);
});

test("matches on suffix, so an unknown family still works", () => {
  // The prefix is a convention, not a contract. A model family nobody has
  // seen yet must not silently degrade to the 4096 default.
  expect(extractContextLength({ "some_new_arch.context_length": 8192 })).toBe(8192);
});

test("is not fooled by neighbouring length keys", () => {
  // Real /api/show payloads carry a dozen *_length keys; picking the wrong
  // one would set num_ctx to 512 and truncate every prompt.
  const info = {
    "gemma4.attention.key_length": 512,
    "gemma4.embedding_length": 2560,
    "gemma4.vision.feed_forward_length": 3072,
    "gemma4.context_length": 131072,
  };
  expect(extractContextLength(info)).toBe(131072);
});

test("returns null for missing or nonsense values", () => {
  expect(extractContextLength(undefined)).toBeNull();
  expect(extractContextLength({})).toBeNull();
  expect(extractContextLength({ "x.context_length": 0 })).toBeNull();
  expect(extractContextLength({ "x.context_length": "lots" })).toBeNull();
});

// ─── parseTagsEntry ──────────────────────────────────────────────────────────

test("parses a tag entry that reports its context length", () => {
  const m = parseTagsEntry(QWEN_TAG);
  expect(m.name).toBe("qwen3:4b");
  expect(m.parameterSize).toBe("4.0B");
  expect(m.family).toBe("qwen3");
  expect(m.contextLength).toBe(262144);
  expect(m.capabilities).toContain("tools");
});

test("parses a tag entry that omits its context length", () => {
  const m = parseTagsEntry(GEMMA_TAG);
  expect(m.name).toBe("gemma4:e4b");
  expect(m.contextLength).toBeNull(); // → getOllamaModelInfo falls back to /api/show
});

test("survives a malformed entry rather than throwing", () => {
  const m = parseTagsEntry({} as any);
  expect(m.name).toBe("");
  expect(m.capabilities).toEqual([]);
  expect(m.sizeBytes).toBe(0);
});

// ─── Capabilities ────────────────────────────────────────────────────────────

test("a model with no tools capability is rejected", () => {
  expect(supportsTools(model({ capabilities: ["completion"] }))).toBe(false);
});

test("a model reporting no capabilities at all is allowed through", () => {
  // Older Ollama did not report capabilities. Refusing to run on an old
  // server is worse than trying and letting the fallback parser catch it.
  expect(supportsTools(model({ capabilities: [] }))).toBe(true);
});

test("detects thinking models", () => {
  expect(isThinkingModel(parseTagsEntry(QWEN_TAG))).toBe(true);
  expect(isThinkingModel(model({ capabilities: ["completion", "tools"] }))).toBe(false);
});

// ─── recommendedNumCtx ───────────────────────────────────────────────────────

test("clamps a huge advertised context down to the ceiling", () => {
  // qwen3:4b advertises 262144. Allocating that KV cache on a laptop turns a
  // truncation bug into an OOM.
  expect(recommendedNumCtx(model({ contextLength: 262144 }))).toBe(DEFAULT_NUM_CTX_CEILING);
});

test("never returns Ollama's 4096 default for a model that can do better", () => {
  // This is the whole point of the module: 4096 does not fit the system
  // prompt plus 13 tool schemas plus a file.
  expect(recommendedNumCtx(model({ contextLength: 32768 }))).toBeGreaterThan(4096);
});

test("respects a model whose own maximum is below our floor", () => {
  // Asking for more than the weights support is an error, not a stretch goal.
  expect(recommendedNumCtx(model({ contextLength: 2048 }))).toBe(2048);
});

test("falls back to a usable window when the context length is unknown", () => {
  expect(recommendedNumCtx(null)).toBeGreaterThanOrEqual(MIN_USABLE_NUM_CTX);
  expect(recommendedNumCtx(model({ contextLength: null }))).toBeGreaterThanOrEqual(
    MIN_USABLE_NUM_CTX,
  );
});

// ─── Effort selection ────────────────────────────────────────────────────────
//
// The selection itself lives in config/local-catalog.ts, which is what BOTH
// model resolvers read. Driving it through setLocalCatalog here tests the path
// the runtime actually takes rather than a parallel copy of the logic.

/** Publishes models to the shared catalogue the way primeOllamaCache does. */
function publish(models: OllamaModelInfo[]) {
  setLocalCatalog(
    models.map((m) => ({ name: m.name, sizeBytes: m.sizeBytes, toolCapable: supportsTools(m) })),
  );
}

test("picks smallest for fast and largest for max", () => {
  publish([
    model({ name: "small", sizeBytes: 1 }),
    model({ name: "mid", sizeBytes: 2 }),
    model({ name: "big", sizeBytes: 3 }),
  ]);
  expect(localModelForEffort("fast")).toBe("small");
  expect(localModelForEffort("max")).toBe("big");
  expect(localModelForEffort("balanced")).toBe("mid");
});

test("orders by size regardless of the order the server returned", () => {
  publish([
    model({ name: "big", sizeBytes: 3 }),
    model({ name: "small", sizeBytes: 1 }),
    model({ name: "mid", sizeBytes: 2 }),
  ]);
  expect(localModelForEffort("fast")).toBe("small");
  expect(localModelForEffort("max")).toBe("big");
});

test("excludes models that cannot call tools at every effort", () => {
  // A model that cannot act is not a cheaper option for an agent, it is a
  // broken one — so it must not win `fast` just for being small.
  publish([
    model({ name: "tiny-no-tools", sizeBytes: 1, capabilities: ["completion"] }),
    model({ name: "usable", sizeBytes: 2 }),
  ]);
  expect(localModelForEffort("fast")).toBe("usable");
  expect(localModelForEffort("max")).toBe("usable");
});

test("returns null when nothing usable is installed", () => {
  publish([]);
  expect(localModelForEffort("balanced")).toBeNull();
  publish([model({ capabilities: ["completion"] })]);
  expect(localModelForEffort("balanced")).toBeNull();
});

test("returns null before the catalogue has been primed", () => {
  // Startup and a down server take this path, and it must mean "fall back to
  // the built-in default", not "no model".
  clearLocalCatalog();
  expect(localModelForEffort("balanced")).toBeNull();
});

test("a single installed model is chosen at every effort", () => {
  publish([model({ name: "only" })]);
  for (const e of ["fast", "balanced", "max"] as const) {
    expect(localModelForEffort(e)).toBe("only");
  }
});

test("priming publishes the catalogue to the shared resolver", async () => {
  // The link that keeps getActiveModelId and resolveAgentConfig agreeing:
  // fetching must feed the same store both of them read.
  stubFetch({ "/api/tags": { models: [QWEN_TAG, GEMMA_TAG] } });
  await primeOllamaCache();
  expect(localModelForEffort("fast")).toBe("qwen3:4b");
  expect(localModelForEffort("max")).toBe("gemma4:e4b");
});

// ─── Network paths ───────────────────────────────────────────────────────────

test("lists installed models smallest first", async () => {
  stubFetch({ "/api/tags": { models: [GEMMA_TAG, QWEN_TAG] } });
  const models = await listOllamaModels();
  expect(models.map((m) => m.name)).toEqual(["qwen3:4b", "gemma4:e4b"]);
});

test("fills in a missing context length from /api/show", async () => {
  stubFetch({
    "/api/tags": { models: [GEMMA_TAG] },
    "/api/show": { model_info: { "gemma4.context_length": 131072 } },
  });
  const info = await getOllamaModelInfo("gemma4:e4b");
  expect(info?.contextLength).toBe(131072);
});

test("does not call /api/show when the tag already answered", async () => {
  // The /api/show payload includes the model's full licence text. Fetching it
  // when we already have the answer is pure waste on the request path.
  const calls: string[] = [];
  stubFetch({ "/api/tags": { models: [QWEN_TAG] } }, (p) => calls.push(p));
  await getOllamaModelInfo("qwen3:4b");
  expect(calls).not.toContain("/api/show");
});

test("resolves a bare name to its :latest tag", async () => {
  stubFetch({ "/api/tags": { models: [{ ...QWEN_TAG, name: "mistral:latest" }] } });
  expect((await getOllamaModelInfo("mistral"))?.name).toBe("mistral:latest");
});

test("an uninstalled model resolves to null, not an error", async () => {
  stubFetch({ "/api/tags": { models: [QWEN_TAG] } });
  expect(await getOllamaModelInfo("llama3:70b")).toBeNull();
});

test("a down server degrades instead of throwing", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  // Startup must survive Ollama being off, including when it is not even the
  // active provider.
  expect(await listOllamaModels()).toEqual([]);
  expect(await getOllamaModelInfo("qwen3:4b")).toBeNull();
  const health = await checkOllamaHealth();
  expect(health.ok).toBe(false);
  expect(health.error).toContain("ollama serve");
});

// ─── Error explanation ───────────────────────────────────────────────────────

test("explains the allocation failure in terms of memory", () => {
  // The real message, verbatim from a 16GB laptop with 1.8GB free.
  const raw =
    "llama-server process has terminated: exit status 1: " +
    "ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 1765048320 " +
    "... unable to allocate CPU_REPACK buffer";
  const out = explainOllamaError(raw, "gemma4:e4b")!;
  expect(out).toContain("memory");
  expect(out).toContain("gemma4:e4b");
  expect(out).not.toContain("ggml_backend");
});

test("explains a missing model as something to pull", () => {
  const out = explainOllamaError("model 'zzz' not found", "zzz")!;
  expect(out).toContain("ollama pull zzz");
});

test("leaves an unrecognised message alone", () => {
  // A worse guess is not an improvement on the original.
  expect(explainOllamaError("something entirely new")).toBeNull();
});

// ─── Warning bus ─────────────────────────────────────────────────────────────

test("publishes a warning once and drains it once", () => {
  emitOllamaWarning("ctx too small");
  emitOllamaWarning("ctx too small");
  expect(drainOllamaWarnings()).toEqual(["ctx too small"]);
  expect(drainOllamaWarnings()).toEqual([]);
});
