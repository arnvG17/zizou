/**
 * run-bash.ts — One-shot blocking shell command.
 *
 * Layer: tools
 * Allowed imports: config, types
 *
 * WHAT CHANGED AND WHY:
 *   This used to wrap promisify(exec), which REJECTS on a non-zero exit code.
 *   The catch block kept only `err.message` and dropped `err.code`,
 *   `err.stdout` and `err.stderr` on the floor. The practical effect: a failed
 *   `npm run build` came back as the string "Command failed: npm run build"
 *   with no compiler output at all. The model cannot fix what it cannot see,
 *   so it would either retry verbatim or declare success.
 *
 *   Now we spawn directly and always report the same shape — exit code,
 *   stdout and stderr — whether the command succeeded or failed. A non-zero
 *   exit is DATA, not an exception.
 *
 * SCOPE: this tool is for commands that FINISH. A dev server run through here
 * blocks the turn until the timeout and then reports failure; that is what the
 * `service` tool is for.
 */

import { spawn } from "node:child_process";
import { z } from "zod";
import { tool } from "ai";
import { ConfirmFn } from "./types.js";
import {
  getShellConfig,
  resolveCwd,
  stripAnsi,
  truncateHead,
  truncateTail,
  wrapForExitCode,
} from "./shell.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** Per-stream output caps. stdout gets more room; stderr is what we truncate least carefully. */
const MAX_STDOUT = 5_000;
const MAX_STDERR = 3_000;

export interface RunBashResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cwd: string;
  command: string;
  error?: string;
}

/**
 * Runs a command to completion and reports what happened.
 * Never throws on a non-zero exit — that is a normal, reportable outcome.
 */
export async function execCommand(
  command: string,
  opts: { cwd?: string; timeoutMs?: number; root?: string } = {},
): Promise<RunBashResult> {
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  let cwd: string;
  try {
    cwd = resolveCwd(opts.cwd, opts.root);
  } catch (err) {
    return {
      success: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cwd: opts.cwd ?? process.cwd(),
      command,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return new Promise<RunBashResult>((res) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(wrapForExitCode(command), {
      ...getShellConfig(),
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({
        // A timeout is a failure even if the process happened to exit 0 as it died.
        success: !timedOut && !spawnError && exitCode === 0,
        exitCode,
        // stdout keeps its head (output starts with what matters),
        // stderr keeps its TAIL (errors end with what matters).
        stdout: truncateHead(stripAnsi(stdout), MAX_STDOUT),
        stderr: truncateTail(stripAnsi(stderr), MAX_STDERR),
        timedOut,
        cwd,
        command,
        ...(spawnError
          ? { error: spawnError }
          : timedOut
            ? { error: `Command timed out after ${timeoutMs}ms and was killed.` }
            : {}),
      });
    };

    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));
  });
}

export const createRunBashTool = (confirm: ConfirmFn) => {
  return tool({
    description:
      "Run a shell command and wait for it to finish. " +
      "Returns exitCode, stdout and stderr — ALWAYS check exitCode before assuming it worked. " +
      "Use this for commands that terminate (git, ls, tsc --noEmit, a one-off script). " +
      "Do NOT use it for dev servers, watchers, or anything that does not exit — use the 'service' tool for those, " +
      "or this will simply block until the timeout. " +
      "For a sequence of commands that share state (cd, env vars, a venv), use the 'terminal' tool instead. " +
      "Requires user confirmation. On Windows this runs in PowerShell; on macOS/Linux, the default shell.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
      cwd: z
        .string()
        .optional()
        .describe(
          "Directory to run in, relative to the workspace root (e.g. 'frontend/todo-app'). " +
            "Use this instead of prefixing the command with 'cd'.",
        ),
      timeoutMs: z
        .number()
        .optional()
        .describe(
          `How long to wait before killing the command. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}. ` +
            "Raise it for slow installs.",
        ),
    }),
    execute: async ({ command, cwd, timeoutMs }) => {
      const where = cwd ? ` (in ${cwd})` : "";
      const isApproved = await confirm(
        `The agent wants to run the following command:\n  ${command}${where}\nAllow?`,
      );

      if (!isApproved) {
        return {
          success: false as const,
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          error: "User denied permission to run this command.",
        };
      }

      return execCommand(command, { cwd, timeoutMs });
    },
  });
};
