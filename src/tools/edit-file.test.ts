import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createEditFileTool, editFailureTracker } from "./edit-file.js";

const TEST_FILE = resolve(process.cwd(), "temp-edit-file-test.jsx");
const autoApproveConfirm = async () => true;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

export async function runEditFileUniquenessTests() {
  console.log("Running editFile AMBIGUOUS_MATCH uniqueness tests...");
  editFailureTracker.clear();

  try {
    // ── Test 1: Ambiguous match without near_line ───────────────────
    const initialContent1 = [
      "<header>",
      '  <div className="flex items-center">Header Content</div>',
      "</header>",
      "<main>",
      '  <div className="flex items-center">Main Content</div>',
      "</main>",
      "<footer>",
      '  <div className="flex items-center">Footer Content</div>',
      "</footer>",
    ].join("\n");

    writeFileSync(TEST_FILE, initialContent1, "utf-8");

    const editTool = createEditFileTool(autoApproveConfirm);
    let res1: any = await editTool.execute(
      {
        path: TEST_FILE,
        old_string: '<div className="flex items-center">',
        new_string: '<div className="flex items-center updated">',
      },
      {} as any
    );

    assert(res1.success === false, "Test 1: should fail due to ambiguity");
    assert(typeof res1.error === "string" && res1.error.includes("AMBIGUOUS_MATCH"), "Test 1: should contain AMBIGUOUS_MATCH");
    assert(typeof res1.error === "string" && res1.error.includes("matches 3 locations"), "Test 1: should report 3 locations");

    const currentContent1 = readFileSync(TEST_FILE, "utf-8");
    assert(currentContent1 === initialContent1, "Test 1: file content should remain unchanged");

    // ── Test 2: Unique match with surrounding context ───────────────
    let res2: any = await editTool.execute(
      {
        path: TEST_FILE,
        old_string: [
          "<main>",
          '  <div className="flex items-center">Main Content</div>',
          "</main>",
        ].join("\n"),
        new_string: [
          "<main>",
          '  <div className="flex items-center updated">Main Content</div>',
          "</main>",
        ].join("\n"),
      },
      {} as any
    );

    assert(res2.success === true, "Test 2: should succeed with surrounding context");
    const updatedContent2 = readFileSync(TEST_FILE, "utf-8");
    assert(updatedContent2.includes('<div className="flex items-center updated">Main Content</div>'), "Test 2: should update main block");

    // ── Test 3: Multiple matches with near_line hint ────────────────
    editFailureTracker.clear();
    const initialContent3 = [
      "<header>",
      '  <div className="flex items-center">Header Content</div>',
      "</header>",
      "<main>",
      '  <div className="flex items-center">Main Content</div>',
      "</main>",
    ].join("\n");
    writeFileSync(TEST_FILE, initialContent3, "utf-8");

    let res3: any = await editTool.execute(
      {
        path: TEST_FILE,
        old_string: '<div className="flex items-center">',
        new_string: '<div className="flex items-center main-only">',
        near_line: 5,
      },
      {} as any
    );

    assert(res3.success === true, "Test 3: should succeed with near_line");
    const updatedContent3 = readFileSync(TEST_FILE, "utf-8");
    assert(updatedContent3.includes('<div className="flex items-center main-only">Main Content</div>'), "Test 3: should update line near 5");

    // ── Test 4: Forced fallback on 2 failures ───────────────────────
    editFailureTracker.clear();
    const initialContent4 = "line 1\nline 2\nline 2\nline 3";
    writeFileSync(TEST_FILE, initialContent4, "utf-8");

    let res4a: any = await editTool.execute(
      {
        path: TEST_FILE,
        old_string: "line 2",
        new_string: "line 2 modified",
      },
      {} as any
    );
    assert(res4a.success === false, "Test 4a: should fail ambiguity");
    assert(res4a.forceFallback === undefined, "Test 4a: no fallback on 1st fail");

    let res4b: any = await editTool.execute(
      {
        path: TEST_FILE,
        old_string: "nonexistent string",
        new_string: "something else",
      },
      {} as any
    );
    assert(res4b.success === false, "Test 4b: should fail 2nd time");
    assert(res4b.forceFallback === "writeFile", "Test 4b: should force writeFile fallback on 2nd fail");

    console.log("All editFile AMBIGUOUS_MATCH tests passed!");
  } finally {
    if (existsSync(TEST_FILE)) {
      unlinkSync(TEST_FILE);
    }
    editFailureTracker.clear();
  }
}

// Run if executed directly
if (import.meta.main) {
  runEditFileUniquenessTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
