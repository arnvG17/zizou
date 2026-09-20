// src/tools/readonly-map.test.ts
//
// Who gets openFile, and who must not.
//
// openFile launches the OS viewer and cannot modify the filesystem, so it is
// read-only by this map's definition. But "changes nothing" and "appropriate
// here" are different questions, and the split between them is load-bearing:
//
//   - The ask and chat routes need it. Without it, a user who says "open it"
//     gets the file's contents pasted into the terminal instead — the bug
//     this test exists for.
//   - The planner must not have it. Its contract is to describe work rather
//     than begin it, and a planner that opens a browser has begun.

import { test, expect } from "bun:test";
import { buildReadOnlyToolMap, buildToolMap } from "./index.js";

const READ_ONLY_CORE = ["readFile", "glob", "grep", "listDir"];

test("the default read-only map is look-only — this is the planner's map", () => {
  expect(Object.keys(buildReadOnlyToolMap()).sort()).toEqual([...READ_ONLY_CORE].sort());
});

test("the planner's map cannot open, write, edit or run anything", () => {
  const keys = Object.keys(buildReadOnlyToolMap());
  for (const forbidden of ["openFile", "writeFile", "editFile", "runBash", "runBackground", "fileOperations"]) {
    expect(keys).not.toContain(forbidden);
  }
});

test("canOpen adds openFile and nothing else", () => {
  const withOpen = Object.keys(buildReadOnlyToolMap({ canOpen: true }));
  expect(withOpen).toContain("openFile");
  expect(withOpen.sort()).toEqual([...READ_ONLY_CORE, "openFile"].sort());
});

test("canOpen still cannot write, edit or run", () => {
  // The whole claim of the ask route is that it changes nothing on disk.
  // openFile is allowed precisely because it does not.
  const keys = Object.keys(buildReadOnlyToolMap({ canOpen: true }));
  for (const forbidden of ["writeFile", "editFile", "runBash", "runBackground", "fileOperations"]) {
    expect(keys).not.toContain(forbidden);
  }
});

test("the full map is a superset of the read-only one", () => {
  // A tool that exists only in the read-only map would be invisible in build
  // mode — the kind of drift that is silent, because an unknown tool name
  // simply never matches.
  const full = Object.keys(buildToolMap(async () => true));
  for (const name of Object.keys(buildReadOnlyToolMap({ canOpen: true }))) {
    expect(full).toContain(name);
  }
});
