// evals/run-evals.ts
//
// The eval runner. Rewritten against the new task contract in ./types.ts.
//
// WHAT IT DOES THAT THE OLD RUNNER DID NOT:
//
//   - Seeds fixtures, so a task can start from a codebase instead of an empty
//     directory. The old runner made a bare temp dir, which is why two tasks
//     had to fabricate their own starting files and left them behind in
//     temp-workspaces/ to be committed.
//
//   - Runs EVERY assertion and reports all of them. The old contract's single
//     expectedCheck short-circuited on the first failure, so one broken
//     condition hid the rest.
//
//   - Writes a run journal per run (see src/agent/debug/run-journal.ts), which
//     is both the artifact you read when a run fails and the source of every
//     metric in the report. The old runner serialized orchestrator events into
//     __eval_events.json inside the workspace it was about to delete, and
//     stripped agent-events down to their `kind` on the way — so the trace was
//     thrown away on success and near-useless on failure.
//
//   - Measures more than pass/fail: steps, tool calls, tool failures, fallback
//     parses, tokens, cost, duration. On agentic tasks that is the difference
//     between models, and pass/fail alone cannot see it.
//
//   - Sweeps a matrix of provider/effort cells in one invocation and emits a
//     comparison table, which is the whole point of supporting six providers.
//
// SAFETY INVARIANT (unchanged, and still the most important thing here):
//   Every run gets a fresh temp directory under evals/.artifacts/. The Zizou
//   project directory is NEVER used as a workspace, and the suite verifies the
//   project was untouched before it exits.
//
// USAGE:
//   bun run evals/run-evals.ts
//   bun run evals/run-evals.ts --task build-create-file
//   bun run evals/run-evals.ts --tag plan-mode
//   bun run evals/run-evals.ts --provider groq --effort fast
//   bun run evals/run-evals.ts --matrix anthropic:balanced,groq:fast --repeat 3
//   bun run evals/run-evals.ts --keep-workspaces

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";

import { ALL_TASKS, selectTasks } from "./tasks/index.js";
import type {
  AssertionContext,
  AssertionResult,
  FailureCategory,
  GoldenTask,
  MatrixCell,
  RunOutcome,
  SuiteReport,
  TaskResult,
} from "./types.js";

import type { ModelMessage } from "ai";
import { runOrchestrator, type OrchestratorEvent } from "../src/agent/orchestrator.js";
import type { ModeContext } from "../src/agent/mode.js";
import type { PlanStep, ProjectContext } from "../src/agent/types.js";
import { buildSystemPrompt } from "../src/context/build-system-prompt.js";
import { EFFORT_PROFILES, modelForEffort, type Effort } from "../src/config/effort.js";
import { resolveModel, getActiveModelId } from "../src/sdk/resolve-model.js";
import { getDefaultProvider, type ProviderChoice } from "../src/config/api-keys.js";
import { RunJournal, setActiveJournal, type RunTotals } from "../src/agent/debug/index.js";
import { costOf, getSessionUsage, resetUsage } from "../src/telemetry/index.js";

// ─── Paths ───────────────────────────────────────────────────────────────────

const EVALS_ROOT = resolve(import.meta.dir ?? dirname(new URL(import.meta.url).pathname), ".");
const PROJECT_ROOT = resolve(EVALS_ROOT, "..");
const ARTIFACTS_DIR = join(EVALS_ROOT, ".artifacts");
const REPORTS_DIR = join(EVALS_ROOT, "reports");

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface Args {
  taskId?: string;
  tag?: string;
  cells: MatrixCell[];
  repeatOverride?: number;
  keepWorkspaces: boolean;
  /** Seconds to pause between runs. Providers rate-limit aggressively. */
  pauseSeconds: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let taskId: string | undefined;
  let tag: string | undefined;
  let provider: ProviderChoice | undefined;
  let effort: Effort = "balanced";
  let matrix: string | undefined;
  let repeatOverride: number | undefined;
  let keepWorkspaces = false;
  let pauseSeconds = 8;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task" && argv[i + 1]) taskId = argv[++i];
    else if (a === "--tag" && argv[i + 1]) tag = argv[++i];
    else if (a === "--provider" && argv[i + 1]) provider = argv[++i] as ProviderChoice;
    else if (a === "--effort" && argv[i + 1]) effort = argv[++i] as Effort;
    else if (a === "--matrix" && argv[i + 1]) matrix = argv[++i];
    else if (a === "--repeat" && argv[i + 1]) repeatOverride = Number(argv[++i]);
    else if (a === "--keep-workspaces") keepWorkspaces = true;
    else if (a === "--pause" && argv[i + 1]) pauseSeconds = Number(argv[++i]);
  }

  // The matrix is the general form; --provider/--effort is the one-cell case.
  const cells: MatrixCell[] = matrix
    ? matrix.split(",").map((spec) => {
        const [p, e = "balanced"] = spec.split(":");
        return toCell(p as ProviderChoice, e as Effort);
      })
    : [toCell(provider ?? (getDefaultProvider() || "groq"), effort)];

  return { taskId, tag, cells, repeatOverride, keepWorkspaces, pauseSeconds };
}

function toCell(provider: ProviderChoice, effort: Effort): MatrixCell {
  return {
    provider,
    effort,
    // Resolve the model id NOW so the report records what actually ran rather
    // than the effort label, which says nothing a year from now.
    modelId: modelForEffort(provider, effort) ?? getActiveModelId(provider),
  };
}

// ─── Workspace management ────────────────────────────────────────────────────

function createWorkspace(runId: string): string {
  const dir = join(ARTIFACTS_DIR, runId, "workspace");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes the task's fixture files into the fresh workspace. */
function seedFixture(workspaceDir: string, task: GoldenTask): void {
  if (!task.fixture) return;
  for (const [relPath, contents] of Object.entries(task.fixture)) {
    const abs = resolve(workspaceDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf-8");
  }
}

function removeWorkspace(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort — a locked file must not fail the suite.
  }
}

// ─── Project integrity ──────────────────────────────────────────────────────
//
// The runner chdir()s into a temp workspace, and a tool that resolves a path
// wrongly could write into the project instead. This is the tripwire.

interface ProjectSnapshot {
  srcMtime: number | null;
  packageJsonMtime: number | null;
}

function snapshotProject(): ProjectSnapshot {
  const mtime = (p: string): number | null => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return null;
    }
  };
  return {
    srcMtime: mtime(join(PROJECT_ROOT, "src")),
    packageJsonMtime: mtime(join(PROJECT_ROOT, "package.json")),
  };
}

function verifyIntegrity(before: ProjectSnapshot): boolean {
  const after = snapshotProject();
  if (before.srcMtime !== after.srcMtime) {
    console.error("\n  INTEGRITY VIOLATION: src/ was modified during the eval run.");
    return false;
  }
  if (before.packageJsonMtime !== after.packageJsonMtime) {
    console.error("\n  INTEGRITY VIOLATION: package.json was modified during the eval run.");
    return false;
  }
  return true;
}

// ─── Cost ────────────────────────────────────────────────────────────────────

/**
 * Estimated USD for a run, or null when the model has no known rate.
 *
 * Costed from the TELEMETRY LEDGER, not from the journal totals. The journal
 * only sees calls that go through runTurn, which is the executor — so a
 * journal-derived cost silently omits the router call, the planner call, and
 * one verifier call per step. On a plan-mode task that is most of the calls.
 * See src/telemetry/usage.ts.
 *
 * Returning null rather than defaulting to a guessed rate is also deliberate:
 * a fabricated figure sitting in the same column as measured ones is worse
 * than an admitted gap.
 */
function estimateRunCost(modelId: string, provider: string): number | null {
  const usage = getSessionUsage();
  if (usage.totalCalls === 0) return null;
  // Any unpriced call makes the total a floor, not a cost. Report unknown
  // rather than a number that reads as complete.
  if (usage.unpricedCalls > 0) return null;
  return costOf(
    modelId,
    {
      inputTokens: usage.totalInputTokens,
      outputTokens: usage.totalOutputTokens,
      cachedInputTokens: usage.totalCachedInputTokens,
      reasoningTokens: usage.totalReasoningTokens,
    },
    provider,
  );
}

// ─── Budget ──────────────────────────────────────────────────────────────────

function checkBudget(task: GoldenTask, totals: RunTotals): string | null {
  const b = task.budget;
  if (!b) return null;
  if (b.maxToolCalls !== undefined && totals.toolCalls > b.maxToolCalls) {
    return `tool calls ${totals.toolCalls} > budget ${b.maxToolCalls}`;
  }
  if (b.maxDurationMs !== undefined && totals.durationMs > b.maxDurationMs) {
    return `duration ${(totals.durationMs / 1000).toFixed(0)}s > budget ${(b.maxDurationMs / 1000).toFixed(0)}s`;
  }
  if (b.maxTotalTokens !== undefined) {
    const total = totals.usage.inputTokens + totals.usage.outputTokens;
    if (total > b.maxTotalTokens) return `tokens ${total} > budget ${b.maxTotalTokens}`;
  }
  return null;
}

// ─── Journal reading ─────────────────────────────────────────────────────────

/** Parses a run's .jsonl back into events for the assertions to inspect. */
function readJournalEvents(jsonlPath: string): Array<Record<string, any>> {
  try {
    return readFileSync(jsonlPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, any> => e !== null);
  } catch {
    return [];
  }
}

// ─── Driving the orchestrator ────────────────────────────────────────────────

const autoConfirm = async (): Promise<boolean> => true;

/**
 * Runs one task once and returns the orchestrator's events.
 *
 * Plan mode stops at "plan-ready" for the user's y/n; the runner approves and
 * re-invokes to execute. Orchestrator-level events that the journal cannot see
 * from inside runTurn — the plan, and each verification — are recorded here, so
 * the .jsonl is a complete trace of the run rather than only its LLM turns.
 */
async function driveOrchestrator(
  task: GoldenTask,
  workspaceDir: string,
  cell: MatrixCell,
  journal: RunJournal,
): Promise<OrchestratorEvent[]> {
  const model = resolveModel(cell.provider as ProviderChoice, cell.modelId);
  const modeContext: ModeContext = { mode: task.mode, reason: "user-flag" };
  const profile = EFFORT_PROFILES[cell.effort as Effort] ?? EFFORT_PROFILES.balanced;

  const makeContext = async (): Promise<ProjectContext> => ({
    projectRoot: workspaceDir,
    systemPrompt: await buildSystemPrompt(workspaceDir, "executor"),
    maxSteps: profile.maxSteps,
  });

  const events: OrchestratorEvent[] = [];
  let approvedPlan: PlanStep[] | undefined;

  // Carried across prompts so a multi-turn task is one CONVERSATION rather
  // than a series of unrelated runs. Without this the suite could only ever
  // exercise the first turn, which is exactly how a history-trimming bug shipped
  // green — trimming happens only between turns.
  let history: ModelMessage[] = [];

  const consume = async (prompt: string, approved?: PlanStep[]) => {
    for await (const event of runOrchestrator({
      userPrompt: prompt,
      modeContext,
      context: await makeContext(),
      model,
      onConfirm: autoConfirm,
      history,
      ...(approved ? { approvedPlan: approved } : {}),
    })) {
      events.push(event);

      if (event.kind === "history-updated") history = event.history;

      if (event.kind === "plan-ready") {
        approvedPlan = event.steps;
        journal.plan(
          event.steps.map((s) => ({
            index: s.index,
            description: s.description,
            targetFiles: (s as any).targetFiles,
          })),
          event.assumptions,
        );
      } else if (event.kind === "step-verified") {
        journal.verification(
          event.step.index,
          event.verification.verified,
          event.verification.mismatches ?? [],
        );
      } else if (event.kind === "mode-info") {
        journal.phase("executor", `mode=${event.mode} reason=${event.reason}`);
      }
    }
  };

  await consume(task.prompt);
  if (approvedPlan) await consume(task.prompt, approvedPlan);

  // Each follow-up is a new turn on the SAME history — which is what makes the
  // between-turn machinery (history trimming, tool-result collapsing) run at all.
  for (const followUp of task.followUps ?? []) {
    approvedPlan = undefined;
    await consume(followUp);
    if (approvedPlan) await consume(followUp, approvedPlan);
  }

  return events;
}

// ─── One run ─────────────────────────────────────────────────────────────────

function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /rate.?limit/i.test(msg) ||
    msg.includes("429") ||
    msg.includes("Too Many Requests") ||
    (typeof err === "object" && err !== null && (err as any).statusCode === 429)
  );
}

function rateLimitWaitMs(err: unknown, attempt: number): number {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/try again in\s+([\d.]+)s/i);
  const base = m ? Math.ceil(parseFloat(m[1]) * 1000) : 5000;
  return base * attempt + 2000;
}

const MAX_RATE_LIMIT_ATTEMPTS = 4;

async function runOnce(
  task: GoldenTask,
  cell: MatrixCell,
  runIndex: number,
  keepWorkspaces: boolean,
): Promise<RunOutcome> {
  const runId = `${cell.provider}-${cell.effort}--${task.id}--run${runIndex + 1}-${Date.now()}`;
  const workspaceDir = createWorkspace(runId);
  seedFixture(workspaceDir, task);

  const journal = new RunJournal({
    dir: join(ARTIFACTS_DIR, runId),
    runId,
    label: `${task.id} [${cell.provider}/${cell.modelId}/${cell.effort}]`,
    root: workspaceDir,
  });

  // runTurn reads the active journal, so this is what makes every tool call and
  // file diff inside the agent land in THIS run's files.
  setActiveJournal(journal);

  // The usage ledger is process-wide, so without this every run would inherit
  // the previous one's tokens and the per-task cost column would climb
  // monotonically across the suite.
  resetUsage();

  journal.runStart({
    prompt: task.prompt,
    mode: task.mode,
    provider: cell.provider,
    modelId: cell.modelId,
    meta: { taskId: task.id, intent: task.intent, runIndex, effort: cell.effort },
  });

  const originalCwd = process.cwd();
  let failureCategory: FailureCategory | undefined;
  let failureDetail: string | undefined;

  try {
    process.chdir(workspaceDir);

    let attempt = 1;
    for (;;) {
      try {
        await driveOrchestrator(task, workspaceDir, cell, journal);
        break;
      } catch (err) {
        if (isRateLimit(err) && attempt < MAX_RATE_LIMIT_ATTEMPTS) {
          const waitMs = rateLimitWaitMs(err, attempt);
          console.log(`      rate limited — retrying in ${(waitMs / 1000).toFixed(0)}s (attempt ${attempt}/${MAX_RATE_LIMIT_ATTEMPTS})`);
          await sleep(waitMs);
          attempt++;
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    journal.error("driveOrchestrator", err);
    failureCategory = isRateLimit(err) ? "rate-limit" : "exception";
    failureDetail = err instanceof Error ? err.message : String(err);
  } finally {
    process.chdir(originalCwd);
  }

  const totals = journal.runEnd(!failureCategory, failureDetail);
  setActiveJournal(null);

  // ── Assertions ──────────────────────────────────────────────────────────
  //
  // These run even after an exception: a crashed run may still have produced
  // most of the intended output, and knowing which assertions survived is more
  // informative than a bare stack trace.
  const ctx: AssertionContext = {
    workspaceDir,
    totals,
    events: readJournalEvents(journal.jsonlPath),
  };

  const assertions: AssertionResult[] = [];
  for (const assertion of task.assertions) {
    try {
      assertions.push(await assertion(ctx));
    } catch (err) {
      assertions.push({
        name: "(assertion threw)",
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const hardFailures = assertions.filter((a) => !a.passed && !a.advisory);
  if (!failureCategory && hardFailures.length > 0) {
    failureCategory = "assertion";
    failureDetail = hardFailures.map((a) => `${a.name}: ${a.detail}`).join("; ");
  }

  // Budget is checked last: a run that produced the right answer but blew its
  // ceiling is still a failure, and should say so rather than reading as a pass.
  if (!failureCategory) {
    const overBudget = checkBudget(task, totals);
    if (overBudget) {
      failureCategory = "budget";
      failureDetail = overBudget;
    }
  }

  const passed = !failureCategory;

  if (passed && !keepWorkspaces) removeWorkspace(workspaceDir);

  return {
    runIndex,
    passed,
    assertions,
    failureCategory,
    failureDetail,
    totals,
    costUsd: estimateRunCost(cell.modelId, cell.provider),
    journalPath: journal.logPath,
    workspaceDir: passed && !keepWorkspaces ? undefined : workspaceDir,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── One task ────────────────────────────────────────────────────────────────

async function runTask(
  task: GoldenTask,
  cell: MatrixCell,
  repeat: number,
  keepWorkspaces: boolean,
  pauseSeconds: number,
): Promise<TaskResult> {
  console.log(`\n  ${task.id}  (${task.mode} mode, ${repeat} run${repeat > 1 ? "s" : ""})`);
  console.log(`    ${task.intent}`);

  const runs: RunOutcome[] = [];

  for (let i = 0; i < repeat; i++) {
    if (i > 0 && pauseSeconds > 0) await sleep(pauseSeconds * 1000);

    const outcome = await runOnce(task, cell, i, keepWorkspaces);
    runs.push(outcome);

    const label = repeat > 1 ? ` [${i + 1}/${repeat}]` : "";
    const t = outcome.totals;
    const cost = outcome.costUsd === null ? "$?" : `$${outcome.costUsd.toFixed(4)}`;
    const stats =
      `${t.toolCalls} tools` +
      `${t.toolFailures ? ` (${t.toolFailures} failed)` : ""}` +
      `, +${t.linesAdded}/-${t.linesRemoved} lines` +
      `, ${(t.durationMs / 1000).toFixed(0)}s, ${cost}`;

    if (outcome.passed) {
      console.log(`    PASS${label}  ${stats}`);
    } else {
      console.log(`    FAIL${label}  [${outcome.failureCategory}]  ${stats}`);
      for (const a of outcome.assertions.filter((x) => !x.passed)) {
        console.log(`        ${a.advisory ? "advisory" : "FAILED  "} ${a.name}`);
        console.log(`                 ${a.detail.split("\n").join("\n                 ")}`);
      }
      if (outcome.failureCategory !== "assertion" && outcome.failureDetail) {
        console.log(`        ${outcome.failureCategory}: ${outcome.failureDetail}`);
      }
      console.log(`        journal:   ${outcome.journalPath}`);
      if (outcome.workspaceDir) console.log(`        workspace: ${outcome.workspaceDir}`);
    }
  }

  return {
    id: task.id,
    intent: task.intent,
    runs,
    passRate: runs.filter((r) => r.passed).length / runs.length,
  };
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
}

function zizouVersion(): string {
  try {
    return JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

interface CellSummary {
  cell: MatrixCell;
  passRate: number;
  tasksPassed: number;
  tasksTotal: number;
  avgToolCalls: number;
  avgTokens: number;
  avgDurationMs: number;
  /** null when any run's model had no known rate. */
  avgCostUsd: number | null;
  fallbackParses: number;
  toolFailures: number;
}

function summarize(cell: MatrixCell, tasks: TaskResult[]): CellSummary {
  const runs = tasks.flatMap((t) => t.runs);
  const n = Math.max(runs.length, 1);
  const anyUnknownCost = runs.some((r) => r.costUsd === null);

  return {
    cell,
    passRate: runs.filter((r) => r.passed).length / n,
    tasksPassed: tasks.filter((t) => t.passRate === 1).length,
    tasksTotal: tasks.length,
    avgToolCalls: runs.reduce((s, r) => s + r.totals.toolCalls, 0) / n,
    avgTokens:
      runs.reduce((s, r) => s + r.totals.usage.inputTokens + r.totals.usage.outputTokens, 0) / n,
    avgDurationMs: runs.reduce((s, r) => s + r.totals.durationMs, 0) / n,
    avgCostUsd: anyUnknownCost ? null : runs.reduce((s, r) => s + (r.costUsd ?? 0), 0) / n,
    fallbackParses: runs.reduce((s, r) => s + r.totals.fallbackParses, 0),
    toolFailures: runs.reduce((s, r) => s + r.totals.toolFailures, 0),
  };
}

/**
 * The comparison table. This is the artifact the whole harness exists to
 * produce, so it is committed to evals/reports/ rather than only printed:
 * a benchmark claim that lives in a terminal scrollback cannot be reviewed
 * in a diff, and CI cannot gate on it.
 */
function renderMarkdown(reports: SuiteReport[], summaries: CellSummary[]): string {
  const lines: string[] = [];
  const first = reports[0];

  lines.push(`# Zizou eval report`);
  lines.push("");
  lines.push(`- commit: \`${first.gitSha}\``);
  lines.push(`- version: ${first.zizouVersion}`);
  lines.push(`- started: ${first.startedAt}`);
  lines.push(`- tasks: ${first.tasks.length}`);
  lines.push("");

  lines.push(`## Model comparison`);
  lines.push("");
  lines.push(`| model | effort | pass | tasks | tools/run | tokens/run | $/run | $/pass | fallback | tool fails |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of summaries) {
    const cost = s.avgCostUsd === null ? "unknown" : `$${s.avgCostUsd.toFixed(4)}`;
    // Cost per PASS, not per run: it prices the failures in, which is what you
    // actually pay when a cheap model needs three attempts.
    const costPerPass =
      s.avgCostUsd === null ? "unknown" : s.passRate > 0 ? `$${(s.avgCostUsd / s.passRate).toFixed(4)}` : "never passed";
    lines.push(
      `| \`${s.cell.modelId}\` | ${s.cell.effort} | ${(s.passRate * 100).toFixed(0)}% | ` +
        `${s.tasksPassed}/${s.tasksTotal} | ${s.avgToolCalls.toFixed(1)} | ` +
        `${Math.round(s.avgTokens).toLocaleString()} | ${cost} | ${costPerPass} | ` +
        `${s.fallbackParses} | ${s.toolFailures} |`,
    );
  }
  lines.push("");
  lines.push(
    `\`$/run\` reads \`unknown\` when the model has no entry in the rate table ` +
      `(\`src/tui/cost-tracker.ts\`). It is not defaulted to a guessed rate.`,
  );
  lines.push("");

  lines.push(`## Per-task results`);
  lines.push("");
  for (const report of reports) {
    lines.push(`### ${report.cell.provider} / \`${report.cell.modelId}\` / ${report.cell.effort}`);
    lines.push("");
    lines.push(`| task | pass rate | failures |`);
    lines.push(`|---|---|---|`);
    for (const t of report.tasks) {
      const fails = t.runs
        .filter((r) => !r.passed)
        .map((r) => `${r.failureCategory}: ${(r.failureDetail ?? "").slice(0, 120)}`)
        .join("<br>");
      lines.push(`| \`${t.id}\` | ${(t.passRate * 100).toFixed(0)}% | ${fails || "—"} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const tasks = selectTasks({ id: args.taskId, tag: args.tag });

  if (tasks.length === 0) {
    console.error(`No tasks matched. Available ids:`);
    for (const t of ALL_TASKS) console.error(`  ${t.id}  [${(t.tags ?? []).join(", ")}]`);
    process.exit(1);
  }

  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });

  console.log("=".repeat(70));
  console.log("  ZIZOU EVAL HARNESS");
  console.log("=".repeat(70));
  console.log(`  tasks    : ${tasks.length} of ${ALL_TASKS.length}`);
  console.log(`  matrix   : ${args.cells.map((c) => `${c.provider}/${c.modelId}/${c.effort}`).join(", ")}`);
  console.log(`  artifacts: ${ARTIFACTS_DIR}`);

  const snapshot = snapshotProject();
  const startedAt = new Date().toISOString();
  const reports: SuiteReport[] = [];

  for (const cell of args.cells) {
    console.log(`\n${"-".repeat(70)}`);
    console.log(`  CELL  ${cell.provider} / ${cell.modelId} / ${cell.effort}`);
    console.log("-".repeat(70));

    const results: TaskResult[] = [];
    for (let i = 0; i < tasks.length; i++) {
      if (i > 0 && args.pauseSeconds > 0) await sleep(args.pauseSeconds * 1000);
      const task = tasks[i];
      const repeat = args.repeatOverride ?? task.repeat ?? 1;
      results.push(await runTask(task, cell, repeat, args.keepWorkspaces, args.pauseSeconds));
    }

    reports.push({
      startedAt,
      finishedAt: new Date().toISOString(),
      gitSha: gitSha(),
      zizouVersion: zizouVersion(),
      cell,
      tasks: results,
      integrityOk: true,
    });
  }

  const integrityOk = verifyIntegrity(snapshot);
  for (const r of reports) r.integrityOk = integrityOk;

  // ── Summary ─────────────────────────────────────────────────────────────
  const summaries = reports.map((r) => summarize(r.cell, r.tasks));

  console.log(`\n${"=".repeat(70)}`);
  console.log("  SUMMARY");
  console.log("=".repeat(70));
  for (const s of summaries) {
    const cost = s.avgCostUsd === null ? "$?" : `$${s.avgCostUsd.toFixed(4)}`;
    console.log(
      `  ${`${s.cell.modelId} (${s.cell.effort})`.padEnd(38)} ` +
        `${(s.passRate * 100).toFixed(0).padStart(3)}%  ` +
        `${s.tasksPassed}/${s.tasksTotal} tasks  ` +
        `${s.avgToolCalls.toFixed(1).padStart(5)} tools/run  ` +
        `${cost.padStart(8)}/run` +
        `${s.fallbackParses ? `  ${s.fallbackParses} fallback parses` : ""}`,
    );
  }

  const sha = gitSha();
  const jsonPath = join(REPORTS_DIR, `${sha}-${Date.now()}.json`);
  const mdPath = join(REPORTS_DIR, `${sha}.md`);
  writeFileSync(jsonPath, JSON.stringify({ reports, summaries }, null, 2), "utf-8");
  writeFileSync(mdPath, renderMarkdown(reports, summaries), "utf-8");

  console.log(`\n  report: ${mdPath}`);
  console.log(`  raw   : ${jsonPath}`);

  const allPassed = summaries.every((s) => s.passRate === 1);
  console.log(`\n  ${allPassed && integrityOk ? "ALL PASSED" : "FAILURES PRESENT"}\n`);

  process.exit(allPassed && integrityOk ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error in eval runner:", err);
  process.exit(1);
});
