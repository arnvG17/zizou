// src/trace/wrap-tools.ts
//
// LAYER: trace/
//
// The instrumentation choke point: every filesystem change the agent makes is
// observed here, and nowhere else.
//
// THIS IS THE WHOLE POINT OF THE REWRITE. The old checkpoint system captured
// "before" content when the CONSUMER received a tool-call event from the
// stream (executor.ts). But the AI SDK invokes execute() concurrently with
// delivering that part — there is no backpressure guaranteeing the consumer
// reads the event before writeFileSync lands. So `oldContent` was routinely
// the file's post-change content, the change looked like a no-op, and no
// patch was recorded at all. Non-deterministically, which is why undo
// "sometimes" worked.
//
// Snapshotting INSIDE execute(), before delegating, removes the race entirely:
// there is no window in which the tool could have run first.
//
// The structure is ported from RunJournal.wrapTools (agent/debug/run-journal.ts),
// which already got this right — it was only ever gated behind ZIZOU_DEBUG.
// The two now coexist: the journal stays a debug sink, this one is always on.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildFileDiff } from "../agent/debug/file-diff.js";
import { putBlob } from "./blobs.js";
import { appendEdit, appendGap } from "./ledger.js";
import { canonicalPath, displayPath, toAbsolute } from "./paths.js";
import type { EditKind } from "./types.js";

// ─── Which tools touch the filesystem, and where ─────────────────────────────
//
// Kept as data, mirroring the journal's table. A tool absent from both tables
// is passed through untouched — the right default for a read-only tool.

type PathExtractor = (input: any) => string[];

const MUTATING_TOOLS: Record<string, PathExtractor> = {
  writeFile: (i) => (typeof i?.path === "string" ? [i.path] : []),
  editFile: (i) => (typeof i?.path === "string" ? [i.path] : []),
  // A move shows up naturally as two edits: source content->null (deleted) and
  // destination null->content (created). No special case is needed, because
  // the records come from the snapshots rather than from the tool's intent.
  fileOperations: (i) => {
    const out: string[] = [];
    if (typeof i?.source === "string") out.push(i.source);
    if (typeof i?.destination === "string") out.push(i.destination);
    return out;
  },
};

/** Tools that can change files we cannot name from the arguments. */
const OPAQUE_TOOLS = new Set(["runBash", "runBackground", "terminal", "service"]);

export interface TraceContext {
  /** One user prompt. `/undo` reverts a whole turn. */
  turnId: string;
  sessionId: string | null;
  /** Project root that canonical paths are relative to. */
  root: string;
}

function readOrNull(abs: string): string | null {
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

function summarizeCommand(input: any): string {
  const cmd = typeof input?.command === "string" ? input.command : JSON.stringify(input ?? {});
  return cmd.length > 200 ? `${cmd.slice(0, 200)}…` : cmd;
}

/**
 * Wraps a tool map so every call records the file changes it actually caused.
 *
 * Transparent by contract: it returns exactly what execute() returned, and a
 * throw propagates unchanged after being recorded. A tool that threw halfway
 * still gets its partial writes traced — which is the case where being able
 * to undo matters most.
 */
export function wrapToolsWithTrace<T extends Record<string, any>>(
  tools: T,
  ctx: TraceContext,
): T {
  const wrapped: Record<string, any> = {};

  // Paths seen so far this turn, so an opaque call has something to re-check.
  // Keyed by canonical identity, valued by the spelling to show the user.
  const knownPaths = new Map<string, string>();

  for (const [name, def] of Object.entries(tools)) {
    if (!def || typeof def.execute !== "function") {
      wrapped[name] = def;
      continue;
    }

    // Cast: indexing a Record yields a non-optional type, but a tool absent
    // from the table genuinely has no extractor.
    const extractor = MUTATING_TOOLS[name] as PathExtractor | undefined;
    const isOpaque = OPAQUE_TOOLS.has(name);

    // Neither mutating nor opaque: nothing to observe, so do not pay the
    // wrapper cost on every readFile/grep call.
    if (!extractor && !isOpaque) {
      wrapped[name] = def;
      continue;
    }

    const original = def.execute.bind(def);

    wrapped[name] = {
      ...def,
      execute: async (args: any, toolCtx: any) => {
        // Derived from the RAW argument, so the display spelling survives:
        // canonicalPath lowercases on Windows, and computing the display form
        // from its output would turn README.md into readme.md in the listing.
        let watch: Array<{ canon: string; display: string }> = [];
        if (extractor) {
          watch = extractor(args).map((raw) => ({
            canon: canonicalPath(raw, ctx.root),
            display: displayPath(raw, ctx.root),
          }));
          for (const w of watch) knownPaths.set(w.canon, w.display);
        } else if (isOpaque) {
          // Cannot name the targets, so re-check everything seen so far.
          watch = Array.from(knownPaths, ([canon, display]) => ({ canon, display }));
        }

        const before = new Map<string, string | null>();
        for (const w of watch) {
          before.set(w.canon, readOrNull(toAbsolute(w.canon, ctx.root)));
        }

        let output: unknown;
        let threw: unknown;
        try {
          output = await original(args, toolCtx);
        } catch (e) {
          threw = e;
          output = { error: String(e) };
        }

        for (const { canon, display } of watch) {
          const abs = toAbsolute(canon, ctx.root);
          const after = readOrNull(abs);
          const beforeContent = before.get(canon) ?? null;
          if (beforeContent === after) continue;

          const diff = buildFileDiff(display, abs, beforeContent, after);
          const kind: EditKind =
            beforeContent === null ? "created" : after === null ? "deleted" : "modified";

          appendEdit({
            id: randomUUID(),
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            toolCallId: String(toolCtx?.toolCallId ?? "unknown"),
            toolName: name,
            path: canon,
            displayPath: display,
            kind,
            beforeBlob: beforeContent === null ? null : putBlob(beforeContent),
            afterBlob: after === null ? null : putBlob(after),
            added: diff.added,
            removed: diff.removed,
            timestamp: new Date().toISOString(),
            revertedAt: null,
            coverage: extractor ? "exact" : "best-effort",
          });
        }

        // Record the gap even when nothing visibly changed: the point is that
        // this call COULD have changed files outside coverage, and the user
        // should be told that rather than shown a clean list that omits them.
        if (isOpaque) {
          appendGap({
            turnId: ctx.turnId,
            toolName: name,
            summary: summarizeCommand(args),
            timestamp: new Date().toISOString(),
          });
        }

        if (threw) throw threw;
        return output;
      },
    };
  }

  return wrapped as T;
}
