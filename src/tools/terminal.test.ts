// src/tools/terminal.test.ts
//
// The claim a terminal makes that no previous tool could: STATE PERSISTS.
//
// Before this existed, every command was a fresh detached child process, so a
// `cd`, an exported variable, an activated venv — all of it vanished the
// moment that spawn exited. The first two tests here are the whole reason the
// abstraction exists; if they pass, a terminal is really a session.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAllTerminals,
  createTerminal,
  getTerminal,
  listTerminals,
  sendCommand,
} from "./terminal-registry.js";

const isWin = process.platform === "win32";

/** Prints the current directory in a way both shells understand. */
const PWD = isWin ? "(Get-Location).Path" : "pwd";
/** Sets a shell variable, then reads it back in a LATER command. */
const SET_VAR = isWin ? "$env:ZIZOU_MARK = 'persisted'" : "export ZIZOU_MARK=persisted";
const READ_VAR = isWin ? "Write-Output $env:ZIZOU_MARK" : "echo $ZIZOU_MARK";

afterAll(() => closeAllTerminals());

test("an environment variable set in one command survives into the next", async () => {
  // THE point of a persistent shell. runBash cannot do this at all.
  const name = `t-env-${Date.now()}`;
  createTerminal({ name, cwd: ".", root: process.cwd() });

  await sendCommand(name, SET_VAR, 20_000);
  const read = await sendCommand(name, READ_VAR, 20_000);

  expect(read.output).toContain("persisted");
  expect(read.exitCode).toBe(0);
});

test("a cd in one command changes where the next command runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "zizou-term-"));
  mkdirSync(join(root, "nested"));

  const name = `t-cd-${Date.now()}`;
  createTerminal({ name, cwd: ".", root });

  await sendCommand(name, "cd nested", 20_000);
  const where = await sendCommand(name, PWD, 20_000);

  expect(where.output.toLowerCase()).toContain("nested");
});

test("the sentinel recovers a NON-ZERO exit code from inside a live shell", async () => {
  // A never-exiting shell has no natural per-command exit status; this is what
  // the appended marker is for. Without it a failing command in a terminal
  // would be indistinguishable from a succeeding one.
  const name = `t-exit-${Date.now()}`;
  createTerminal({ name, cwd: ".", root: process.cwd() });

  const res = await sendCommand(name, "exit 7", 20_000);
  expect(res.exitCode).toBe(7);
});

test("a succeeding command reports exit code 0", async () => {
  const name = `t-ok-${Date.now()}`;
  createTerminal({ name, cwd: ".", root: process.cwd() });

  const res = await sendCommand(name, "echo fine", 20_000);
  expect(res.exitCode).toBe(0);
  expect(res.output).toContain("fine");
});

test("output that LOOKS like a sentinel does not end someone else's read", async () => {
  // The marker id is random per send and unknown to the shell before the
  // command runs, so a command printing sentinel-shaped text cannot terminate
  // the read early and strand the real exit code.
  const name = `t-spoof-${Date.now()}`;
  createTerminal({ name, cwd: ".", root: process.cwd() });

  const res = await sendCommand(name, "echo __ZIZOU_END_deadbeef__:0", 20_000);
  expect(res.exitCode).toBe(0);
  expect(res.stillRunning).toBe(false);
  expect(res.output).toContain("__ZIZOU_END_deadbeef__");
});

test("a command that outruns its timeout is reported, NOT killed", async () => {
  // Deliberate: plenty of legitimate commands take longer than the caller
  // guessed, and killing an install halfway is worse than waiting.
  const name = `t-slow-${Date.now()}`;
  createTerminal({ name, cwd: ".", root: process.cwd() });

  const res = await sendCommand(name, isWin ? "Start-Sleep -Seconds 10" : "sleep 10", 700);
  expect(res.stillRunning).toBe(true);
  expect(res.exitCode).toBe(null);
  expect(getTerminal(name)?.status).toBe("busy");
});

test("a busy terminal refuses a second command instead of interleaving it", async () => {
  const name = `t-busy-${Date.now()}`;
  createTerminal({ name, cwd: ".", root: process.cwd() });

  await sendCommand(name, isWin ? "Start-Sleep -Seconds 10" : "sleep 10", 500);
  await expect(sendCommand(name, "echo nope", 1000)).rejects.toThrow(/still running/i);
});

test("two terminals keep separate state", async () => {
  const a = `t-a-${Date.now()}`;
  const b = `t-b-${Date.now()}`;
  createTerminal({ name: a, cwd: ".", root: process.cwd() });
  createTerminal({ name: b, cwd: ".", root: process.cwd() });

  await sendCommand(a, SET_VAR, 20_000);
  const fromB = await sendCommand(b, READ_VAR, 20_000);

  // B never set it, so B must not see it.
  expect(fromB.output).not.toContain("persisted");
});

test("reusing a live terminal's name is refused rather than silently reattaching", async () => {
  // Handing back a shell sitting in an unexpected directory with unexpected
  // env is worse than an error.
  const name = `t-dup-${Date.now()}`;
  createTerminal({ name, cwd: ".", root: process.cwd() });
  expect(() => createTerminal({ name, cwd: ".", root: process.cwd() })).toThrow(/already open/i);
});

test("listTerminals reports the open sessions and their directories", async () => {
  const name = `t-list-${Date.now()}`;
  createTerminal({ name, cwd: ".", root: process.cwd() });
  const found = listTerminals().find((t) => t.name === name);
  expect(found).toBeDefined();
  expect(found!.cwd).toBe(process.cwd());
});
