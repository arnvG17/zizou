// evals/golden-tasks/build-single-file-fix.ts
//
// GOLDEN TASK: Build-mode single-file creation.
//
// Fast sanity check that build mode can create a single file end-to-end.
// Regresses if tool-call parsing or fallback wiring breaks.

import type { GoldenTask } from "../types.js";
import { fileExists } from "../checks/file-exists.js";
import { grepContains } from "../checks/grep-contains.js";

export const buildSingleFileFix: GoldenTask = {
  id: "build-single-file-fix",
  prompt: "Create a file called hello.txt with the content 'Hello, World!'",
  mode: "build",

  async expectedCheck(workspaceDir: string) {
    const exists = await fileExists(workspaceDir, "hello.txt");
    if (!exists) {
      return { passed: false, detail: "hello.txt was not created" };
    }

    const hasContent = await grepContains(
      workspaceDir,
      "hello.txt",
      /Hello,?\s*World!?/i,
    );
    if (!hasContent) {
      return {
        passed: false,
        detail: "hello.txt exists but doesn't contain 'Hello, World!'",
      };
    }

    return { passed: true, detail: "hello.txt exists with correct content" };
  },
};
