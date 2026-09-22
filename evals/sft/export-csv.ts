// evals/sft/export-csv.ts
//
// Exports the dataset as CSV, for reading in a spreadsheet.
//
//   bun run sft:csv
//
// WHAT THIS IS FOR, AND WHAT IT IS NOT
//
// This is an INSPECTION artifact. Training reads the JSONL — a CSV cannot
// carry the nested messages/tools structure without mangling it, and anything
// that round-trips through a spreadsheet will lose the exact whitespace that
// editFile's old_string depends on. Never train from this file.
//
// What it is good for: sorting 1048 records by band, eyeballing which prompts
// look unnatural, spotting a tool that is over- or under-represented, and
// handing someone a view of the dataset who does not want to read JSONL.
//
// Three files are written:
//   records.csv    one row per training record
//   calls.csv      one row per tool call, for per-call analysis
//   summary.csv    band and tool counts, the manifest as a table

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TrainingRecord } from "./types.js";

const DATA_DIR = join(process.cwd(), "evals", "sft", "data");

// ─── CSV encoding ────────────────────────────────────────────────────────────

/**
 * Escapes one field per RFC 4180.
 *
 * Newlines are turned into a literal \n rather than left raw. A quoted field
 * may legally contain a newline, but the result is a CSV whose rows no longer
 * line up with its lines — which breaks `wc -l`, `head`, grep, and about half
 * the tools someone would reach for when inspecting it. Since inspection is
 * the entire purpose of this file, one-row-per-line wins over fidelity to
 * text that is already available verbatim in the JSONL.
 */
function csvField(value: unknown): string {
  const s = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  // Always quote. Cheaper to reason about than conditional quoting, and
  // Excel/Sheets/pandas all handle it identically.
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(fields: unknown[]): string {
  return fields.map(csvField).join(",");
}

/**
 * Writes with a UTF-8 BOM.
 *
 * Without it, Excel on Windows decodes the file as the system codepage and
 * every non-ASCII character in a prompt — the em dashes and arrows this
 * dataset is full of — renders as mojibake. Sheets and pandas ignore the BOM.
 */
function writeCsv(path: string, rows: string[]): void {
  writeFileSync(path, "﻿" + rows.join("\n") + "\n", "utf-8");
}

// ─── Loading ─────────────────────────────────────────────────────────────────

function loadSplit(name: string): TrainingRecord[] {
  const path = join(DATA_DIR, `${name}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TrainingRecord);
}

/** The same char-based estimate the validator uses, so numbers agree. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

function firstUserPrompt(record: TrainingRecord): string {
  const msg = record.messages.find((m) => m.role === "user");
  return msg && "content" in msg ? msg.content : "";
}

function finalAssistantText(record: TrainingRecord): string {
  for (let i = record.messages.length - 1; i >= 0; i--) {
    const m = record.messages[i]!;
    if (m.role === "assistant" && m.content) return m.content;
  }
  return "";
}

// ─── Exports ─────────────────────────────────────────────────────────────────

function exportRecords(records: Array<TrainingRecord & { split: string }>): void {
  const rows = [
    csvRow([
      "id", "split", "band", "turns", "tool_calls", "tools",
      "user_prompt", "final_text", "est_tokens", "has_failure",
    ]),
  ];

  for (const r of records) {
    // A record containing a failed tool result is a recovery example. Worth a
    // column of its own: it is the most valuable band and the easiest to lose
    // track of when sorting by anything else.
    const hasFailure = r.messages.some(
      (m) => m.role === "tool" && /"success"\s*:\s*false/.test(m.content),
    );

    rows.push(
      csvRow([
        r.meta.id,
        r.split,
        r.meta.band,
        r.meta.turns,
        r.meta.tools.length,
        r.meta.tools.join(" > "),
        firstUserPrompt(r),
        finalAssistantText(r),
        estimateTokens(r.system + JSON.stringify(r.tools) + JSON.stringify(r.messages)),
        hasFailure ? "yes" : "no",
      ]),
    );
  }

  writeCsv(join(DATA_DIR, "records.csv"), rows);
  console.log(`  records.csv   ${records.length} rows`);
}

function exportCalls(records: Array<TrainingRecord & { split: string }>): void {
  const rows = [
    csvRow([
      "record_id", "split", "band", "step", "tool",
      "arguments", "ok", "result_preview",
    ]),
  ];

  let count = 0;
  for (const r of records) {
    let step = 0;
    for (const msg of r.messages) {
      if (msg.role !== "assistant" || !msg.tool_calls) continue;

      for (const call of msg.tool_calls) {
        step++;
        const result = r.messages.find(
          (m) => m.role === "tool" && m.tool_call_id === call.id,
        );
        const content = (result && "content" in result ? result.content : "") ?? "";
        const ok = content ? !/"success"\s*:\s*false/.test(content) : "";

        rows.push(
          csvRow([
            r.meta.id,
            r.split,
            r.meta.band,
            step,
            call.function.name,
            call.function.arguments,
            ok === "" ? "" : ok ? "ok" : "FAILED",
            // Truncated: a readFile result can be a whole file, and a
            // spreadsheet cell holding 4KB of source helps nobody.
            content.slice(0, 300),
          ]),
        );
        count++;
      }
    }
  }

  writeCsv(join(DATA_DIR, "calls.csv"), rows);
  console.log(`  calls.csv     ${count} rows`);
}

function exportSummary(records: Array<TrainingRecord & { split: string }>): void {
  const bands = new Map<string, number>();
  const tools = new Map<string, number>();

  for (const r of records) {
    bands.set(r.meta.band, (bands.get(r.meta.band) ?? 0) + 1);
    for (const t of r.meta.tools) tools.set(t, (tools.get(t) ?? 0) + 1);
  }

  const totalCalls = [...tools.values()].reduce((a, b) => a + b, 0);
  const rows = [csvRow(["category", "name", "count", "pct_of_category"])];

  for (const [band, n] of [...bands].sort((a, b) => b[1] - a[1])) {
    rows.push(csvRow(["band", band, n, ((n / records.length) * 100).toFixed(1)]));
  }
  for (const [tool, n] of [...tools].sort((a, b) => b[1] - a[1])) {
    rows.push(csvRow(["tool", tool, n, ((n / totalCalls) * 100).toFixed(1)]));
  }

  writeCsv(join(DATA_DIR, "summary.csv"), rows);
  console.log(`  summary.csv   ${rows.length - 1} rows`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const train = loadSplit("train").map((r) => ({ ...r, split: "train" }));
  const val = loadSplit("val").map((r) => ({ ...r, split: "val" }));
  const all = [...train, ...val];

  if (all.length === 0) {
    console.error(
      `No dataset found in ${DATA_DIR}.\n` +
        `The JSONL is gitignored — rebuild it with: bun run sft:build`,
    );
    process.exit(1);
  }

  console.log(`Exporting ${all.length} records (${train.length} train, ${val.length} val) to CSV:`);
  exportRecords(all);
  exportCalls(all);
  exportSummary(all);
  console.log(`\nWritten to ${DATA_DIR}`);
  console.log(`These are for READING. Training reads the .jsonl — a CSV cannot`);
  console.log(`carry the nested message structure, and round-tripping through a`);
  console.log(`spreadsheet would destroy the exact whitespace editFile depends on.`);
}

if (import.meta.main) main();
