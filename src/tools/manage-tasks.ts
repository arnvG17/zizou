/**
 * manage-tasks.ts — Backwards-compatible alias over the service registry.
 *
 * Layer: tools
 * Allowed imports: ./service-registry.js
 *
 * `service` supersedes this. The name is kept because stored transcripts and
 * the trace/journal OPAQUE_TOOLS sets key off it as a string.
 *
 * WHAT CHANGED: 'logs' used to return the same overlapping 10 000-character
 * window on every call with stdout and stderr merged together, and exitCode
 * was reachable only through 'list'. Now logs are line-based with a cursor,
 * the streams stay tagged, and there is a 'wait' action so waiting for a task
 * to finish does not cost one LLM round-trip per poll.
 */

import { z } from "zod";
import { tool } from "ai";
import { getService, listServices, serviceLogs, stopService, waitForExit } from "./service-registry.js";

export const manageTasks = tool({
  description:
    "Inspect background tasks and services started in this session: list them, read their logs, " +
    "wait for one to finish, or stop one. Prefer the 'service' tool for new work.",
  inputSchema: z.object({
    action: z
      .enum(["list", "kill", "logs", "wait"])
      .describe(
        "'list' (all tasks), 'logs' (output, supports sinceOffset), " +
          "'wait' (block until it exits, returns exitCode), 'kill' (stop it)",
      ),
    taskId: z.string().optional().describe("The taskId/name from runBackground or service. Required except for 'list'."),
    sinceOffset: z.number().optional().describe("For 'logs': return only lines after this cursor."),
    tail: z.number().optional().describe("For 'logs': trailing line count. Default 50."),
    timeoutMs: z.number().optional().describe("For 'wait': how long to wait. Default 30000."),
  }),
  execute: async ({ action, taskId, sinceOffset, tail, timeoutMs }) => {
    try {
      if (action === "list") {
        return {
          success: true as const,
          tasks: listServices().map((s) => ({
            id: s.name,
            command: s.command,
            cwd: s.cwd,
            pid: s.pid,
            status: s.status,
            exitCode: s.exitCode,
            url: s.url,
            crashReason: s.crashReason,
            startTime: s.startedAt.toISOString(),
          })),
        };
      }

      if (!taskId) {
        return { success: false as const, error: `A 'taskId' is required for action '${action}'.` };
      }

      const service = getService(taskId);
      if (!service) return { success: false as const, error: `Task ${taskId} not found.` };

      if (action === "logs") {
        const { lines, nextOffset, status } = serviceLogs(taskId, { sinceOffset, tail });
        return {
          success: true as const,
          taskId,
          command: service.command,
          status,
          logs: lines || "(No output logs yet)",
          nextOffset,
        };
      }

      if (action === "wait") {
        const result = await waitForExit(taskId, timeoutMs);
        return {
          success: result.exitCode === 0,
          taskId,
          status: result.status,
          exitCode: result.exitCode,
          output: result.output,
          ...(result.exitCode === null
            ? { note: "Still running when the wait timed out — it was not killed." }
            : {}),
        };
      }

      if (action === "kill") {
        if (service.status === "stopped") {
          return { success: false as const, error: `Task ${taskId} is already stopped.` };
        }
        return stopService(taskId)
          ? { success: true as const, message: `Successfully terminated background task ${taskId}.` }
          : { success: false as const, error: `Failed to terminate task ${taskId}.` };
      }

      return { success: false as const, error: `Unsupported action: ${action}` };
    } catch (err) {
      return {
        success: false as const,
        error: err instanceof Error ? err.message : "Unknown error managing tasks",
      };
    }
  },
});
