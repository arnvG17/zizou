// src/agent/debug/run-journal.test.ts
//
// These tests exercise the part of the journal that is easy to get quietly
// wrong: the tool wrapper. A logger that writes plausible-looking lines while
// recording the wrong thing is worse than no logger, because it is trusted.
//
// So the assertions here are about GROUND TRUTH: when a tool claims to write a
// file but does not, the journal must record no change.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunJournal } from "./run-journal.js";
import { buildFileDiff } from "./file-diff.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "zizou-journal-test-"));
}

/** Reads the journal's JSONL back as parsed events. */
function events(journal: RunJournal): Array<Record<string, any>> {
  return readFileSync(journal.jsonlPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("buildFileDiff", () => {
  test("reports a created file with an accurate added-line count", () => {
    const d = buildFileDiff("a.txt", "/abs/a.txt", null, "one\ntwo\nthree");
    expect(d.kind).toBe("created");
    expect(d.added).toBe(3);
    expect(d.removed).toBe(0);
  });

  test("reports a deletion", () => {
    const d = buildFileDiff("a.txt", "/abs/a.txt", "one\ntwo", null);
    expect(d.kind).toBe("deleted");
    expect(d.removed).toBe(2);
  });

  test("counts only changed lines for a modification, not context", () => {
    const before = "line1\nline2\nline3\nline4\nline5";
    const after = "line1\nline2\nCHANGED\nline4\nline5";
    const d = buildFileDiff("a.txt", "/abs/a.txt", before, after);
    expect(d.kind).toBe("modified");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    // The patch carries surrounding context, but the counts must not include it.
    expect(d.patch).toContain("+CHANGED");
    expect(d.patch).toContain("-line3");
  });

  test("identical content is unchanged, not an empty modification", () => {
    const d = buildFileDiff("a.txt", "/abs/a.txt", "same", "same");
    expect(d.kind).toBe("unchanged");
    expect(d.patch).toBe("");
  });

  test("binary content is summarized, never diffed line by line", () => {
    const bin = `PNG${String.fromCharCode(0)}payload`;
    const d = buildFileDiff("i.png", "/abs/i.png", null, bin);
    expect(d.kind).toBe("created");
    expect(d.patch).toBe("");
    expect(d.note).toContain("binary");
  });
});

describe("RunJournal.wrapTools", () => {
  test("records the real diff a writing tool produced", async () => {
    const root = scratch();
    const journal = new RunJournal({ dir: join(root, "j"), runId: "r", root });

    const tools = journal.wrapTools<Record<string, any>>({
      writeFile: {
        execute: async ({ path, contents }: any) => {
          writeFileSync(join(root, path), contents, "utf-8");
          return { success: true };
        },
      },
    });

    await tools.writeFile.execute({ path: "out.txt", contents: "hello\nworld" }, { toolCallId: "c1" });

    const toolEvents = events(journal).filter((e) => e.kind === "tool-call");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].ok).toBe(true);
    expect(toolEvents[0].fileChanges).toHaveLength(1);
    expect(toolEvents[0].fileChanges[0].kind).toBe("created");
    expect(toolEvents[0].fileChanges[0].added).toBe(2);
    expect(toolEvents[0].fileChanges[0].path).toBe("out.txt");

    rmSync(root, { recursive: true, force: true });
  });

  test("a tool that claims success without writing records NO file change", async () => {
    // The whole reason the journal snapshots the filesystem instead of trusting
    // the tool's arguments. This is the case the old logging got wrong: it would
    // print the 2-line `contents` argument as though it had landed.
    const root = scratch();
    const journal = new RunJournal({ dir: join(root, "j"), runId: "r", root });

    const tools = journal.wrapTools<Record<string, any>>({
      writeFile: {
        execute: async () => ({ success: true, message: "wrote the file" }),
      },
    });

    await tools.writeFile.execute({ path: "ghost.txt", contents: "never written" }, { toolCallId: "c1" });

    const toolEvents = events(journal).filter((e) => e.kind === "tool-call");
    expect(toolEvents[0].fileChanges).toHaveLength(0);

    const humanLog = readFileSync(journal.logPath, "utf-8");
    expect(humanLog).toContain("no filesystem change observed");

    rmSync(root, { recursive: true, force: true });
  });

  test("marks a tool that returned an error as failed", async () => {
    const root = scratch();
    const journal = new RunJournal({ dir: join(root, "j"), runId: "r", root });

    const tools = journal.wrapTools<Record<string, any>>({
      editFile: { execute: async () => ({ success: false, error: "no match" }) },
    });

    await tools.editFile.execute({ path: "x.ts" }, { toolCallId: "c1" });

    const rec = events(journal).find((e) => e.kind === "tool-call")!;
    expect(rec.ok).toBe(false);
    expect(journal.snapshot().toolFailures).toBe(1);

    rmSync(root, { recursive: true, force: true });
  });

  test("a throwing tool is recorded and the throw still propagates", async () => {
    const root = scratch();
    const journal = new RunJournal({ dir: join(root, "j"), runId: "r", root });

    const tools = journal.wrapTools<Record<string, any>>({
      writeFile: {
        execute: async () => {
          throw new Error("disk on fire");
        },
      },
    });

    await expect(
      tools.writeFile.execute({ path: "x.txt", contents: "" }, { toolCallId: "c1" }),
    ).rejects.toThrow("disk on fire");

    const rec = events(journal).find((e) => e.kind === "tool-call")!;
    expect(rec.ok).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test("attributes a bash-driven change to the runBash call", async () => {
    const root = scratch();
    const journal = new RunJournal({ dir: join(root, "j"), runId: "r", root });

    const tools = journal.wrapTools<Record<string, any>>({
      writeFile: {
        execute: async ({ path, contents }: any) => {
          writeFileSync(join(root, path), contents, "utf-8");
          return { success: true };
        },
      },
      runBash: {
        execute: async () => {
          // Stands in for a command that edits a file the args never named.
          writeFileSync(join(root, "seen.txt"), "modified by bash", "utf-8");
          return { success: true, stdout: "" };
        },
      },
    });

    // runBash can only be credited for paths the journal already knows about,
    // so the file has to have been seen once first. That limit is real and the
    // log states it rather than implying full coverage.
    await tools.writeFile.execute({ path: "seen.txt", contents: "original" }, { toolCallId: "c1" });
    await tools.runBash.execute({ command: "echo" }, { toolCallId: "c2" });

    const bashEvent = events(journal).filter((e) => e.kind === "tool-call")[1];
    expect(bashEvent.toolName).toBe("runBash");
    expect(bashEvent.fileChanges).toHaveLength(1);
    expect(bashEvent.fileChanges[0].kind).toBe("modified");
    expect(bashEvent.coverageNote).toContain("cannot enumerate");

    rmSync(root, { recursive: true, force: true });
  });

  test("read-only tools pass through untouched and get no diff", async () => {
    const root = scratch();
    const journal = new RunJournal({ dir: join(root, "j"), runId: "r", root });

    const tools = journal.wrapTools<Record<string, any>>({
      grep: { execute: async () => ({ success: true, matches: ["a"] }) },
    });

    const out = await tools.grep.execute({ pattern: "a" }, { toolCallId: "c1" });
    expect(out).toEqual({ success: true, matches: ["a"] });

    const rec = events(journal).find((e) => e.kind === "tool-call")!;
    expect(rec.fileChanges).toHaveLength(0);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("RunJournal totals", () => {
  test("runEnd reports line counts and touched files from observed diffs", async () => {
    const root = scratch();
    const journal = new RunJournal({ dir: join(root, "j"), runId: "r", root });

    const tools = journal.wrapTools<Record<string, any>>({
      writeFile: {
        execute: async ({ path, contents }: any) => {
          writeFileSync(join(root, path), contents, "utf-8");
          return { success: true };
        },
      },
    });

    await tools.writeFile.execute({ path: "a.txt", contents: "1\n2\n3" }, { toolCallId: "c1" });
    await tools.writeFile.execute({ path: "b.txt", contents: "1" }, { toolCallId: "c2" });

    const totals = journal.runEnd(true);
    expect(totals.filesCreated).toBe(2);
    expect(totals.linesAdded).toBe(4);
    expect(totals.filesTouched).toEqual(["a.txt", "b.txt"]);
    expect(totals.toolCalls).toBe(2);

    rmSync(root, { recursive: true, force: true });
  });

  test("a disabled journal writes nothing and still returns working tools", async () => {
    const journal = new RunJournal({ dir: join(scratch(), "j"), runId: "r", enabled: false });
    const tools = journal.wrapTools<Record<string, any>>({
      writeFile: { execute: async () => ({ success: true }) },
    });
    expect(await tools.writeFile.execute({}, {})).toEqual({ success: true });
    expect(journal.snapshot().toolCalls).toBe(0);
  });
});
