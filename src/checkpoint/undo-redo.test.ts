// src/checkpoint/undo-redo.test.ts
//
// Undo/redo as head-pointer movement along the checkpoint chain (plan Phase 3).
//
// The bug class this guards against: undo/redo used to be a SEPARATE store
// (src/checkpoints/undo-redo-stack.ts, a Conf file under <cwd>/.zizou) holding
// its own snapshots, with no link to the checkpoint history. The two drifted:
//
//   - /undo restored files but left history.json claiming the undone content
//     was current, so /checkpoint diff reported the undone step as a fresh
//     local modification and /checkpoint revert would RE-APPLY it.
//   - /checkpoint restore changed the disk without touching the stacks, so a
//     later /undo reverted to a "before" state that no longer matched reality.
//
// With one chain and one head pointer that divergence is unrepresentable, so
// these tests assert disk state and history agree after every move.


import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import * as manager from "./manager.js";
import * as storage from "./storage.js";

const originalCwd = process.cwd();
const workspace = mkdtempSync(join(tmpdir(), "zizou-undo-test-"));

// Each test starts from an empty history AND an empty workspace. Sharing
// state across them made "undo the first checkpoint" mean whichever
// checkpoint an earlier test happened to leave at the root.
beforeEach(() => {
  process.chdir(workspace);
  try {
    rmSync(storage.getCheckpointHistoryPath(), { force: true });
  } catch {
    // best effort
  }
  for (const entry of readdirSync(workspace)) {
    rmSync(join(workspace, entry), { recursive: true, force: true });
  }
});

afterAll(() => {
  try {
    rmSync(join(storage.getCheckpointHistoryPath(), ".."), { recursive: true, force: true });
  } catch {
    // best effort
  }
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

function write(relPath: string, content: string): string {
  writeFileSync(join(workspace, relPath), content, "utf-8");
  return relPath;
}

function read(relPath: string): string | null {
  const abs = join(workspace, relPath);
  return existsSync(abs) ? readFileSync(abs, "utf-8") : null;
}

/** Records a checkpoint for a file going from `before` to `after`. */
function commit(description: string, relPath: string, before: string | null, after: string) {
  write(relPath, after);
  return manager.createCheckpoint(description, [relPath], new Map([[relPath, before]]));
}

test("undo walks back one checkpoint at a time and redo walks forward", () => {
  commit("v1", "notes.md", null, "one\n");
  commit("v2", "notes.md", "one\n", "two\n");
  commit("v3", "notes.md", "two\n", "three\n");

  expect(read("notes.md")).toBe("three\n");
  expect(manager.getUndoDepth()).toBe(3);
  expect(manager.getRedoDepth()).toBe(0);

  manager.undoCheckpoint();
  expect(read("notes.md")).toBe("two\n");

  manager.undoCheckpoint();
  expect(read("notes.md")).toBe("one\n");
  expect(manager.getRedoDepth()).toBe(2);

  manager.redoCheckpoint();
  expect(read("notes.md")).toBe("two\n");

  manager.redoCheckpoint();
  expect(read("notes.md")).toBe("three\n");
  expect(manager.getRedoDepth()).toBe(0);
});

test("undoing the first checkpoint removes a file it created, and redo restores it", () => {
  // The old stack could undo the very first step; the head pointer must be
  // able to sit "before the root" for that to still work.
  commit("create", "fresh.ts", null, "export const a = 1;\n");
  expect(read("fresh.ts")).toBe("export const a = 1;\n");

  manager.undoCheckpoint();
  expect(existsSync(join(workspace, "fresh.ts"))).toBe(false);
  expect(manager.getUndoDepth()).toBe(0);

  manager.redoCheckpoint();
  expect(read("fresh.ts")).toBe("export const a = 1;\n");
});

test("after undo, the checkpoint history agrees with the working tree", () => {
  // THE headline divergence: /undo used to leave history.json claiming the
  // undone content was still current, so getLocalChanges() reported the
  // undone step as an uncommitted local modification and reverting it would
  // re-apply exactly what the user had just undone.
  commit("baseline", "agree.ts", null, "first\n");
  commit("second", "agree.ts", "first\n", "second\n");

  manager.undoCheckpoint();
  expect(read("agree.ts")).toBe("first\n");

  // The head is now the baseline checkpoint, and disk matches it exactly,
  // so there is nothing pending relative to the head.
  const pending = manager.getLocalChanges().filter((c) => c.filePath.includes("agree.ts"));
  expect(pending).toEqual([]);
});

test("recording a new checkpoint after undoing everything starts a fresh root", () => {
  commit("throwaway", "gone.ts", null, "discard me\n");
  manager.undoCheckpoint();
  expect(manager.getUndoDepth()).toBe(0);
  expect(manager.getRedoDepth()).toBe(1);

  commit("after reset", "reborn.ts", null, "hello\n");

  expect(manager.getUndoDepth()).toBe(1);
  // Committing past an undone chain discards the redo future, as in git.
  expect(manager.getRedoDepth()).toBe(0);
  expect(read("reborn.ts")).toBe("hello\n");
});

test("undo reports nothing to do on an empty history", () => {
  expect(manager.getUndoDepth()).toBe(0);
  expect(manager.undoCheckpoint()).toBeNull();
});
