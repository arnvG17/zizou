/**
 * run-background.ts — Backwards-compatible alias over the service registry.
 *
 * Layer: tools
 * Allowed imports: ./service-registry.js, ./types.js
 *
 * WHY THIS STILL EXISTS:
 *   `service` replaces it, but the tool NAME is load-bearing in several places
 *   that key off strings rather than imports — the OPAQUE_TOOLS sets in
 *   src/trace/wrap-tools.ts and src/agent/debug/run-journal.ts, the history
 *   collapser in src/agent/executor.ts, and every stored transcript. Keeping
 *   the name pointed at the new machinery means old sessions keep resolving.
 *
 * WHAT CHANGED BEHIND IT:
 *   It used to return the instant the process was spawned, which is what let a
 *   verification step read the filesystem ~58 seconds before `npm init` had
 *   created anything. With `waitFor` it now waits for a real signal.
 */

import { z } from "zod";
import { tool } from "ai";
import { ConfirmFn } from "./types.js";
import { startService } from "./service-registry.js";

let bgCounter = 1;

export const createRunBackgroundTool = (confirm: ConfirmFn) => {
  return tool({
    description:
      "Run a command in the background. Prefer the 'service' tool, which does the same thing with a name you choose. " +
      "IMPORTANT: pass waitFor, or this returns before the work exists and anything checking its results will race it. " +
      "Use waitFor.exit for a command that finishes (an install, a scaffolder); " +
      "waitFor.readyRegex / port / url for a server.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute in the background"),
      cwd: z.string().optional().describe("Directory relative to the workspace root. Do not prefix with 'cd'."),
      waitFor: z
        .object({
          exit: z.boolean().optional().describe("Wait for the command to finish and report its exit code."),
          readyRegex: z.string().optional().describe("Wait until the output matches this pattern."),
          port: z.number().optional().describe("Wait until this port is listening."),
          url: z.string().optional().describe("Wait until this URL responds."),
        })
        .optional()
        .describe("What to wait for before returning. Omitting this reintroduces the race."),
      waitTimeoutMs: z.number().optional().describe("How long to wait. Default 60000."),
    }),
    execute: async ({ command, cwd, waitFor, waitTimeoutMs }) => {
      const where = cwd ? ` (in ${cwd})` : "";
      const isApproved = await confirm(
        `The agent wants to run this background command:\n  ${command}${where}\nAllow?`,
      );

      if (!isApproved) {
        return { success: false as const, error: "User denied permission to run this command." };
      }

      try {
        const name = `bg_${bgCounter++}`;
        const service = await startService({
          name,
          command,
          cwd,
          waitTimeoutMs,
          ...(waitFor ?? {}),
        });

        return {
          success: service.status === "ready",
          taskId: service.name,
          pid: service.pid,
          status: service.status,
          exitCode: service.exitCode,
          readySignal: service.readySignal,
          url: service.url,
          message:
            service.status === "ready"
              ? `Background task ${name} is ready${service.readySignal ? ` (${service.readySignal})` : ""}.`
              : `Background task ${name} did not come up.`,
          ...(service.status === "crashed" ? { error: service.crashReason } : {}),
        };
      } catch (err) {
        return {
          success: false as const,
          error: err instanceof Error ? err.message : "Unknown error starting background command",
        };
      }
    },
  });
};
