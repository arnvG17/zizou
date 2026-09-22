// src/agent/debug/run-journal.ts
//
// LAYER: agent/debug
//
// The run journal: one structured, append-only record of everything a single
// run did. It replaces both predecessors — TurnLogger, which was 80 lines of
// `// Silenced` no-op methods that still got called on every event, and
// SessionLogger, whose post-mortem is in specs/002-debug.md.
//
// It writes TWO files per run, from one event stream:
//
//   <dir>/<runId>.jsonl   machine-readable — one JSON event per line.
//                         This is what the eval harness scores and what any
//                         future exporter (Langfuse, a report) reads.
//   <dir>/<runId>.log     human-readable — the thing you actually open when
//                         a run went wrong.
//
// THREE THINGS IT GETS RIGHT THAT THE OLD LOGGING DID NOT:
//
//   1. Tool calls are paired. A call and its result are one event with a
//      duration and an ok/failed verdict, so "which calls failed" is a filter
//      rather than a manual scan for a matching id.
//
//   2. File names are resolved. Every path is recorded both as the model
//      wrote it and as an absolute path, because "wrote to src/app.ts" is
//      useless when the disagreement is about which directory that was.
//
//   3. Diffs are ground truth. See file-diff.ts — the journal snapshots from
//      the filesystem around execute(), so a denied confirm or a silently
//      failed write shows up as an empty diff instead of as a confident log
//      line quoting the arguments the model sent.
//
// Allowed imports: node builtins, ./file-diff.js. Nothing from agent/, ui/,
// tools/ or sdk/ — the journal is a sink, so it must not be able to influence
// what it is recording.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildFileDiff, formatDiffStat, type FileDiff } from "./file-diff.js";

// ─── Which tools touch the filesystem, and where ─────────────────────────────
//
// Kept as data rather than as branches inside the wrapper so that adding a
// tool means adding one entry. A tool missing from this table is still logged
// in full; it just gets no diff, which is the right default for a read-only
// tool.

type PathExtractor = (input: any) => string[];

const MUTATING_TOOLS: Record<string, PathExtractor> = {
  writeFile: (i) => (typeof i?.path === "string" ? [i.path] : []),
  editFile: (i) => (typeof i?.path === "string" ? [i.path] : []),
  fileOperations: (i) => {
    const out: string[] = [];
    if (typeof i?.source === "string") out.push(i.source);
    if (typeof i?.destination === "string") out.push(i.destination);
    return out;
  },
};

/**
 * Tools that can change arbitrary files we cannot name from the arguments.
 *
 * For these the journal re-snapshots every path it has seen so far in the run
 * and reports any that moved. That will not catch a file the run never
 * otherwise touched, and the log says so rather than implying full coverage —
 * an honest partial answer beats a confident empty one.
 */
const OPAQUE_TOOLS = new Set(["runBash", "runBackground", "terminal", "service"]);

// ─── Event shapes ────────────────────────────────────────────────────────────

export interface ToolCallRecord {
  toolName: string;
  toolCallId: string;
  input: unknown;
  output: unknown;
  ok: boolean;
  /**
   * True when the harness declined the call rather than the tool failing it —
   * an edit to a file that was never read, or that changed since it was.
   * Recorded so the log shows it, excluded from toolFailures because nothing
   * went wrong.
   */
  harnessRefusal?: boolean;
  durationMs: number;
  /** True when the call came from the pseudo-call text parser, not the API. */
  viaFallback: boolean;
  /** Ground-truth file changes observed around this call. */
  fileChanges: FileDiff[];
  /** Set for runBash-style tools whose file effects cannot be enumerated. */
  coverageNote?: string;
}

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

/**
 * Which part of a turn is speaking.
 *
 * "router" and "chat" joined the original three when auto mode landed: a phase
 * list that cannot name the router leaves its calls filed under whatever ran
 * next, which is exactly the confusion the journal exists to remove.
 */
export type JournalPhase = "router" | "planner" | "executor" | "verifier" | "chat";

/**
 * One event's own fields, without the envelope.
 *
 * Kept separate from JournalEvent because `Omit<Union, k>` does not distribute
 * over a union — it collapses to the keys every member shares, which erased
 * every payload field and made emit() reject its own callers.
 */
export type JournalPayload =
  | { kind: "run-start"; runId: string; label: string; cwd: string; prompt: string; mode: string; provider?: string; modelId?: string; meta?: Record<string, unknown> }
  | { kind: "phase"; phase: JournalPhase; detail: string; stepIndex?: number }
  | { kind: "route"; route: string; confidence?: number | string; reason?: string }
  | { kind: "prompt"; role: string; system?: string; user?: string; stepIndex?: number }
  | { kind: "note"; label: string; text: string }
  | { kind: "step-end"; stepIndex: number; claimedFiles: string[]; toolNames: string[]; text?: string }
  | { kind: "plan"; steps: Array<{ index: number; description: string; targetFiles?: string[] }>; assumptions?: string[] }
  | { kind: "llm-call"; role: string; modelId?: string; finishReason?: string; usage?: UsageRecord; steps?: number }
  | { kind: "assistant-text"; text: string }
  | ({ kind: "tool-call" } & ToolCallRecord)
  | { kind: "fallback-parse"; toolName: string; rawText: string; recovered: boolean }
  | { kind: "duplicate-blocked"; toolName: string; input: unknown }
  | { kind: "verification"; stepIndex: number; verified: boolean; mismatches: string[] }
  | { kind: "error"; where: string; message: string; stack?: string }
  | { kind: "run-end"; ok: boolean; totals: RunTotals; detail?: string };

/** The envelope added to every payload as it is written to the JSONL. */
export interface JournalEnvelope {
  /** Monotonic within a run, so ordering survives equal timestamps. */
  seq: number;
  /** ISO timestamp. */
  t: string;
}

export type JournalEvent = JournalEnvelope & JournalPayload;

export interface RunTotals {
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  toolFailures: number;
  fallbackParses: number;
  duplicatesBlocked: number;
  filesCreated: number;
  filesModified: number;
  filesDeleted: number;
  linesAdded: number;
  linesRemoved: number;
  usage: UsageRecord;
  /** Every distinct file the run actually changed, relative to cwd. */
  filesTouched: string[];
}

// ─── Formatting for the human log ────────────────────────────────────────────

function rule(char = "-", n = 78): string {
  return char.repeat(n);
}

function heading(title: string): string {
  return `\n${rule("=")}\n  ${title}\n${rule("=")}\n`;
}

function indent(text: string, pad = "    "): string {
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function preview(value: unknown, max = 1200): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  if (s === undefined) return "undefined";
  return s.length > max ? `${s.slice(0, max)}\n... (truncated, ${s.length} chars total)` : s;
}

// ─── The journal ─────────────────────────────────────────────────────────────

export interface RunJournalOptions {
  /** Directory the two files are written into. Created if missing. */
  dir: string;
  /** Stable id used for both filenames. */
  runId: string;
  /** Short human label for the log header, e.g. the task id or "interactive". */
  label?: string;
  /** Paths are logged relative to this. Defaults to process.cwd() at construction. */
  root?: string;
  /** When false, every method is a no-op and no files are created. */
  enabled?: boolean;
  /**
   * Whether to record verbatim system and user prompts.
   *
   * Off by default, and this is the whole reason SessionLogger was unusable in
   * practice: it wrote the full system prompt on EVERY step, unconditionally.
   * The executor prompt is ~3.7k tokens of tool schemas, so a ten-step plan
   * produced a log where the same boilerplate appeared eleven times and the
   * three lines describing what actually went wrong were buried in it.
   *
   * Turn it on with ZIZOU_DEBUG=prompts when the prompt itself is the suspect.
   */
  capturePrompts?: boolean;
}

export class RunJournal {
  readonly jsonlPath: string;
  readonly logPath: string;
  readonly runId: string;

  private seq = 0;
  private readonly startedAt = Date.now();
  private readonly root: string;
  private readonly enabled: boolean;
  private readonly capturePrompts: boolean;

  /** Every path the run has referenced, so opaque tools have something to re-check. */
  private readonly knownPaths = new Set<string>();

  private readonly totals: RunTotals = {
    durationMs: 0,
    llmCalls: 0,
    toolCalls: 0,
    toolFailures: 0,
    fallbackParses: 0,
    duplicatesBlocked: 0,
    filesCreated: 0,
    filesModified: 0,
    filesDeleted: 0,
    linesAdded: 0,
    linesRemoved: 0,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
    filesTouched: [],
  };

  private readonly touched = new Set<string>();

  constructor(opts: RunJournalOptions) {
    this.runId = opts.runId;
    this.root = opts.root ?? process.cwd();
    this.enabled = opts.enabled !== false;
    this.capturePrompts = opts.capturePrompts === true;
    this.jsonlPath = join(opts.dir, `${opts.runId}.jsonl`);
    this.logPath = join(opts.dir, `${opts.runId}.log`);

    if (!this.enabled) return;

    try {
      mkdirSync(opts.dir, { recursive: true });
      writeFileSync(this.jsonlPath, "", "utf-8");
      writeFileSync(
        this.logPath,
        `${rule("=")}\n` +
          `  ZIZOU RUN JOURNAL\n` +
          `  run    : ${opts.runId}\n` +
          `  label  : ${opts.label ?? "(none)"}\n` +
          `  root   : ${this.root}\n` +
          `  started: ${new Date(this.startedAt).toISOString()}\n` +
          `  events : ${this.jsonlPath}\n` +
          `${rule("=")}\n`,
        "utf-8",
      );
    } catch {
      // Logging must never take the run down with it.
    }
  }

  // ── Low-level emit ─────────────────────────────────────────────────────────

  private emit(event: JournalPayload, human: string): void {
    if (!this.enabled) return;
    const full = { seq: ++this.seq, t: new Date().toISOString(), ...event } as JournalEvent;
    try {
      appendFileSync(this.jsonlPath, `${JSON.stringify(full)}\n`, "utf-8");
    } catch {
      /* best effort */
    }
    try {
      appendFileSync(this.logPath, human, "utf-8");
    } catch {
      /* best effort */
    }
  }

  private rel(p: string): string {
    try {
      const r = relative(this.root, p);
      return r && !r.startsWith("..") ? r.replace(/\\/g, "/") : p.replace(/\\/g, "/");
    } catch {
      return p;
    }
  }

  // ── Public recording API ───────────────────────────────────────────────────

  runStart(info: {
    prompt: string;
    mode: string;
    provider?: string;
    modelId?: string;
    meta?: Record<string, unknown>;
  }): void {
    this.emit(
      {
        kind: "run-start",
        runId: this.runId,
        label: this.runId,
        cwd: this.root,
        prompt: info.prompt,
        mode: info.mode,
        provider: info.provider,
        modelId: info.modelId,
        meta: info.meta,
      },
      heading("RUN START") +
        `  mode    : ${info.mode}\n` +
        `  provider: ${info.provider ?? "(unset)"}\n` +
        `  model   : ${info.modelId ?? "(unset)"}\n` +
        `  prompt  :\n${indent(info.prompt)}\n`,
    );
  }

  phase(phase: JournalPhase, detail: string, stepIndex?: number): void {
    const label = stepIndex === undefined
      ? `PHASE: ${phase.toUpperCase()}`
      : `PHASE: ${phase.toUpperCase()} (step ${stepIndex + 1})`;
    this.emit({ kind: "phase", phase, detail, stepIndex }, heading(label) + `  ${detail}\n`);
  }

  /** Auto mode's routing decision, recorded before anything runs. */
  route(route: string, confidence?: number | string, reason?: string): void {
    this.emit(
      { kind: "route", route, confidence, reason },
      `\n  [ROUTE] -> ${route}` +
        `${confidence !== undefined ? ` (confidence ${confidence})` : ""}\n` +
        `${reason ? `    ${reason}\n` : ""}`,
    );
  }

  /**
   * The verbatim prompts sent for one call. No-op unless capturePrompts is on.
   *
   * Gated rather than truncated because a truncated system prompt is the worst
   * of both options: still long enough to bury the rest of the log, and cut off
   * before the part you needed to see.
   */
  prompt(info: { role: string; system?: string; user?: string; stepIndex?: number }): void {
    if (!this.capturePrompts) return;
    this.emit(
      { kind: "prompt", ...info },
      `\n  ${rule()}\n  PROMPT (${info.role}${info.stepIndex !== undefined ? ` step ${info.stepIndex + 1}` : ""})\n` +
        `${info.system ? `  [system]\n${indent(info.system, "      ")}\n` : ""}` +
        `${info.user ? `  [user]\n${indent(info.user, "      ")}\n` : ""}` +
        `  ${rule()}\n`,
    );
  }

  /** A one-line observation with no richer event of its own. */
  note(label: string, text: string): void {
    this.emit({ kind: "note", label, text }, `\n  [${label.toUpperCase()}] ${text}\n`);
  }

  /**
   * What one executor step ended up doing.
   *
   * `claimedFiles` is what the model SAYS it touched. Compare it against the
   * run-end `files touched` list, which comes from observed diffs: a file named
   * here and absent there is a claim the filesystem did not support, and that
   * gap is usually the bug.
   */
  stepEnd(info: { stepIndex: number; claimedFiles: string[]; toolNames: string[]; text?: string }): void {
    this.emit(
      { kind: "step-end", ...info },
      `\n  [STEP ${info.stepIndex + 1} END]\n` +
        `    claimed files: ${info.claimedFiles.join(", ") || "(none)"}\n` +
        `    tools used   : ${info.toolNames.join(", ") || "(none)"}\n`,
    );
  }

  plan(
    steps: Array<{ index: number; description: string; targetFiles?: string[] }>,
    assumptions?: string[],
  ): void {
    const body = steps.length
      ? steps
          .map(
            (s) =>
              `    [${s.index + 1}] ${s.description}` +
              (s.targetFiles?.length ? `\n        targets: ${s.targetFiles.join(", ")}` : ""),
          )
          .join("\n")
      : "    (no steps)";
    const assume = assumptions?.length
      ? `\n  assumptions:\n${assumptions.map((a) => `    - ${a}`).join("\n")}\n`
      : "";
    this.emit({ kind: "plan", steps, assumptions }, `\n  PLAN (${steps.length} steps)\n${body}\n${assume}`);
  }

  llmCall(info: { role: string; modelId?: string; finishReason?: string; usage?: UsageRecord; steps?: number }): void {
    this.totals.llmCalls++;
    if (info.usage) {
      const u = this.totals.usage;
      u.inputTokens += info.usage.inputTokens ?? 0;
      u.outputTokens += info.usage.outputTokens ?? 0;
      u.cachedInputTokens = (u.cachedInputTokens ?? 0) + (info.usage.cachedInputTokens ?? 0);
      u.reasoningTokens = (u.reasoningTokens ?? 0) + (info.usage.reasoningTokens ?? 0);
    }
    const usageStr = info.usage
      ? `in=${info.usage.inputTokens} out=${info.usage.outputTokens}` +
        (info.usage.cachedInputTokens ? ` cached=${info.usage.cachedInputTokens}` : "") +
        (info.usage.reasoningTokens ? ` reasoning=${info.usage.reasoningTokens}` : "")
      : "usage unavailable";
    this.emit(
      { kind: "llm-call", ...info },
      `\n  [LLM ${info.role}] model=${info.modelId ?? "?"} finish=${info.finishReason ?? "?"} ` +
        `steps=${info.steps ?? "?"} ${usageStr}\n`,
    );
  }

  assistantText(text: string): void {
    if (!text.trim()) return;
    this.emit(
      { kind: "assistant-text", text },
      `\n  ${rule()}\n  ASSISTANT TEXT\n${indent(preview(text, 4000))}\n  ${rule()}\n`,
    );
  }

  /** Records a completed, already-paired tool call plus its observed diffs. */
  toolCall(rec: ToolCallRecord): void {
    this.totals.toolCalls++;
    // A precondition refusal is recorded (ok is false, and the log shows it)
    // but is not counted as a failure — see the wrapTools note on isRefusal.
    if (!rec.ok && !rec.harnessRefusal) this.totals.toolFailures++;
    if (rec.viaFallback) this.totals.fallbackParses++;

    for (const d of rec.fileChanges) {
      if (d.kind === "created") this.totals.filesCreated++;
      else if (d.kind === "modified") this.totals.filesModified++;
      else if (d.kind === "deleted") this.totals.filesDeleted++;
      this.totals.linesAdded += d.added;
      this.totals.linesRemoved += d.removed;
      if (d.kind !== "unchanged") this.touched.add(d.path);
    }

    const changed = rec.fileChanges.filter((d) => d.kind !== "unchanged");
    const header =
      `\n  ${rule()}\n` +
      `  TOOL ${rec.ok ? "OK  " : "FAIL"}  ${rec.toolName}` +
      `${rec.viaFallback ? "  [FALLBACK PARSE]" : ""}  (${rec.durationMs}ms)\n` +
      `  id: ${rec.toolCallId}\n` +
      `  input:\n${indent(preview(rec.input), "      ")}\n` +
      `  output:\n${indent(preview(rec.output, 1500), "      ")}\n`;

    const diffText = changed.length
      ? changed
          .map((d) => {
            const head = `  FILE ${d.kind.toUpperCase()}: ${d.path}  (${formatDiffStat(d)})\n       abs: ${d.absPath}\n`;
            if (d.note) return `${head}       note: ${d.note}\n`;
            const trunc = d.truncated ? "\n       ... (patch truncated)\n" : "\n";
            return `${head}${indent(d.patch, "       ")}${trunc}`;
          })
          .join("\n")
      : rec.coverageNote
        ? `  FILES: none of the ${this.knownPaths.size} known paths changed. ${rec.coverageNote}\n`
        : "  FILES: no filesystem change observed.\n";

    this.emit({ kind: "tool-call", ...rec }, `${header}${diffText}  ${rule()}\n`);
  }

  fallbackParse(toolName: string, rawText: string, recovered: boolean): void {
    this.emit(
      { kind: "fallback-parse", toolName, rawText: rawText.slice(0, 2000), recovered },
      `\n  [FALLBACK PARSER] tool=${toolName} recovered=${recovered}\n` +
        `    The model emitted a tool call as text rather than using the API's\n` +
        `    native tool-calling. This is a model-capability signal, not a bug.\n` +
        `    raw:\n${indent(preview(rawText, 800), "      ")}\n`,
    );
  }

  duplicateBlocked(toolName: string, input: unknown): void {
    this.totals.duplicatesBlocked++;
    this.emit(
      { kind: "duplicate-blocked", toolName, input },
      `\n  [DUPLICATE BLOCKED] ${toolName} retried an identical failing call.\n`,
    );
  }

  verification(stepIndex: number, verified: boolean, mismatches: string[]): void {
    this.emit(
      { kind: "verification", stepIndex, verified, mismatches },
      `\n  [VERIFY step ${stepIndex + 1}] ${verified ? "PASS" : "FAIL"}` +
        `${mismatches.length ? `\n    mismatches: ${mismatches.join("; ")}` : ""}\n`,
    );
  }

  error(where: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    this.emit(
      { kind: "error", where, message, stack },
      `\n  [ERROR in ${where}] ${message}\n${stack ? indent(stack, "      ") + "\n" : ""}`,
    );
  }

  runEnd(ok: boolean, detail?: string): RunTotals {
    this.totals.durationMs = Date.now() - this.startedAt;
    this.totals.filesTouched = Array.from(this.touched).sort();
    const t = this.totals;
    this.emit(
      { kind: "run-end", ok, totals: t, detail },
      heading(`RUN END — ${ok ? "OK" : "FAILED"}`) +
        `  duration      : ${(t.durationMs / 1000).toFixed(1)}s\n` +
        `  llm calls     : ${t.llmCalls}\n` +
        `  tool calls    : ${t.toolCalls} (${t.toolFailures} failed)\n` +
        `  fallback parse: ${t.fallbackParses}\n` +
        `  dupes blocked : ${t.duplicatesBlocked}\n` +
        `  files         : +${t.filesCreated} created, ${t.filesModified} modified, ${t.filesDeleted} deleted\n` +
        `  lines         : +${t.linesAdded} -${t.linesRemoved}\n` +
        `  tokens        : in=${t.usage.inputTokens} out=${t.usage.outputTokens}` +
        `${t.usage.cachedInputTokens ? ` cached=${t.usage.cachedInputTokens}` : ""}` +
        `${t.usage.reasoningTokens ? ` reasoning=${t.usage.reasoningTokens}` : ""}\n` +
        `  files touched :\n${t.filesTouched.map((f) => `      ${f}`).join("\n") || "      (none)"}\n` +
        `${detail ? `  detail        : ${detail}\n` : ""}`,
    );
    return { ...t, usage: { ...t.usage }, filesTouched: [...t.filesTouched] };
  }

  /** Snapshot of totals so far, safe to read mid-run. */
  snapshot(): RunTotals {
    return {
      ...this.totals,
      durationMs: Date.now() - this.startedAt,
      usage: { ...this.totals.usage },
      filesTouched: Array.from(this.touched).sort(),
    };
  }

  // ── The instrumentation choke point ────────────────────────────────────────

  private readFileOrNull(abs: string): string | null {
    try {
      return readFileSync(abs, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Wraps a tool map so every call is journaled with a real before/after diff.
   *
   * This is deliberately the ONLY place diffs are produced. Tools do not report
   * their own changes: a tool that failed halfway, or was denied at the confirm
   * prompt, would still describe what it meant to do. Snapshotting from the
   * outside means the log cannot flatter the run.
   *
   * The wrapper is transparent — it returns exactly what execute() returned,
   * and a throw propagates unchanged after being recorded.
   */
  wrapTools<T extends Record<string, any>>(tools: T): T {
    if (!this.enabled) return tools;

    const wrapped: Record<string, any> = {};

    for (const [name, def] of Object.entries(tools)) {
      if (!def || typeof def.execute !== "function") {
        wrapped[name] = def;
        continue;
      }

      const extractor = MUTATING_TOOLS[name];
      const isOpaque = OPAQUE_TOOLS.has(name);
      const original = def.execute.bind(def);

      wrapped[name] = {
        ...def,
        execute: async (args: any, ctx: any) => {
          // Which paths to watch across this call.
          let watch: string[] = [];
          if (extractor) {
            watch = extractor(args);
            for (const p of watch) this.knownPaths.add(p);
          } else if (isOpaque) {
            // Cannot name the targets, so re-check everything seen so far.
            watch = Array.from(this.knownPaths);
          }

          const before = new Map<string, string | null>();
          for (const p of watch) {
            before.set(p, this.readFileOrNull(resolve(this.root, p)));
          }

          const startedAt = Date.now();
          let output: unknown;
          let threw: unknown;
          try {
            output = await original(args, ctx);
          } catch (e) {
            threw = e;
            output = { error: String(e) };
          }
          const durationMs = Date.now() - startedAt;

          const fileChanges: FileDiff[] = [];
          for (const p of watch) {
            const abs = resolve(this.root, p);
            const after = this.readFileOrNull(abs);
            const diff = buildFileDiff(this.rel(abs), abs, before.get(p) ?? null, after);
            if (diff.kind !== "unchanged") fileChanges.push(diff);
          }

          // A HARNESS REFUSAL IS NOT A TOOL FAILURE. When the task-state layer
          // declines an edit because the file was never read, or has changed
          // since, nothing malfunctioned — a guarantee held. Counting it as a
          // failure would inflate toolFailures in the totals and fail the
          // `noToolFailures` eval assertion on runs that behaved exactly as
          // designed. The call is still RECORDED below with ok:false, so the
          // log shows the refusal; it just does not read as a defect.
          const isRefusal =
            !!output && typeof output === "object" && (output as any).harnessRefusal === true;

          const ok =
            !threw &&
            !(output && typeof output === "object" && (output as any).success === false) &&
            !(output && typeof output === "object" && (output as any).error);

          this.toolCall({
            toolName: name,
            toolCallId: String(ctx?.toolCallId ?? "unknown"),
            input: args,
            output,
            ok,
            harnessRefusal: isRefusal,
            durationMs,
            viaFallback: false,
            fileChanges,
            coverageNote: isOpaque
              ? "This tool can change files the journal cannot enumerate; only previously-seen paths were re-checked."
              : undefined,
          });

          if (threw) throw threw;
          return output;
        },
      };
    }

    return wrapped as T;
  }
}

/** A journal that writes nothing — for code paths where logging is off. */
export function disabledJournal(): RunJournal {
  return new RunJournal({ dir: ".", runId: "disabled", enabled: false });
}

// ─── The active journal ──────────────────────────────────────────────────────
//
// runTurn accepts a journal explicitly, which is what the eval harness uses so
// each task run gets its own file. But the interactive CLI has a single run in
// flight at a time and threading a journal through every layer to say so would
// be noise, so it registers one here instead.
//
// This is process-wide mutable state, which is a real cost. It is acceptable
// only because a journal is write-only: nothing reads back from it, so a stale
// or wrong active journal misfiles log lines and cannot change behaviour. Any
// caller that cares — the eval harness, or a future parallel mode — passes its
// own and never touches this.

let activeJournal: RunJournal | null = null;

export function setActiveJournal(journal: RunJournal | null): void {
  activeJournal = journal;
}

/** The registered journal, or a no-op one so callers never branch on null. */
export function getActiveJournal(): RunJournal {
  return activeJournal ?? DISABLED;
}

const DISABLED = disabledJournal();
