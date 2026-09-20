// src/config/local-catalog.ts
//
// LAYER: config/
//
// The installed local-model catalogue, as a synchronous read.
//
// WHY THIS IS NOT IN sdk/ollama.ts, WHERE THE FETCHING LIVES:
//
// Model resolution happens in two places that must never disagree —
// resolveAgentConfig() (what the agent calls) and getActiveModelId() (what the
// UI prints). sdk/active-model.test.ts exists because they DID disagree once:
// the sidebar showed claude-3-5-sonnet-latest while the agent called
// claude-sonnet-4-5, on three of six providers, silently.
//
// Ollama reopens that risk, because its catalogue is not a table in the source
// — it is whatever the user pulled, and only the server knows. If each caller
// consulted the server separately, or one consulted it and the other fell back
// to a hardcoded default, the two would drift apart again for one provider.
//
// So the list is stored here, in the layer both resolvers already depend on,
// and read synchronously by both. sdk/ollama.ts owns fetching it and calls
// setLocalCatalog(); this module owns answering questions about it and has no
// imports and no I/O.

/** The one fact about a local model that resolution needs. */
export interface LocalModel {
  name: string;
  /** On-disk size in bytes — the only cost signal available locally. */
  sizeBytes: number;
  /** Whether the model can emit native tool calls. */
  toolCapable: boolean;
}

let catalogue: LocalModel[] | null = null;

/**
 * Publishes the catalogue read from the server, smallest first.
 *
 * Called by sdk/ollama.ts after a successful probe. Passing an empty array is
 * meaningful — "the server answered and has nothing installed" — and is not
 * the same as never having primed.
 */
export function setLocalCatalog(models: LocalModel[]): void {
  catalogue = [...models].sort((a, b) => a.sizeBytes - b.sizeBytes);
}

/** The catalogue, or null when it has not been primed. */
export function getLocalCatalog(): LocalModel[] | null {
  return catalogue;
}

/** Forgets the catalogue, so the next prime re-reads the server. */
export function clearLocalCatalog(): void {
  catalogue = null;
}

/**
 * The local model to use at this effort, or null when unknown.
 *
 * Ordered by size, which tracks capability closely enough within one machine's
 * collection. Models that cannot call tools are excluded rather than ranked:
 * for an agent, a model that cannot act is not a cheaper option, it is a
 * broken one, and it must not win `fast` just for being small.
 *
 * Null means "fall back to the built-in default" — the behaviour every other
 * provider already has when its table has no entry.
 */
export function localModelForEffort(effort: "fast" | "balanced" | "max"): string | null {
  if (!catalogue) return null;
  const usable = catalogue.filter((m) => m.toolCapable);
  if (usable.length === 0) return null;
  if (effort === "fast") return usable[0]!.name;
  if (effort === "max") return usable[usable.length - 1]!.name;
  return usable[Math.floor((usable.length - 1) / 2)]!.name;
}
