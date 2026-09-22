// src/trace/trace.test.ts
//
// The bug class these guard against is the reason checkpoint/ was replaced.
//
// The old system captured a file's "before" content when the CONSUMER received
// a tool-call event from the SDK stream. The SDK runs execute() concurrently
// with delivering that event, so the read raced the write it was meant to
// precede: oldContent was frequently the POST-change content, the change
// looked like a no-op, and nothing was recorded. Undo then silently did
// nothing. It was non-deterministic, so it passed by luck as often as not.
//
// The race regression test below is the one the old design cannot pass at all:
// its fake tool writes the file inside execute(), which is exactly the window
// the old capture point lost.

import { test, expect, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

import { getTraceDir } from "./blobs.js";
import { readEdits, readGaps } from "./ledger.js";
import { canonicalPath } from "./paths.js";
import { getChanges, lastRedoableTurn, lastUndoableTurn } from "./query.js";
import { redoTurn, revertEdit, revertTurn } from "./revert.js";
import { wrapToolsWithTrace } from "./wrap-tools.js";

const originalCwd = process.cwd();
const workspace = mkdtempSync(join(tmpdir(), "zizou-trace-test-"));

beforeEach(() => {
  process.chdir(workspace);
  rmSync(getTraceDir(), { recursive: true, force: true });
  for (const entry of readdirSync(workspace)) {
    rmSync(join(workspace, entry), { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(getTraceDir(), { recursive: true, force: true });
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  mkdirSync(dirname(join(workspace, rel)), { recursive: true });
  writeFileSync(join(workspace, rel), content, "utf-8");
}

function read(rel: string): string | null {
  try {
    return readFileSync(join(workspace, rel), "utf-8");
  } catch {
    return null;
  }
}

function ctx(turnId = "turn-1") {
  return { turnId, sessionId: "session-1", root: workspace };
}

/** A fake writeFile tool: it declares `path` and writes inside execute(). */
function fakeWriteFile() {
  return {
    execute: async (args: { path: string; content: string | null }, _ctx?: unknown) => {
      const abs = resolve(workspace, args.path);
      if (args.content === null) {
        rmSync(abs, { force: true });
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, args.content, "utf-8");
      }
      return { success: true };
    },
  };
}

// ─── The race ────────────────────────────────────────────────────────────────

test("captures pre-change content even though the tool writes inside execute()", async () => {
  write("a.ts", "original\n");

  const tools = wrapToolsWithTrace({ writeFile: fakeWriteFile() }, ctx());
  await tools.writeFile.execute({ path: "a.ts", content: "changed\n" }, { toolCallId: "c1" });

  const edits = readEdits();
  expect(edits).toHaveLength(1);
  expect(edits[0].kind).toBe("modified");

  const { files } = getChanges(workspace, "session-1");
  expect(files[0].path).toBe(canonicalPath("a.ts", workspace));

  // The whole point: before is the ORIGINAL, not what the tool just wrote.
  revertTurn("turn-1", workspace);
  expect(read("a.ts")).toBe("original\n");
});

test("a tool that throws mid-write still has its partial change traced", async () => {
  write("a.ts", "original\n");

  const throwing = {
    execute: async (args: { path: string }, _ctx?: unknown) => {
      writeFileSync(join(workspace, args.path), "half-written\n", "utf-8");
      throw new Error("boom");
    },
  };

  const tools = wrapToolsWithTrace({ writeFile: throwing }, ctx());
  await expect(
    tools.writeFile.execute({ path: "a.ts" }, { toolCallId: "c1" }),
  ).rejects.toThrow("boom");

  expect(readEdits()).toHaveLength(1);
  revertTurn("turn-1", workspace);
  expect(read("a.ts")).toBe("original\n");
});

// ─── Path identity ───────────────────────────────────────────────────────────

test("different spellings of one path collapse to a single entry", async () => {
  write("src/a.ts", "v1\n");
  const tools = wrapToolsWithTrace({ writeFile: fakeWriteFile() }, ctx());

  await tools.writeFile.execute({ path: "src/a.ts", content: "v2\n" }, { toolCallId: "c1" });
  await tools.writeFile.execute({ path: "./src/a.ts", content: "v3\n" }, { toolCallId: "c2" });
  await tools.writeFile.execute(
    { path: join(workspace, "src/a.ts"), content: "v4\n" },
    { toolCallId: "c3" },
  );

  const { files } = getChanges(workspace, "session-1");
  expect(files).toHaveLength(1);
  expect(files[0].edits).toHaveLength(3);
});

// ─── Revert semantics ────────────────────────────────────────────────────────

test("reverting a created file deletes it", async () => {
  const tools = wrapToolsWithTrace({ writeFile: fakeWriteFile() }, ctx());
  await tools.writeFile.execute({ path: "new.ts", content: "hi\n" }, { toolCallId: "c1" });

  expect(read("new.ts")).toBe("hi\n");
  revertTurn("turn-1", workspace);
  expect(existsSync(join(workspace, "new.ts"))).toBe(false);
});

test("reverting a delete recreates the file, including a missing parent directory", async () => {
  write("nested/deep/a.ts", "content\n");
  const tools = wrapToolsWithTrace({ writeFile: fakeWriteFile() }, ctx());

  await tools.writeFile.execute({ path: "nested/deep/a.ts", content: null }, { toolCallId: "c1" });
  // Remove the parent too — the old patcher threw on exactly this case.
  rmSync(join(workspace, "nested"), { recursive: true, force: true });

  const results = revertTurn("turn-1", workspace, true);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(read("nested/deep/a.ts")).toBe("content\n");
});

test("three edits to one file in a turn unwind to the pre-turn content", async () => {
  write("a.ts", "v0\n");
  const tools = wrapToolsWithTrace({ writeFile: fakeWriteFile() }, ctx());

  await tools.writeFile.execute({ path: "a.ts", content: "v1\n" }, { toolCallId: "c1" });
  await tools.writeFile.execute({ path: "a.ts", content: "v2\n" }, { toolCallId: "c2" });
  await tools.writeFile.execute({ path: "a.ts", content: "v3\n" }, { toolCallId: "c3" });

  revertTurn("turn-1", workspace);
  expect(read("a.ts")).toBe("v0\n");
});

test("reverting one file leaves the turn's other files alone", async () => {
  write("a.ts", "a0\n");
  write("b.ts", "b0\n");
  const tools = wrapToolsWithTrace({ writeFile: fakeWriteFile() }, ctx());

  await tools.writeFile.execute({ path: "a.ts", content: "a1\n" }, { toolCallId: "c1" });
  await tools.writeFile.execute({ path: "b.ts", content: "b1\n" }, { toolCallId: "c2" });

  const target = readEdits().find((e) => e.path.endsWith("a.ts"))!;
  expect(revertEdit(target.id, workspace).ok).toBe(true);

  expect(read("a.ts")).toBe("a0\n");
  expect(read("b.ts")).toBe("b1\n"); // untouched
});

// ─── The safety guard ────────────────────────────────────────────────────────

test("refuses to revert a file the user edited afterwards, unless forced", async () => {
  write("a.ts", "original\n");
  const tools = wrapToolsWithTrace({ writeFile: fakeWriteFile() }, ctx());
  await tools.writeFile.execute({ path: "a.ts", content: "agent\n" }, { toolCallId: "c1" });

  write("a.ts", "hand-edited by the user\n");

  const refused = revertTurn("turn-1", workspace);
  expect(refused[0].ok).toBe(false);
  expect(refused[0].reason).toContain("changed since");
  expect(read("a.ts")).toBe("hand-edited by the user\n"); // their work survives

  const forced = revertTurn("turn-1", workspace, true);
  expect(forced[0].ok).toBe(true);
  expect(read("a.ts")).toBe("original\n");
});

// ─── Coverage of tools the old system ignored ────────────────────────────────

test("fileOperations delete is traced and revertible", async () => {
  write("gone.ts", "keep me\n");

  const fileOperations = {
    execute: async (args: { source: string }, _ctx?: unknown) => {
      rmSync(join(workspace, args.source), { force: true });
      return { success: true };
    },
  };

  const tools = wrapToolsWithTrace({ fileOperations }, ctx());
  await tools.fileOperations.execute({ source: "gone.ts" }, { toolCallId: "c1" });

  const edits = readEdits();
  expect(edits).toHaveLength(1);
  expect(edits[0].kind).toBe("deleted");

  revertTurn("turn-1", workspace);
  expect(read("gone.ts")).toBe("keep me\n");
});

test("a bash call records a coverage gap and re-checks known paths", async () => {
  write("a.ts", "v0\n");

  const runBash = {
    execute: async (_args?: unknown, _ctx?: unknown) => {
      writeFileSync(join(workspace, "a.ts"), "touched by bash\n", "utf-8");
      return { success: true };
    },
  };

  const tools = wrapToolsWithTrace({ writeFile: fakeWriteFile(), runBash }, ctx());
  // Seed the known-paths set — bash can only be checked against paths seen.
  await tools.writeFile.execute({ path: "a.ts", content: "v1\n" }, { toolCallId: "c1" });
  await tools.runBash.execute({ command: "echo hi > a.ts" }, { toolCallId: "c2" });

  const bashEdit = readEdits().find((e) => e.toolName === "runBash");
  expect(bashEdit?.coverage).toBe("best-effort");

  const gaps = readGaps();
  expect(gaps).toHaveLength(1);
  expect(gaps[0].summary).toContain("echo hi");
});

// ─── Turn selection ──────────────────────────────────────────────────────────

test("undo targets the latest turn; redo brings it back", async () => {
  write("a.ts", "v0\n");

  const t1 = wrapToolsWithTrace({ writeFile: fakeWriteFile() }, ctx("turn-1"));
  await t1.writeFile.execute({ path: "a.ts", content: "v1\n" }, { toolCallId: "c1" });

  const t2 = wrapToolsWithTrace({ writeFile: fakeWriteFile() }, ctx("turn-2"));
  await t2.writeFile.execute({ path: "a.ts", content: "v2\n" }, { toolCallId: "c2" });

  expect(lastUndoableTurn("session-1")).toBe("turn-2");

  revertTurn("turn-2", workspace);
  expect(read("a.ts")).toBe("v1\n");

  expect(lastUndoableTurn("session-1")).toBe("turn-1");
  expect(lastRedoableTurn("session-1")).toBe("turn-2");

  redoTurn("turn-2", workspace);
  expect(read("a.ts")).toBe("v2\n");
});

test("an unverified step's changes are still traced", async () => {
  // There is no verification gate any more: the wrapper records at the tool
  // call, so whether a later verifier approved the step is irrelevant. The old
  // system only wrote a checkpoint `if (verification.verified)`, which is why
  // a failed step's writes were stranded on disk with no way back.
  write("a.ts", "v0\n");
  const tools = wrapToolsWithTrace({ writeFile: fakeWriteFile() }, ctx());
  await tools.writeFile.execute({ path: "a.ts", content: "broken\n" }, { toolCallId: "c1" });

  expect(readEdits()).toHaveLength(1);
  revertTurn("turn-1", workspace);
  expect(read("a.ts")).toBe("v0\n");
});

test("shows the file as the user spells it, while still matching case-insensitively", async () => {
  // canonicalPath lowercases on Windows so two spellings share one identity.
  // That must not reach the display, or README.md is listed as readme.md.
  write("README.md", "v0\n");
  const tools = wrapToolsWithTrace({ writeFile: fakeWriteFile() }, ctx());
  await tools.writeFile.execute({ path: "README.md", content: "v1\n" }, { toolCallId: "c1" });

  const { files } = getChanges(workspace, "session-1");
  expect(files).toHaveLength(1);
  expect(files[0].displayPath).toBe("README.md");
});

test("read-only tools are passed through untouched", () => {
  const readFile = { execute: async () => ({ content: "x" }) };
  const wrapped = wrapToolsWithTrace({ readFile }, ctx());
  expect(wrapped.readFile).toBe(readFile);
});
