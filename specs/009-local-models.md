# Local Models (Ollama) — Spec Sheet

How Zizou runs against a local Ollama server, what was silently broken before, and what each fix actually does. Findings here were measured against a live server (Ollama 0.32.1) rather than inferred.

---

## Table of Contents

1. [The headline finding](#1-the-headline-finding)
2. [All seven defects](#2-all-seven-defects)
3. [Model discovery](#3-model-discovery)
4. [The context window](#4-the-context-window)
5. [Transport](#5-transport)
6. [Model resolution](#6-model-resolution-and-the-bug-it-nearly-reopened)
7. [Preflight and errors](#7-preflight-and-errors)
8. [User-facing surface](#8-user-facing-surface)
9. [Files](#9-files)

---

## 1. The headline finding

The working assumption was "small models are just bad at tool calling". That is at best incomplete.

**Ollama defaults `num_ctx` to 4096 unless the server is started with `OLLAMA_CONTEXT_LENGTH`.** No `OLLAMA_*` variable was set on the development machine.

Zizou's executor system prompt plus the JSON Schema for its 13 tools is **~3.7k tokens, measured** — and the Qwen3 template puts both in the *same system block* (see [010 §2.2](./010-sft-dataset.md#22-tool-schemas-live-in-the-system-block)). That is most of a 4096 budget consumed before the user's message or a single line of file content.

> [!IMPORTANT]
> Ollama **truncates silently** rather than erroring. The model was routinely receiving its own tool definitions cut off mid-schema, then being blamed for emitting `<function/writeFile>{...}</function>`. A model advertising a 262144-token context was being run at 4096.

This reorders the whole local-model effort: fix the wiring, measure again, and only then decide how much fine-tuning is needed.

---

## 2. All seven defects

| # | Defect | Fix |
|---|---|---|
| 1 | `num_ctx` never set or checked | Request it per call; **read back what was actually loaded** and warn |
| 2 | Thinking models burn the output budget — `fast` effort caps output at 1024 tokens, spendable entirely on `<think>` | Send `think: false` for models with the `thinking` capability |
| 3 | `parallelToolCalls: false` gated on `provider === "openai"`, excluding Ollama and OpenRouter — which use the same client | Gate widened to all OpenAI-compatible providers |
| 4 | `createOpenAI(...)(modelId)` resolves to the **Responses API** (`/v1/responses`) | `.chat(modelId)` |
| 5 | `EFFORT_MODELS.ollama` hardcoded `qwen3:4b` at all three efforts — `/effort` was a no-op, and a user without that tag got a 404 | Read the catalogue from `/api/tags` |
| 6 | No check that the chosen model supports tools | Capability preflight |
| 7 | Ollama errors surfaced as raw `llama-server` stderr | Mapped to one actionable line |

### On defect 4

`node_modules/@ai-sdk/openai/dist/index.js:8036` — the callable provider form routes to `createResponsesModel`, which POSTs to `${baseURL}/responses`.

Ollama 0.32.1 *does* implement that endpoint (verified: it returns a proper `model not found` for a bogus model, whereas a genuinely absent path returns plain-text `404 page not found`). **So this was not broken — it was fragile.** Older Ollama builds, LM Studio, llama.cpp's server and vLLM are all `/v1/chat/completions`-only. `.chat()` is the endpoint every OpenAI-compatible local server supports and the one their tool calling is tested against.

---

## 3. Model discovery

[src/sdk/ollama.ts](../src/sdk/ollama.ts). Every other provider has a model table in the source; Ollama's catalogue is whatever the user pulled, so it must be read from the server.

`/api/tags` returns, per model, exactly what matters:

```json
{ "name": "qwen3:4b",
  "details": { "parameter_size": "4.0B", "quantization_level": "Q4_K_M", "context_length": 262144 },
  "capabilities": ["completion", "tools", "thinking"] }
```

Two wrinkles handled:

- **`context_length` is inconsistent.** Present for `qwen3:4b`, absent for `gemma4:e4b`. Missing values are filled from `/api/show`'s `model_info`, where the key is family-prefixed (`gemma4.context_length`). `extractContextLength()` matches on the **suffix**, because the prefix is a convention, not a contract — and a `model_info` block carries a dozen other `*_length` keys, so picking the wrong one would set `num_ctx` to 512.
- **Absent capabilities mean "old server", not "no tools".** `supportsTools()` returns `true` when the array is empty. Refusing to run on an old Ollama is worse than trying and letting the fallback parser catch it.

Everything fails soft: a 3-second timeout and null on any failure. Ollama being down must never block startup.

---

## 4. The context window

`recommendedNumCtx()` clamps at both ends:

| Bound | Value | Why |
|---|---|---|
| Floor | 8192 (`MIN_USABLE_NUM_CTX`) | Below this the prompt plus tool schemas plus one useful file does not fit |
| Ceiling | 16384 (`DEFAULT_NUM_CTX_CEILING`, overridable) | `qwen3:4b` advertises 262144; allocating that KV cache on a 16 GB laptop trades a truncation bug for an OOM |

A model whose own maximum is below the floor gets its maximum — asking for more than the weights support is an error, and a warning is the honest response.

### The part that matters: we do not assume the request lands

Ollama's OpenAI-compatible handler unmarshals into a typed struct and drops unrecognised fields. `options.num_ctx` is accepted without complaint **whether or not it is honoured**, and the response cannot tell you which happened. Testing it directly was impossible during development — the machine had 0.8 GB free and no model would load.

So [resolve-model.ts](../src/sdk/resolve-model.ts) asks, then verifies:

1. A custom `fetch` injects `options: { num_ctx }` (and `think: false` for thinking models) into each request body.
2. After the first successful call, `/api/ps` reports the context length the model was **actually loaded with**.
3. If it is lower than requested, a warning names the exact fix:

```
qwen3:4b is running with a 4096-token context, but Zizou asked for 16384.
Your Ollama version ignores per-request num_ctx, so long prompts are being
silently truncated — which is the usual cause of malformed tool calls.
Fix: restart Ollama with OLLAMA_CONTEXT_LENGTH=16384.
```

This is correct on every Ollama version, including ones released after the code was written — which guessing would not have been.

Warnings reach the UI through a small bus in `ollama.ts` (`emitOllamaWarning` / `drainOllamaWarnings`): the `sdk/` layer cannot import from `ui/`, and a stray `console.warn` corrupts the Ink frame.

---

## 5. Transport

```ts
const ollama = createOpenAI({
  baseURL: `${baseURL}/v1`,
  apiKey,
  fetch: createLocalModelFetch(modelId),
});
return ollama.chat(modelId);   // NOT ollama(modelId)
```

Five tests in [local-transport.test.ts](../src/sdk/local-transport.test.ts) pin this against a stub server: the request must hit `/v1/chat/completions` and not `/v1/responses`, `num_ctx` must exceed 4096 and stay below the model's maximum, `think` must be `false`, and the payload must survive the body rewrite.

Both regressions were confirmed to fail those tests when reintroduced — reverting to `ollama(modelId)` fails all five; removing the `num_ctx` injection fails two.

---

## 6. Model resolution, and the bug it nearly reopened

[src/sdk/active-model.test.ts](../src/sdk/active-model.test.ts) exists because display and runtime once resolved models through different tables — the sidebar showed `claude-3-5-sonnet-latest` while the agent called `claude-sonnet-4-5`, on three of six providers, silently.

Removing `EFFORT_MODELS.ollama` reopened exactly that. `resolveAgentConfig()` would have fallen through to `fallbackModel()` while `getActiveModelId()` consulted a new cache — the same divergence, one provider at a time. **The failing test caught it.**

The fix is [src/config/local-catalog.ts](../src/config/local-catalog.ts): a dependency-free store in the layer both resolvers already import, read synchronously by both.

```
sdk/ollama.ts  ──primeOllamaCache()──▶  config/local-catalog.ts
                                              ▲            ▲
                          resolveAgentConfig()─┘            └─getActiveModelId()
```

Selection is by on-disk size — the only cost signal available locally — with `fast` taking the smallest and `max` the largest. **Models that cannot call tools are excluded rather than ranked:** for an agent, a model that cannot act is not a cheaper option, it is a broken one, and it must not win `fast` for being small.

An explicit pin via `/model` or `/modelid` always wins, and before the cache is primed (startup, or Ollama down) the lookup returns null and falls through to the built-in default like every other provider.

---

## 7. Preflight and errors

`preflightOllama(modelId)` runs on provider switch. Checks gate each other — telling someone their model lacks tool support when the server isn't running is noise:

1. Server reachable? → `"Ollama is not reachable at <url> — is \`ollama serve\` running?"`
2. Any models installed? → suggests `ollama pull qwen3:4b`
3. Requested model installed? → lists what *is* installed
4. Does it support tools? → names the installed models that do
5. Is its context large enough? → warns if below the floor

An empty result means the setup is sound, which is worth stating because the failure mode it replaces was silence.

`explainOllamaError()` rewrites raw stderr. The real message observed during development:

```
llama-server process has terminated: exit status 1:
ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size
1765048320 ... unable to allocate CPU_REPACK buffer
```

becomes:

```
Not enough free memory to load `gemma4:e4b`. Close some applications, or
switch to a smaller model with /model ollama <name> (/models lists yours).
```

Unrecognised messages pass through unchanged — a worse guess is not an improvement.

---

## 8. User-facing surface

```
/model ollama <name>   Switch and pin; preflights and reports problems
/models                Live catalogue with capability badges
/ollama <url>          Base URL; re-primes the catalogue
/ollama ctx <n>        Cap the context window asked of local models
```

`/models` for Ollama now reads the server instead of printing a hardcoded list. The old line advertised `llama3 (default), mistral, phi3` — none of which was the real default (`qwen3:4b`), and any of which might not be installed:

```
ollama      - installed locally (v0.32.1):
              qwen3:4b 4.0B Q4_K_M  [tools, thinking, 256k ctx]
              gemma4:e4b 8.0B Q4_K_M  [tools, thinking, 128k ctx]
```

---

## 9. Files

**New:** `src/sdk/ollama.ts`, `src/sdk/ollama.test.ts` (28 tests), `src/sdk/local-transport.test.ts` (5 tests), `src/config/local-catalog.ts`

**Modified:** `src/sdk/resolve-model.ts` (`.chat()`, request hook), `src/config/effort.ts` (Ollama entry removed), `src/config/agent-config.ts` + `src/sdk/active-model.test.ts` (shared resolution), `src/config/api-keys.ts` (`ollamaNumCtx`), `src/agent/run-turn.ts` (provider gate), `src/commands/index.ts` (live `/models`, preflight, `/ollama ctx`), `src/cli.tsx` (prime at startup), `src/ui/Chat.tsx` (warnings + error mapping), `docs/content/commands.mdx`

**Unchanged:** the tool layer, the agent loop, and the system prompt.

### Still unverified

Whether Ollama honours per-request `num_ctx` through the OpenAI-compatible endpoint. The `/api/ps` read-back makes this self-correcting at runtime, so it is a known unknown rather than a risk — but the `OLLAMA_CONTEXT_LENGTH` path is the guaranteed one if the warning ever fires.

### The measurement not yet taken

`bun run evals/run-evals.ts --provider ollama --repeat 5`, before and after, watching `fallbackParses`. The machine could not load a model during development (0.8 GB free). If the §1 diagnosis is right, that number drops sharply with no fine-tuning at all.
