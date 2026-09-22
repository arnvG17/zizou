// src/agent/verifier.test.ts
//
// What "verified" means.
//
// The verifier had no tests at all, which is how it came to contain a comment
// describing target-not-created as "a soft warning rather than a hard failure"
// sitting directly above the line that made it a hard failure. These tests pin
// the distinction the comment was always claiming:
//
//   hard — evidence the step did not do its job. Fails, and earns a retry.
//   soft — a prediction that did not pan out. A note on a passing step.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePreSnapshot, verifyStep, renderRepairContext } from "./verifier.js";
import { makeFinding } from "./types.js";
import type { PlanStep, StepResult, ToolCall } from "./types.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "zizou-verify-"));
}

function step(over: Partial<PlanStep> = {}): PlanStep {
  return { index: 0, description: "do the thing", targetFiles: [], dependsOn: [], ...over };
}

function result(over: Partial<StepResult> = {}): StepResult {
  return { stepIndex: 0, claimedFiles: [], toolCallsMade: [], ...over };
}

function call(toolName: string, input: unknown, output: unknown): ToolCall {
  return { toolName, toolCallId: `c-${Math.random()}`, input, output };
}

/** verifyStep with no model, so the advisory LLM pass is skipped. */
async function verify(s: PlanStep, r: StepResult, cwd: string) {
  return verifyStep(s, r, cwd, capturePreSnapshot(s, cwd));
}

// ─── The regression that started this ────────────────────────────────────────

test("a target file the plan predicted but the step did not create is SOFT", async () => {
  // This is verbatim the failure from the transcript:
  //   ✗ Step 2 verification failed
  //     ↳ target-not-created: frontend/todo-app/package.json
  // The step had in fact succeeded. The planner named the path before the work
  // ran, so it was a guess, and a guess must not be able to fail a step.
  const cwd = workspace();
  const s = step({ targetFiles: ["frontend/todo-app/package.json"] });

  const v = await verify(s, result(), cwd);

  expect(v.verified).toBe(true);
  expect(v.findings).toHaveLength(1);
  expect(v.findings[0].code).toBe("target-not-created");
  expect(v.findings[0].severity).toBe("soft");
});

test("a step with only soft findings still passes", async () => {
  const cwd = workspace();
  const s = step({ targetFiles: ["a.ts", "b.ts", "c.ts"] });

  const v = await verify(s, result(), cwd);

  expect(v.verified).toBe(true);
  expect(v.findings.every((f) => f.severity === "soft")).toBe(true);
});

// ─── Hard findings: what actually proves failure ─────────────────────────────

test("a non-zero exit code from runBash is HARD and keeps the stderr", async () => {
  // toolCallsMade was fully populated and read by nobody, so every command
  // failure it recorded was thrown away before anything could act on it.
  const cwd = workspace();
  const r = result({
    toolCallsMade: [
      call(
        "runBash",
        { command: "npm run build" },
        { success: false, exitCode: 1, stdout: "", stderr: "error TS2304: Cannot find name 'Foo'." },
      ),
    ],
  });

  const v = await verify(step(), r, cwd);

  expect(v.verified).toBe(false);
  const finding = v.findings.find((f) => f.code === "command-failed");
  expect(finding?.severity).toBe("hard");
  expect(finding?.detail).toContain("npm run build");
  expect(finding?.detail).toContain("TS2304");
});

test("a command that timed out is HARD", async () => {
  const cwd = workspace();
  const r = result({
    toolCallsMade: [call("runBash", { command: "npm test" }, { success: false, exitCode: null, timedOut: true })],
  });

  const v = await verify(step(), r, cwd);
  expect(v.verified).toBe(false);
  expect(v.findings.some((f) => f.code === "command-failed" && f.severity === "hard")).toBe(true);
});

test("a crashed service is HARD and carries its crash reason", async () => {
  const cwd = workspace();
  const r = result({
    toolCallsMade: [
      call(
        "service",
        { name: "web", command: "npm run dev" },
        { success: false, name: "web", status: "crashed", crashReason: "Error: listen EADDRINUSE :::5173" },
      ),
    ],
  });

  const v = await verify(step(), r, cwd);
  expect(v.verified).toBe(false);
  expect(v.findings.find((f) => f.code === "command-failed")?.detail).toContain("EADDRINUSE");
});

test("an unreachable URL is HARD and includes the server's own log", async () => {
  const cwd = workspace();
  const r = result({
    toolCallsMade: [
      call(
        "checkUrl",
        { url: "http://localhost:5173" },
        { ok: false, error: "fetch failed", logTail: "Error: Cannot find module './App'" },
      ),
    ],
  });

  const v = await verify(step(), r, cwd);
  expect(v.verified).toBe(false);
  const finding = v.findings.find((f) => f.code === "url-unreachable");
  expect(finding?.severity).toBe("hard");
  // "It did not answer" plus the stack trace, in one finding.
  expect(finding?.detail).toContain("Cannot find module");
});

test("a failed writeFile is a TOOL error carrying the cause, not a bare missing file", async () => {
  // claimedFiles is populated on tool-call INTENT, so a write that failed
  // still counted as a claim and surfaced as "claimed-changed-but-missing" —
  // the symptom, with the actual error stripped off.
  const cwd = workspace();
  const r = result({
    claimedFiles: ["src/App.tsx"],
    toolCallsMade: [
      call("writeFile", { path: "src/App.tsx" }, { success: false, error: "EACCES: permission denied" }),
    ],
  });

  const v = await verify(step(), r, cwd);

  expect(v.verified).toBe(false);
  const toolError = v.findings.find((f) => f.code === "tool-error");
  expect(toolError?.severity).toBe("hard");
  expect(toolError?.detail).toContain("EACCES");
});

test("a file the executor claims to have written but which does not exist is HARD", async () => {
  const cwd = workspace();
  const r = result({ claimedFiles: ["src/Missing.tsx"] });

  const v = await verify(step(), r, cwd);

  expect(v.verified).toBe(false);
  expect(v.findings.some((f) => f.code === "claimed-changed-but-missing" && f.severity === "hard")).toBe(true);
});

test("invalid JSON in a written file is HARD", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "package.json"), "{ not json ", "utf-8");
  const r = result({ claimedFiles: ["package.json"] });

  const v = await verify(step(), r, cwd);
  expect(v.verified).toBe(false);
  expect(v.findings.some((f) => f.code === "syntax-error" && f.severity === "hard")).toBe(true);
});

test("a clean step produces no findings at all", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "ok.ts"), "export const a = 1;\n", "utf-8");
  const r = result({
    claimedFiles: ["ok.ts"],
    toolCallsMade: [call("runBash", { command: "npm run build" }, { success: true, exitCode: 0, stdout: "done" })],
  });

  const v = await verify(step(), r, cwd);

  expect(v.verified).toBe(true);
  expect(v.findings).toHaveLength(0);
});

// ─── Declared checks ─────────────────────────────────────────────────────────

test("a declared command check runs and fails the step on a non-zero exit", async () => {
  const cwd = workspace();
  const s = step({ check: { kind: "command", command: "exit 5" } });

  const v = await verify(s, result(), cwd);

  expect(v.verified).toBe(false);
  expect(v.findings.some((f) => f.code === "command-failed")).toBe(true);
});

test("a declared command check passes on exit 0", async () => {
  const cwd = workspace();
  const s = step({ check: { kind: "command", command: "echo fine" } });

  const v = await verify(s, result(), cwd);
  expect(v.verified).toBe(true);
});

test("a declared command already run by the executor is not run twice", async () => {
  // Re-running `npm run build` because the plan mentioned it would double the
  // cost of every build step.
  const cwd = workspace();
  const s = step({ check: { kind: "command", command: "npm run build" } });
  const r = result({
    toolCallsMade: [call("runBash", { command: "npm run build" }, { success: true, exitCode: 0 })],
  });

  const v = await verify(s, r, cwd);
  expect(v.verified).toBe(true);
});

test("a declared files check is HARD, unlike a guessed targetFile", async () => {
  // The difference is intent: targetFiles is a prediction, check.files is an
  // assertion the planner chose to make.
  const cwd = workspace();
  const s = step({ check: { kind: "files", files: ["must-exist.ts"] } });

  const v = await verify(s, result(), cwd);

  expect(v.verified).toBe(false);
  expect(v.findings.some((f) => f.code === "claimed-changed-but-missing")).toBe(true);
});

// ─── Settlement ──────────────────────────────────────────────────────────────

test("verification waits for a file that background work creates a moment later", async () => {
  // The race itself: a step spawned background work and the disk was read
  // before that work had produced anything.
  const cwd = workspace();
  mkdirSync(join(cwd, "app"), { recursive: true });

  const s = step({ targetFiles: ["app/package.json"] });
  const r = result({
    toolCallsMade: [call("runBackground", { command: "npm init -y" }, { success: true, taskId: "bg_1" })],
  });

  // Appears after verification has already begun.
  setTimeout(() => writeFileSync(join(cwd, "app", "package.json"), "{}", "utf-8"), 700);

  const v = await verify(s, r, cwd);

  // It waited, found the file, and did not report it as missing.
  expect(v.findings.some((f) => f.code === "target-not-created")).toBe(false);
  expect(v.verified).toBe(true);
});

test("a step with no background work is not delayed by settlement", async () => {
  const cwd = workspace();
  const s = step({ targetFiles: ["never-appears.ts"] });

  const began = Date.now();
  await verify(s, result(), cwd);

  // No background tool was called, so there is nothing to wait for.
  expect(Date.now() - began).toBeLessThan(1000);
});

// ─── Repair context ──────────────────────────────────────────────────────────

test("the repair context states the actual error, not that verification failed", async () => {
  // Telling a model "verification failed" gives it nothing to act on and
  // invites a cosmetic retry of the same broken action.
  const text = renderRepairContext([
    makeFinding("command-failed", undefined, "`npm run build` exited 1\nerror TS2304: Cannot find name 'Foo'."),
    makeFinding("target-not-created", "guessed/path.ts"),
  ]);

  expect(text).toContain("TS2304");
  expect(text).toContain("npm run build");
  // The soft finding is not a reason to retry, so it stays out of the brief.
  expect(text).not.toContain("guessed/path.ts");
});

test("the repair context is empty when nothing hard failed", () => {
  expect(renderRepairContext([makeFinding("target-not-created", "a.ts")])).toBe("");
});

test("mismatches stays populated as one-line renderings, for old persisted logs", async () => {
  const cwd = workspace();
  const s = step({ targetFiles: ["nope.ts"] });

  const v = await verify(s, result(), cwd);

  expect(v.mismatches).toHaveLength(v.findings.length);
  expect(v.mismatches[0]).toContain("target-not-created");
  expect(v.mismatches[0]).toContain("nope.ts");
});

// ─── Derived verification ────────────────────────────────────────────────────
//
// The hole these cover: only a PLAN step carries a `check`. Build mode
// synthesises its step from the raw user prompt with none, so runDeclaredCheck
// did nothing on the route that runs most often — a TypeScript change could
// touch three files, finish green, and never be compiled.

/** A workspace that looks like a real project, so a check can be derived. */
function project(scripts: Record<string, string>): string {
  const cwd = workspace();
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts }), "utf-8");
  // deriveVerification refuses to run anything before an install, because the
  // command could not succeed and the failure would be about the install.
  mkdirSync(join(cwd, "node_modules"), { recursive: true });
  return cwd;
}

test("a code change with no declared check is verified against the project's own script", async () => {
  const cwd = project({ typecheck: "exit 1" });
  writeFileSync(join(cwd, "app.ts"), "const a = 1;\n", "utf-8");
  const s = step();

  const v = await verify(s, result({ claimedFiles: ["app.ts"] }), cwd);

  // Hard, so it flows into the existing repair loop as any other failed
  // command would. A green tick on an uncompiled change is the thing this
  // exists to prevent.
  expect(v.verified).toBe(false);
  const failure = v.findings.find((f) => f.code === "command-failed");
  expect(failure?.severity).toBe("hard");
  // The message has to say the check was the harness's idea, or the model
  // will hunt for where the step asked for it.
  expect(failure?.detail).toContain("run automatically");
});

test("a passing derived check leaves the step verified", async () => {
  const cwd = project({ typecheck: "exit 0" });
  writeFileSync(join(cwd, "app.ts"), "const a = 1;\n", "utf-8");

  const v = await verify(step(), result({ claimedFiles: ["app.ts"] }), cwd);

  expect(v.verified).toBe(true);
});

test("a documentation change derives no check", async () => {
  // Running a project's test suite because a README changed is a tax, and a
  // tax gets switched off — taking the useful case with it.
  const cwd = project({ typecheck: "exit 1" });
  writeFileSync(join(cwd, "README.md"), "# hi\n", "utf-8");

  const v = await verify(step(), result({ claimedFiles: ["README.md"] }), cwd);

  expect(v.verified).toBe(true);
});

test("a check the step already ran is not run a second time", async () => {
  const cwd = project({ typecheck: "exit 1" });
  writeFileSync(join(cwd, "app.ts"), "const a = 1;\n", "utf-8");

  // The executor ran it and it PASSED as far as this step is concerned; the
  // verifier must take that at face value rather than doubling the cost of
  // every build step to ask again.
  const r = result({
    claimedFiles: ["app.ts"],
    toolCallsMade: [call("runBash", { command: "bun run typecheck" }, { success: true, exitCode: 0 })],
  });

  const v = await verify(step(), r, cwd);

  expect(v.findings.filter((f) => f.code === "command-failed")).toHaveLength(0);
});

test("a step with its own command check is not second-guessed", async () => {
  // A declared check is the step's own statement of what success means.
  // Deriving another on top of it would be the harness overruling the plan
  // the user approved.
  const cwd = project({ typecheck: "exit 1" });
  writeFileSync(join(cwd, "app.ts"), "const a = 1;\n", "utf-8");
  const s = step({ check: { kind: "command", command: "exit 0" } });

  const v = await verify(s, result({ claimedFiles: ["app.ts"] }), cwd);

  expect(v.verified).toBe(true);
});

test("autoVerify: false disables only the derived check", async () => {
  const cwd = project({ typecheck: "exit 1" });
  writeFileSync(join(cwd, "app.ts"), "const a = 1;\n", "utf-8");
  const s = step();

  const v = await verifyStep(s, result({ claimedFiles: ["app.ts"] }), cwd, capturePreSnapshot(s, cwd), undefined, false);

  expect(v.verified).toBe(true);
  expect(v.findings.filter((f) => f.code === "command-failed")).toHaveLength(0);
});

test("a step that changed nothing runs no derived check", async () => {
  const cwd = project({ typecheck: "exit 1" });
  const v = await verify(step(), result(), cwd);
  expect(v.verified).toBe(true);
});

// ─── Harness refusals ────────────────────────────────────────────────────────

test("a precondition refusal the step recovered from does not fail it", async () => {
  // The task-state layer declines an edit to a file that was never read. The
  // expected next move is that the model reads it and edits again — which it
  // usually does, inside the same step.
  //
  // Counting the refusal as a failed tool call would fail verification on a
  // step that recovered perfectly well, and burn a whole repair attempt
  // rediscovering that nothing was wrong.
  const cwd = workspace();
  writeFileSync(join(cwd, "app.ts"), "const a = 2;\n", "utf-8");

  const r = result({
    claimedFiles: ["app.ts"],
    toolCallsMade: [
      call("editFile", { path: "app.ts" }, {
        success: false,
        harnessRefusal: true,
        code: "FILE_NOT_OBSERVED",
        error: "You have not read app.ts during this task",
      }),
      call("readFile", { path: "app.ts" }, { success: true, contents: "const a = 1;\n" }),
      call("editFile", { path: "app.ts" }, { success: true, message: "Successfully replaced 1 occurrence" }),
    ],
  });

  const v = await verify(step(), r, cwd);

  expect(v.verified).toBe(true);
  expect(v.findings.filter((f) => f.code === "tool-error")).toHaveLength(0);
});

test("a genuine tool failure is still hard", async () => {
  // The exclusion above must key off the refusal marker specifically, not on
  // editFile failures in general — a write that actually broke still has to
  // fail the step.
  const cwd = workspace();

  const r = result({
    claimedFiles: ["app.ts"],
    toolCallsMade: [call("editFile", { path: "app.ts" }, { success: false, error: "EACCES: permission denied" })],
  });

  const v = await verify(step(), r, cwd);

  expect(v.verified).toBe(false);
  expect(v.findings.find((f) => f.code === "tool-error")?.severity).toBe("hard");
});
