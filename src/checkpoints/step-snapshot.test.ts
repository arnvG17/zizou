// src/checkpoints/step-snapshot.test.ts
//
// Regression test for the /undo deletes-files bug (plan Phase 0).
//
// See checkpoint.test.ts for why this chdirs before importing.

import { test, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalCwd = process.cwd();
const workspace = mkdtempSync(join(tmpdir(), "zizou-snap-test-"));
process.chdir(workspace);

const { buildSnapshot } = await import("./step-snapshot.js");

// Bun runs test files in one process, and the sibling checkpoint test also
// chdirs. Re-assert our workspace before each test so evaluation order can't
// leak between them.
beforeEach(() => {
  process.chdir(workspace);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

test("buildSnapshot skips files whose before-state is unknown", () => {
  // buildSnapshot looked up `before` by ABSOLUTE path, but the orchestrator
  // hands it the executor's oldFileStates, which is keyed by the RELATIVE path
  // the model passed to the tool. Every lookup missed, `?? null` turned the
  // miss into "file did not exist before", and applySnapshotReverse then
  // unlinked a file that should have been restored.
  writeFileSync(join(workspace, "mystery.ts"), "current content\n", "utf-8");

  const snapshot = buildSnapshot("0", new Map(), ["mystery.ts"]);

  // No diff at all is the safe outcome — undo leaves the file alone.
  expect(snapshot.fileDiffs).toHaveLength(0);
});

test("buildSnapshot accepts a before-map keyed by relative path", () => {
  writeFileSync(join(workspace, "rel.ts"), "after\n", "utf-8");

  const snapshot = buildSnapshot("1", new Map([["rel.ts", "before\n"]]), ["rel.ts"]);

  expect(snapshot.fileDiffs).toHaveLength(1);
  expect(snapshot.fileDiffs[0]!.before).toBe("before\n");
  expect(snapshot.fileDiffs[0]!.after).toBe("after\n");
});

test("buildSnapshot accepts a before-map keyed by absolute path", () => {
  const abs = join(workspace, "abs.ts");
  writeFileSync(abs, "after\n", "utf-8");

  const snapshot = buildSnapshot("2", new Map([[abs, null]]), ["abs.ts"]);

  expect(snapshot.fileDiffs).toHaveLength(1);
  // A genuine recorded null (file did not exist) must still round-trip.
  expect(snapshot.fileDiffs[0]!.before).toBeNull();
  expect(snapshot.fileDiffs[0]!.after).toBe("after\n");
});
