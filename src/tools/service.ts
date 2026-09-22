/**
 * service.ts — Tool surface over supervised long-running processes.
 *
 * Layer: tools
 * Allowed imports: ./service-registry.js, ./types.js
 */

import { z } from "zod";
import { tool } from "ai";
import { ConfirmFn } from "./types.js";
import {
  getService,
  listServices,
  restartService,
  serviceLogs,
  startService,
  stopService,
} from "./service-registry.js";

export const createServiceTool = (confirm: ConfirmFn) => {
  return tool({
    description:
      "Start and supervise a long-running process — a dev server, a watcher, an API. " +
      "Unlike runBash, 'start' does NOT return the moment the process spawns: it waits until the service is " +
      "actually READY (a log pattern, a listening port, or a responding URL), or reports that it CRASHED with " +
      "the reason. Always give a ready signal; a process that was merely spawned proves nothing. " +
      "Run several services at once by giving each a name ('web', 'api'), each with its own cwd. " +
      "Use autoPort to have a free port allocated and passed as $PORT instead of guessing one.",
    inputSchema: z.object({
      action: z
        .enum(["start", "status", "logs", "restart", "stop", "list"])
        .describe("What to do. 'list' needs no name; everything else does."),
      name: z.string().optional().describe("Service name, e.g. 'web' or 'api'."),
      command: z.string().optional().describe("For 'start': the command, e.g. 'npm run dev'."),
      cwd: z.string().optional().describe("For 'start': directory relative to the workspace root."),
      readyRegex: z
        .string()
        .optional()
        .describe("For 'start': treat as ready when the output matches this, e.g. 'ready in \\\\d+'."),
      port: z.number().optional().describe("For 'start': treat as ready once this port is listening."),
      url: z.string().optional().describe("For 'start': treat as ready once this URL responds."),
      autoPort: z
        .boolean()
        .optional()
        .describe("For 'start': allocate a free port, pass it as $PORT, and wait for it. Avoids port collisions."),
      exit: z
        .boolean()
        .optional()
        .describe(
          "For 'start': this command is expected to FINISH (an install, a scaffolder). " +
            "Waits for exit and reports the exit code.",
        ),
      persist: z
        .boolean()
        .optional()
        .describe("For 'start': keep running after the CLI exits. Default false — services are cleaned up."),
      waitTimeoutMs: z.number().optional().describe("For 'start': how long to wait for ready. Default 60000."),
      sinceOffset: z
        .number()
        .optional()
        .describe("For 'logs': return only lines after this cursor. Use nextOffset from the previous call."),
      tail: z.number().optional().describe("For 'logs': number of trailing lines. Default 50."),
      stream: z.enum(["stdout", "stderr", "both"]).optional().describe("For 'logs': which stream. Default both."),
    }),
    execute: async (args) => {
      const { action, name } = args;
      try {
        if (action === "list") {
          return {
            success: true as const,
            services: listServices().map((s) => ({
              name: s.name,
              status: s.status,
              url: s.url,
              port: s.port,
              pid: s.pid,
              command: s.command,
              cwd: s.cwd,
              exitCode: s.exitCode,
              crashReason: s.crashReason,
              startedAt: s.startedAt.toISOString(),
            })),
          };
        }

        if (!name) {
          return { success: false as const, error: `A 'name' is required for action '${action}'.` };
        }

        if (action === "start") {
          if (!args.command) {
            return { success: false as const, error: "'command' is required for action 'start'." };
          }
          const where = args.cwd ? ` (in ${args.cwd})` : "";
          const approved = await confirm(
            `The agent wants to start the background service "${name}"${where}:\n  ${args.command}\nAllow?`,
          );
          if (!approved) {
            return { success: false as const, error: "User denied permission to start this service." };
          }

          const service = await startService({
            name,
            command: args.command,
            cwd: args.cwd,
            readyRegex: args.readyRegex,
            port: args.port,
            url: args.url,
            autoPort: args.autoPort,
            exit: args.exit,
            persist: args.persist,
            waitTimeoutMs: args.waitTimeoutMs,
          });

          return {
            success: service.status === "ready",
            name: service.name,
            status: service.status,
            url: service.url,
            port: service.port,
            pid: service.pid,
            exitCode: service.exitCode,
            readySignal: service.readySignal,
            ...(service.status === "crashed"
              ? {
                  error: `Service "${name}" did not come up.`,
                  crashReason: service.crashReason,
                }
              : {}),
          };
        }

        if (action === "status") {
          const service = getService(name);
          if (!service) return { success: false as const, error: `No service named "${name}".` };
          return {
            success: service.status === "ready",
            name: service.name,
            status: service.status,
            url: service.url,
            port: service.port,
            pid: service.pid,
            exitCode: service.exitCode,
            crashReason: service.crashReason,
          };
        }

        if (action === "logs") {
          const { lines, nextOffset, status } = serviceLogs(name, {
            sinceOffset: args.sinceOffset,
            tail: args.tail,
            stream: args.stream,
          });
          return { success: true as const, name, status, logs: lines || "(no output yet)", nextOffset };
        }

        if (action === "restart") {
          const approved = await confirm(`The agent wants to restart the service "${name}".\nAllow?`);
          if (!approved) return { success: false as const, error: "User denied permission to restart." };
          const service = await restartService(name);
          return {
            success: service.status === "ready",
            name,
            status: service.status,
            url: service.url,
            crashReason: service.crashReason,
          };
        }

        if (action === "stop") {
          const stopped = stopService(name);
          return stopped
            ? { success: true as const, message: `Service "${name}" stopped.` }
            : { success: false as const, error: `No service named "${name}".` };
        }

        return { success: false as const, error: `Unsupported action: ${action}` };
      } catch (err) {
        return { success: false as const, error: err instanceof Error ? err.message : "Unknown service error" };
      }
    },
  });
};
