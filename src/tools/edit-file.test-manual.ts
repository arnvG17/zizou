import { writeFileSync, unlinkSync } from "node:fs";
import { editFile } from "./edit-file.js";

const TEST_FILE = "edit-test.txt";

async function runTests() {
  console.log("=== Manual Test for editFile ===");

  // Setup: create a test file
  const initialContent = "line 1\nline 2\nline 2\nline 3\n";
  writeFileSync(TEST_FILE, initialContent, "utf-8");

  // Test 1: Zero occurrences
  console.log("\n--- Test 1: Zero occurrences ---");
  let result = await editFile.execute({
    path: TEST_FILE,
    old_string: "line 4",
    new_string: "line 5",
  }, {} as any);
  console.log(result);

  // Test 2: Multiple occurrences
  console.log("\n--- Test 2: Multiple occurrences ---");
  result = await editFile.execute({
    path: TEST_FILE,
    old_string: "line 2",
    new_string: "line 2 changed",
  }, {} as any);
  console.log(result);

  // Test 3: Exactly one occurrence
  console.log("\n--- Test 3: Exactly one occurrence ---");
  result = await editFile.execute({
    path: TEST_FILE,
    old_string: "line 3",
    new_string: "line 3 changed",
  }, {} as any);
  console.log(result);

  // Cleanup
  try {
    unlinkSync(TEST_FILE);
  } catch (e) {
    // ignore cleanup errors
  }
}

runTests().catch(console.error);
