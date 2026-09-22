/**
 * terminal-registry.ts — Persistent, named shell sessions.
 *
 * Layer: tools
 * Allowed imports: node stdlib, ./shell.js
 *
 * WHY THIS EXISTS:
 *   Before this, every command was a fresh detached child process with
 *   `stdin: "ignore"`. Two consequences shaped a lot of bad behaviour:
 *
 *     1. NO STATE SURVIVED between commands. A `cd`, an exported env var, an
 *        activated venv, an `nvm use` — all discarded the moment that spawn
 *        exited. Working inside a sub-project meant embedding `cd x; ...` in
 *        every command string, which the registry could not see.
 *     2. NOTHING COULD BE TYPED INTO A RUNNING PROCESS. `npm init vite@latest`
 *        without --yes asks a question into a closed pipe and hangs until the
 *        120-second timeout kills it.
 *
 *   A terminal here is a long-lived shell with stdin PIPED, held open across
 *   turns, addressed by a name the model chose ("web", "api") rather than an
 *   incrementing counter.
 *
 * THE HARD PART — WHERE DOES ONE COMMAND'S OUTPUT END?
 *   A shell that never exits gives you no natural boundary and no per-command
 *   exit status. We create both by appending a sentinel echo to each command:
 *
 *       <command>
 *       echo "__ZIZOU_END_<random>__:<exit code expression>"
 *
 *   and reading until that exact marker appears. The id is random PER SEND and
 *   is not known to the shell before the command runs, so a command that
 *   happens to print sentinel-shaped text cannot terminate someone else's read.
 */

import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { getInteractiveShell, resolveCwd, stripAnsi, tailLines } from "./shell.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Terminal {
  name: string;
  cwd: string;
  process: ChildProcess;
  status: "ready" | "busy" | "closed";
  /** Output accumulated since the last completed read. */
  buffer: string;
  /** The command currently running, if status is "busy". */
  runningCommand?: string;
  createdAt: Date;
  /** Commands sent, most recent last. Useful context when listing terminals. */
  history: string[];
  exitCode: number | null;
}

export interface SendResult {
  name: string;
  command: string;
  output: string;
  exitCode: number | null;
  durationMs: number;
  /** True when the command did not finish before timeoutMs. The terminal stays busy. */
  stillRunning: boolean;
  cwd: string;
}

/** How much output we retain per terminal before dropping the oldest. */
const MAX_BUFFER_CHARS = 200_000;

/** Lines of output returned from a single send. */
const MAX_OUTPUT_LINES = 300;

const terminals = new Map<string, Terminal>();

// ─── Sentinel construction ───────────────────────────────────────────────────

/**
 * The shell fragment that prints our end-of-command marker with the exit code.
 *
 * PowerShell needs care: `$LASTEXITCODE` is only set by NATIVE executables and
 * persists between commands, while `$?` reflects the last operation including
 * cmdlets. Checking both — and preferring a non-zero LASTEXITCODE — gets the
 * right answer for `npm run build` (native, sets LASTEXITCODE) and for a failed
 * cmdlet like `Set-Location nope` (sets $? to false) alike.
 */
function markerCommand(id: string): string {
  const marker = `__ZIZOU_END_${id}__`;
  if (process.platform === "win32") {
    return (
      `Write-Output "${marker}:$(if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) ` +
      `{ $LASTEXITCODE } elseif ($?) { 0 } else { 1 })"`
    );
  }
  return `printf '${marker}:%s\\n' "$?"`;
}

function markerPattern(id: string): RegExp {
  return new RegExp(`__ZIZOU_END_${id}__:(-?\\d+)`);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Opens a new shell session. Throws if the name is taken by a live terminal —
 * silently reusing one would hand the caller a shell sitting in an unexpected
 * directory with unexpected env.
 */
export function createTerminal(opts: { name: string; cwd?: string; root?: string }): Terminal {
  const existing = terminals.get(opts.name);
  if (existing && existing.status !== "closed") {
    throw new Error(
      `A terminal named "${opts.name}" is already open (cwd: ${existing.cwd}). ` +
        `Send commands to it, or close it first.`,
    );
  }

  const cwd = resolveCwd(opts.cwd, opts.root);
  const { command, args } = getInteractiveShell();

  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
  });

  const term: Terminal = {
    name: opts.name,
    cwd,
    process: child,
    status: "ready",
    buffer: "",
    createdAt: new Date(),
    history: [],
    exitCode: null,
  };

  const append = (chunk: string) => {
    term.buffer += chunk;
    if (term.buffer.length > MAX_BUFFER_CHARS) {
      term.buffer = term.buffer.slice(-MAX_BUFFER_CHARS);
    }
  };

  child.stdout?.setEncoding("utf-8");
  child.stdout?.on("data", append);
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", append);

  child.on("close", (code) => {
    term.status = "closed";
    term.exitCode = code;
  });
  child.on("error", (err) => {
    term.status = "closed";
    append(`\n[terminal error] ${err.message}\n`);
  });

  terminals.set(opts.name, term);
  return term;
}

export function getTerminal(name: string): Terminal | undefined {
  return terminals.get(name);
}

export function listTerminals(): Array<Omit<Terminal, "process" | "buffer">> {
  return Array.from(terminals.values()).map(
    ({ process: _p, buffer: _b, ...rest }) => rest,
  );
}

export function closeTerminal(name: string): boolean {
  const term = terminals.get(name);
  if (!term) return false;
  try {
    term.process.stdin?.end();
    term.process.kill();
  } catch {
    /* already dead */
  }
  term.status = "closed";
  terminals.delete(name);
  return true;
}

export function closeAllTerminals(): void {
  for (const name of Array.from(terminals.keys())) closeTerminal(name);
}

// ─── Sending commands ────────────────────────────────────────────────────────

/**
 * Sends a command and waits for it to finish, recovering a real exit code.
 *
 * On timeout the command is NOT killed — many legitimate commands simply take
 * longer than the caller guessed. The terminal stays `busy`, the partial output
 * is returned with `stillRunning: true`, and the caller can `read` again later
 * or interrupt with sendKeys("\x03").
 */
export async function sendCommand(
  name: string,
  command: string,
  timeoutMs = 120_000,
): Promise<SendResult> {
  const term = terminals.get(name);
  if (!term) throw new Error(`No terminal named "${name}". Create it first.`);
  if (term.status === "closed") throw new Error(`Terminal "${name}" has closed.`);
  if (term.status === "busy") {
    throw new Error(
      `Terminal "${name}" is still running: ${term.runningCommand}. ` +
        `Wait with action "read", or interrupt it with sendKeys.`,
    );
  }
  if (!term.process.stdin?.writable) {
    throw new Error(`Terminal "${name}" cannot accept input (stdin closed).`);
  }

  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const pattern = markerPattern(id);
  const started = Date.now();

  // Clear the buffer so the result contains only THIS command's output.
  term.buffer = "";
  term.status = "busy";
  term.runningCommand = command;
  term.history.push(command);

  term.process.stdin.write(`${command}\n${markerCommand(id)}\n`);

  const settle = (stillRunning: boolean, exitCode: number | null): SendResult => {
    const raw = stripAnsi(term.buffer);
    // Drop the marker line itself — it is our bookkeeping, not the command's output.
    const output = raw
      .split("\n")
      .filter((l) => !l.includes(`__ZIZOU_END_${id}__`))
      .join("\n")
      .trim();

    if (!stillRunning) {
      term.status = "ready";
      term.runningCommand = undefined;
      term.buffer = "";
    }

    return {
      name,
      command,
      output: tailLines(output, MAX_OUTPUT_LINES),
      exitCode,
      durationMs: Date.now() - started,
      stillRunning,
      cwd: term.cwd,
    };
  };

  return new Promise<SendResult>((resolvePromise) => {
    const check = () => {
      const match = term.buffer.match(pattern);
      if (match) {
        cleanup();
        resolvePromise(settle(false, Number.parseInt(match[1], 10)));
        return true;
      }
      if (term.status === "closed") {
        cleanup();
        resolvePromise(settle(false, term.exitCode));
        return true;
      }
      return false;
    };

    // Poll rather than hook 'data': the marker can straddle two chunks, and a
    // 50ms poll over an in-memory string is cheaper than re-scanning per chunk.
    const interval = setInterval(check, 50);
    const timer = setTimeout(() => {
      if (check()) return;
      cleanup();
      resolvePromise(settle(true, null));
    }, timeoutMs);

    function cleanup() {
      clearInterval(interval);
      clearTimeout(timer);
    }

    check();
  });
}

/**
 * Writes raw input to the terminal without waiting for a command boundary.
 * This is how an interactive prompt gets answered ("y\n") or a runaway
 * command gets interrupted ("\x03" for Ctrl-C).
 */
export function sendKeys(name: string, keys: string): void {
  const term = terminals.get(name);
  if (!term) throw new Error(`No terminal named "${name}".`);
  if (!term.process.stdin?.writable) throw new Error(`Terminal "${name}" cannot accept input.`);
  term.process.stdin.write(keys);
}

/** Returns output accumulated so far without sending anything. */
export function readTerminal(name: string, lines = 100): { output: string; status: string; runningCommand?: string } {
  const term = terminals.get(name);
  if (!term) throw new Error(`No terminal named "${name}".`);
  return {
    output: tailLines(stripAnsi(term.buffer).trim(), lines),
    status: term.status,
    runningCommand: term.runningCommand,
  };
}
