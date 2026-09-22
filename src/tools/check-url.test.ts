// src/tools/check-url.test.ts
//
// Proving a server SERVES, as opposed to merely being bound.
//
// managePorts can only report that a process holds a port. That is weaker
// than it looks: a dev server that binds and then dies on a bad import still
// shows as bound for a moment, and a stale process from a previous session
// holds the port without serving the current app at all.

import { test, expect, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { checkUrl } from "./check-url.js";
import { findFreePort } from "./shell.js";

const servers: Server[] = [];

/** Starts a throwaway server on an OS-assigned port and returns its URL. */
function serve(handler: (req: any, res: any) => void): Promise<string> {
  return new Promise((res) => {
    const srv = createServer(handler);
    servers.push(srv);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      res(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
    });
  });
}

afterAll(() => servers.forEach((s) => s.close()));

/** The tool's execute() signature takes an options bag we do not use. */
const run = (args: any) => (checkUrl as any).execute(args, {} as any);

test("a serving app reports ok, its status, and the start of its body", async () => {
  const url = await serve((_, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><html><body><div id="root"></div></body></html>');
  });

  const res = await run({ url });
  expect(res.ok).toBe(true);
  expect(res.status).toBe(200);
  expect(res.contentType).toContain("text/html");
  // Seeing the actual markup is what distinguishes "the app" from "a proxy
  // error page that also returns 200".
  expect(res.bodyHead).toContain('id="root"');
});

test("nothing listening is reported as unreachable, not as a pass", async () => {
  // Port 1 is reserved and never served by a dev server.
  const res = await run({ url: "http://127.0.0.1:1", timeoutMs: 1200 });
  expect(res.ok).toBe(false);
  expect(res.status).toBe(null);
  expect(res.error).toContain("Could not reach");
  expect(res.attempts).toBeGreaterThan(0);
});

test("a 500 is a failure even though the server answered", async () => {
  const url = await serve((_, res) => {
    res.writeHead(500);
    res.end("Internal Error");
  });

  const res = await run({ url, timeoutMs: 3000 });
  expect(res.ok).toBe(false);
  expect(res.status).toBe(500);
});

test("a wrong status is returned immediately rather than retried to the timeout", async () => {
  // A response with the wrong status is a real answer, not a connection
  // problem — retrying it just burns the whole timeout to learn nothing.
  const url = await serve((_, res) => {
    res.writeHead(404);
    res.end("nope");
  });

  const began = Date.now();
  const res = await run({ url, expectStatus: 200, timeoutMs: 8000 });
  expect(res.ok).toBe(false);
  expect(res.status).toBe(404);
  expect(Date.now() - began).toBeLessThan(3000);
});

test("expectStatus accepts the code it was told to expect", async () => {
  const url = await serve((_, res) => {
    res.writeHead(201);
    res.end("created");
  });

  const res = await run({ url, expectStatus: 201 });
  expect(res.ok).toBe(true);
});

test("it retries a server that is not up yet, then succeeds once it binds", async () => {
  // The dev-server case the retry loop exists for: the probe is fired while
  // the server is still starting, and must not give up on the first refusal.
  const port = await findFreePort();
  const srv = createServer((_, res) => res.end("late but here"));
  servers.push(srv);

  setTimeout(() => srv.listen(port, "127.0.0.1"), 900);

  const res = await run({ url: `http://127.0.0.1:${port}`, timeoutMs: 8000 });
  expect(res.ok).toBe(true);
  expect(res.attempts).toBeGreaterThan(1);
  expect(res.bodyHead).toContain("late but here");
});
