/**
 * shell.ts — Shared shell primitives for every tool that spawns a process.
 *
 * Layer: tools
 * Allowed imports: node stdlib only
 * NOT allowed to import from: agent/, ui/, sdk/
 *
 * WHY THIS EXISTS:
 *   getShellConfig() used to be copy-pasted into run-bash.ts and
 *   run-background.ts, and the two copies had silently DIVERGED: run-bash
 *   returned `{}` on POSIX (node's default /bin/sh) while run-background
 *   returned `{ shell: true }`. Two tools claiming to "use the default
 *   shell" while actually using different ones is the kind of drift that
 *   shows up as an unreproducible bug on someone else's machine.
 *
 *   Everything a process-spawning tool needs to agree on lives here: which
 *   shell, which working directory, and how to truncate output without
 *   throwing away the part that matters.
 */

import { join, resolve, isAbsolute, relative } from "node:path";
import { statSync } from "node:fs";

// ─── Shell selection ─────────────────────────────────────────────────────────

/**
 * The platform-appropriate shell for spawn()/exec().
 *
 * On Windows, cmd.exe is the default but is too limited for modern tooling
 * (npm, npx, and anything expecting POSIX-ish quoting). We resolve the
 * absolute path to powershell.exe rather than relying on PATH, because a
 * PATH-shadowed `powershell` is a real failure mode on managed machines.
 */
export function getShellConfig(): { shell: string | true } {
  if (process.platform === "win32") {
    return { shell: getWindowsShellPath() };
  }
  return { shell: true };
}

/** Absolute path to powershell.exe. Windows only. */
export function getWindowsShellPath(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return join(systemRoot, "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
}

/**
 * Absolute path to a Windows System32 executable.
 *
 * WHY NOT JUST THE BARE NAME: `taskkill`, `netstat` and `tasklist` are only
 * resolvable if System32 is on PATH, and it is not always there — under a
 * Git Bash or MSYS-derived environment PATH is rewritten POSIX-style and
 * System32 can be missing entirely. Measured on this machine, `taskkill /pid
 * … /T /F` failed with "'taskkill' is not recognized", which the caller's
 * catch swallowed: the process tree was never killed, the server kept its
 * port, and the registry reported it as stopped regardless.
 */
export function win32Bin(name: string): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return join(systemRoot, "System32", `${name}.exe`);
}

/**
 * Makes a command report its REAL exit code through the shell wrapper.
 *
 * PowerShell does not propagate a native executable's exit status: it reports
 * its own, which is 1 for any non-zero native exit. Measured directly —
 *
 *     spawn('node -e "process.exit(4)"', { shell: powershell })  → code 1
 *     spawn('node -e "process.exit(4)"; exit $LASTEXITCODE', …)  → code 4
 *
 * So every `npm`, `node`, `tsc` or `git` command run on Windows was reporting
 * a fabricated 1. That is not cosmetic here: the exit code is the ground truth
 * this layer uses to decide whether a step worked, and a real code is what
 * tells a build failure apart from a test failure.
 *
 * Appending the explicit exit is a no-op everywhere else: a PowerShell
 * statement like `exit 3` never reaches it, and with no native command run
 * $LASTEXITCODE is $null, which exits 0.
 */
export function wrapForExitCode(command: string): string {
  if (process.platform !== "win32") return command;
  return `${command}\nexit $LASTEXITCODE`;
}

/**
 * The argv for spawning a shell that stays open and reads commands from
 * stdin — the basis of a persistent terminal session.
 *
 * -NoProfile matters: a user's PowerShell profile can print a banner, change
 * the prompt, or take seconds to load, all of which corrupt the output of the
 * first command we send.
 */
export function getInteractiveShell(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: getWindowsShellPath(),
      args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"],
    };
  }
  return { command: process.env.SHELL || "/bin/bash", args: ["-s"] };
}

// ─── Working directory ───────────────────────────────────────────────────────

/**
 * Resolves a caller-supplied working directory against the workspace root.
 *
 * WHY THIS IS A FUNCTION AND NOT `cwd ?? process.cwd()`:
 *   Every shell tool previously hard-coded `cwd: process.cwd()`, so running
 *   anything inside a sub-project required the model to embed `cd frontend;`
 *   in the command string. That works in the shell and is invisible to
 *   everything else — the task registry, the logs, the error messages all
 *   report the wrong directory.
 *
 * Relative paths resolve against `root`. Absolute paths are allowed but must
 * stay inside `root`: a tool call is not a licence to run commands anywhere
 * on the filesystem.
 *
 * @throws if the directory does not exist or escapes the workspace root.
 */
export function resolveCwd(cwd: string | undefined, root: string = process.cwd()): string {
  if (!cwd || cwd === "." || cwd === "./") return root;

  const abs = isAbsolute(cwd) ? resolve(cwd) : resolve(root, cwd);

  const rel = relative(resolve(root), abs);
  if (rel.startsWith("..")) {
    throw new Error(
      `cwd "${cwd}" resolves outside the workspace root (${root}). ` +
        `Use a path inside the project.`,
    );
  }

  try {
    if (!statSync(abs).isDirectory()) {
      throw new Error(`cwd "${cwd}" exists but is not a directory.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("not a directory")) throw err;
    throw new Error(
      `cwd "${cwd}" does not exist. Create the directory first, or omit cwd to run from the workspace root.`,
    );
  }

  return abs;
}

// ─── Output handling ─────────────────────────────────────────────────────────

/** Matches the ANSI escape sequences that colourised CLI output is full of. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * Strips ANSI colour codes.
 *
 * Vite, npm and most modern CLIs emit colour even when not attached to a TTY.
 * Those escape sequences are pure cost in a model's context window, and they
 * also break naive line/character truncation by landing mid-sequence.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Truncates keeping the END of the text.
 *
 * Use for stderr. Compiler errors, stack traces and "npm ERR!" summaries all
 * put the useful part last, so head-first truncation — which is what the old
 * run-bash did to everything — cut off precisely the line the model needed.
 */
export function truncateTail(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `...[${text.length - maxLen} EARLIER CHARS TRUNCATED]\n` + text.slice(-maxLen);
}

/**
 * Truncates keeping the START of the text.
 *
 * Use for stdout, where the interesting output usually begins immediately.
 */
export function truncateHead(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n...[${text.length - maxLen} MORE CHARS TRUNCATED]`;
}

/** Keeps the last `n` lines. Line-based, so it never cuts mid-line. */
export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n");
}

// ─── Free port allocation ────────────────────────────────────────────────────

/**
 * Asks the OS for a free TCP port by binding to port 0 and reading back what
 * it assigned.
 *
 * WHY: the alternative is starting a server on a guessed port, watching it
 * fail with EADDRINUSE, and recovering. Allocating up front means the
 * collision never happens. There is an inherent race — the port is free when
 * we check and could be taken before the child binds it — but the window is
 * milliseconds, versus the certainty of two dev servers both defaulting to
 * 5173.
 */
export async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? res(port) : rej(new Error("could not allocate a port"))));
    });
  });
}

/** True if something is listening on `port`. */
export async function isPortBound(port: number, host = "127.0.0.1"): Promise<boolean> {
  const { connect } = await import("node:net");
  return new Promise((res) => {
    const socket = connect({ port, host });
    const done = (bound: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      res(bound);
    };
    socket.setTimeout(1000);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });
}
