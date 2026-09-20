// src/sdk/local-transport.test.ts
//
// What actually goes out on the wire to a local model.
//
// Two defects live here and neither is visible from the response:
//
//   1. WRONG ENDPOINT. createOpenAI(...)(modelId) resolves to the Responses
//      API — /v1/responses. Ollama only implements that on recent builds, and
//      LM Studio, llama.cpp's server and vLLM do not implement it at all. The
//      fix is .chat(), and nothing about the call site makes the difference
//      obvious, so it is exactly the kind of thing that gets "tidied" back.
//
//   2. MISSING num_ctx. Ollama defaults to a 4096-token context and TRUNCATES
//      SILENTLY. Zizou's system prompt plus 13 tool schemas is most of that
//      budget, so the model receives its own tool definitions cut off — and
//      then gets blamed for emitting pseudo-calls instead of real ones. There
//      is no error and no warning; the only evidence is worse output.
//
// Both are asserted against a stub server rather than a live Ollama, so this
// runs anywhere and does not need a model loaded into memory.

import { test, expect, afterEach, beforeEach } from "bun:test";
import { generateText } from "ai";
import { resolveModel } from "./resolve-model.js";
import { clearOllamaCache } from "./ollama.js";

const realFetch = globalThis.fetch;
const realBaseUrl = process.env.OLLAMA_BASE_URL;

interface Captured {
  path: string;
  body: Record<string, any>;
}

let captured: Captured[] = [];

/** A model that reports tools + thinking, matching real qwen3:4b. */
const TAGS = {
  models: [
    {
      name: "qwen3:4b",
      model: "qwen3:4b",
      size: 2497293931,
      details: {
        family: "qwen3",
        parameter_size: "4.0B",
        quantization_level: "Q4_K_M",
        context_length: 262144,
      },
      capabilities: ["completion", "tools", "thinking"],
    },
  ],
};

/** A minimal, valid OpenAI chat-completion response. */
const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "qwen3:4b",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

beforeEach(() => {
  captured = [];
  clearOllamaCache();
  process.env.OLLAMA_BASE_URL = "http://stub.invalid:11434";

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    let body: Record<string, any> = {};
    try {
      body = init?.body ? JSON.parse(String(init.body)) : {};
    } catch {
      /* non-JSON bodies are not ours */
    }
    captured.push({ path, body });

    if (path === "/api/tags") return Response.json(TAGS);
    if (path === "/api/ps") return Response.json({ models: [] });
    if (path.endsWith("/chat/completions")) return Response.json(COMPLETION);
    // Anything else — notably /v1/responses — is a routing mistake.
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = realBaseUrl;
  clearOllamaCache();
});

async function callOllama() {
  return generateText({
    model: resolveModel("ollama", "qwen3:4b"),
    prompt: "hi",
    maxRetries: 0,
  });
}

test("talks to /v1/chat/completions, not the Responses API", async () => {
  await callOllama();
  const paths = captured.map((c) => c.path);
  expect(paths).toContain("/v1/chat/completions");
  expect(paths).not.toContain("/v1/responses");
});

test("asks for a context window larger than Ollama's 4096 default", async () => {
  await callOllama();
  const req = captured.find((c) => c.path === "/v1/chat/completions")!;
  expect(req.body.options?.num_ctx).toBeGreaterThan(4096);
});

test("clamps the requested window rather than using the model's maximum", async () => {
  // qwen3:4b advertises 262144. Allocating that KV cache on a laptop trades a
  // truncation bug for an out-of-memory crash.
  await callOllama();
  const req = captured.find((c) => c.path === "/v1/chat/completions")!;
  expect(req.body.options.num_ctx).toBeLessThan(262144);
});

test("turns off thinking for a reasoning model", async () => {
  // At `fast` effort maxOutputTokens is 1024, which a thinking model can spend
  // entirely on reasoning and never reach the tool call.
  await callOllama();
  const req = captured.find((c) => c.path === "/v1/chat/completions")!;
  expect(req.body.think).toBe(false);
});

test("still sends the prompt it was given", async () => {
  // The body is parsed, mutated and re-serialized on every request, so the
  // failure mode to guard against is a rewrite that drops the payload.
  await callOllama();
  const req = captured.find((c) => c.path === "/v1/chat/completions")!;
  expect(req.body.model).toBe("qwen3:4b");
  expect(JSON.stringify(req.body.messages)).toContain("hi");
});
