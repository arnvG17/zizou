// src/agent/verifier.ts
//
// LAYER: agent/
//
// Did the step actually do its job?
//
// WHAT THIS USED TO ASK, AND WHY IT WAS THE WRONG QUESTION:
//   The original verifier compared file mtimes before and after a step and
//   called that verification. Two problems followed from it.
//
//   First, mtime is a terrible proxy for success — `touch package.json`
//   passes it. The signals that actually mean "it worked" were all available
//   and all discarded: StepResult.toolCallsMade carries every tool's output
//   and errors and was read by nobody.
//
//   Second, every discrepancy was fatal, because `verified` was
//   `mismatches.length === 0`. A plan step's targetFiles are produced by the
//   planner BEFORE the work happens, so for anything involving a scaffolder
//   they are a guess. Enforcing a guess produced failures like
//   "target-not-created: frontend/todo-app/package.json" for a step that had
//   in fact succeeded — and worse, that noise sat next to genuine failures
//   looking exactly the same.
//
// WHAT IT ASKS NOW:
//   - Did any tool actually report an error? (hard)
//   - Did any command exit non-zero? (hard)
//   - Did the server answer? (hard)
//   - Do the files the executor claims to have written exist? (hard)
//   - Did the planner's guessed paths appear? (soft — a note, not a failure)
//
// DEPENDENCY DIRECTION: imports from agent/types.ts and tools/ only.
// Must NOT import from ui/ or provider/.

import { statSync, readFileSync, existsSync } from "fs";
import { resolve, extname } from "path";
import { generateText, type LanguageModel } from "ai";
import { recordModelUsage } from "../telemetry/index.js";
import type { PlanStep, StepResult, ToolCall, VerificationResult, Finding } from "./types.js";
import { makeFinding, renderFinding } from "./types.js";
import { getActiveJournal } from "./debug/index.js";
import { getService, hasStartingServices, listServices, serviceLogTail } from "../tools/service-registry.js";
import { execCommand } from "../tools/run-bash.js";
import { deriveVerification, alreadyRan } from "./verification-plan.js";
import { recordVerification } from "./task-state.js";

// ─── File State Snapshot ─────────────────────────────────────────────────────

interface FileSnapshot {
  path: string;
  /** Last modification time in ms, or null if the file does not exist. */
  mtimeMs: number | null;
}

function snapshotFile(absolutePath: string): FileSnapshot {
  try {
    return { path: absolutePath, mtimeMs: statSync(absolutePath).mtimeMs };
  } catch {
    // Absent is fine — a step that CREATES a file has no prior mtime.
    return { path: absolutePath, mtimeMs: null };
  }
}

/**
 * Captures filesystem state before a step runs.
 * Pass the result to verifyStep() afterwards.
 */
export function capturePreSnapshot(step: PlanStep, cwd: string): Map<string, FileSnapshot> {
  const snapshots = new Map<string, FileSnapshot>();
  for (const file of [...step.targetFiles, ...(step.check?.files ?? [])]) {
    const abs = resolve(cwd, file);
    snapshots.set(abs, snapshotFile(abs));
  }
  return snapshots;
}

// ─── Settlement ──────────────────────────────────────────────────────────────

/** How long to let still-starting background work finish before judging the disk. */
const SETTLE_MS = 15_000;
/**
 * How long to wait when nothing is reported as still starting.
 *
 * Bounded much lower on purpose: if no service is in `starting`, the files
 * probably are not coming, and the thing we would be waiting for is a soft
 * finding anyway. Three seconds covers a filesystem that has not caught up;
 * beyond that we would just be taxing every step for a guess.
 */
const QUICK_SETTLE_MS = 3_000;
const SETTLE_POLL_MS = 250;

/**
 * Waits for background work started by this step before we read the disk.
 *
 * THIS IS THE RACE THAT STARTED ALL OF THIS. A step ran
 * `npm init vite@latest frontend/todo-app` through a tool that returned the
 * instant the process was spawned. Verification then read the filesystem
 * immediately — roughly a minute before npm had created anything — and
 * reported the target as missing. The step had succeeded; the measurement was
 * taken at the wrong time.
 *
 * The service layer now waits for a declared ready signal, which fixes the
 * common case at the source. This is the backstop for a step that started
 * something WITHOUT declaring one: if any service is still starting, poll
 * until the expected files appear or everything settles.
 */
async function awaitStepSettlement(
  step: PlanStep,
  result: StepResult,
  cwd: string,
): Promise<void> {
  const spawnedBackgroundWork = result.toolCallsMade.some((c) =>
    ["runBackground", "service", "terminal"].includes(c.toolName),
  );
  if (!spawnedBackgroundWork) return;

  const expected = [...step.targetFiles, ...(step.check?.files ?? [])].map((f) => resolve(cwd, f));
  if (expected.length === 0) return; // nothing on disk to wait for

  const started = Date.now();
  for (;;) {
    if (expected.every(existsSync)) return;

    const elapsed = Date.now() - started;
    const budget = hasStartingServices() ? SETTLE_MS : QUICK_SETTLE_MS;
    if (elapsed >= budget) return;

    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
}

// ─── Syntax validation ───────────────────────────────────────────────────────

/**
 * Cheap structural checks per file type. Returns an error string or null.
 *
 * Deliberately shallow: this catches a truncated write, not a type error.
 * Real correctness comes from running the build, which is what `check.command`
 * and the command-failed finding are for.
 */
export function validateFileSyntax(filePath: string): string | null {
  try {
    const ext = extname(filePath).toLowerCase();
    const content = readFileSync(filePath, "utf-8");

    switch (ext) {
      case ".html": {
        if (!content.includes("<html") && !content.includes("<!DOCTYPE")) {
          return `HTML file missing basic structure tags`;
        }
        const count = (re: RegExp) => (content.match(re) || []).length;
        if (count(/<html/gi) !== count(/<\/html>/gi)) return `HTML file has unbalanced <html> tags`;
        if (count(/<body/gi) !== count(/<\/body>/gi)) return `HTML file has unbalanced <body> tags`;
        if (count(/<head/gi) !== count(/<\/head>/gi)) return `HTML file has unbalanced <head> tags`;
        break;
      }

      case ".js":
      case ".jsx":
      case ".ts":
      case ".tsx":
        // NOTE: no delimiter counting here. Naive brace/paren/bracket counting
        // produces false positives on valid code, because characters inside
        // strings, template literals, regexes and comments all get counted.
        // A real syntax error surfaces when the build runs — which is now
        // something a step can actually declare via check.command.
        break;

      case ".css": {
        const open = (content.match(/\{/g) || []).length;
        const close = (content.match(/\}/g) || []).length;
        if (open !== close) return `Unbalanced braces in CSS file`;
        break;
      }

      case ".json":
        try {
          JSON.parse(content);
        } catch (e) {
          return `Invalid JSON: ${e instanceof Error ? e.message : "parse error"}`;
        }
        break;

      default:
        break;
    }

    return null;
  } catch (err) {
    return `Failed to read file for validation: ${err instanceof Error ? err.message : "unknown error"}`;
  }
}

// ─── Tool-result inspection ──────────────────────────────────────────────────

const MAX_DETAIL = 600;

function clip(text: string): string {
  const t = text.trim();
  // Keep the TAIL: a command's error is at the end of its output.
  return t.length > MAX_DETAIL ? `...${t.slice(-MAX_DETAIL)}` : t;
}

/**
 * Reads what the tools actually reported.
 *
 * This is the check that makes a green tick mean something. `toolCallsMade`
 * was fully populated and read by nobody; every failure it recorded — a
 * non-zero build, a refused write, an unreachable server — was thrown away
 * before anything could act on it.
 */
function inspectToolCalls(calls: ToolCall[]): Finding[] {
  const findings: Finding[] = [];

  for (const call of calls) {
    const out = call.output as Record<string, unknown> | null | undefined;
    if (!out || typeof out !== "object") continue;

    // A HARNESS REFUSAL IS NOT A FAILED CALL. When the task-state layer
    // declines an edit because the file was never read, or has changed since,
    // the expected next move is that the model reads it and edits again — and
    // it usually does, within the same step.
    //
    // Counting the refusal would then make a step that recovered perfectly
    // well fail verification on a hard tool-error, which costs a whole repair
    // attempt to rediscover that nothing is wrong. The step is judged on
    // where it ended up, not on a guardrail it bounced off along the way. If
    // the model never recovers, the edit simply did not happen, and the
    // checks below catch that on the evidence rather than on this.
    if (out.harnessRefusal === true) continue;

    const failed = out.success === false || out.error !== undefined;

    switch (call.toolName) {
      case "runBash":
      case "terminal": {
        const exitCode = out.exitCode;
        if (typeof exitCode === "number" && exitCode !== 0) {
          const cmd = String((call.input as any)?.command ?? "command");
          const detail = clip(String(out.stderr ?? out.output ?? out.error ?? ""));
          findings.push(
            makeFinding(
              "command-failed",
              undefined,
              `\`${cmd}\` exited ${exitCode}${detail ? `\n${detail}` : ""}`,
            ),
          );
        } else if (out.timedOut === true) {
          const cmd = String((call.input as any)?.command ?? "command");
          findings.push(makeFinding("command-failed", undefined, `\`${cmd}\` timed out and was killed`));
        }
        break;
      }

      case "service":
      case "runBackground": {
        // A service that did not reach "ready" is a failure regardless of
        // whether a process was spawned — spawning proves nothing.
        if (out.status === "crashed") {
          const name = String(out.name ?? out.taskId ?? "service");
          findings.push(
            makeFinding("command-failed", undefined, `service "${name}" crashed:\n${clip(String(out.crashReason ?? out.error ?? ""))}`),
          );
        } else if (failed) {
          findings.push(makeFinding("tool-error", undefined, clip(String(out.error ?? "service failed to start"))));
        }
        break;
      }

      case "checkUrl": {
        if (out.ok === false) {
          const url = String((call.input as any)?.url ?? "the URL");
          const detail = [out.error, out.logTail].filter(Boolean).map(String).join("\n");
          findings.push(makeFinding("url-unreachable", undefined, `${url} — ${clip(detail)}`));
        }
        break;
      }

      default: {
        // A failed write or edit is a TOOL error, not a verification
        // mismatch. It used to surface as "claimed-changed-but-missing",
        // which described the symptom and dropped the cause: claimedFiles is
        // populated on tool-call INTENT, so a write that threw still counted
        // as a claim.
        if (failed && ["writeFile", "editFile", "fileOperations"].includes(call.toolName)) {
          const file = String((call.input as any)?.path ?? (call.input as any)?.filePath ?? "");
          findings.push(makeFinding("tool-error", file || undefined, clip(String(out.error ?? "tool reported failure"))));
        }
        break;
      }
    }
  }

  return findings;
}

// ─── Declared checks ─────────────────────────────────────────────────────────

/**
 * Runs the step's own declared success condition.
 *
 * Skipped when the executor already ran it — re-running `npm run build`
 * because the plan mentioned it would double the cost of every build step.
 */
async function runDeclaredCheck(step: PlanStep, result: StepResult, cwd: string): Promise<Finding[]> {
  const check = step.check;
  if (!check) return [];

  if (check.kind === "files" && check.files?.length) {
    return check.files
      .filter((f) => !existsSync(resolve(cwd, f)))
      .map((f) => makeFinding("claimed-changed-but-missing", f, "declared by the step's check and not found"));
  }

  if (check.kind === "command" && check.command) {
    const alreadyRan = result.toolCallsMade.some(
      (c) =>
        ["runBash", "terminal"].includes(c.toolName) &&
        String((c.input as any)?.command ?? "").includes(check.command!),
    );
    if (alreadyRan) return [];

    const res = await execCommand(check.command, { cwd: check.cwd, root: cwd });
    if (!res.success) {
      return [
        makeFinding(
          "command-failed",
          undefined,
          `\`${check.command}\` exited ${res.exitCode}${res.stderr ? `\n${clip(res.stderr)}` : ""}`,
        ),
      ];
    }
    return [];
  }

  if (check.kind === "url" && check.url) {
    const alreadyChecked = result.toolCallsMade.some(
      (c) => c.toolName === "checkUrl" && (c.output as any)?.ok === true,
    );
    if (alreadyChecked) return [];

    try {
      const res = await fetch(check.url, { signal: AbortSignal.timeout(10_000) });
      if (res.status >= 400) {
        return [makeFinding("url-unreachable", undefined, `${check.url} returned ${res.status}`)];
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // If a service in this session owns that URL, include its own output.
      // "It did not answer" plus the server's stack trace is one round-trip
      // instead of two, and the second one is the useful half.
      const owner = listServices().find((s) => s.url === check.url);
      const logs = owner ? `\n${serviceLogTail(owner.name) ?? owner.crashReason ?? ""}` : "";
      return [makeFinding("url-unreachable", undefined, `${check.url} — ${detail}${logs}`)];
    }
  }

  return [];
}

// ─── Derived checks ──────────────────────────────────────────────────────────

/**
 * Runs a check the step never declared, chosen from what it actually changed.
 *
 * THE GAP THIS CLOSES: only a plan step carries a `check`. Build mode
 * synthesises its step from the raw user prompt with no check at all, so
 * runDeclaredCheck above did nothing on the route that runs most often — a
 * TypeScript change could touch three files, finish green, and never be
 * compiled. "Never claim success without verification" was a prompt rule with
 * no way to notice when it was ignored.
 *
 * Proportional by construction: deriveVerification reads the project's real
 * scripts and returns null unless the changed files earn a check that the
 * project actually declares. A README edit runs nothing. A step that already
 * ran the check itself does not run it twice.
 *
 * A failure lands as a HARD command-failed finding, which is the existing
 * currency — it flows into the same repair loop and the same
 * renderRepairContext with no new plumbing.
 */
async function runDerivedCheck(
  step: PlanStep,
  result: StepResult,
  cwd: string,
  autoVerify: boolean,
): Promise<Finding[]> {
  if (!autoVerify) return [];
  if (result.claimedFiles.length === 0) return [];

  // A declared command check is the step's own statement of what success
  // means. Deriving a second one on top of it would be the harness
  // second-guessing the plan the user approved.
  if (step.check?.kind === "command") return [];

  const derived = deriveVerification(result.claimedFiles, cwd);
  if (!derived) return [];

  const ranCommands = result.toolCallsMade
    .filter((c) => ["runBash", "terminal"].includes(c.toolName))
    .map((c) => String((c.input as any)?.command ?? ""));

  if (alreadyRan(derived, ranCommands)) return [];

  const res = await execCommand(derived.command, { root: cwd });

  recordVerification({
    command: derived.command,
    kind: derived.kind,
    passed: res.success,
    ...(res.success ? {} : { detail: `exit ${res.exitCode}` }),
  });

  if (res.success) return [];

  return [
    makeFinding(
      "command-failed",
      undefined,
      `\`${derived.command}\` exited ${res.exitCode}\n` +
        `(run automatically because this step changed code and declared no check of its own)` +
        `${res.stderr ? `\n${clip(res.stderr)}` : ""}` +
        `${!res.stderr && res.stdout ? `\n${clip(res.stdout)}` : ""}`,
    ),
  ];
}

// ─── Verification ────────────────────────────────────────────────────────────

export async function verifyStep(
  step: PlanStep,
  result: StepResult,
  cwd: string,
  preSnapshots: Map<string, FileSnapshot>,
  model?: LanguageModel,
  autoVerify: boolean = true,
): Promise<VerificationResult> {
  const findings: Finding[] = [];
  let verboseFeedback: string | undefined = undefined;

  const journal = getActiveJournal();
  journal.phase(
    "verifier",
    `expected ${JSON.stringify(step.targetFiles)}, executor claimed ${JSON.stringify(result.claimedFiles)}`,
    step.index,
  );

  // ── Check 0: let background work finish before reading the disk ─────────
  await awaitStepSettlement(step, result, cwd);

  // ── Check 1: what did the tools actually report? ────────────────────────
  findings.push(...inspectToolCalls(result.toolCallsMade));

  // ── Check 2: are the files the executor wrote syntactically intact? ─────
  for (const claimedFile of result.claimedFiles) {
    const abs = resolve(cwd, claimedFile);
    if (!existsSync(abs)) continue; // handled as a missing-file finding below
    const syntaxError = validateFileSyntax(abs);
    if (syntaxError) findings.push(makeFinding("syntax-error", claimedFile, syntaxError));
  }

  // ── Check 3: did every claimed file actually change? ────────────────────
  for (const claimedFile of result.claimedFiles) {
    const abs = resolve(cwd, claimedFile);
    const post = snapshotFile(abs);
    const pre = preSnapshots.get(abs);

    if (post.mtimeMs === null) {
      findings.push(
        makeFinding("claimed-changed-but-missing", claimedFile, "the executor wrote this file but it does not exist"),
      );
    } else if (pre && pre.mtimeMs !== null && post.mtimeMs === pre.mtimeMs) {
      // SOFT: filesystem mtime granularity is coarse enough that two writes
      // within the same millisecond are indistinguishable, and a rewrite with
      // identical content is a no-op worth noting rather than failing.
      findings.push(
        makeFinding("claimed-changed-but-unchanged", claimedFile, "mtime did not move — possibly an identical rewrite"),
      );
    }
  }

  // ── Check 4: the planner's guessed target files ─────────────────────────
  //
  // SOFT, all of it. These paths were predicted before the work ran.
  for (const targetFile of step.targetFiles) {
    const abs = resolve(cwd, targetFile);
    if (result.claimedFiles.some((f) => resolve(cwd, f) === abs)) continue;

    const post = snapshotFile(abs);
    const pre = preSnapshots.get(abs);

    if (pre && pre.mtimeMs !== null && post.mtimeMs !== pre.mtimeMs) {
      findings.push(makeFinding("changed-but-not-claimed", targetFile));
    } else if (post.mtimeMs === null) {
      findings.push(
        makeFinding("target-not-created", targetFile, "the plan predicted this path; the step took another route"),
      );
    }
  }

  // ── Check 5: the step's own declared success condition ──────────────────
  findings.push(...(await runDeclaredCheck(step, result, cwd)));

  // ── Check 5.5: a check derived from what actually changed ───────────────
  findings.push(...(await runDerivedCheck(step, result, cwd, autoVerify)));

  // ── Check 6: LLM semantic review — ADVISORY ONLY ────────────────────────
  if (model && result.claimedFiles.length > 0) {
    verboseFeedback = await runSemanticReview(step, result, cwd, model);
  }

  const finalResult: VerificationResult = {
    verified: !findings.some((f) => f.severity === "hard"),
    findings,
    mismatches: findings.map(renderFinding),
    verboseFeedback,
  };

  journal.verification(step.index, finalResult.verified, finalResult.mismatches);
  return finalResult;
}

/**
 * Asks a model whether the files satisfy the step description.
 *
 * ADVISORY, DELIBERATELY. It does not vote on `verified`, for the same
 * reasons it never did: build mode is iterative, so "does this one file fully
 * implement the task?" after the first tool call is the wrong question and
 * will almost always answer no; and a plan step already has the user's
 * approval, which a second opinion should not be able to overturn. Its value
 * is the prose, which goes to the user.
 */
async function runSemanticReview(
  step: PlanStep,
  result: StepResult,
  cwd: string,
  model: LanguageModel,
): Promise<string | undefined> {
  try {
    let fileContentsSummary = "";
    for (const file of result.claimedFiles) {
      try {
        const content = readFileSync(resolve(cwd, file), "utf-8");
        const truncated = content.length > 4000 ? content.slice(0, 4000) + "\n... (truncated)" : content;
        fileContentsSummary += `File: ${file}\n\`\`\`\n${truncated}\n\`\`\`\n\n`;
      } catch {
        /* file may have been removed by a later tool call */
      }
    }
    if (!fileContentsSummary) return undefined;

    const prompt = `You are a strict code quality and verification agent. Your task is to verify if the following task has been completed correctly and successfully.

Task Description:
"${step.description}"

Here are the files that were modified and their current contents:
${fileContentsSummary}

Please analyze the file contents against the task description.
Respond in JSON format with the following schema:
{
  "verified": boolean,
  "mismatches": string[],
  "verboseFeedback": string
}
where:
- "verified" is true if all requirements of the task description are met, and false otherwise.
- "mismatches" is an array of strings detailing any gaps, errors, or unfulfilled requirements. If verified is true, this should be empty.
- "verboseFeedback" is a conversational, detailed summary explaining what was verified, what works, and what gaps (if any) were found. Be verbose and friendly.

Ensure your response is valid JSON.`;

    const { text, usage } = await generateText({ model, prompt });

    // One verifier call per step. On a ten-step plan that is ten calls, none of
    // which reached the cost display before.
    recordModelUsage("verifier", model, usage);

    let cleanText = text.trim();
    if (cleanText.includes("```")) {
      const match = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (match && match[1]) cleanText = match[1].trim();
    }

    const parsed = JSON.parse(cleanText) as {
      verified: boolean;
      mismatches: string[];
      verboseFeedback: string;
    };

    let feedback = parsed.verboseFeedback || undefined;
    if (!parsed.verified && parsed.mismatches?.length) {
      const note = `LLM review notes (advisory): ${parsed.mismatches.join("; ")}`;
      feedback = feedback ? `${feedback}\n\n${note}` : note;
    }
    return feedback;
  } catch (err) {
    return `LLM verification skipped or failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Renders findings as instructions for a repair attempt.
 *
 * The point is CONCRETENESS. Telling a model "verification failed" gives it
 * nothing to act on and invites a cosmetic retry; telling it the command, the
 * exit code and the stderr tail gives it the actual bug.
 */
export function renderRepairContext(findings: Finding[]): string {
  const hard = findings.filter((f) => f.severity === "hard");
  if (hard.length === 0) return "";

  const lines = hard.map((f) => {
    switch (f.code) {
      case "command-failed":
        return `- A command failed:\n  ${f.detail ?? "(no output captured)"}`;
      case "url-unreachable":
        return `- The server did not serve:\n  ${f.detail ?? "(no detail)"}`;
      case "tool-error":
        return `- A tool call failed${f.file ? ` on ${f.file}` : ""}:\n  ${f.detail ?? "(no detail)"}`;
      case "claimed-changed-but-missing":
        return `- ${f.file} does not exist, though this step was supposed to write it.`;
      case "syntax-error":
        return `- ${f.file} is not valid: ${f.detail}`;
      default:
        return `- ${renderFinding(f)}`;
    }
  });

  return `\n\nTHE PREVIOUS ATTEMPT AT THIS STEP FAILED. What actually went wrong:\n${lines.join(
    "\n",
  )}\n\nFix the underlying cause and complete the step. Do not repeat the same action unchanged, and do not claim success without re-checking.`;
}

/** Re-exported so callers can look up a service's logs when reporting. */
export { getService };
