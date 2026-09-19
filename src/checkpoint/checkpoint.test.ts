// src/checkpoint/checkpoint.test.ts
//
// Regression tests for the checkpoint data-loss bugs (plan Phase 0).
//
// These run against a throwaway project directory: both the history file path
// and every file operation resolve against the CURRENT cwd, so chdir-ing is
// enough to isolate them. (That was not always true — storage.ts and
// patcher.ts used to cache `const CWD = process.cwd()` at module load, which
// forced these tests to chdir before a dynamic import.)

import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import * as manager from "./manager.js";
import * as storage from "./storage.js";

const originalCwd = process.cwd();
const workspace = mkdtempSync(join(tmpdir(), "zizou-cp-test-"));

// See the matching note in undo-redo.test.ts: test files share a process,
// and more than one of them chdirs.
beforeEach(() => {
  process.chdir(workspace);
});

afterAll(() => {
  // Remove the history this test wrote under the user's home before restoring cwd.
  try {
    rmSync(join(storage.getCheckpointHistoryPath(), ".."), { recursive: true, force: true });
  } catch {
    // best effort
  }
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

/** Creates a file in the workspace and returns its relative path. */
function write(relPath: string, content: string): string {
  const abs = join(workspace, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return relPath;
}

function exists(relPath: string): boolean {
  return existsSync(join(workspace, relPath));
}

test("createCheckpoint records a patch for a newly created file", () => {
  // Before the fix, oldFileStates.get(path) returned null, `??` treated that
  // as absent, and captureFileState() supplied the CURRENT content — so
  // oldContent === newContent and the create was dropped entirely.
  const path = write("created.ts", "export const a = 1;\n");
  const oldStates = new Map<string, string | null>([[path, null]]);

  const checkpoint = manager.createCheckpoint("create a file", [path], oldStates);

  const patch = checkpoint.patches.find((p) => p.filePath === path);
  expect(patch).toBeDefined();
  expect(patch!.operation).toBe("create");
  expect(patch!.oldContent).toBeNull();
  expect(patch!.newContent).toBe("export const a = 1;\n");
});

test("restoreCheckpoint rolls back files first touched AFTER the target", () => {
  // The original implementation only replayed patches root->target, so a file
  // created by a LATER checkpoint had no patch in the target's chain and was
  // left on disk at its newer state forever.
  const first = write("alpha.ts", "alpha v1\n");
  const cp1 = manager.createCheckpoint(
    "add alpha",
    [first],
    new Map([[first, null]]),
  );

  const second = write("beta.ts", "beta v1\n");
  manager.createCheckpoint("add beta", [second], new Map([[second, null]]));

  expect(exists("beta.ts")).toBe(true);

  manager.restoreCheckpoint(cp1.id);

  expect(exists("alpha.ts")).toBe(true);
  expect(exists("beta.ts")).toBe(false);
});

test("getSessionChanges returns nothing when there is no session baseline", () => {
  // A fresh project's root checkpoint has no parent, so there is no recorded
  // pre-session state. This must NOT be reported as "every file is new".
  expect(manager.hasSessionBaseline()).toBe(false);
  expect(manager.getSessionChanges()).toEqual([]);
});

test("revertSessionChanges refuses without a baseline instead of emptying the tree", () => {
  // The headline bug: with no baseline every project file was classified as a
  // `create` with oldContent null, and reverting a create means unlinking it.
  write("keepme.ts", "important\n");
  expect(manager.hasSessionBaseline()).toBe(false);

  expect(() => manager.revertSessionChanges()).toThrow(/no known state to revert to/i);

  // The whole point: the working tree survives.
  expect(exists("keepme.ts")).toBe(true);
  expect(exists("alpha.ts")).toBe(true);
});
