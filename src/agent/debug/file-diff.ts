// src/agent/debug/file-diff.ts
//
// LAYER: agent/debug
//
// Turns a before/after pair of file contents into a structured, loggable diff.
//
// WHY THIS EXISTS: the debug log used to record what the model SAID it did
// (tool name + arguments). That is a claim, not a fact. A writeFile call whose
// `contents` argument is 400 lines tells you nothing about what actually
// landed on disk — the tool may have been denied at the confirm prompt, hit a
// permission error, or written to a path that resolved somewhere unexpected.
//
// So the journal snapshots the file from the filesystem immediately before and
// immediately after execute() and diffs the two. The diff in the log is
// therefore ground truth: if it is empty, nothing changed, whatever the model
// claimed.
//
// Allowed imports: none from within the project (leaf module).

import { structuredPatch, type StructuredPatch } from "diff";

/** How a file changed over a single tool call. */
export type FileChangeKind = "created" | "modified" | "deleted" | "unchanged";

export interface FileDiff {
  /** Path as the model referred to it — relative where possible. */
  path: string;
  /** Absolute path actually touched, so ambiguity about cwd is impossible. */
  absPath: string;
  kind: FileChangeKind;
  /** Lines added / removed, counted from the hunks (not estimated). */
  added: number;
  removed: number;
  /** Unified-diff text, already truncated to a sane size for a log file. */
  patch: string;
  /** True when the patch was cut short by the size cap. */
  truncated: boolean;
  /** Set when the file is binary or too large to diff meaningfully. */
  note?: string;
}

/** Above this many patch lines, we cut the patch short. */
const MAX_PATCH_LINES = 400;
/** Files bigger than this are summarized rather than diffed line by line. */
const MAX_DIFF_BYTES = 512 * 1024;
/** A NUL byte within this many leading chars means "treat as binary". */
const BINARY_SNIFF_BYTES = 8192;

const NUL = String.fromCharCode(0);

function looksBinary(content: string): boolean {
  return content.slice(0, BINARY_SNIFF_BYTES).includes(NUL);
}

function countLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length;
}

/**
 * Builds a FileDiff from two snapshots. `null` means "did not exist".
 *
 * created/deleted are derived from the snapshots, not from which tool ran:
 * `writeFile` onto an existing path is a modification, and the log should
 * say so rather than trusting the tool's name.
 */
export function buildFileDiff(
  path: string,
  absPath: string,
  before: string | null,
  after: string | null,
): FileDiff {
  const base = { path, absPath, truncated: false };

  if (before === after) {
    return { ...base, kind: "unchanged", added: 0, removed: 0, patch: "" };
  }

  // ── Created ──────────────────────────────────────────────────────────────
  if (before === null && after !== null) {
    if (looksBinary(after)) {
      return {
        ...base,
        kind: "created",
        added: 0,
        removed: 0,
        patch: "",
        note: `binary file created (${after.length} bytes)`,
      };
    }
    const lines = after.split("\n");
    const shown = lines.slice(0, MAX_PATCH_LINES);
    return {
      ...base,
      kind: "created",
      added: countLines(after),
      removed: 0,
      patch: ["--- /dev/null", `+++ ${path}`, ...shown.map((l) => `+${l}`)].join("\n"),
      truncated: lines.length > shown.length,
    };
  }

  // ── Deleted ──────────────────────────────────────────────────────────────
  if (before !== null && after === null) {
    if (looksBinary(before)) {
      return {
        ...base,
        kind: "deleted",
        added: 0,
        removed: 0,
        patch: "",
        note: `binary file deleted (${before.length} bytes)`,
      };
    }
    const lines = before.split("\n");
    const shown = lines.slice(0, MAX_PATCH_LINES);
    return {
      ...base,
      kind: "deleted",
      added: 0,
      removed: countLines(before),
      patch: [`--- ${path}`, "+++ /dev/null", ...shown.map((l) => `-${l}`)].join("\n"),
      truncated: lines.length > shown.length,
    };
  }

  // ── Modified ─────────────────────────────────────────────────────────────
  const b = before as string;
  const a = after as string;

  if (looksBinary(b) || looksBinary(a)) {
    return {
      ...base,
      kind: "modified",
      added: 0,
      removed: 0,
      patch: "",
      note: `binary file changed (${b.length} -> ${a.length} bytes)`,
    };
  }

  if (b.length > MAX_DIFF_BYTES || a.length > MAX_DIFF_BYTES) {
    return {
      ...base,
      kind: "modified",
      added: 0,
      removed: 0,
      patch: "",
      note:
        `file too large to diff (${b.length} -> ${a.length} bytes, ` +
        `${countLines(b)} -> ${countLines(a)} lines)`,
    };
  }

  let patchObj: StructuredPatch | undefined;
  try {
    patchObj = structuredPatch(path, path, b, a, undefined, undefined, { context: 3 });
  } catch {
    patchObj = undefined;
  }

  if (!patchObj || patchObj.hunks.length === 0) {
    return {
      ...base,
      kind: "modified",
      added: 0,
      removed: 0,
      patch: "",
      note: "contents differ but no line-level hunks were produced",
    };
  }

  let added = 0;
  let removed = 0;
  const body: string[] = [`--- ${path}`, `+++ ${path}`];

  for (const hunk of patchObj.hunks) {
    body.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
      body.push(line);
    }
  }

  const truncated = body.length > MAX_PATCH_LINES;
  const shown = truncated ? body.slice(0, MAX_PATCH_LINES) : body;

  return {
    ...base,
    kind: "modified",
    added,
    removed,
    patch: shown.join("\n"),
    truncated,
  };
}

/** `+12 -3` style summary for one-line rendering. */
export function formatDiffStat(d: FileDiff): string {
  if (d.kind === "unchanged") return "no change";
  return `+${d.added} -${d.removed}`;
}
