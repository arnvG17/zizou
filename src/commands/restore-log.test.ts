// src/commands/restore-log.test.ts
//
// Restoring a chat log written by an older version of Zizou.
//
// THE BUG THIS LOCKS DOWN: the persisted log was JSON.parse'd and cast to
// LogEntry[] with no validation. LogEntry has gained fields over time, so a
// session saved before a field existed restored an entry without it, the
// renderer read `.length` off undefined, and the crash unmounted the entire
// TUI — leaving that session permanently unopenable.
//
// The shapes below are taken from real session files on disk (schemaVersion
// undefined and 2), not invented.

import { test, expect } from "bun:test";
import { parseRestoredLog } from "./index.js";

test("a plan-display saved before assumptions existed is repaired, not dropped", () => {
  // The exact crash: seven sessions on disk had plan-display entries with
  // steps but no `assumptions` key at all.
  const log = JSON.stringify([
    { kind: "plan-display", steps: [{ index: 0, description: "do a thing", targetFiles: [], dependsOn: [] }] },
  ]);

  const [entry] = parseRestoredLog(log) as any[];

  expect(entry.kind).toBe("plan-display");
  expect(entry.assumptions).toEqual([]);
  // The steps it DID have must survive — repairing the entry must not cost
  // the user the plan they were looking at.
  expect(entry.steps).toHaveLength(1);
});

test("a plan-display missing steps is still renderable", () => {
  const [entry] = parseRestoredLog(JSON.stringify([{ kind: "plan-display" }])) as any[];
  expect(entry.steps).toEqual([]);
  expect(entry.assumptions).toEqual([]);
});

test("newer plan-display fields are preserved", () => {
  // routeReason and projectRoot postdate the original entry. A repair pass
  // that dropped unknown-to-it fields would silently erase them.
  const log = JSON.stringify([
    {
      kind: "plan-display",
      steps: [],
      assumptions: ["React"],
      routeReason: "Auto → plan: multi-file work",
      projectRoot: "C:/tmp/x",
    },
  ]);

  const [entry] = parseRestoredLog(log) as any[];

  expect(entry.routeReason).toBe("Auto → plan: multi-file work");
  expect(entry.projectRoot).toBe("C:/tmp/x");
  expect(entry.assumptions).toEqual(["React"]);
});

test("an unparseable log returns [] rather than throwing", () => {
  // Two sessions on disk have logs that do not parse at all.
  expect(parseRestoredLog("{not json")).toEqual([]);
  expect(parseRestoredLog("")).toEqual([]);
  expect(parseRestoredLog(undefined)).toEqual([]);
  expect(parseRestoredLog(null)).toEqual([]);
});

test("a log that parses to a non-array returns []", () => {
  expect(parseRestoredLog('{"kind":"user"}')).toEqual([]);
  expect(parseRestoredLog("42")).toEqual([]);
  expect(parseRestoredLog("null")).toEqual([]);
});

test("junk entries are dropped without taking the good ones with them", () => {
  // One bad line must cost one line. That is the whole point.
  const log = JSON.stringify([
    { kind: "user", text: "hello" },
    null,
    "a bare string",
    { kind: "kind-from-the-future", payload: 1 },
    { kind: "assistant", text: "hi" },
  ]);

  const restored = parseRestoredLog(log);

  expect(restored).toHaveLength(2);
  expect(restored.map((e: any) => e.text)).toEqual(["hello", "hi"]);
});

test("mode-switch with a mode this version does not know falls back", () => {
  // `mode` indexes a badge table at render time, so an unknown value would be
  // a second undefined-property crash in the same renderer.
  const [entry] = parseRestoredLog(
    JSON.stringify([{ kind: "mode-switch", mode: "clarify", reason: "old mode" }]),
  ) as any[];

  expect(entry.mode).toBe("build");
  expect(entry.reason).toBe("old mode");
});

test("a known mode-switch is left alone", () => {
  for (const mode of ["auto", "chat", "ask", "build", "plan"]) {
    const [entry] = parseRestoredLog(
      JSON.stringify([{ kind: "mode-switch", mode, reason: "r" }]),
    ) as any[];
    expect(entry.mode).toBe(mode);
  }
});

test("verification and step-progress survive missing numeric fields", () => {
  const restored = parseRestoredLog(
    JSON.stringify([
      { kind: "verification" },
      { kind: "step-progress" },
    ]),
  ) as any[];

  expect(restored[0].mismatches).toEqual([]);
  expect(restored[0].verified).toBe(false);
  expect(restored[1].stepIndex).toBe(0);
  expect(restored[1].totalSteps).toBe(1);
});

test("a tool-call with a missing status renders as finished, not as running", () => {
  // A restored tool call cannot still be in flight — the process that owned
  // it is gone. Defaulting to "running" would spin a spinner forever.
  const [entry] = parseRestoredLog(
    JSON.stringify([{ kind: "tool-call", toolCallId: "1", name: "readFile", input: {} }]),
  ) as any[];

  expect(entry.status).toBe("success");
  expect(entry.startTime).toBe(0);
});

test("an ordinary current-version log round-trips unchanged", () => {
  const entries = [
    { kind: "user", text: "build me a thing" },
    { kind: "assistant", text: "done", thoughtDuration: "2s" },
    { kind: "scope-hint", text: "touched 5 files" },
    { kind: "error", text: "boom" },
  ];

  const restored = parseRestoredLog(JSON.stringify(entries));

  expect(restored).toHaveLength(4);
  expect(restored).toEqual(entries as any);
});
