// src/tools/edit-file-contract.test.ts
//
// What editFile promises about its failures, and about the bytes it writes.
//
// SEPARATE FROM edit-file.test.ts because that file is a hand-rolled script
// with its own assert() and a single exported runner, covering the
// AMBIGUOUS_MATCH/near_line behaviour. Rewriting it to add these would mix an
// unrelated change into a refactor; these are bun:test like every other suite
// in the repo.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditFileTool, editFailureTracker } from "./edit-file.js";

const approve = async () => true;
const deny = async () => false;

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "zizou-edit-contract-"));
  editFailureTracker.clear();
});

afterEach(() => {
  editFailureTracker.clear();
  rmSync(workspace, { recursive: true, force: true });
});

function seed(name: string, contents: string): string {
  const path = join(workspace, name);
  writeFileSync(path, contents, "utf-8");
  return path;
}

async function edit(args: Record<string, unknown>, confirm = approve): Promise<any> {
  return createEditFileTool(confirm).execute(args as any, {} as any);
}

// ─── The $-substitution bug ──────────────────────────────────────────────────

test("a replacement containing $& is written literally", () => {
  // String.prototype.replace treats $&, $`, $' and $1 as substitution
  // patterns IN THE REPLACEMENT. The single-match path used it, so any
  // new_string containing a literal $& — routine in jQuery, shell expansions,
  // regex source and Tailwind arbitrary values — was silently corrupted.
  // The near_line path spliced by offset and was immune, so the same edit
  // behaved differently depending on how many times the target appeared.
  const path = seed("app.js", "const target = OLD;\n");

  return edit({ path, old_string: "OLD", new_string: 'jq("$&").val()' }).then((res) => {
    expect(res.success).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe('const target = jq("$&").val();\n');
  });
});

test("the other substitution patterns are written literally too", async () => {
  const path = seed("app.js", "X\n");
  await edit({ path, old_string: "X", new_string: "a$`b$'c$1d" });
  expect(readFileSync(path, "utf-8")).toBe("a$`b$'c$1d\n");
});

test("the single-match and near_line paths agree", async () => {
  // The bug was that they DID NOT. Pinning the agreement is the point: two
  // code paths for one operation is how they drift apart again.
  const single = seed("single.js", "X\n");
  const multi = seed("multi.js", "X\nX\n");

  await edit({ path: single, old_string: "X", new_string: "$&" });
  await edit({ path: multi, old_string: "X", new_string: "$&", near_line: 1 });

  expect(readFileSync(single, "utf-8")).toBe("$&\n");
  expect(readFileSync(multi, "utf-8")).toBe("$&\nX\n");
});

// ─── Line endings ────────────────────────────────────────────────────────────

test("editing one line of a CRLF file does not rewrite every other line", async () => {
  // Matching needs LF-normalised text, because old_string comes from a model
  // and never carries \r. Writing that normalised text BACK turned a one-line
  // edit into a whole-file diff in /changes and in git — which violates
  // "make the smallest change" at the harness level, not the model's.
  const path = seed("app.ts", "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n");

  const res = await edit({ path, old_string: "const b = 2;", new_string: "const b = 22;" });

  expect(res.success).toBe(true);
  expect(readFileSync(path, "utf-8")).toBe("const a = 1;\r\nconst b = 22;\r\nconst c = 3;\r\n");
});

test("an LF file stays LF", async () => {
  const path = seed("app.ts", "const a = 1;\nconst b = 2;\n");
  await edit({ path, old_string: "const b = 2;", new_string: "const b = 22;" });
  expect(readFileSync(path, "utf-8")).toBe("const a = 1;\nconst b = 22;\n");
});

test("a multi-line insert into a CRLF file uses CRLF for the new lines", async () => {
  const path = seed("app.ts", "start\r\nend\r\n");

  await edit({ path, old_string: "start", new_string: "start\nmiddle" });

  expect(readFileSync(path, "utf-8")).toBe("start\r\nmiddle\r\nend\r\n");
});

// ─── Structured failure codes ────────────────────────────────────────────────

test("a missing old_string reports NOT_FOUND", async () => {
  const path = seed("app.ts", "const a = 1;\n");
  const res = await edit({ path, old_string: "nope", new_string: "x" });

  expect(res.success).toBe(false);
  expect(res.code).toBe("NOT_FOUND");
  // The prose is what the model recovers from and must survive the addition
  // of a machine-readable code beside it.
  expect(res.error).toContain("not found");
});

test("an ambiguous old_string reports AMBIGUOUS_MATCH", async () => {
  const path = seed("app.ts", "dup\ndup\n");
  const res = await edit({ path, old_string: "dup", new_string: "x" });

  expect(res.code).toBe("AMBIGUOUS_MATCH");
  expect(res.error).toContain("near_line");
});

test("a missing file reports FILE_NOT_FOUND rather than a generic write failure", async () => {
  const res = await edit({ path: join(workspace, "nope.ts"), old_string: "a", new_string: "b" });

  expect(res.success).toBe(false);
  expect(res.code).toBe("FILE_NOT_FOUND");
});

test("a denied edit reports PERMISSION_DENIED and does not count as a strike", async () => {
  // A denial says nothing about whether the edit was well-formed. Counting it
  // would push a correct edit into the forced writeFile fallback for a reason
  // the model can neither see nor fix.
  const path = seed("app.ts", "const a = 1;\n");

  const first = await edit({ path, old_string: "const a = 1;", new_string: "x" }, deny);
  expect(first.code).toBe("PERMISSION_DENIED");

  const second = await edit({ path, old_string: "const a = 1;", new_string: "x" }, deny);
  expect(second.code).toBe("PERMISSION_DENIED");
  expect(second.forceFallback).toBeUndefined();
});

test("the second real failure on a file forces the writeFile fallback, and says what caused it", async () => {
  const path = seed("app.ts", "const a = 1;\n");

  await edit({ path, old_string: "nope", new_string: "x" });
  const res = await edit({ path, old_string: "still nope", new_string: "x" });

  expect(res.code).toBe("FORCED_FALLBACK");
  expect(res.forceFallback).toBe("writeFile");
  // Losing the underlying code would make the remedy look like the diagnosis.
  expect(res.cause).toBe("NOT_FOUND");
});

test("a successful edit clears the file's failure count", async () => {
  const path = seed("app.ts", "const a = 1;\n");

  await edit({ path, old_string: "nope", new_string: "x" });
  await edit({ path, old_string: "const a = 1;", new_string: "const a = 2;" });
  // Without the clear, the next unrelated miss would immediately force the
  // fallback on a file the model is editing perfectly well.
  const res = await edit({ path, old_string: "nope", new_string: "x" });

  expect(res.code).toBe("NOT_FOUND");
  expect(res.forceFallback).toBeUndefined();
});
