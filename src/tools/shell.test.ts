// src/tools/shell.test.ts
//
// What a command actually reports back.
//
// The regression this file exists for: runBash used to wrap promisify(exec),
// which rejects on a non-zero exit, and its catch kept only err.message —
// discarding err.code, err.stdout and err.stderr. A failed `npm run build`
// therefore came back as the bare string "Command failed: npm run build" with
// no compiler output at all, leaving the model nothing to act on.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand } from "./run-bash.js";
import { resolveCwd, truncateTail, truncateHead, stripAnsi, findFreePort, isPortBound } from "./shell.js";

const isWin = process.platform === "win32";

test("a successful command reports exit code 0 and its stdout", async () => {
  const res = await execCommand("echo hello-from-zizou");
  expect(res.success).toBe(true);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain("hello-from-zizou");
});

test("a FAILING command reports the real exit code, not just a message", async () => {
  // The whole point. Before, this produced { success: false, error: "Command
  // failed: ..." } and nothing else.
  const res = await execCommand(isWin ? "exit 3" : "exit 3");
  expect(res.success).toBe(false);
  expect(res.exitCode).toBe(3);
});

test("a failing command's stderr survives instead of being swallowed", async () => {
  const cmd = isWin
    ? `[Console]::Error.WriteLine("BOOM-marker"); exit 1`
    : `echo BOOM-marker 1>&2; exit 1`;
  const res = await execCommand(cmd);
  expect(res.success).toBe(false);
  expect(res.stderr).toContain("BOOM-marker");
});

test("cwd runs the command somewhere else without a cd prefix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zizou-cwd-"));
  writeFileSync(join(dir, "marker-file.txt"), "x");

  // Pass the temp dir as the ROOT so resolveCwd's containment check is
  // satisfied — the point under test is that cwd is honoured at all.
  const res = await execCommand(isWin ? "Get-ChildItem -Name" : "ls", {
    cwd: ".",
    root: dir,
  });
  expect(res.stdout).toContain("marker-file.txt");
  expect(res.cwd).toBe(dir);
});

test("a cwd outside the workspace root is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zizou-esc-"));
  const res = await execCommand("echo nope", { cwd: "../..", root: dir });
  expect(res.success).toBe(false);
  expect(res.error).toContain("outside the workspace root");
});

test("a missing cwd is reported as such rather than silently ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zizou-missing-"));
  const res = await execCommand("echo nope", { cwd: "no-such-dir", root: dir });
  expect(res.success).toBe(false);
  expect(res.error).toContain("does not exist");
});

test("a command that overruns its timeout is killed and says so", async () => {
  const cmd = isWin ? "Start-Sleep -Seconds 10" : "sleep 10";
  const res = await execCommand(cmd, { timeoutMs: 600 });
  expect(res.timedOut).toBe(true);
  expect(res.success).toBe(false);
  expect(res.error).toContain("timed out");
});

// ─── Truncation ──────────────────────────────────────────────────────────────

test("stderr truncation keeps the TAIL", () => {
  // Compiler errors and stack traces put the useful line last. The original
  // code head-truncated everything, cutting off exactly the part needed.
  const text = "noise\n".repeat(1000) + "THE ACTUAL ERROR";
  expect(truncateTail(text, 100)).toContain("THE ACTUAL ERROR");
});

test("stdout truncation keeps the HEAD", () => {
  const text = "FIRST LINE\n" + "noise\n".repeat(1000);
  expect(truncateHead(text, 100)).toContain("FIRST LINE");
});

test("short text is returned untouched by either truncator", () => {
  expect(truncateTail("short", 100)).toBe("short");
  expect(truncateHead("short", 100)).toBe("short");
});

test("ANSI colour codes are stripped", () => {
  // Vite and npm emit colour even off a TTY; those bytes are pure context cost.
  expect(stripAnsi("\u001b[32mready in 412 ms\u001b[0m")).toBe("ready in 412 ms");
});

// ─── Ports ───────────────────────────────────────────────────────────────────

test("findFreePort returns a port nothing is listening on", async () => {
  const port = await findFreePort();
  expect(port).toBeGreaterThan(0);
  expect(await isPortBound(port)).toBe(false);
});

test("resolveCwd treats '.' and undefined as the root", () => {
  const root = mkdtempSync(join(tmpdir(), "zizou-root-"));
  expect(resolveCwd(undefined, root)).toBe(root);
  expect(resolveCwd(".", root)).toBe(root);
});
