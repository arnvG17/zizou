// src/agent/history.ts
//
// LAYER: agent/
//
// Making a conversation safe to send.
//
// WHY THIS IS ITS OWN MODULE, AT THE PROVIDER BOUNDARY:
//   Corrupt history used to kill a turn before a single tool ran, with
//   "Invalid prompt: The messages do not match the ModelMessage[] schema."
//   The first fix repaired history when a SESSION LOADED, which was the wrong
//   place — it could not help a session already running with the bad messages
//   in memory, and it left every other entry point (session switch, a
//   mid-turn history-updated event, a resumed plan) unguarded.
//
//   A conversation can be malformed for reasons that have nothing to do with
//   each other, so the guard belongs where they all converge: immediately
//   before the messages are handed to the model. One chokepoint, no way past.
//
// DEPENDENCY DIRECTION: imports nothing from this codebase, so both
// run-turn.ts and executor.ts can use it without a cycle.

import type { ModelMessage } from "ai";

/** The tagged shapes AI SDK v7 accepts for a tool result's `output`. */
type OutputTag = "text" | "json" | "error-text" | "error-json" | "content";

/**
 * Reads a tool result's payload out of its tagged wrapper.
 *
 * AI SDK v7 stores output as `{ type: "json", value: {...} }` — the payload is
 * under `.value`, and the object itself only says what kind it is. Reading the
 * wrapper directly finds no `success` field on any result, which is how failed
 * commands came back to the model labelled "Command completed successfully".
 */
export function unwrapToolOutput(part: any): { value: any; type: OutputTag } {
  const raw = part?.output ?? part?.result;
  if (raw && typeof raw === "object" && typeof raw.type === "string" && "value" in raw) {
    return { value: raw.value, type: raw.type as OutputTag };
  }
  // Untagged: an older persisted session, or a provider that does not tag.
  return { value: raw, type: part?.isError ? "error-json" : "json" };
}

/** Wraps a payload in the tagged shape the schema requires. */
export function tagToolOutput(value: unknown, type: OutputTag = "json"): { type: OutputTag; value: unknown } {
  // "text" demands a string value; anything structured has to go as json.
  if (type === "text" && typeof value !== "string") return { type: "json", value };
  if (type === "error-text" && typeof value !== "string") return { type: "error-json", value };
  return { type, value };
}

/**
 * Returns a conversation that can be sent, whatever state it arrived in.
 *
 * Three things make a conversation unsendable, and all three end the same way
 * — the turn dies at the provider before anything runs:
 *
 *   1. UNTAGGED TOOL OUTPUT. The history trimmer used to write the bare
 *      payload into `output` instead of the `{type, value}` wrapper. Sessions
 *      written by those builds still hold the broken shape on disk, so fixing
 *      the writer alone would leave them permanently unopenable.
 *   2. AN ORPHANED TOOL CALL. Every provider requires a tool-call to be
 *      followed by its result. A turn aborted between the two — Esc, a crash,
 *      a rate limit — leaves an assistant message that can never be sent again.
 *   3. A STRUCTURALLY BROKEN MESSAGE: null, no role, null content.
 *
 * Repairing beats rejecting. Losing a stale tool receipt costs the model a
 * little context; refusing to send costs the user their whole session.
 */
export function repairHistory(messages: ModelMessage[]): ModelMessage[] {
  if (!Array.isArray(messages)) return [];

  // Which tool-call ids actually have a matching result.
  const resolved = new Set<string>();
  for (const msg of messages) {
    if ((msg as any)?.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as any[]) {
      if (part?.type === "tool-result" && part.toolCallId) resolved.add(part.toolCallId);
    }
  }

  const out: ModelMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || !(msg as any).role) continue;

    if (!Array.isArray(msg.content)) {
      // A string content is fine; null/undefined is not.
      if (msg.content === null || msg.content === undefined) continue;
      out.push(msg);
      continue;
    }

    const content = (msg.content as any[])
      .filter((part) => {
        if (!part || typeof part !== "object") return false;
        // Drop a call nothing ever answered.
        if (part.type === "tool-call" && !resolved.has(part.toolCallId)) return false;
        return true;
      })
      .map((part) => {
        if (part.type !== "tool-result") return part;
        const raw = part.output ?? part.result;
        const alreadyTagged =
          raw && typeof raw === "object" && typeof raw.type === "string" && "value" in raw;
        if (alreadyTagged) return part;
        return { ...part, output: tagToolOutput(raw ?? {}, part.isError ? "error-json" : "json") };
      });

    // A message left with no content at all is itself invalid. A user message
    // is kept regardless — dropping the thing the user actually said would
    // silently change what was asked.
    if (content.length === 0 && (msg as any).role !== "user") continue;

    out.push({ ...msg, content } as ModelMessage);
  }

  return out;
}
