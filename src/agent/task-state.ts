// src/agent/task-state.ts
//
// LAYER: agent/
//
// What the agent knows about the request it is currently working on.
//
// WHY THIS EXISTS: the only memory the agent had was the conversation. That is
// enough to answer "what was said" and useless for "what do I actually know
// right now" — which file did I read, what did the build exit with, has this
// failure happened before. Every one of those was either re-derived by parsing
// message content back out of the history (see the deleted
// extractRecentFileReferences) or simply not known.
//
// Three things depend on this being explicit rather than inferred:
//
//   1. editFile's preconditions. "Was this file read?" is a fact about the
//      task, not about the transcript, and it has to survive history trimming.
//   2. The step prompt. Rendering known state is strictly better than
//      instructing the model to remember it.
//   3. Recovery. Comparing this failure to the last one is the only way to
//      tell a retry that learned something from one that did not.
//
// SCOPE IS ONE USER REQUEST. taskId IS the orchestrator's turnId — the same id
// already stamped on every FileEdit in the trace ledger — so task state and
// the record of what changed on disk are joined without inventing a second
// identity. Observations deliberately do not survive across requests:
// cleanHistoryForNextTurn drops old readFile contents from the context anyway,
// so a longer-lived receipt would claim the model still knows something the
// model can no longer see.
//
// AMBIENT, like getActiveJournal() and getActiveSessionId(). The alternative
// was threading a TaskState parameter through runTurn, executeStep, every tool
// wrapper and the verifier, which is a lot of plumbing for something exactly
// one of exists at a time.
//
// DEPENDENCY DIRECTION: imports from trace/paths.ts (path identity) and
// agent/mode.ts (the Route type) only. Must NOT import from ui/ or tools/.

import { createHash } from "node:crypto";
import { canonicalPath, displayPath } from "../trace/paths.js";
import type { Route } from "./mode.js";

// ─── Records ─────────────────────────────────────────────────────────────────

/** How a file came to be known. */
export type ObservationSource = "readFile" | "writeFile" | "editFile";

/**
 * A file this task has seen the contents of, and the contents it saw.
 *
 * The hash is what makes staleness detectable: a file observed at hash X and
 * now sitting at hash Y changed under the agent, and an edit written against
 * what it remembers would be written against the wrong file.
 */
export interface ObservedFile {
  /** Canonical project-relative key. The identity — see trace/paths.ts. */
  path: string;
  /** The same file spelled as the user would recognise it. Display only. */
  displayPath: string;
  /** sha256 of the contents at the moment of observation. */
  hash: string;
  observedAt: string;
  via: ObservationSource;
}

export interface CommandRecord {
  command: string;
  cwd?: string;
  /** null when the process never started or was killed before exiting. */
  exitCode: number | null;
  success: boolean;
  at: string;
}

export type VerificationKind = "typecheck" | "test" | "build" | "lint";

export interface VerificationRecord {
  command: string;
  kind: VerificationKind;
  passed: boolean;
  /** The failure's evidence — exit code and stderr tail. Absent when passed. */
  detail?: string;
  at: string;
}

/**
 * Everything known about the request in progress.
 *
 * Deliberately not a general-purpose blackboard. Each field exists because a
 * specific decision reads it: preconditions read observedFiles, the verifier
 * reads modifiedFiles, the step prompt renders the lot, and recovery reads
 * failureSignatures.
 */
export interface TaskState {
  /** The orchestrator's turnId. Joins this state to the trace ledger. */
  taskId: string;
  /** The user's request, verbatim. */
  goal: string;
  route: Route;
  startedAt: string;
  /**
   * Set when the request finished. A finished task stops recording but stays
   * readable, because it is what gets persisted into the session after the
   * generator drains — clearing it at the end of a run would leave nothing to
   * save. Without this flag, a later chat or ask turn's file reads would be
   * appended to the completed build's record.
   */
  finishedAt: string | null;
  observedFiles: Map<string, ObservedFile>;
  /** Canonical paths this task wrote to. */
  modifiedFiles: Set<string>;
  commands: CommandRecord[];
  verifications: VerificationRecord[];
  /** How many execution attempts this task has made. First attempt is 1. */
  attempts: number;
  /**
   * One signature per failed attempt, oldest first.
   *
   * Two identical consecutive signatures mean the retry produced no new
   * information, which is the only reliable way to tell thrash from progress.
   */
  failureSignatures: string[];
}

// ─── The active task ─────────────────────────────────────────────────────────
//
// Module-level, like the active journal and the active session. Exactly one
// request is in flight at a time in every caller we have.

let active: TaskState | null = null;

/** Starts a new task, replacing any previous one. Returns the fresh state. */
export function beginTask(args: { taskId: string; goal: string; route: Route }): TaskState {
  active = {
    taskId: args.taskId,
    goal: args.goal,
    route: args.route,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    observedFiles: new Map(),
    modifiedFiles: new Set(),
    commands: [],
    verifications: [],
    attempts: 0,
    failureSignatures: [],
  };
  return active;
}

/**
 * The task in progress, or null.
 *
 * Null is an ordinary state, not an error: a unit test calling a tool directly,
 * or a route that never begins a task, has no task state and the recorders
 * below degrade to no-ops rather than branching at every call site.
 */
export function getActiveTaskState(): TaskState | null {
  return active;
}

/**
 * Marks the current task finished without discarding it.
 *
 * The record outlives the run on purpose — the UI persists it into the
 * session once the orchestrator's generator drains, and a chat turn that
 * follows should not erase what the last build established. What stops is
 * RECORDING: the recorders below ignore a finished task, so an ask-mode file
 * read cannot be appended to a build that already completed.
 */
export function finishTask(): void {
  if (active && !active.finishedAt) active.finishedAt = new Date().toISOString();
}

/** Discards the current task outright. Idempotent. */
export function endTask(): void {
  active = null;
}

/** The task currently accepting records, or null. */
function live(): TaskState | null {
  return active && !active.finishedAt ? active : null;
}

/** Test seam — drops the active task without pretending one completed. */
export function _resetForTests(): void {
  active = null;
}

// ─── Recording ───────────────────────────────────────────────────────────────

export function hashContents(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

/**
 * Records that the agent has seen this file's contents.
 *
 * Re-observing a file overwrites the previous record, which is the point: the
 * newest hash is the one a later edit must be checked against.
 */
export function recordObservation(
  rawPath: string,
  contents: string,
  via: ObservationSource,
  root: string,
): void {
  const state = live();
  if (!state) return;
  const canon = canonicalPath(rawPath, root);
  state.observedFiles.set(canon, {
    path: canon,
    displayPath: displayPath(rawPath, root),
    hash: hashContents(contents),
    observedAt: new Date().toISOString(),
    via,
  });
}

/** What the agent last saw at this path, or undefined if it never looked. */
export function getObservation(rawPath: string, root: string): ObservedFile | undefined {
  if (!active) return undefined;
  return active.observedFiles.get(canonicalPath(rawPath, root));
}

export function recordModification(rawPath: string, root: string): void {
  const state = live();
  if (!state) return;
  state.modifiedFiles.add(canonicalPath(rawPath, root));
}

export function recordCommand(record: Omit<CommandRecord, "at">): void {
  const state = live();
  if (!state) return;
  state.commands.push({ ...record, at: new Date().toISOString() });
}

export function recordVerification(record: Omit<VerificationRecord, "at">): void {
  const state = live();
  if (!state) return;
  state.verifications.push({ ...record, at: new Date().toISOString() });
}

/** Counts an execution attempt. Called once per pass through the step loop. */
export function recordAttempt(): void {
  const state = live();
  if (!state) return;
  state.attempts++;
}

/**
 * Appends a failed attempt's signature to the task's history.
 *
 * DOES NOT decide whether it is a repeat. That comparison is deliberately the
 * caller's, because the question "did this fail the same way as last time" is
 * only meaningful WITHIN one step: in plan mode a whole plan is one task, so
 * step 3 failing the way step 1 did is two different problems that happen to
 * look alike, and comparing against this list would abandon step 3 on its
 * first attempt. The list is the session-level record; the comparison is
 * scoped to the step loop that owns it.
 */
export function recordFailureSignature(signature: string): void {
  const state = live();
  if (!state) return;
  state.failureSignatures.push(signature);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** How many of each list to show before summarising the remainder. */
const MAX_LISTED = 8;

function summarise(items: string[]): string {
  if (items.length <= MAX_LISTED) return items.join(", ");
  const shown = items.slice(0, MAX_LISTED).join(", ");
  return `${shown}, and ${items.length - MAX_LISTED} more`;
}

/**
 * The compact state block injected into the step prompt.
 *
 * Facts, not instructions. This replaced three imperative lines telling the
 * model to use the write tools and not to ask questions; what it actually
 * needed was to know what it had already done, so that a repair pass does not
 * re-read a file it just read or re-run a command it just ran.
 *
 * Returns "" when there is nothing to say, so a first attempt carries no
 * empty scaffolding.
 */
export function renderTaskState(state: TaskState | null = active): string {
  if (!state) return "";

  const lines: string[] = [];

  const read = [...state.observedFiles.values()]
    .filter((f) => f.via === "readFile")
    .map((f) => f.displayPath);
  if (read.length) lines.push(`  Files read: ${summarise(read)}`);

  const modified = [...state.observedFiles.values()]
    .filter((f) => state.modifiedFiles.has(f.path))
    .map((f) => f.displayPath);
  if (modified.length) lines.push(`  Files modified: ${summarise(modified)}`);

  for (const cmd of state.commands.slice(-MAX_LISTED)) {
    const where = cmd.cwd ? ` (in ${cmd.cwd})` : "";
    lines.push(`  Ran \`${cmd.command}\`${where} → exit ${cmd.exitCode ?? "none"}`);
  }

  for (const v of state.verifications.slice(-MAX_LISTED)) {
    const outcome = v.passed ? "passed" : `FAILED${v.detail ? ` — ${v.detail}` : ""}`;
    lines.push(`  Verification \`${v.command}\` ${outcome}`);
  }

  if (lines.length === 0) return "";

  return `\n\nWhat this task has established so far:\n${lines.join("\n")}`;
}

// ─── Persistence ─────────────────────────────────────────────────────────────
//
// Maps and Sets do not survive JSON.stringify, so the stored shape uses arrays.
// Kept next to the live type so the two cannot drift apart unnoticed.

export interface PersistedTaskState {
  taskId: string;
  goal: string;
  route: Route;
  startedAt: string;
  finishedAt: string | null;
  observedFiles: ObservedFile[];
  modifiedFiles: string[];
  commands: CommandRecord[];
  verifications: VerificationRecord[];
  attempts: number;
  failureSignatures: string[];
}

export function toPersisted(state: TaskState | null = active): PersistedTaskState | undefined {
  if (!state) return undefined;
  return {
    taskId: state.taskId,
    goal: state.goal,
    route: state.route,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    observedFiles: [...state.observedFiles.values()],
    modifiedFiles: [...state.modifiedFiles],
    commands: state.commands,
    verifications: state.verifications,
    attempts: state.attempts,
    failureSignatures: state.failureSignatures,
  };
}

/**
 * Rebuilds task state from a persisted session.
 *
 * Tolerant by design: a session written by a build whose shape differed
 * slightly should lose a field, not refuse to open. The schema version gate in
 * session/types.ts is the coarse guard; this is the fine one.
 */
export function fromPersisted(raw: PersistedTaskState | undefined): TaskState | null {
  if (!raw || typeof raw !== "object" || typeof raw.taskId !== "string") return null;

  return {
    taskId: raw.taskId,
    goal: typeof raw.goal === "string" ? raw.goal : "",
    route: raw.route,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : new Date().toISOString(),
    // A restored task is never live — the run that owned it is over.
    finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : new Date().toISOString(),
    observedFiles: new Map(
      (Array.isArray(raw.observedFiles) ? raw.observedFiles : []).map((f) => [f.path, f]),
    ),
    modifiedFiles: new Set(Array.isArray(raw.modifiedFiles) ? raw.modifiedFiles : []),
    commands: Array.isArray(raw.commands) ? raw.commands : [],
    verifications: Array.isArray(raw.verifications) ? raw.verifications : [],
    attempts: typeof raw.attempts === "number" ? raw.attempts : 0,
    failureSignatures: Array.isArray(raw.failureSignatures) ? raw.failureSignatures : [],
  };
}
