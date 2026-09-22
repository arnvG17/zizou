// src/commands/evals.ts
//
// LAYER: commands/
// Allowed imports: telemetry/, node builtins.
//
// `/evals` and `/test` — running the checks from inside the chat.
//
// WHY A SUBPROCESS RATHER THAN AN IMPORT. The eval harness calls
// process.chdir() into each throwaway workspace, and the TUI is running in the
// same process with its own cwd. Importing run-evals.ts would move the chat's
// working directory out from under it mid-run, so every relative path the user
// then typed would resolve somewhere else. It also calls process.exit() at the
// end, which would take the chat down with it. A child process has its own cwd
// and its own exit code, and Ink keeps rendering while it works.
//
// WHAT THIS DELIBERATELY DOES NOT DO: stream output line by line into the
// transcript. A full suite prints hundreds of lines and would push the
// conversation off screen for several minutes. Progress arrives as periodic
// summary lines instead, and the full text is on disk.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readLatestEvalReport, type EvalSnapshot } from "../telemetry/index.js";

/** How the caller reports progress back into the chat transcript. */
export type Emit = (text: string) => void;

export interface RunResult {
  ok: boolean;
  /** Process exit code, or null when it could not be started. */
  code: number | null;
  /** The last few meaningful lines, for the transcript. */
  tail: string[];
}

/** Lines worth surfacing while a suite runs. Everything else is noise. */
function isProgressLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return (
    t.startsWith("PASS") ||
    t.startsWith("FAIL") ||
    t.startsWith("CELL") ||
    t.startsWith("ALL PASSED") ||
    t.startsWith("FAILURES PRESENT") ||
    t.startsWith("INTEGRITY") ||
    t.includes("rate limited") ||
    // Task headers: two-space indent then an id with a hyphen.
    /^[a-z0-9-]+\s{2,}\(/.test(t)
  );
}

/**
 * Spawns a command, forwards selected progress lines, and resolves at exit.
 *
 * Never rejects: a suite that cannot start is a message in the transcript, not
 * an exception that kills the chat.
 */
function run(
  command: string,
  args: string[],
  cwd: string,
  emit: Emit,
  onLine?: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // `shell: true` so `bun` resolves via PATH on Windows without the
        // caller having to know whether it is bun.exe or a shim.
        shell: true,
      });
    } catch (err) {
      emit(`Could not start ${command}: ${String(err)}`);
      resolve({ ok: false, code: null, tail: [] });
      return;
    }

    const tail: string[] = [];
    let buffer = "";

    const consume = (chunk: unknown) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      // Keep the last, possibly-partial line for the next chunk.
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const stripped = line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
        if (!stripped.trim()) continue;
        tail.push(stripped);
        if (tail.length > 40) tail.shift();
        onLine?.(stripped);
      }
    };

    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);

    child.on("error", (err) => {
      emit(`Process error: ${err.message}`);
      resolve({ ok: false, code: null, tail });
    });

    child.on("close", (code) => {
      if (buffer.trim()) tail.push(buffer.trim());
      resolve({ ok: code === 0, code, tail });
    });
  });
}

// ─── Report rendering ────────────────────────────────────────────────────────

/** The eval panel's numbers as a transcript block. */
export function renderReport(snapshot: EvalSnapshot | null): string {
  if (!snapshot) {
    return [
      "No eval report found.",
      "",
      "Run `/evals` to benchmark the current model, or `/evals smoke` for a",
      "single fast task.",
    ].join("\n");
  }

  const rows = snapshot.cells.map((c) => {
    const pass = `${(c.passRate * 100).toFixed(0)}%`.padStart(4);
    const cost = c.avgCostUsd === null ? "unknown" : `$${c.avgCostUsd.toFixed(4)}`;
    return (
      `  ${c.modelId.padEnd(30)} ${pass}  ` +
      `${String(c.tasksPassed)}/${c.tasksTotal} tasks  ` +
      `${c.avgToolCalls.toFixed(1).padStart(5)} tools  ` +
      `${cost.padStart(8)}/task` +
      (c.fallbackParses > 0 ? `  ${c.fallbackParses} fallbacks` : "")
    );
  });

  const lines = [
    `Eval report — commit ${snapshot.gitSha}` +
      (snapshot.ageDays > 0 ? `, ${snapshot.ageDays}d ago` : ", today"),
    "",
    ...rows,
  ];

  if (snapshot.failingTaskIds.length > 0) {
    lines.push("", `Failing: ${snapshot.failingTaskIds.join(", ")}`);
  }
  if (!snapshot.integrityOk) {
    lines.push(
      "",
      "INTEGRITY VIOLATION recorded — a tool wrote outside its workspace during",
      "that run. Treat every number above as suspect.",
    );
  }
  lines.push("", `Full report: ${snapshot.reportPath}`);
  return lines.join("\n");
}

// ─── /evals ──────────────────────────────────────────────────────────────────

const KNOWN_TAGS = [
  "smoke",
  "tool-calling",
  "editing",
  "precision",
  "plan-mode",
  "multi-file",
  "ambiguity",
  "error-handling",
  "router",
  "auto-mode",
  "placement",
];

export function evalsHelp(): string {
  return [
    "/evals — benchmark the agent against the golden tasks.",
    "",
    "  /evals                 every task, current provider",
    "  /evals smoke           one tag (see below)",
    "  /evals <task-id>       one task",
    "  /evals report          show the last report without running anything",
    "  /evals matrix a,b      compare cells, e.g. groq:fast,anthropic:balanced",
    "  /evals --repeat 3      run each task 3x for a pass rate",
    "",
    `  tags: ${KNOWN_TAGS.join(", ")}`,
    "",
    "Runs cost real tokens against your provider. A full suite is ~11 tasks;",
    "start with `/evals smoke` if you just want to know the agent is alive.",
  ].join("\n");
}

/**
 * Translates the chat-friendly argument forms into run-evals.ts flags.
 *
 * `/evals smoke` is nicer to type than `/evals --tag smoke`, so a bare word is
 * read as a tag when it is one and a task id otherwise.
 */
export function buildEvalArgs(args: string[]): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < args.length) {
    const a = args[i]!;
    if (a === "matrix" && args[i + 1]) {
      out.push("--matrix", args[i + 1]!);
      i += 2;
    } else if (a.startsWith("--")) {
      // Pass flags straight through, with their value if they take one.
      out.push(a);
      if (args[i + 1] && !args[i + 1]!.startsWith("--")) out.push(args[++i]!);
      i++;
    } else if (KNOWN_TAGS.includes(a)) {
      out.push("--tag", a);
      i++;
    } else {
      out.push("--task", a);
      i++;
    }
  }
  return out;
}

export interface EvalsOptions {
  projectRoot: string;
  args: string[];
  emit: Emit;
}

/** Runs `/evals`. Returns the text to append when it finishes. */
export async function runEvals(opts: EvalsOptions): Promise<string> {
  const { projectRoot, args, emit } = opts;

  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "help" || sub === "--help") return evalsHelp();
  if (sub === "report" || sub === "last") {
    return renderReport(readLatestEvalReport(projectRoot));
  }

  const runner = join(projectRoot, "evals", "run-evals.ts");
  if (!existsSync(runner)) {
    // Zizou installed from npm ships only dist/, so the harness is absent. Say
    // that plainly rather than failing with a module-not-found from bun.
    return [
      "The eval harness is not present in this installation.",
      "",
      "It lives in the Zizou source repository (`evals/run-evals.ts`) and is not",
      "included in the published package. Clone the repo to run it.",
    ].join("\n");
  }

  const evalArgs = buildEvalArgs(args);
  emit(
    `Running evals${evalArgs.length ? ` (${evalArgs.join(" ")})` : " — full suite"}…\n` +
      `This calls your provider and costs tokens. Results stream below.`,
  );

  const result = await run(
    "bun",
    ["run", "evals/run-evals.ts", ...evalArgs],
    projectRoot,
    emit,
    (line) => {
      if (isProgressLine(line)) emit(`  ${line.trim()}`);
    },
  );

  // The report on disk is the authority; the tail is only for context when the
  // run died before writing one.
  const snapshot = readLatestEvalReport(projectRoot);
  const summary = renderReport(snapshot);

  if (result.ok) return `Evals passed.\n\n${summary}`;

  const tail = result.tail.slice(-12).map((l) => `  ${l}`).join("\n");
  return [
    `Evals finished with failures (exit ${result.code ?? "?"}).`,
    "",
    summary,
    "",
    "Last output:",
    tail,
  ].join("\n");
}

// ─── /test ───────────────────────────────────────────────────────────────────

/**
 * Runs the project's own unit tests.
 *
 * Defaults to `src/ evals/` rather than a bare `bun test`, but be aware of what
 * that does and does not buy: bun treats positional arguments as SUBSTRING
 * filters over discovered files, not as directory scopes. So `src/` also matches
 * `todo-app/src/`, and a scratch project the agent left in the working tree gets
 * its failures reported as Zizou's.
 *
 * That is why this returns the tally and the failing test names rather than just
 * a verdict — the names are what let you tell "Zizou is broken" from "there is a
 * stray React app in the repo". Pass an explicit path to narrow it:
 * `/test src/telemetry`.
 */
export async function runTests(opts: {
  projectRoot: string;
  args: string[];
  emit: Emit;
}): Promise<string> {
  const { projectRoot, args, emit } = opts;

  const filters = args.filter((a) => !a.startsWith("--"));
  const targets = filters.length > 0 ? filters : ["src/", "evals/"];

  emit(`Running tests: bun test ${targets.join(" ")}…`);

  const result = await run("bun", ["test", ...targets], projectRoot, emit);

  // Bun prints the tally to stderr; both streams land in `tail`.
  const tally = result.tail.filter((l) => /\d+ (pass|fail)|Ran \d+ tests/.test(l));
  const failures = result.tail.filter((l) => l.includes("(fail)"));

  const lines = [result.ok ? "Tests passed." : `Tests failed (exit ${result.code ?? "?"}).`];
  if (tally.length > 0) lines.push("", ...tally.map((l) => `  ${l.trim()}`));
  if (failures.length > 0) {
    lines.push("", "Failing:");
    lines.push(...failures.slice(0, 12).map((l) => `  ${l.trim()}`));
  }
  if (!result.ok && failures.length === 0) {
    lines.push("", "Last output:", ...result.tail.slice(-10).map((l) => `  ${l}`));
  }
  return lines.join("\n");
}
