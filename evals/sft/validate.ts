// evals/sft/validate.ts
//
// The gate. Nothing ships without passing every check here.
//
// The point is that these are EXECUTED, not described. specs/010-sft-dataset.md
// has a §10.2 table listing wrong field names — filePath vs path, oldString
// vs old_string, port: "3000" vs 3000, action "stop" vs "kill" — as prose for
// a human to check by eye. A table like that is only ever as current as the
// last person who remembered to update it after changing a Zod schema.
//
// Here the same rule is one line: parse every arguments blob with the live
// inputSchema from buildToolMap(). Add a tool, rename a field, tighten a
// type, and this file needs no edit — a dataset that disagrees with the
// schema stops being publishable the moment the schema changes.
//
// The subtlest check is #6. The exact malformed shapes that
// agent/fallback-tool-parse.ts exists to rescue — <function/name>{...},
// <tool_call> tags, bare {"name":...,"arguments":...} in prose — must never
// appear inside a content field, because a training set that contains them as
// TEXT teaches the model to emit them as text. That is the precise failure
// this whole dataset exists to remove.

import { buildToolMap } from "../../src/tools/index.js";
import type { TrainingRecord, TrainingMessage } from "./types.js";

const TOOLS = buildToolMap(async () => true);
const TOOL_NAMES = new Set(Object.keys(TOOLS));

/** Rough token estimate. Good enough to find outliers without a tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export interface Problem {
  record: string;
  rule: string;
  detail: string;
}

/** Default ceiling. Matches the num_ctx Zizou requests from local models. */
export const DEFAULT_MAX_TOKENS = 16384;

// ─── Individual rules ────────────────────────────────────────────────────────

/**
 * Tool-call syntax appearing as prose.
 *
 * Checked against content fields only — a real tool_call is structured data
 * and never a string, so any of these inside text is the failure mode itself.
 */
const PSEUDO_CALL_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /<function[\/>]/, what: "<function/> pseudo-tag" },
  { re: /<tool_call>/, what: "<tool_call> tag" },
  { re: /"arguments"\s*:/, what: 'raw {"name","arguments"} JSON' },
  { re: /"toolName"\s*:/, what: '"toolName" JSON (the AI SDK internal shape)' },
];

function checkPseudoCalls(record: TrainingRecord, problems: Problem[]): void {
  for (const [i, msg] of record.messages.entries()) {
    // Tool RESULTS legitimately contain arbitrary JSON echoed back from disk,
    // so only what the model is being taught to SAY is checked.
    if (msg.role === "tool") continue;
    const content = (msg as { content?: string }).content;
    if (!content) continue;
    for (const { re, what } of PSEUDO_CALL_PATTERNS) {
      if (re.test(content)) {
        problems.push({
          record: record.meta.id,
          rule: "no-pseudo-calls",
          detail: `message ${i} (${msg.role}) contains ${what} as text`,
        });
      }
    }
  }
}

/**
 * Replays the record's file edits to know what each file contains at each
 * point, so an editFile's old_string can be checked against the state the
 * model would actually be looking at — not against the original fixture.
 *
 * A record that reads a file, edits it, then edits it again with an
 * old_string from the ORIGINAL contents is teaching a stale read. It looks
 * fine in isolation and is wrong in sequence, which is why this replays
 * rather than spot-checks.
 */
function checkEditPreconditions(record: TrainingRecord, problems: Problem[]): void {
  const files = new Map<string, string>();

  for (const [i, msg] of record.messages.entries()) {
    if (msg.role === "tool") {
      // readFile results are the source of truth for a file's contents.
      if (msg.name === "readFile") {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed?.success && typeof parsed.contents === "string") {
            const call = findCallFor(record.messages, msg.tool_call_id);
            const path = call?.path;
            if (path) files.set(path, parsed.contents);
          }
        } catch {
          // A tool result that is not JSON is caught by its own rule below.
        }
      }
      continue;
    }

    if (msg.role !== "assistant" || !msg.tool_calls) continue;

    for (const call of msg.tool_calls) {
      if (call.function.name !== "editFile") continue;
      let args: any;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        continue; // reported by the schema rule
      }

      // A call whose result was a FAILURE is the content of a recovery
      // record, not a defect in it. The ambiguous old_string in
      // recovery-near-line-* is precisely what the model is being taught to
      // recognise and fix, so holding it to the precondition would reject
      // the most valuable records in the set for being what they are.
      //
      // Only successful edits are checked, and what they are checked for is
      // a stale read: an old_string taken from a version of the file that
      // the preceding turns have already changed.
      if (!resultSucceeded(record.messages, call.id)) {
        continue;
      }

      const known = files.get(args.path);
      if (known === undefined) continue; // never read — a different rule's job

      const occurrences = known.split(args.old_string).length - 1;
      if (occurrences === 0) {
        problems.push({
          record: record.meta.id,
          rule: "edit-precondition",
          detail: `message ${i}: editFile old_string not present in the last read of ${args.path}`,
        });
      } else if (occurrences > 1 && args.near_line === undefined) {
        problems.push({
          record: record.meta.id,
          rule: "edit-precondition",
          detail: `message ${i}: editFile old_string matches ${occurrences}x in ${args.path} with no near_line`,
        });
      }

      // Apply the edit so later steps see the updated file.
      if (occurrences >= 1) {
        files.set(args.path, known.replace(args.old_string, args.new_string));
      }
    }
  }
}

/**
 * Did the tool result for this call report success?
 *
 * Tools in this repo never throw — they return `{ success: false, error }` —
 * so the result object is the only place the outcome lives.
 */
function resultSucceeded(messages: TrainingMessage[], callId: string): boolean {
  for (const msg of messages) {
    if (msg.role !== "tool" || msg.tool_call_id !== callId) continue;
    try {
      const parsed = JSON.parse(msg.content);
      return parsed?.success !== false && !parsed?.error;
    } catch {
      return false;
    }
  }
  return false;
}

/** Finds the editFile/readFile args that produced a given tool_call_id. */
function findCallFor(messages: TrainingMessage[], id: string): any | null {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.tool_calls) continue;
    for (const call of msg.tool_calls) {
      if (call.id !== id) continue;
      try {
        return JSON.parse(call.function.arguments);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ─── The gate ────────────────────────────────────────────────────────────────

export function validateRecord(
  record: TrainingRecord,
  maxTokens = DEFAULT_MAX_TOKENS,
): Problem[] {
  const problems: Problem[] = [];
  const add = (rule: string, detail: string) =>
    problems.push({ record: record.meta.id, rule, detail });

  if (!record.system?.trim()) add("system-present", "system prompt is empty");
  if (!record.tools?.length) add("tools-present", "no tool schemas attached");
  if (!record.messages?.length) add("messages-present", "no messages");

  const seenCallIds = new Set<string>();

  for (const [i, msg] of (record.messages ?? []).entries()) {
    if (msg.role === "assistant") {
      const hasText = !!msg.content?.trim();
      const hasCalls = !!msg.tool_calls?.length;
      // An assistant turn that says nothing and does nothing renders as an
      // empty completion — the model's version of hanging.
      if (!hasText && !hasCalls) {
        add("no-empty-assistant", `message ${i} has neither content nor tool_calls`);
      }

      for (const call of msg.tool_calls ?? []) {
        seenCallIds.add(call.id);

        if (!TOOL_NAMES.has(call.function.name)) {
          add("known-tool", `message ${i} calls unknown tool "${call.function.name}"`);
          continue;
        }

        // arguments is a JSON STRING on the wire. An object here would render
        // as [object Object] through the chat template.
        if (typeof call.function.arguments !== "string") {
          add("arguments-are-string", `message ${i}: arguments must be a JSON string`);
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(call.function.arguments);
        } catch (err) {
          add("arguments-parse", `message ${i}: arguments is not valid JSON — ${String(err)}`);
          continue;
        }

        // THE SCHEMA CHECK. The live Zod schema, not a copy of it.
        const schema = (TOOLS as Record<string, any>)[call.function.name].inputSchema;
        const result = schema.safeParse(parsed);
        if (!result.success) {
          const issues = result.error.issues
            .map((it: any) => `${it.path.join(".") || "(root)"}: ${it.message}`)
            .join("; ");
          add("schema", `message ${i} (${call.function.name}) — ${issues}`);
        }
      }
    }

    if (msg.role === "tool") {
      if (!seenCallIds.has(msg.tool_call_id)) {
        // An orphan result is a conversation that does not typecheck: the
        // template will render an answer to a question nobody asked.
        add("tool-result-has-call", `message ${i} answers unknown call id ${msg.tool_call_id}`);
      }
      if (!msg.content?.length) {
        add("tool-result-nonempty", `message ${i} has an empty result`);
      }
    }
  }

  const last = record.messages?.[record.messages.length - 1];
  if (last && last.role !== "assistant") {
    add("ends-with-assistant", `record ends on a ${last.role} message`);
  }

  checkPseudoCalls(record, problems);
  checkEditPreconditions(record, problems);

  const tokens = estimateTokens(
    record.system + JSON.stringify(record.tools) + JSON.stringify(record.messages),
  );
  if (tokens > maxTokens) {
    add("token-budget", `~${tokens} tokens exceeds the ${maxTokens} limit`);
  }

  return problems;
}

export interface ValidationReport {
  total: number;
  passed: number;
  problems: Problem[];
  duplicates: string[];
  tokenStats: { p50: number; p95: number; max: number };
}

export function validateAll(
  records: TrainingRecord[],
  maxTokens = DEFAULT_MAX_TOKENS,
): ValidationReport {
  const problems: Problem[] = [];
  const failed = new Set<string>();
  const seenHashes = new Map<string, string>();
  const duplicates: string[] = [];
  const tokens: number[] = [];

  for (const record of records) {
    const found = validateRecord(record, maxTokens);
    if (found.length) {
      problems.push(...found);
      failed.add(record.meta.id);
    }

    // Near-identical records inflate an epoch without adding signal, and two
    // copies straddling the train/val split make validation loss a lie.
    const hash = record.system + "\u0000" + JSON.stringify(record.messages);
    const previous = seenHashes.get(hash);
    if (previous) duplicates.push(`${record.meta.id} duplicates ${previous}`);
    else seenHashes.set(hash, record.meta.id);

    tokens.push(
      estimateTokens(
        record.system + JSON.stringify(record.tools) + JSON.stringify(record.messages),
      ),
    );
  }

  tokens.sort((a, b) => a - b);
  const at = (q: number) => tokens[Math.min(tokens.length - 1, Math.floor(tokens.length * q))] ?? 0;

  return {
    total: records.length,
    passed: records.length - failed.size,
    problems,
    duplicates,
    tokenStats: { p50: at(0.5), p95: at(0.95), max: tokens[tokens.length - 1] ?? 0 },
  };
}
