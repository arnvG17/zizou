// evals/run-evals.ts
//
// Eval runner — executes golden tasks against disposable temp workspaces
// and reports deterministic pass/fail results.
//
// CRITICAL SAFETY INVARIANT:
//   Every golden task runs against a fresh temp directory under
//   evals/temp-workspaces/. The Zizou project directory is NEVER used
//   as a workspace. This prevents the chess.html/todo.html pollution
//   problem from recurring.
//
// USAGE:
//   bun run evals/run-evals.ts                    # run full suite
//   bun run evals/run-evals.ts --task <id>        # run one task
//   bun run evals/run-evals.ts --provider groq    # override provider
//
// The runner drives runOrchestrator() programmatically (no TUI).
// All tool executions are auto-approved via a no-op ConfirmFn.

import { mkdirSync, rmSync, writeFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { ALL_TASKS } from "./golden-tasks/index.js";
import type { GoldenTask, TaskResult } from "./types.js";
import type { OrchestratorEvent } from "../src/agent/orchestrator.js";
import type { ModeContext } from "../src/agent/mode.js";
import type { ProjectContext, PlanStep } from "../src/agent/types.js";
import { runOrchestrator } from "../src/agent/orchestrator.js";
import { buildSystemPrompt } from "../src/context/build-system-prompt.js";
import { resolveModel } from "../src/sdk/resolve-model.js";
import { getDefaultProvider, type ProviderChoice } from "../src/config/api-keys.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const EVALS_ROOT = resolve(import.meta.dir, ".");
const TEMP_WORKSPACES_DIR = join(EVALS_ROOT, "temp-workspaces");
const PROJECT_ROOT = resolve(EVALS_ROOT, "..");

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

function parseArgs(): { taskFilter?: string; provider?: ProviderChoice } {
  const args = process.argv.slice(2);
  let taskFilter: string | undefined;
  let provider: ProviderChoice | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--task" && args[i + 1]) {
      taskFilter = args[++i];
    } else if (args[i] === "--provider" && args[i + 1]) {
      provider = args[++i] as ProviderChoice;
    }
  }

  return { taskFilter, provider };
}

// ─── Temp Workspace Management ───────────────────────────────────────────────

function createTempWorkspace(taskId: string): string {
  const timestamp = Date.now();
  const dirName = `${taskId}-${timestamp}`;
  const wsPath = join(TEMP_WORKSPACES_DIR, dirName);
  mkdirSync(wsPath, { recursive: true });
  return wsPath;
}

function cleanupTempWorkspace(wsPath: string): void {
  try {
    rmSync(wsPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — don't fail the eval if cleanup fails
  }
}

// ─── Project Integrity Check ─────────────────────────────────────────────────
//
// Captures a snapshot of the project directory's key paths before the
// eval suite runs, then verifies nothing changed after.

interface ProjectSnapshot {
  srcMtime: number | null;
  packageJsonMtime: number | null;
}

function captureProjectSnapshot(): ProjectSnapshot {
  const getTime = (path: string): number | null => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  };

  return {
    srcMtime: getTime(join(PROJECT_ROOT, "src")),
    packageJsonMtime: getTime(join(PROJECT_ROOT, "package.json")),
  };
}

function verifyProjectIntegrity(before: ProjectSnapshot): boolean {
  const after = captureProjectSnapshot();
  if (before.srcMtime !== after.srcMtime) {
    console.error("❌ INTEGRITY VIOLATION: src/ directory was modified during eval run!");
    return false;
  }
  if (before.packageJsonMtime !== after.packageJsonMtime) {
    console.error("❌ INTEGRITY VIOLATION: package.json was modified during eval run!");
    return false;
  }
  return true;
}

// ─── Auto-Confirm (no user interaction) ──────────────────────────────────────

const autoConfirm = async (_description: string): Promise<boolean> => true;

// ─── Orchestrator Event Draining ─────────────────────────────────────────────
//
// The orchestrator is an async generator that yields events. In the TUI,
// Chat.tsx consumes these to render progress. Here, we drain them silently
// and capture them for inspection by golden task checks.
//
// For plan-mode tasks, the orchestrator yields multi-phase events:
//   1. "clarification-needed" → we re-invoke with pre-canned answers
//   2. "plan-ready" → we re-invoke with approvedPlan (auto-approve)
//   3. Then the execution phase yields step events until "complete"

async function drainOrchestrator(
  task: GoldenTask,
  workspaceDir: string,
  provider: ProviderChoice,
): Promise<OrchestratorEvent[]> {
  const model = resolveModel(provider);
  const modeContext: ModeContext = {
    mode: task.mode,
    reason: "user-flag",
  };

  // Build system prompt with the temp workspace as project root
  const systemPrompt = await buildSystemPrompt(workspaceDir, "executor");
  const context: ProjectContext = {
    projectRoot: workspaceDir,
    systemPrompt,
    budget: "default",
  };

  const allEvents: OrchestratorEvent[] = [];

  // Phase 1: Initial invocation
  const gen = runOrchestrator(
    task.prompt,
    modeContext,
    context,
    model,
    autoConfirm,
  );

  for await (const event of gen) {
    allEvents.push(event);

    // ── Handle plan-mode multi-phase flow ──────────────────────────────
    if (event.kind === "clarification-needed") {
      // Re-invoke with pre-canned answers (or empty if none provided)
      const answers = task.clarifierAnswers ?? {};

      // Map pre-canned answers to the actual questions
      const mappedAnswers: Record<string, string> = {};
      for (const [key, value] of Object.entries(answers)) {
        mappedAnswers[key] = value;
      }

      // If no answers provided, auto-generate generic ones
      if (Object.keys(mappedAnswers).length === 0 && event.questions) {
        for (let i = 0; i < event.questions.length; i++) {
          mappedAnswers[String(i)] = "Use sensible defaults";
        }
      }

      // Re-invoke with answers — this will proceed to planning phase
      const systemPrompt2 = await buildSystemPrompt(workspaceDir, "executor");
      const context2: ProjectContext = {
        projectRoot: workspaceDir,
        systemPrompt: systemPrompt2,
        budget: "default",
      };

      const gen2 = runOrchestrator(
        task.prompt,
        modeContext,
        context2,
        model,
        autoConfirm,
        mappedAnswers,
      );

      for await (const event2 of gen2) {
        allEvents.push(event2);

        if (event2.kind === "plan-ready") {
          // Auto-approve the plan and re-invoke for execution
          const steps = (event2 as any).steps as PlanStep[];
          const systemPrompt3 = await buildSystemPrompt(workspaceDir, "executor");
          const context3: ProjectContext = {
            projectRoot: workspaceDir,
            systemPrompt: systemPrompt3,
            budget: "default",
          };

          const gen3 = runOrchestrator(
            task.prompt,
            modeContext,
            context3,
            model,
            autoConfirm,
            task.clarifierAnswers ?? {},
            steps,
          );

          for await (const event3 of gen3) {
            allEvents.push(event3);
          }
          break; // plan-ready handled, execution complete
        }
      }
      break; // clarification-needed handled
    }

    if (event.kind === "plan-ready") {
      // Direct plan-ready (no clarification phase) — auto-approve
      const steps = (event as any).steps as PlanStep[];
      const systemPrompt2 = await buildSystemPrompt(workspaceDir, "executor");
      const context2: ProjectContext = {
        projectRoot: workspaceDir,
        systemPrompt: systemPrompt2,
        budget: "default",
      };

      const gen2 = runOrchestrator(
        task.prompt,
        modeContext,
        context2,
        model,
        autoConfirm,
        task.clarifierAnswers ?? {},
        steps,
      );

      for await (const event2 of gen2) {
        allEvents.push(event2);
      }
      break; // plan-ready handled
    }
  }

  return allEvents;
}

// ─── Task Runner ─────────────────────────────────────────────────────────────

async function runTask(
  task: GoldenTask,
  provider: ProviderChoice,
): Promise<TaskResult> {
  const runs = task.repeat ?? 1;
  const results: boolean[] = [];
  const failures: string[] = [];

  console.log(`\n${"─".repeat(60)}`);
  console.log(`▶ ${task.id} (${task.mode} mode, ${runs} run${runs > 1 ? "s" : ""})`);
  console.log(`  Prompt: "${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? "..." : ""}"`);

  for (let i = 0; i < runs; i++) {
    const runLabel = runs > 1 ? ` [run ${i + 1}/${runs}]` : "";
    const workspaceDir = createTempWorkspace(task.id);
    console.log(`  ${runLabel}Workspace: ${workspaceDir}`);

    try {
      const originalCwd = process.cwd();
      process.chdir(workspaceDir);

      let events: OrchestratorEvent[] = [];
      try {
        let success = false;
        const maxAttempts = 5;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            // Run the orchestrator and capture all events
            events = await drainOrchestrator(task, workspaceDir, provider);
            success = true;
            break;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isRateLimit = 
              errMsg.includes("rate_limit_exceeded") || 
              errMsg.includes("Rate limit reached") || 
              (err && typeof err === "object" && (err as any).statusCode === 429);

            if (isRateLimit && attempt < maxAttempts) {
              let waitMs = 5000;
              const match = errMsg.match(/try again in ([\d\.]+)s/i);
              if (match) {
                waitMs = Math.ceil(parseFloat(match[1]) * 1000);
              }
              // Add a backoff multiplier to the wait time
              waitMs = (waitMs * attempt) + 2000;
              console.log(`  ⚠️ Rate limit hit. Retrying in ${(waitMs / 1000).toFixed(1)}s (Attempt ${attempt}/${maxAttempts})...`);
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              continue;
            }
            throw err;
          }
        }
        if (!success) {
          throw new Error("Failed after maximum retries due to rate limits.");
        }
      } finally {
        // Always restore cwd, even if the orchestrator throws
        process.chdir(originalCwd);
      }

      // Write events to workspace so the check function can inspect them
      const serializableEvents = events.map((e) => {
        // Strip non-serializable parts (agent events can contain functions)
        if (e.kind === "agent-event") {
          return { kind: "agent-event", eventKind: (e as any).event?.kind };
        }
        return e;
      });
      writeFileSync(
        join(workspaceDir, "__eval_events.json"),
        JSON.stringify(serializableEvents, null, 2),
      );

      // Run the deterministic check
      const check = await task.expectedCheck(workspaceDir);

      if (check.passed) {
        results.push(true);
        console.log(`  ✓${runLabel} PASSED — ${check.detail}`);
        cleanupTempWorkspace(workspaceDir);
      } else {
        results.push(false);
        failures.push(check.detail);
        console.log(`  ✗${runLabel} FAILED — ${check.detail}`);
        console.log(`    Workspace kept for inspection: ${workspaceDir}`);

        // Try to extract failure classification from events
        const verificationFailures = serializableEvents.filter(
          (e: any) =>
            e.kind === "step-verified" &&
            e.verification?.verified === false,
        );
        const escalations = serializableEvents.filter(
          (e: any) => e.kind === "escalation-prompt",
        );

        if (verificationFailures.length > 0) {
          for (const vf of verificationFailures) {
            const mismatches = (vf as any).verification?.mismatches ?? [];
            console.log(`    Category: verification-failed → ${mismatches.join(", ") || "no details"}`);
          }
        }
        if (escalations.length > 0) {
          for (const esc of escalations) {
            console.log(`    Category: escalation → ${(esc as any).trigger?.reason ?? "unknown"}`);
          }
        }
      }
    } catch (err) {
      results.push(false);
      const errMsg = err instanceof Error ? err.message : String(err);
      failures.push(`Exception: ${errMsg}`);
      console.log(`  ✗${runLabel} ERROR — ${errMsg}`);
      console.log(`    Workspace kept for inspection: ${workspaceDir}`);
    }
  }

  const passRate = results.filter(Boolean).length / results.length;
  return { id: task.id, passRate, runs: results.length, failures };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { taskFilter, provider: providerOverride } = parseArgs();
  const provider = providerOverride ?? (getDefaultProvider() || "groq");

  // Ensure temp-workspaces directory exists
  mkdirSync(TEMP_WORKSPACES_DIR, { recursive: true });

  // Filter tasks if --task was specified
  let tasks = ALL_TASKS;
  if (taskFilter) {
    tasks = ALL_TASKS.filter((t) => t.id === taskFilter);
    if (tasks.length === 0) {
      console.error(`❌ No task found with id "${taskFilter}"`);
      console.error(`Available tasks: ${ALL_TASKS.map((t) => t.id).join(", ")}`);
      process.exit(1);
    }
  }

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║              ZIZOU EVAL HARNESS                          ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`  Provider:  ${provider}`);
  console.log(`  Tasks:     ${tasks.length} of ${ALL_TASKS.length}`);
  console.log(`  Workspace: ${TEMP_WORKSPACES_DIR}`);

  // Capture project state before evals
  const projectSnapshot = captureProjectSnapshot();

  // Run tasks
  const results: TaskResult[] = [];
  for (let i = 0; i < tasks.length; i++) {
    if (i > 0) {
      console.log(`\n  Sleeping 15s between tasks to prevent provider rate limits...`);
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
    const result = await runTask(tasks[i], provider);
    results.push(result);
  }

  // Verify project integrity
  console.log(`\n${"═".repeat(60)}`);
  const integrityOk = verifyProjectIntegrity(projectSnapshot);

  // Summary
  console.log("\n  RESULTS SUMMARY");
  console.log(`  ${"─".repeat(56)}`);

  let allPassed = true;
  for (const r of results) {
    const icon = r.passRate === 1.0 ? "✓" : r.passRate > 0 ? "◐" : "✗";
    const pct = (r.passRate * 100).toFixed(0);
    const label = `${icon} ${r.id}`;
    const stats = r.runs > 1 ? `${pct}% (${r.runs} runs)` : r.passRate === 1.0 ? "PASS" : "FAIL";
    console.log(`  ${label.padEnd(45)} ${stats}`);
    if (r.passRate < 1.0) allPassed = false;
  }

  console.log(`  ${"─".repeat(56)}`);
  const overallIcon = allPassed && integrityOk ? "✓" : "✗";
  const totalTasks = results.length;
  const passedTasks = results.filter((r) => r.passRate === 1.0).length;
  console.log(`  ${overallIcon} ${passedTasks}/${totalTasks} tasks passed${integrityOk ? "" : " (INTEGRITY VIOLATION)"}`);
  console.log("");

  process.exit(allPassed && integrityOk ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error in eval runner:", err);
  process.exit(1);
});
