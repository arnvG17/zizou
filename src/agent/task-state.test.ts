// src/agent/task-state.test.ts
//
// The guarantees the harness now makes about editing.
//
// These exist because the rules they cover used to live in the system prompt,
// where nothing could check them. A prompt rule has no failing test — it has
// a model that mostly complies. These are the tests that became possible once
// the rules became code.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetForTests,
  beginTask,
  finishTask,
  getActiveTaskState,
  getObservation,
  recordCommand,
  recordFailureSignature,
  recordModification,
  recordObservation,
  recordVerification,
  renderTaskState,
  fromPersisted,
  toPersisted,
} from "./task-state.js";
import { checkEditPreconditions } from "./observe-tools.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "zizou-task-state-"));
  _resetForTests();
});

afterEach(() => {
  _resetForTests();
  rmSync(workspace, { recursive: true, force: true });
});

function seed(name: string, contents: string): string {
  const path = join(workspace, name);
  writeFileSync(path, contents, "utf-8");
  return path;
}

// ─── Observation ─────────────────────────────────────────────────────────────

test("a file is not observed until it has been read", () => {
  beginTask({ taskId: "t1", goal: "edit it", route: "build" });
  expect(getObservation("app.ts", workspace)).toBeUndefined();

  recordObservation("app.ts", "const a = 1;", "readFile", workspace);
  expect(getObservation("app.ts", workspace)?.via).toBe("readFile");
});

test("re-observing a file replaces the previous hash rather than adding to it", () => {
  // The newest hash is the one a later edit must be checked against. Keeping
  // the first would make every edit after a legitimate write look stale.
  beginTask({ taskId: "t1", goal: "edit it", route: "build" });

  recordObservation("app.ts", "one", "readFile", workspace);
  const first = getObservation("app.ts", workspace)!.hash;
  recordObservation("app.ts", "two", "writeFile", workspace);
  const second = getObservation("app.ts", workspace)!;

  expect(second.hash).not.toBe(first);
  expect(second.via).toBe("writeFile");
  expect(getActiveTaskState()!.observedFiles.size).toBe(1);
});

test("path spelling does not create a second identity for one file", () => {
  // ./src/a.ts, src/a.ts and the absolute path are one file. The old
  // checkpoint system treated them as three, which is why canonicalPath
  // exists and why this reuses it.
  beginTask({ taskId: "t1", goal: "edit it", route: "build" });
  recordObservation("./app.ts", "const a = 1;", "readFile", workspace);

  expect(getObservation("app.ts", workspace)).toBeDefined();
  expect(getObservation(join(workspace, "app.ts"), workspace)).toBeDefined();
  expect(getActiveTaskState()!.observedFiles.size).toBe(1);
});

// ─── Preconditions ───────────────────────────────────────────────────────────

test("editing a file that was never read is refused, with a recoverable reason", () => {
  seed("app.ts", "const a = 1;\n");
  beginTask({ taskId: "t1", goal: "edit it", route: "build" });

  const refusal = checkEditPreconditions("app.ts", workspace);

  expect(refusal?.code).toBe("FILE_NOT_OBSERVED");
  expect(refusal?.harnessRefusal).toBe(true);
  // The remedy has to be in the message — a refusal the model cannot act on
  // is just a failure with better manners.
  expect(refusal?.error).toContain("readFile");
});

test("editing a file that was read is allowed", () => {
  const path = seed("app.ts", "const a = 1;\n");
  beginTask({ taskId: "t1", goal: "edit it", route: "build" });
  recordObservation(path, "const a = 1;\n", "readFile", workspace);

  expect(checkEditPreconditions("app.ts", workspace)).toBeNull();
});

test("editing a file that changed since it was read is refused, with its current contents", () => {
  // THE CASE THIS EXISTS FOR: the model reads a file, something else writes
  // to it, and the model's old_string is then matched against contents nobody
  // has seen. It either fails with a guessed explanation or — worse — matches
  // somewhere unintended.
  const path = seed("app.ts", "const a = 1;\n");
  beginTask({ taskId: "t1", goal: "edit it", route: "build" });
  recordObservation(path, "const a = 1;\n", "readFile", workspace);

  writeFileSync(path, "const a = 2;\n// added by someone else\n", "utf-8");

  const refusal = checkEditPreconditions("app.ts", workspace);

  expect(refusal?.code).toBe("STALE_CONTENTS");
  // Handed back inline so recovery costs one round-trip, not two.
  expect(refusal?.currentContents).toContain("added by someone else");
});

test("a stale refusal re-observes the file, so the immediate retry succeeds", () => {
  const path = seed("app.ts", "const a = 1;\n");
  beginTask({ taskId: "t1", goal: "edit it", route: "build" });
  recordObservation(path, "const a = 1;\n", "readFile", workspace);
  writeFileSync(path, "const a = 2;\n", "utf-8");

  expect(checkEditPreconditions("app.ts", workspace)?.code).toBe("STALE_CONTENTS");
  // The model was just given the current contents, so it now HAS seen them.
  // Refusing again would strand it in a loop it cannot exit.
  expect(checkEditPreconditions("app.ts", workspace)).toBeNull();
});

test("editing a file that does not exist says so, rather than blaming the read", () => {
  beginTask({ taskId: "t1", goal: "edit it", route: "build" });

  const refusal = checkEditPreconditions("nope.ts", workspace);

  expect(refusal?.code).toBe("FILE_NOT_FOUND");
  expect(refusal?.error).toContain("writeFile");
});

test("preconditions do not fire when no task is active", () => {
  // Direct tool use in a unit test, or a route that never begins a task,
  // must not be broken by a guarantee it never opted into.
  seed("app.ts", "const a = 1;\n");
  expect(checkEditPreconditions("app.ts", workspace)).toBeNull();
});

// ─── Rendering ───────────────────────────────────────────────────────────────

test("a task with nothing established renders nothing", () => {
  beginTask({ taskId: "t1", goal: "do it", route: "build" });
  expect(renderTaskState()).toBe("");
});

test("the rendered state names files, exit codes and verification outcomes", () => {
  beginTask({ taskId: "t1", goal: "do it", route: "build" });
  recordObservation("src/app.ts", "x", "readFile", workspace);
  recordObservation("src/out.ts", "y", "writeFile", workspace);
  recordModification("src/out.ts", workspace);
  recordCommand({ command: "bun test", exitCode: 1, success: false });
  recordVerification({ command: "bun run typecheck", kind: "typecheck", passed: false, detail: "exit 2" });

  const rendered = renderTaskState();

  expect(rendered).toContain("src/app.ts");
  expect(rendered).toContain("src/out.ts");
  expect(rendered).toContain("bun test");
  expect(rendered).toContain("exit 1");
  // A failed check must read as failed. Reporting it neutrally is how a model
  // ends up describing unverified work as done.
  expect(rendered).toContain("FAILED");
});

test("beginning a task clears what the previous one knew", () => {
  beginTask({ taskId: "t1", goal: "first", route: "build" });
  recordObservation("app.ts", "x", "readFile", workspace);

  beginTask({ taskId: "t2", goal: "second", route: "build" });

  // Otherwise a file read in an earlier request would count as observed in
  // this one, vouching for contents the model can no longer see.
  expect(getObservation("app.ts", workspace)).toBeUndefined();
  expect(getActiveTaskState()!.taskId).toBe("t2");
});

test("a finished task stops recording but stays readable", () => {
  // The record has to outlive the run: the UI persists it into the session
  // once the orchestrator's generator drains. But a chat or ask turn that
  // follows must not append ITS file reads to the build that already
  // completed, or the session's record of that build quietly grows wrong.
  beginTask({ taskId: "t1", goal: "do it", route: "build" });
  recordObservation("app.ts", "x", "readFile", workspace);

  finishTask();
  recordObservation("unrelated.ts", "y", "readFile", workspace);
  recordCommand({ command: "git status", exitCode: 0, success: true });

  const state = getActiveTaskState()!;
  expect(state.observedFiles.size).toBe(1);
  expect(state.commands).toHaveLength(0);
  // Still persistable — that is the whole reason it was not discarded.
  expect(toPersisted()?.taskId).toBe("t1");
});

test("a restored task is never treated as live", () => {
  // Otherwise reopening a session would leave the previous request's task
  // accepting records from the next one.
  const restored = fromPersisted({ taskId: "t1", observedFiles: [] } as any)!;
  expect(restored.finishedAt).not.toBeNull();
});

// ─── Failure signatures ──────────────────────────────────────────────────────

test("failure signatures accumulate without deciding whether they repeat", () => {
  // The comparison is the step loop's, not this module's: in plan mode a whole
  // plan is one task, so step 3 failing the way step 1 did is two different
  // problems that happen to look alike.
  beginTask({ taskId: "t1", goal: "do it", route: "plan" });

  recordFailureSignature("command-failed|build");
  recordFailureSignature("command-failed|build");

  expect(getActiveTaskState()!.failureSignatures).toEqual([
    "command-failed|build",
    "command-failed|build",
  ]);
});

// ─── Persistence ─────────────────────────────────────────────────────────────

test("task state survives a round-trip through the session format", () => {
  beginTask({ taskId: "t1", goal: "add a flag", route: "build" });
  recordObservation("src/cli.ts", "x", "readFile", workspace);
  recordModification("src/cli.ts", workspace);
  recordCommand({ command: "bun test", exitCode: 0, success: true });
  recordVerification({ command: "bun run typecheck", kind: "typecheck", passed: true });
  recordFailureSignature("sig");

  const restored = fromPersisted(JSON.parse(JSON.stringify(toPersisted())))!;

  expect(restored.taskId).toBe("t1");
  expect(restored.goal).toBe("add a flag");
  // Maps and Sets do not survive JSON, so these are what actually break if
  // the persisted shape and the live shape drift apart.
  expect(restored.observedFiles.size).toBe(1);
  expect(restored.modifiedFiles.size).toBe(1);
  expect(restored.commands).toHaveLength(1);
  expect(restored.verifications[0]!.passed).toBe(true);
  expect(restored.failureSignatures).toEqual(["sig"]);
});

test("a malformed persisted task is dropped rather than thrown on", () => {
  // A session written by a build whose shape differed should lose a field,
  // not refuse to open. Losing a session to a bad receipt is the worse trade.
  expect(fromPersisted(undefined)).toBeNull();
  expect(fromPersisted({} as any)).toBeNull();
  expect(fromPersisted({ taskId: "t1" } as any)?.observedFiles.size).toBe(0);
});
