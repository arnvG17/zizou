// src/tools/write-file.test.ts
//
// What writeFile tells the MODEL, not just the user.
//
// findSimilarFiles has existed for a while, and its result went into the
// confirmation dialog and nowhere else. So the one actor that could act on it
// — by editing the existing file instead of leaving a near-duplicate beside
// it — was the only one never told. The system prompt asked the model to
// search for an existing implementation before creating a file; this is the
// harness doing that search and handing over what it found.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteFileTool } from "./write-file.js";

const approve = async () => true;

let workspace: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), "zizou-write-file-"));
  // findSimilarFiles walks from process.cwd() rather than taking a root, so
  // the only way to point it at a fixture is to move the process there.
  //
  // process.chdir is process-wide, so the restore in afterEach is load-bearing
  // for every other suite in the run — a test left in the temp directory would
  // break anything that resolves a relative path afterwards.
  process.chdir(workspace);
});

afterEach(() => {
  // Restored FIRST, so a failure to delete the temp directory cannot leave the
  // process parked outside the repo.
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

/** `any` because tool.execute's return type is a union that includes an
 *  AsyncIterable, which no branch of these assertions cares about. */
async function write(path: string, contents: string, confirm = approve): Promise<any> {
  return createWriteFileTool(confirm).execute({ path, contents } as any, {} as any);
}

test("creating a file beside an existing namesake reports it to the model", async () => {
  // The repeated real failure: a fresh todo.html at the root while an
  // app/todo.html already exists, leaving two files that disagree.
  mkdirSync(join(workspace, "app"), { recursive: true });
  writeFileSync(join(workspace, "app", "todo.html"), "<h1>original</h1>", "utf-8");

  const res = await write("todo.html", "<h1>duplicate</h1>");

  expect(res.success).toBe(true);
  expect(res.similarFiles).toContain(join("app", "todo.html"));
  // The model has to be told what to DO about it, not merely that it happened.
  expect(res.note).toContain("consolidate");
});

test("a file with the same stem but a different extension counts", async () => {
  writeFileSync(join(workspace, "calc.js"), "module.exports = {};", "utf-8");

  const res = await write("calc.ts", "export {};");

  expect(res.similarFiles).toContain("calc.js");
});

test("a genuinely new file reports nothing", async () => {
  // A hint that fires on every write is a hint nobody reads, which is why
  // the match is narrow — same basename, or same stem.
  const res = await write("brand-new.ts", "export {};");

  expect(res.success).toBe(true);
  expect(res.similarFiles).toBeUndefined();
  expect(res.note).toBeUndefined();
});

test("overwriting an existing file reports nothing", async () => {
  // Overwriting IS editing the file that already does the job. Warning here
  // would fire on the correct behaviour.
  writeFileSync(join(workspace, "app.ts"), "export const a = 1;", "utf-8");

  const res = await write("app.ts", "export const a = 2;");

  expect(res.success).toBe(true);
  expect(res.similarFiles).toBeUndefined();
});

test("a denied write still reports the denial rather than succeeding quietly", async () => {
  const res = await write("nope.ts", "x", async () => false);

  expect(res.success).toBe(false);
  expect(res.error).toContain("denied");
});
