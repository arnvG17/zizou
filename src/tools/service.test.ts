// src/tools/service.test.ts
//
// The distinction this module exists to draw: STARTED is not READY, and a
// process that exits on its own has CRASHED.
//
// The old task registry knew only "running" and "exited", which made the two
// cases that matter invisible — a server still booting looked identical to one
// serving traffic (so the next step raced it), and a server that died on a bad
// import looked identical to a healthy one (so nothing noticed).

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetForTests,
  getService,
  listServices,
  restartService,
  serviceLogs,
  startService,
  stopService,
  waitForExit,
} from "./service-registry.js";
import { isPortBound } from "./shell.js";

afterEach(() => _resetForTests());

/** Writes a throwaway node script and returns the dir + command to run it. */
function fixture(body: string): { dir: string; command: string } {
  const dir = mkdtempSync(join(tmpdir(), "zizou-svc-"));
  writeFileSync(join(dir, "fixture.mjs"), body, "utf-8");
  return { dir, command: `node fixture.mjs` };
}

const SERVER = `
import { createServer } from "node:http";
const port = Number(process.env.PORT || 0);
createServer((_, res) => { res.writeHead(200, {"content-type":"text/html"}); res.end("<h1>ok</h1>"); })
  .listen(port, () => console.log("listening, ready in 5 ms"));
`;

test("start does not return until the ready pattern actually matches", async () => {
  const { dir, command } = fixture(`
    setTimeout(() => console.log("ready in 7 ms"), 600);
    setInterval(() => {}, 1000);
  `);

  const began = Date.now();
  const svc = await startService(
    { name: "slow", command, cwd: ".", readyRegex: "ready in \\d+", waitTimeoutMs: 10_000 },
    dir,
  );

  expect(svc.status).toBe("ready");
  // It waited for the signal rather than returning on spawn — the race that
  // made a verification step read the disk before npm had created anything.
  expect(Date.now() - began).toBeGreaterThan(400);
});

test("a process that exits during startup is CRASHED, with the reason kept", async () => {
  const { dir, command } = fixture(`
    console.error("Error: Cannot find module './nope'");
    process.exit(1);
  `);

  const svc = await startService(
    { name: "broken", command, cwd: ".", readyRegex: "never-matches", waitTimeoutMs: 8_000 },
    dir,
  );

  expect(svc.status).toBe("crashed");
  expect(svc.crashReason).toContain("Cannot find module");
});

test("a server that never prints its signal times out as crashed, not ready", async () => {
  const { dir, command } = fixture(`setInterval(() => {}, 1000);`);

  const svc = await startService(
    { name: "silent", command, cwd: ".", readyRegex: "will-not-appear", waitTimeoutMs: 1200 },
    dir,
  );

  expect(svc.status).toBe("crashed");
  expect(svc.crashReason).toContain("did not become ready");
});

test("autoPort allocates a free port, passes it as $PORT, and waits for it", async () => {
  const { dir, command } = fixture(SERVER);

  const svc = await startService(
    { name: "web", command, cwd: ".", autoPort: true, waitTimeoutMs: 10_000 },
    dir,
  );

  expect(svc.status).toBe("ready");
  expect(svc.port).toBeGreaterThan(0);
  expect(svc.url).toBe(`http://localhost:${svc.port}`);
  expect(await isPortBound(svc.port!)).toBe(true);
});

test("exit:true waits for a finishing command and reports its exit code", async () => {
  // The npm-install / scaffolder shape: not a server, a command that ends.
  const { dir, command } = fixture(`console.log("done"); process.exit(0);`);

  const svc = await startService({ name: "install", command, cwd: ".", exit: true, waitTimeoutMs: 8_000 }, dir);
  expect(svc.status).toBe("ready");
  expect(svc.exitCode).toBe(0);
});

test("exit:true reports a non-zero finish as crashed", async () => {
  const { dir, command } = fixture(`console.error("npm ERR! boom"); process.exit(2);`);

  const svc = await startService({ name: "bad-install", command, cwd: ".", exit: true, waitTimeoutMs: 8_000 }, dir);
  expect(svc.status).toBe("crashed");
  expect(svc.exitCode).toBe(2);
  expect(svc.crashReason).toContain("npm ERR!");
});

test("logs keep stdout and stderr separable", async () => {
  // They used to be concatenated into one untagged buffer, so "did this print
  // to stderr?" — the usual first question about a failure — was unanswerable.
  const { dir, command } = fixture(`
    console.log("to-stdout");
    console.error("to-stderr");
    console.log("ready now");
    setInterval(() => {}, 1000);
  `);

  await startService({ name: "streams", command, cwd: ".", readyRegex: "ready now", waitTimeoutMs: 8_000 }, dir);

  expect(serviceLogs("streams", { stream: "stderr" }).lines).toContain("to-stderr");
  expect(serviceLogs("streams", { stream: "stderr" }).lines).not.toContain("to-stdout");
  expect(serviceLogs("streams", { stream: "stdout" }).lines).toContain("to-stdout");
});

test("sinceOffset returns only what is new", async () => {
  // Polling used to re-read the same 10k-character window every time and pay
  // for it in context on each call.
  const { dir, command } = fixture(`
    console.log("first");
    console.log("ready now");
    setTimeout(() => console.log("second"), 500);
    setInterval(() => {}, 1000);
  `);

  await startService({ name: "cursor", command, cwd: ".", readyRegex: "ready now", waitTimeoutMs: 8_000 }, dir);

  const first = serviceLogs("cursor", { sinceOffset: 0 });
  expect(first.lines).toContain("first");

  await new Promise((r) => setTimeout(r, 900));

  const next = serviceLogs("cursor", { sinceOffset: first.nextOffset });
  expect(next.lines).toContain("second");
  expect(next.lines).not.toContain("first");
});

test("starting a second service under a live name is refused", async () => {
  const { dir, command } = fixture(SERVER);
  await startService({ name: "dup", command, cwd: ".", autoPort: true, waitTimeoutMs: 10_000 }, dir);

  await expect(
    startService({ name: "dup", command, cwd: ".", autoPort: true, waitTimeoutMs: 10_000 }, dir),
  ).rejects.toThrow(/already ready|already starting/i);
});

test("stop frees the port", async () => {
  const { dir, command } = fixture(SERVER);
  const svc = await startService({ name: "stoppable", command, cwd: ".", autoPort: true, waitTimeoutMs: 10_000 }, dir);
  const port = svc.port!;

  expect(await isPortBound(port)).toBe(true);
  stopService("stoppable");

  // Give the OS a moment to reclaim the socket.
  await new Promise((r) => setTimeout(r, 1200));
  expect(await isPortBound(port)).toBe(false);
});

test("restart reuses the stored spec without being told the command again", async () => {
  const { dir, command } = fixture(SERVER);
  await startService({ name: "restartable", command, cwd: ".", autoPort: true, waitTimeoutMs: 10_000 }, dir);

  const again = await restartService("restartable", dir);
  expect(again.status).toBe("ready");
  expect(again.command).toBe(command);
});

test("waitForExit resolves with the exit code", async () => {
  const { dir, command } = fixture(`setTimeout(() => process.exit(4), 300);`);
  await startService({ name: "waiter", command, cwd: "." }, dir);

  const res = await waitForExit("waiter", 5000);
  expect(res.exitCode).toBe(4);
});

test("two services run concurrently on their own ports", async () => {
  // The frontend-plus-API case, which was not expressible before: no cwd
  // parameter and no naming meant one command string with an embedded cd.
  const { dir, command } = fixture(SERVER);

  const web = await startService({ name: "web2", command, cwd: ".", autoPort: true, waitTimeoutMs: 10_000 }, dir);
  const api = await startService({ name: "api2", command, cwd: ".", autoPort: true, waitTimeoutMs: 10_000 }, dir);

  expect(web.status).toBe("ready");
  expect(api.status).toBe("ready");
  expect(web.port).not.toBe(api.port);
  expect(listServices().filter((s) => s.status === "ready").length).toBe(2);
  expect(getService("api2")?.url).toContain(String(api.port));
});
