/**
 * sdk/index.ts — Model provider abstraction layer.
 *
 * Layer: sdk
 * Allowed imports: config/
 * NOT allowed to import from: agent/, ui/, tools/
 *
 * This file re-exports the unified model resolver which supports all
 * configured providers: Anthropic, OpenAI, OpenRouter, Google, Groq, and Ollama.
 */

export { resolveModel, getActiveModelId, DEFAULT_MODELS } from "./resolve-model.js";
