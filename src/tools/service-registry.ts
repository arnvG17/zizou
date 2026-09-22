/**
 * service-registry.ts — Supervised long-running processes.
 *
 * Layer: tools
 * Allowed imports: node stdlib, ./shell.js
 *
 * WHY A SERVICE IS NOT A TASK:
 *   `npm run dev` is not a command that finishes — it is a process that should
 *   become READY and then stay up. The old task registry only knew "running"
 *   and "exited", which meant the two most important cases were invisible:
 *
 *     - A server that booted and then died on a bad import looked exactly like
 *       a healthy one, because something had been spawned and nothing checked.
 *     - A server that had not finished starting looked identical to one already
 *       serving traffic, so the next step raced it.
 *
 *   A service therefore has a READY SIGNAL (a log pattern, a bound port, or a
 *   responding URL) and a CRASH state that records why.
 *
 * PORT ALLOCATION:
 *   We take a free port from the OS before starting rather than letting the
 *   process default to 5173 and recovering from EADDRINUSE. Two dev servers
 *   defaulting to the same port is a certainty; losing the allocation race is
 *   a millisecond-wide possibility.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { getShellConfig, resolveCwd, stripAnsi, isPortBound, wrapForExitCode, win32Bin } from "./shell.js";

// ─── Log ring ────────────────────────────────────────────────────────────────

interface LogLine {
  stream: "stdout" | "stderr";
  text: string;
}

/**
 * A line-based ring buffer with a monotonic offset.
 *
 * Line-based, not character-based: the old 10 000-CHARACTER cut could land in
 * the middle of a line (or an escape sequence), producing a garbled first line
 * every time. The offset lets a caller poll for only what is new instead of
 * re-reading the same window and re-paying for it in context.
 */
class LogRing {
  private lines: LogLine[] = [];
  private dropped = 0;
  private partial: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };

  constructor(private readonly max = 2000) {}

  push(stream: "stdout" | "stderr", chunk: string): void {
    const combined = this.partial[stream] + stripAnsi(chunk);
    const parts = combined.split("\n");
    // The last element is an incomplete line unless the chunk ended with \n.
    this.partial[stream] = parts.pop() ?? "";
    for (const text of parts) this.lines.push({ stream, text });

    if (this.lines.length > this.max) {
      const excess = this.lines.length - this.max;
      this.lines.splice(0, excess);
      this.dropped += excess;
    }
  }

  /** Total lines ever written — the cursor a caller passes back as sinceOffset. */
  get offset(): number {
    return this.dropped + this.lines.length;
  }

  since(from: number, stream: "stdout" | "stderr" | "both" = "both"): { lines: LogLine[]; nextOffset: number } {
    const start = Math.max(0, from - this.dropped);
    const slice = this.lines.slice(start);
    return {
      lines: stream === "both" ? slice : slice.filter((l) => l.stream === stream),
      nextOffset: this.offset,
    };
  }

  tail(n: number, stream: "stdout" | "stderr" | "both" = "both"): LogLine[] {
    const pool = stream === "both" ? this.lines : this.lines.filter((l) => l.stream === stream);
    return pool.slice(-n);
  }

  /** Everything buffered, as plain text. Used for ready-pattern matching. */
  text(): string {
    return this.lines.map((l) => l.text).join("\n") + this.partial.stdout + this.partial.stderr;
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ServiceStatus = "starting" | "ready" | "crashed" | "stopped";

export interface ReadySpec {
  /** A pattern to look for in the service's output, e.g. "ready in \\d+ ms". */
  readyRegex?: string;
  /** Consider it ready once something is listening here. */
  port?: number;
  /** Consider it ready once this URL responds. */
  url?: string;
  /** Wait for the process to EXIT successfully instead (installs, scaffolders). */
  exit?: boolean;
}

export interface ServiceSpec extends ReadySpec {
  name: string;
  command: string;
  cwd?: string;
  /** Inject an OS-allocated free port as $PORT and expose it as the service's url. */
  autoPort?: boolean;
  /** Survive CLI exit instead of being killed with everything else. */
  persist?: boolean;
  waitTimeoutMs?: number;
}

export interface Service {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  port?: number;
  url?: string;
  status: ServiceStatus;
  exitCode: number | null;
  readySignal?: string;
  crashReason?: string;
  persist: boolean;
  startedAt: Date;
  spec: ServiceSpec;
  process: ChildProcess;
  log: LogRing;
}

const services = new Map<string, Service>();
let idCounter = 1;

const DEFAULT_WAIT_MS = 60_000;
const CRASH_LOG_LINES = 25;

// ─── Starting ────────────────────────────────────────────────────────────────

/**
 * Starts a service and does not return until it is ready, has crashed, or the
 * wait times out. "Started" is deliberately not a success condition — that is
 * the distinction this whole module exists to draw.
 */
export async function startService(spec: ServiceSpec, root?: string): Promise<Service> {
  const existing = services.get(spec.name);
  if (existing && (existing.status === "ready" || existing.status === "starting")) {
    throw new Error(
      `A service named "${spec.name}" is already ${existing.status}` +
        `${existing.url ? ` at ${existing.url}` : ""} (pid ${existing.pid}). ` +
        `Stop or restart it instead of starting a second one.`,
    );
  }

  const cwd = resolveCwd(spec.cwd, root);
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };

  let port = spec.port;
  if (spec.autoPort && !port) {
    const { findFreePort } = await import("./shell.js");
    port = await findFreePort();
  }
  if (port) env.PORT = String(port);

  const child = spawn(wrapForExitCode(spec.command), {
    ...getShellConfig(),
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const service: Service = {
    id: `svc_${idCounter++}`,
    name: spec.name,
    command: spec.command,
    cwd,
    pid: child.pid,
    port,
    url: spec.url ?? (port ? `http://localhost:${port}` : undefined),
    status: "starting",
    exitCode: null,
    persist: spec.persist ?? false,
    startedAt: new Date(),
    spec: { ...spec, port },
    process: child,
    log: new LogRing(),
  };

  child.stdout?.setEncoding("utf-8");
  child.stdout?.on("data", (c: string) => service.log.push("stdout", c));
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (c: string) => service.log.push("stderr", c));

  child.on("close", (code) => {
    service.exitCode = code;
    if (service.status === "stopped") return; // we asked for this
    if (spec.exit) {
      service.status = code === 0 ? "ready" : "crashed";
    } else {
      // A service that exits on its own has crashed, whatever its code —
      // a dev server reaching "exited cleanly" still means nothing is serving.
      service.status = "crashed";
    }
    if (service.status === "crashed") {
      service.crashReason = formatLines(service.log.tail(CRASH_LOG_LINES)) || `exited with code ${code}`;
    }
  });

  child.on("error", (err) => {
    service.status = "crashed";
    service.crashReason = err.message;
  });

  services.set(spec.name, service);

  await waitForReady(service, spec.waitTimeoutMs ?? DEFAULT_WAIT_MS);
  persistManifest();
  return service;
}

/** Polls the declared ready signal until it fires, the process dies, or we time out. */
async function waitForReady(service: Service, timeoutMs: number): Promise<void> {
  const spec = service.spec;
  const deadline = Date.now() + timeoutMs;
  const pattern = spec.readyRegex ? new RegExp(spec.readyRegex, "i") : null;

  // With no ready signal declared there is nothing to wait for. Give the
  // process a beat to fail fast (a bad command usually dies immediately),
  // then report whatever state it is in.
  const hasSignal = !!(pattern || spec.port || spec.url || spec.exit);
  if (!hasSignal) {
    await sleep(400);
    if (service.status === "starting") service.status = "ready";
    return;
  }

  while (Date.now() < deadline) {
    if (service.status === "crashed") return;
    if (service.status === "ready") return; // the close handler resolved spec.exit

    if (pattern && pattern.test(service.log.text())) {
      service.status = "ready";
      service.readySignal = `log matched /${spec.readyRegex}/`;
      return;
    }
    if (spec.port && (await isPortBound(spec.port))) {
      service.status = "ready";
      service.readySignal = `port ${spec.port} is listening`;
      return;
    }
    if (spec.url && (await urlResponds(spec.url))) {
      service.status = "ready";
      service.readySignal = `${spec.url} responded`;
      return;
    }
    await sleep(250);
  }

  if (service.status === "starting") {
    service.status = "crashed";
    service.crashReason =
      `did not become ready within ${timeoutMs}ms. Last output:\n` +
      formatLines(service.log.tail(CRASH_LOG_LINES));
  }
}

async function urlResponds(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatLines(lines: LogLine[]): string {
  return lines.map((l) => (l.stream === "stderr" ? `[err] ${l.text}` : l.text)).join("\n");
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export function getService(name: string): Service | undefined {
  return services.get(name);
}

export function listServices(): Array<Omit<Service, "process" | "log" | "spec">> {
  return Array.from(services.values()).map(({ process: _p, log: _l, spec: _s, ...rest }) => rest);
}

export function serviceLogs(
  name: string,
  opts: { sinceOffset?: number; tail?: number; stream?: "stdout" | "stderr" | "both" } = {},
): { lines: string; nextOffset: number; status: ServiceStatus } {
  const service = services.get(name);
  if (!service) throw new Error(`No service named "${name}".`);
  const stream = opts.stream ?? "both";

  if (opts.sinceOffset !== undefined) {
    const { lines, nextOffset } = service.log.since(opts.sinceOffset, stream);
    return { lines: formatLines(lines), nextOffset, status: service.status };
  }
  return {
    lines: formatLines(service.log.tail(opts.tail ?? 50, stream)),
    nextOffset: service.log.offset,
    status: service.status,
  };
}

/** Last N log lines. Used by checkUrl and the verifier to explain a failure in one shot. */
export function serviceLogTail(name: string, n = 25): string | undefined {
  const service = services.get(name);
  if (!service) return undefined;
  return formatLines(service.log.tail(n));
}

// ─── Stopping ────────────────────────────────────────────────────────────────

export function stopService(name: string): boolean {
  const service = services.get(name);
  if (!service) return false;
  service.status = "stopped";
  killProcess(service);
  persistManifest();
  return true;
}

export async function restartService(name: string, root?: string): Promise<Service> {
  const service = services.get(name);
  if (!service) throw new Error(`No service named "${name}".`);
  const spec = service.spec;
  stopService(name);
  services.delete(name);
  await sleep(300); // give the OS a moment to release the port
  return startService(spec, root);
}

function killProcess(service: Service): void {
  try {
    if (process.platform === "win32") {
      // taskkill /T reaches the whole TREE, which is the only thing that works
      // here: the direct child is the PowerShell wrapper, and the process
      // actually holding the port is its grandchild (`npm run dev` → node).
      //
      // Two bugs used to hide here, both silenced by the catch below, and both
      // ending the same way: only the wrapper died, the server kept running and
      // kept its port, and "stopped" was a lie the registry told about a live
      // process.
      //   1. require("node:child_process") inline — the package is ESM, so
      //      require is not defined and the call threw every time.
      //   2. the bare name `taskkill`, which only resolves when System32 is on
      //      PATH. It is not, under a Git Bash style environment.
      execSync(`"${win32Bin("taskkill")}" /pid ${service.process.pid} /T /F`, { stdio: "ignore" });
    } else if (service.process.pid) {
      // Negative pid targets the process GROUP, which is why we spawn detached.
      try {
        process.kill(-service.process.pid, "SIGTERM");
      } catch {
        service.process.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          if (service.process.exitCode === null && service.process.pid) {
            process.kill(-service.process.pid, "SIGKILL");
          }
        } catch {
          /* already gone */
        }
      }, 2000);
    }
  } catch {
    try {
      service.process.kill();
    } catch {
      /* already gone */
    }
  }
}

// ─── Waiters (used by the verifier) ──────────────────────────────────────────

/** Resolves when the service's process exits, or at the timeout. */
export function waitForExit(
  name: string,
  timeoutMs = 30_000,
): Promise<{ status: ServiceStatus; exitCode: number | null; output: string }> {
  const service = services.get(name);
  if (!service) return Promise.reject(new Error(`No service named "${name}".`));

  return new Promise((res) => {
    const finish = () =>
      res({
        status: service.status,
        exitCode: service.exitCode,
        output: formatLines(service.log.tail(CRASH_LOG_LINES)),
      });

    if (service.process.exitCode !== null || service.status === "crashed") return finish();
    const timer = setTimeout(finish, timeoutMs);
    service.process.once("close", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/** True if any service is still in `starting`. The verifier waits on this. */
export function hasStartingServices(): boolean {
  return Array.from(services.values()).some((s) => s.status === "starting");
}

// ─── Cross-session manifest ──────────────────────────────────────────────────
//
// Services are killed on CLI exit by default — an orphaned node process
// squatting a port is worse than a lost server, because the next session
// cannot diagnose it. But a `persist: true` service outlives us, and the next
// session needs to know it is there rather than starting a second one and
// colliding.

const MANIFEST_PATH = () => join(process.cwd(), ".zizou", "services.json");

function persistManifest(): void {
  try {
    const persisted = Array.from(services.values())
      .filter((s) => s.persist && s.status !== "stopped")
      .map((s) => ({
        name: s.name,
        pid: s.pid,
        port: s.port,
        url: s.url,
        command: s.command,
        cwd: s.cwd,
        startedAt: s.startedAt.toISOString(),
      }));

    const path = MANIFEST_PATH();
    if (persisted.length === 0 && !existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(persisted, null, 2), "utf-8");
  } catch {
    // The manifest is a convenience, never a correctness requirement.
  }
}

export interface OrphanedService {
  name: string;
  pid?: number;
  port?: number;
  url?: string;
  command: string;
  cwd: string;
  alive: boolean;
}

/**
 * Reads the manifest left by a previous session and reports which of those
 * processes are still alive. Call at startup so "port already in use" can be
 * explained instead of merely observed.
 */
export function reconcileOrphans(): OrphanedService[] {
  try {
    const path = MANIFEST_PATH();
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, "utf-8")) as OrphanedService[];
    return raw.map((entry) => ({ ...entry, alive: entry.pid ? isPidAlive(entry.pid) : false }));
  } catch {
    return [];
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 tests existence without delivering anything
    return true;
  } catch {
    return false;
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup(): void {
  for (const service of services.values()) {
    if (service.persist) continue;
    if (service.status === "stopped") continue;
    service.status = "stopped";
    killProcess(service); // tree-kill — see the note in killProcess
  }
  persistManifest();
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

/** Exported for tests, which must not leak processes between cases. */
export function _resetForTests(): void {
  for (const service of services.values()) {
    service.status = "stopped";
    killProcess(service);
  }
  services.clear();
}
