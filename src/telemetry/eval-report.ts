// src/telemetry/eval-report.ts
//
// LAYER: telemetry/
// Allowed imports: node builtins, ./pricing.js.
//
// Reads the newest report written by evals/run-evals.ts so the chat sidebar can
// show how the current model scored on the golden tasks.
//
// WHY THE UI DOES NOT IMPORT FROM evals/: the harness imports half the agent to
// run tasks, and pulling that graph into the TUI to read a summary would mean
// the chat interface could not start if the eval harness failed to compile.
// This module reads the report as a FILE FORMAT and owns its own defensive
// types, which is also what makes it safe against a report written by an older
// version: unknown fields are ignored, missing ones read as absent, and a
// malformed file yields null instead of throwing into a render.
//
// The point of surfacing this in the chat UI: the user is about to trust this
// model with their codebase. "claude-sonnet-4-5 — 100% on 11 golden tasks,
// measured at c7ee198" is the difference between a model they picked and a
// model they have evidence for.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Just enough of the report shape for the sidebar. Everything is optional. */
interface RawSummary {
  cell?: { provider?: string; modelId?: string; effort?: string };
  passRate?: number;
  tasksPassed?: number;
  tasksTotal?: number;
  avgToolCalls?: number;
  avgTokens?: number;
  avgDurationMs?: number;
  avgCostUsd?: number | null;
  fallbackParses?: number;
  toolFailures?: number;
}

interface RawReportFile {
  reports?: Array<{
    gitSha?: string;
    startedAt?: string;
    integrityOk?: boolean;
    cell?: { provider?: string; modelId?: string; effort?: string };
    tasks?: Array<{ id?: string; passRate?: number }>;
  }>;
  summaries?: RawSummary[];
}

/** One model's line in the sidebar. */
export interface EvalCellSummary {
  provider: string;
  modelId: string;
  effort: string;
  passRate: number;
  tasksPassed: number;
  tasksTotal: number;
  avgToolCalls: number;
  avgCostUsd: number | null;
  fallbackParses: number;
}

export interface EvalSnapshot {
  gitSha: string;
  startedAt: string;
  /** How stale the report is, in whole days. */
  ageDays: number;
  integrityOk: boolean;
  cells: EvalCellSummary[];
  /** Task ids that did not pass every run, across all cells. */
  failingTaskIds: string[];
  reportPath: string;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v ? v : fallback;
}

/**
 * The newest report JSON, or null when there is none.
 *
 * Never throws. A missing directory is the normal state before the suite has
 * ever run, and the sidebar renders "not run yet" rather than an error.
 */
export function readLatestEvalReport(projectRoot: string): EvalSnapshot | null {
  try {
    const dir = join(projectRoot, "evals", "reports");
    if (!existsSync(dir)) return null;

    const candidates = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const full = join(dir, f);
        return { full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (candidates.length === 0) return null;

    const newest = candidates[0]!;
    const parsed = JSON.parse(readFileSync(newest.full, "utf-8")) as RawReportFile;

    const reports = Array.isArray(parsed.reports) ? parsed.reports : [];
    const summaries = Array.isArray(parsed.summaries) ? parsed.summaries : [];
    if (summaries.length === 0) return null;

    const first = reports[0] ?? {};
    const startedAt = str(first.startedAt, new Date(newest.mtime).toISOString());
    const ageDays = Math.max(
      0,
      Math.floor((Date.now() - new Date(startedAt).getTime()) / 86_400_000),
    );

    const cells: EvalCellSummary[] = summaries.map((s) => ({
      provider: str(s.cell?.provider, "?"),
      modelId: str(s.cell?.modelId, "?"),
      effort: str(s.cell?.effort, "?"),
      passRate: num(s.passRate),
      tasksPassed: num(s.tasksPassed),
      tasksTotal: num(s.tasksTotal),
      avgToolCalls: num(s.avgToolCalls),
      avgCostUsd: typeof s.avgCostUsd === "number" ? s.avgCostUsd : null,
      fallbackParses: num(s.fallbackParses),
    }));

    const failing = new Set<string>();
    for (const report of reports) {
      for (const task of report.tasks ?? []) {
        if (task.id && num(task.passRate, 1) < 1) failing.add(task.id);
      }
    }

    return {
      gitSha: str(first.gitSha, "unknown"),
      startedAt,
      ageDays,
      integrityOk: first.integrityOk !== false,
      cells,
      failingTaskIds: [...failing],
      reportPath: newest.full,
    };
  } catch {
    // A corrupt or partially-written report must not take the chat UI down.
    return null;
  }
}

/**
 * The cell matching the model currently in use, or null.
 *
 * Matching is on model id alone, not provider: the same model served through
 * OpenRouter and directly is the same model for scoring purposes, and the user
 * asking "how does what I am running score" does not mean "through this exact
 * vendor".
 */
export function cellForModel(
  snapshot: EvalSnapshot | null,
  modelId: string,
): EvalCellSummary | null {
  if (!snapshot) return null;
  return snapshot.cells.find((c) => c.modelId === modelId) ?? null;
}

/**
 * Whether the report predates the current commit.
 *
 * A pass rate measured three commits ago is evidence about that commit. The
 * sidebar marks it stale rather than quietly presenting it as current.
 */
export function isStale(snapshot: EvalSnapshot, currentSha: string): boolean {
  if (!currentSha || currentSha === "unknown") return false;
  return snapshot.gitSha !== currentSha;
}
