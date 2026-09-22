// evals/sft/render.ts
//
// Renders a record the way Qwen3's chat template does, so the literal
// training target can be read by a human.
//
//   bun run evals/sft/render.ts --id single-edit-timeout-0
//   bun run evals/sft/render.ts --band recovery --limit 1
//
// WHY THIS EXISTS AND WHAT IT IS NOT.
//
// This is a VIEWER, not the training pipeline. Actual training must render
// with the model's own tokenizer:
//
//     tokenizer.apply_chat_template(messages, tools=tools, tokenize=False)
//
// because the tokenizer ships the authoritative template and a hand-written
// copy of it drifts silently — the failure would be a model trained on
// almost-right delimiters, which is worse than one trained on obviously
// wrong ones because it half-works.
//
// The copy below is transcribed from the live Ollama template for qwen3:4b
// (/api/show → .template) and exists so that the shape can be checked by
// eye. It is the single most important thing to get right in this whole
// dataset, and "we assumed" is not good enough: specs/010-sft-dataset.md §10.1
// assumed, and called this exact format a LOSER.
//
// The template's essential facts, visible in the output below:
//   - tool schemas go INSIDE the system block, in <tools> tags
//   - a tool call is <tool_call>{"name":...,"arguments":{...}}</tool_call>
//   - a tool RESULT comes back as a USER turn wrapped in <tool_response>
//   - turns are delimited by <|im_start|>role ... <|im_end|>

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TrainingRecord } from "./types.js";

const IM_START = "<|im_start|>";
const IM_END = "<|im_end|>";

/**
 * Renders one record in Qwen3 / Hermes form.
 *
 * Mirrors the live template, including the exact wording of the tool preamble,
 * so a diff against the real thing is meaningful.
 */
export function renderQwen3(record: TrainingRecord): string {
  const parts: string[] = [];

  // ── System block: prompt + tool schemas together ──────────────────────
  const toolLines = record.tools
    .map((t: any) => `{"type": "function", "function": ${JSON.stringify(t.function)}}`)
    .join("\n");

  parts.push(
    `${IM_START}system\n${record.system}\n\n` +
      `# Tools\n\n` +
      `You may call one or more functions to assist with the user query.\n\n` +
      `You are provided with function signatures within <tools></tools> XML tags:\n` +
      `<tools>\n${toolLines}\n</tools>\n\n` +
      `For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n` +
      `<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>${IM_END}`,
  );

  for (const msg of record.messages) {
    if (msg.role === "user") {
      parts.push(`${IM_START}user\n${msg.content}${IM_END}`);
      continue;
    }

    if (msg.role === "tool") {
      // NOT a "tool" turn — the template renders results as USER turns.
      // Anyone hand-rolling this would reasonably expect otherwise.
      parts.push(`${IM_START}user\n<tool_response>\n${msg.content}\n</tool_response>${IM_END}`);
      continue;
    }

    let body = msg.content ?? "";
    for (const call of msg.tool_calls ?? []) {
      // arguments is stored as a JSON string and interpolated RAW — the
      // template does `"arguments": {{ .Function.Arguments }}` with no
      // quoting, so the value lands as a JSON object, not a string.
      body +=
        `${body ? "\n" : ""}<tool_call>\n` +
        `{"name": "${call.function.name}", "arguments": ${call.function.arguments}}\n` +
        `</tool_call>`;
    }
    parts.push(`${IM_START}assistant\n${body}${IM_END}`);
  }

  return parts.join("\n");
}

/**
 * Just the spans the model is trained to produce.
 *
 * Training uses completion-only loss, so this is the text that actually
 * carries gradient. Reading it on its own is the fastest way to notice that
 * a record is teaching prose where it should teach a call, or vice versa.
 */
export function renderCompletions(record: TrainingRecord): string {
  return record.messages
    .filter((m) => m.role === "assistant")
    .map((m: any, i) => {
      let body = m.content ?? "";
      for (const call of m.tool_calls ?? []) {
        body +=
          `${body ? "\n" : ""}<tool_call>\n` +
          `{"name": "${call.function.name}", "arguments": ${call.function.arguments}}\n` +
          `</tool_call>`;
      }
      return `--- completion ${i + 1} ---\n${body}`;
    })
    .join("\n\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function loadRecords(): TrainingRecord[] {
  const dir = join(process.cwd(), "evals", "sft", "data");
  const out: TrainingRecord[] = [];
  for (const file of ["train.jsonl", "val.jsonl"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const records = loadRecords();
  if (!records.length) {
    console.error("No dataset found. Run: bun run evals/sft/build.ts");
    process.exit(1);
  }

  const id = get("--id");
  const band = get("--band");
  const out = get("--out");
  const limit = Number(get("--limit") ?? 1);

  // --out writes a machine-readable reference instead of printing. This is
  // what training/verify_render.py diffs HuggingFace's apply_chat_template
  // against: two independent renderings of the same record that MUST agree,
  // because one is what the model is trained on and the other is what Ollama
  // serves at inference.
  if (out) {
    // One per band by default — a parity bug is likely to be shape-specific
    // (a record with no tool calls, a record with a failing call), so a
    // sample spanning every band beats N samples of the same shape.
    const perBand = Number(get("--per-band") ?? 3);
    const counts = new Map<string, number>();
    const picked: typeof records = [];
    for (const r of records) {
      const n = counts.get(r.meta.band) ?? 0;
      if (n >= perBand) continue;
      counts.set(r.meta.band, n + 1);
      picked.push(r);
    }

    const payload = picked.map((r) => ({
      id: r.meta.id,
      band: r.meta.band,
      system: r.system,
      tools: r.tools,
      messages: r.messages,
      rendered: renderQwen3(r),
    }));

    writeFileSync(out, JSON.stringify(payload, null, 2), "utf-8");
    console.log(`Wrote ${payload.length} reference renders to ${out}`);
    console.log(`Bands covered: ${[...counts.keys()].sort().join(", ")}`);
    return;
  }

  let selected = records;
  if (id) selected = selected.filter((r) => r.meta.id === id);
  if (band) selected = selected.filter((r) => r.meta.band === band);
  selected = selected.slice(0, limit);

  if (!selected.length) {
    console.error(`No record matched${id ? ` --id ${id}` : ""}${band ? ` --band ${band}` : ""}.`);
    process.exit(1);
  }

  for (const record of selected) {
    console.log("=".repeat(78));
    console.log(`${record.meta.id}  [${record.meta.band}]  tools: ${record.meta.tools.join(", ") || "none"}`);
    console.log("=".repeat(78));
    console.log(
      argv.includes("--completions-only") ? renderCompletions(record) : renderQwen3(record),
    );
    console.log();
  }
}

if (import.meta.main) main();
