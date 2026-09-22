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
