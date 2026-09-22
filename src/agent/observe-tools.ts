// src/agent/observe-tools.ts
//
// LAYER: agent/
//
// Turning "read the file before you edit it" from advice into a guarantee.
//
// THE RULE THIS REPLACES: the executor system prompt said "Before editFile:
// always readFile first to get exact whitespace. Never guess." That is correct
// advice with nothing behind it. A model that skipped the read produced an
// edit indistinguishable from one that did it properly — until old_string
// failed to match, at which point the tool guessed at the cause in prose
// ("the file may have changed since you last read it, or you may have missed
// some whitespace") because it genuinely did not know which.
//
// The harness does know. It sees every read and every write, so it can say
// exactly which of the two happened, and say it before the edit rather than
// after it failed.
//
// WHY A WRAPPER AND NOT A CHANGE TO edit-file.ts: tools/ may not import from
// agent/ (the layer rule in tools/index.ts). "Has this file been read during
// this task" is a fact about the task, and task state lives in agent/. So the
// precondition lives here, wrapped around a tool that stays ignorant of it.
//
// WHERE IT SITS IN THE STACK:
//
//   wrapToolsWithTrace( journal.wrapTools( THIS( duplicateDetection( raw ) ) ) )
//
// Outside duplicate-detection, deliberately. A refusal must not reach that
// guard's failure tracker, or the recovery it demands — read the file, then
// retry the identical edit — would come back BLOCKED for being a repeat.
// Inside the journal and trace wrappers, so a refusal is still recorded: it is
// a real thing that happened and the log should show it.
//
// DEPENDENCY DIRECTION: imports from agent/task-state.ts and tools/edit-file.ts
// (the error-code type only). Must NOT import from ui/.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  getActiveTaskState,
  getObservation,
  hashContents,
  recordCommand,
  recordModification,
  recordObservation,
} from "./task-state.js";
import type { EditErrorCode } from "../tools/edit-file.js";

/**
 * A precondition refusal.
 *
 * `harnessRefusal` is load-bearing well beyond this file. The run journal
 * derives a call's success as `!threw && output.success !== false`, so without
 * a marker every refusal would be counted as a tool failure — by the debug
 * log, and by the `noToolFailures` eval assertion, which would then fail tasks
 * for behaving correctly. A precondition firing is the harness working.
 */
interface Refusal {
  success: false;
  harnessRefusal: true;
  code: EditErrorCode;
  error: string;
  [extra: string]: unknown;
}

function refuse(code: EditErrorCode, error: string, extra: Record<string, unknown> = {}): Refusal {
  return { success: false, harnessRefusal: true, code, error, ...extra };
}

/** How much of a stale file to hand back inline. */
const MAX_INLINE_CONTENTS = 20_000;

function readOrNull(abs: string): string | null {
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

function pathArg(input: any): string | null {
  const p = input?.path ?? input?.filePath ?? input?.file;
  return typeof p === "string" ? p : null;
}

/**
 * Checks whether an edit is allowed to proceed, and why not when it is not.
 *
 * Returns null to allow. Exported for testing — the guarantee is worth
 * asserting on directly rather than only through a wrapped tool.
 */
export function checkEditPreconditions(rawPath: string, root: string): Refusal | null {
  // No active task means no task state to check against: a direct unit-test
  // call, or a route that never begins a task. Refusing there would break
  // callers that never opted into this in the first place.
  if (!getActiveTaskState()) return null;

  const abs = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);

  if (!existsSync(abs)) {
    return refuse(
      "FILE_NOT_FOUND",
      `${rawPath} does not exist, so there is nothing to edit. ` +
        `If it should exist, check the path — glob or listDir will show what is actually there. ` +
        `If you meant to create it, use writeFile.`,
    );
  }

  const observed = getObservation(rawPath, root);
  if (!observed) {
    return refuse(
      "FILE_NOT_OBSERVED",
      `You have not read ${rawPath} during this task, so you cannot know its exact contents. ` +
        `Call readFile on it first, then edit against what it actually says.`,
    );
  }

  const current = readOrNull(abs);
  if (current === null) {
    // Existed a moment ago and cannot be read now — a permissions change, or
    // something removed it between the two calls.
    return refuse("FILE_NOT_FOUND", `${rawPath} could not be read, though it existed a moment ago.`);
  }

  if (hashContents(current) !== observed.hash) {
    // The contents come back inline so this costs ONE round-trip, not two.
    // Refusing and saying "read it again" would be correct and would make the
    // model spend a call retrieving something the harness is already holding.
    const truncated = current.length > MAX_INLINE_CONTENTS;
    recordObservation(rawPath, current, "readFile", root);

    return refuse(
      "STALE_CONTENTS",
      `${rawPath} has changed since you read it — your old_string would be matched against ` +
        `contents you have not seen. The current contents are below; re-read your target in ` +
        `them and edit against that.`,
      {
        currentContents: truncated ? current.slice(0, MAX_INLINE_CONTENTS) : current,
        truncated,
        ...(truncated ? { totalLength: current.length } : {}),
      },
    );
  }

  return null;
}

// ─── Recording ───────────────────────────────────────────────────────────────

/**
 * Records what a successful call taught us about the project.
 *
 * Reads the file back from disk after a write rather than hashing the string
 * the tool was given: editFile restores the original line endings on write, so
 * hashing its input would record a hash the file does not have and make the
 * very next edit look stale.
 */
function recordOutcome(name: string, args: any, output: any, root: string): void {
  if (!getActiveTaskState()) return;
  if (!output || typeof output !== "object") return;

  switch (name) {
    case "readFile": {
      const path = pathArg(args);
      if (path && output.success !== false && typeof output.contents === "string") {
        recordObservation(path, output.contents, "readFile", root);
      }
      break;
    }

    case "writeFile":
    case "editFile": {
      const path = pathArg(args);
      if (!path || output.success === false) break;
      recordModification(path, root);
      const abs = isAbsolute(path) ? path : resolve(root, path);
      const contents = readOrNull(abs);
      if (contents !== null) {
        recordObservation(path, contents, name as "writeFile" | "editFile", root);
      }
      break;
    }

    case "runBash":
    case "terminal": {
      const command = typeof args?.command === "string" ? args.command : null;
      if (!command) break;
      recordCommand({
        command,
        cwd: typeof args?.cwd === "string" ? args.cwd : undefined,
        exitCode: typeof output.exitCode === "number" ? output.exitCode : null,
        success: output.success !== false,
      });
      break;
    }

    case "service": {
      // A service's evidence is its status, not an exit code — "exited
      // cleanly" still means nothing is serving. See service-registry.ts.
      const command = typeof args?.command === "string" ? args.command : String(args?.name ?? "service");
      recordCommand({
        command,
        cwd: typeof args?.cwd === "string" ? args.cwd : undefined,
        exitCode: typeof output.exitCode === "number" ? output.exitCode : null,
        success: output.status === "ready" || (output.success !== false && output.status !== "crashed"),
      });
      break;
    }
  }
}

// ─── The wrapper ─────────────────────────────────────────────────────────────

/** Tools this layer has anything to say about. Everything else passes through. */
const WATCHED = new Set(["readFile", "writeFile", "editFile", "runBash", "terminal", "service"]);

/**
 * Wraps a tool map with task-state preconditions and outcome recording.
 *
 * Transparent by contract: it returns exactly what execute() returned, and a
 * throw propagates unchanged. Only editFile can be short-circuited, and only
 * when a task is active.
 */
export function wrapToolsWithTaskState<T extends Record<string, any>>(
  tools: T,
  opts: { root: string },
): T {
  const wrapped: Record<string, any> = {};

  for (const [name, def] of Object.entries(tools)) {
    if (!def || typeof def.execute !== "function" || !WATCHED.has(name)) {
      wrapped[name] = def;
      continue;
    }

    const original = def.execute.bind(def);

    wrapped[name] = {
      ...def,
      execute: async (args: any, toolCtx: any) => {
        if (name === "editFile") {
          const path = pathArg(args);
          if (path) {
            const refusal = checkEditPreconditions(path, opts.root);
            if (refusal) return refusal;
          }
        }

        const output = await original(args, toolCtx);
        recordOutcome(name, args, output, opts.root);
        return output;
      },
    };
  }

  return wrapped as T;
}
