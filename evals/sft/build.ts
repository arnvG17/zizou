// evals/sft/build.ts
//
// One command: generate, validate, split, write, report.
//
//   bun run evals/sft/build.ts                 # everything
//   bun run evals/sft/build.ts --band recovery # one band
//   bun run evals/sft/build.ts --limit 20      # quick pass while authoring
//   bun run evals/sft/build.ts --dry-run       # validate without writing
//
// VALIDATION IS A GATE, NOT A REPORT. A failing record means the dataset
// disagrees with the live tool schemas, and writing it anyway would produce
// a file that looks finished and trains the wrong thing. So nothing is
// written unless everything passes, and the process exits non-zero.
//
// The split is BY SCENARIO ID, not by record. Records from one scenario
// family are near-identical by construction; putting some in train and
// others in val would make validation loss measure memorization and report
// it as generalization.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAll } from "./generate.js";
import { allScenarios } from "./scenarios/index.js";
import { validateAll, DEFAULT_MAX_TOKENS } from "./validate.js";
import { BANDS, type Band, type TrainingRecord } from "./types.js";

const OUT_DIR = join(process.cwd(), "evals", "sft", "data");

// ─── Arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    band: get("--band") as Band | undefined,
    limit: get("--limit") ? Number(get("--limit")) : undefined,
    maxTokens: get("--max-tokens") ? Number(get("--max-tokens")) : DEFAULT_MAX_TOKENS,
    dryRun: argv.includes("--dry-run"),
    valFraction: get("--val") ? Number(get("--val")) : 0.1,
  };
}

// ─── Split ───────────────────────────────────────────────────────────────────

/**
 * Splits by scenario FAMILY — the id with its trailing index removed.
 *
 * `single-edit-timeout-7` and `single-edit-timeout-12` differ only in a
 * number, so they belong on the same side of the boundary. Splitting by
 * record would place a record's near-twin in the other half and make
 * validation loss measure nothing.
 */
export function familyOf(scenarioId: string): string {
  return scenarioId.replace(/-\d+$/, "");
}

/**
 * Holds out whole families, STRATIFIED BY BAND.
 *
 * Stratification is not a nicety here. Splitting families globally put four
 * families in validation, covering four of the nine bands — so validation
 * loss said nothing whatever about recovery, multi-file work, or knowing
 * when not to call a tool. A validation set that cannot see a behaviour
 * cannot tell you the model lost it.
 *
 * Deterministic by construction: families are sorted and selected by stride,
 * so regenerating gives the same split and two training runs remain
 * comparable.
 */
export function splitByFamily(
  records: TrainingRecord[],
  valFraction: number,
): { train: TrainingRecord[]; val: TrainingRecord[] } {
  // Records per family, and families per band.
  const sizeOf = new Map<string, number>();
  const familiesByBand = new Map<string, Set<string>>();
  for (const r of records) {
    const family = familyOf(r.meta.scenario);
    sizeOf.set(family, (sizeOf.get(family) ?? 0) + 1);
    const set = familiesByBand.get(r.meta.band) ?? new Set<string>();
    set.add(family);
    familiesByBand.set(r.meta.band, set);
  }

  const valFamilies = new Set<string>();
  for (const [band, families] of [...familiesByBand.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const bandRecords = records.filter((r) => r.meta.band === band).length;
    const target = bandRecords * valFraction;

    // Smallest families first. Every band must be represented, and with only
    // a couple of families in a band the smallest one is the cheapest way to
    // buy that coverage — taking the largest would hand a quarter of the
    // whole dataset to validation for one band's sake.
    const sorted = [...families].sort(
      (a, b) => (sizeOf.get(a)! - sizeOf.get(b)!) || a.localeCompare(b),
    );

    let taken = 0;
    for (const family of sorted) {
      if (taken > 0 && taken >= target) break;
      valFamilies.add(family);
      taken += sizeOf.get(family)!;
    }
  }

  const train: TrainingRecord[] = [];
  const val: TrainingRecord[] = [];
  for (const r of records) {
    (valFamilies.has(familyOf(r.meta.scenario)) ? val : train).push(r);
  }
  return { train, val };
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function histogram(label: string, counts: Record<string, number>, total: number): void {
  console.log(`\n${label}`);
  const width = Math.max(...Object.keys(counts).map((k) => k.length));
  for (const [key, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const pct = ((n / total) * 100).toFixed(1).padStart(5);
    const bar = "#".repeat(Math.round((n / total) * 40));
    console.log(`  ${key.padEnd(width)}  ${String(n).padStart(5)}  ${pct}%  ${bar}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let scenarios = allScenarios();
  if (args.band) {
    if (!BANDS.includes(args.band)) {
      console.error(`Unknown band "${args.band}". Known: ${BANDS.join(", ")}`);
      process.exit(2);
    }
    scenarios = scenarios.filter((s) => s.band === args.band);
  }
  if (args.limit) scenarios = scenarios.slice(0, args.limit);

  console.log(`Generating ${scenarios.length} scenarios by executing real tools...`);
  const started = Date.now();
  const { records, errors } = await generateAll(scenarios);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`Generated ${records.length} records in ${seconds}s.`);

  if (errors.length) {
    console.error(`\n${errors.length} scenario(s) failed to generate:\n`);
    for (const e of errors.slice(0, 30)) console.error(`  ${e}`);
    if (errors.length > 30) console.error(`  ... and ${errors.length - 30} more`);
    console.error(
      `\nA scenario fails when a tool did not behave as the scenario declared —\n` +
        `usually an old_string that is no longer unique, or an expectFailure\n` +
        `step that has started succeeding. Both mean the scenario is now\n` +
        `teaching something other than what it says it teaches.`,
    );
    process.exit(1);
  }

  // ── Validate ──
  const report = validateAll(records, args.maxTokens);
  console.log(
    `\nValidation: ${report.passed}/${report.total} passed  ` +
      `(tokens p50 ${report.tokenStats.p50}, p95 ${report.tokenStats.p95}, max ${report.tokenStats.max})`,
  );

  if (report.duplicates.length) {
    console.error(`\n${report.duplicates.length} duplicate record(s):`);
    for (const d of report.duplicates.slice(0, 10)) console.error(`  ${d}`);
  }

  if (report.problems.length) {
    console.error(`\n${report.problems.length} problem(s):\n`);
    const byRule: Record<string, number> = {};
    for (const p of report.problems) byRule[p.rule] = (byRule[p.rule] ?? 0) + 1;
    for (const p of report.problems.slice(0, 40)) {
      console.error(`  [${p.rule}] ${p.record}: ${p.detail}`);
    }
    if (report.problems.length > 40) {
      console.error(`  ... and ${report.problems.length - 40} more`);
    }
    histogram("Problems by rule:", byRule, report.problems.length);
    process.exit(1);
  }

  // ── Stats ──
  const bands: Record<string, number> = {};
  const tools: Record<string, number> = {};
  let toolCalls = 0;
  for (const r of records) {
    bands[r.meta.band] = (bands[r.meta.band] ?? 0) + 1;
    for (const t of r.meta.tools) {
      tools[t] = (tools[t] ?? 0) + 1;
      toolCalls++;
    }
  }
  histogram("Records by band:", bands, records.length);
  histogram("Tool calls by tool:", tools, toolCalls || 1);

  // Every tool must appear, with one documented exception. A tool with no
  // coverage is one the model meets for the first time in production.
  //
  // openFile is excluded ON PURPOSE. It shells out to the OS default
  // handler, so generating even one record would launch a browser or editor
  // on whoever is building the dataset — a thousand scenarios would make
  // that unusable. Its schema is a single `path` string, identical in shape
  // to readFile's, and it is fire-and-forget with no result to learn from,
  // so the cost of leaving it out is close to zero.
  const KNOWN_UNCOVERED = new Set(["openFile"]);

  const uncovered = Object.keys(
    (await import("../../src/tools/index.js")).buildToolMap(async () => true),
  ).filter((name) => !tools[name] && !KNOWN_UNCOVERED.has(name));

  if (uncovered.length) {
    console.error(
      `\nNo coverage for: ${uncovered.join(", ")}\n` +
        `Every tool needs at least one record, or the model meets it first in production.\n` +
        `Add scenarios, or add the tool to KNOWN_UNCOVERED with the reason why.`,
    );
    process.exit(1);
  }

  if (args.dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  // ── Write ──
  const { train, val } = splitByFamily(records, args.valFraction);
  mkdirSync(OUT_DIR, { recursive: true });

  const write = (name: string, rows: TrainingRecord[]) => {
    const path = join(OUT_DIR, name);
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
    console.log(`  ${name}  ${String(rows.length).padStart(5)} records`);
  };

  console.log(`\nWriting to ${OUT_DIR}:`);
  write("train.jsonl", train);
  write("val.jsonl", val);

  const valFamilies = [...new Set(val.map((r) => familyOf(r.meta.scenario)))].sort();
  const valBands: Record<string, number> = {};
  for (const r of val) valBands[r.meta.band] = (valBands[r.meta.band] ?? 0) + 1;

  // Every band must appear in validation, or its behaviour is unmeasured.
  const missing = Object.keys(bands).filter((b) => !valBands[b]);
  if (missing.length) {
    console.error(`\nValidation set is missing bands: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nValidation covers all ${Object.keys(valBands).length} bands.`);
  writeFileSync(
    join(OUT_DIR, "manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalRecords: records.length,
        train: train.length,
        val: val.length,
        valFamilies,
        valBands,
        bands,
        tools,
        tokenStats: report.tokenStats,
        // Recorded so a dataset can be traced back to the schemas it was
        // built from. A model trained before a tool changed is not wrong,
        // but it is answering a question nobody is asking any more.
        toolNames: Object.keys(tools).sort(),
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(`  manifest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
