import { z } from "zod";
import { tool } from "ai";
import { listTasks, killTask, getTask } from "./task-registry.js";

export const manageTasks = tool({
  description:
    "Manage active background tasks spawned during this session. " +
    "Can list running tasks, view their real-time output logs, or kill/terminate them.",
  inputSchema: z.object({
    action: z
      .enum(["list", "kill", "logs"])
      .describe("Action to perform: 'list' (all tasks), 'kill' (stop a task), 'logs' (get stdout/stderr output)"),
    taskId: z
      .string()
      .optional()
      .describe("The taskId returned by runBackground. Required for 'kill' and 'logs'."),
  }),
  execute: async ({ action, taskId }) => {
    try {
      if (action === "list") {
        const activeTasks = listTasks();
        return {
          success: true as const,
          tasks: activeTasks.map((t) => ({
            id: t.id,
            command: t.command,
            pid: t.pid,
            status: t.status,
            exitCode: t.exitCode,
            startTime: t.startTime.toISOString(),
            logSize: t.outputBuffer.length,
          })),
        };
      }

      if (!taskId) {
        return {
          success: false as const,
          error: "A 'taskId' is required for actions 'kill' and 'logs'.",
        };
      }

      if (action === "logs") {
        const task = getTask(taskId);
        if (!task) {
          return {
            success: false as const,
            error: `Task ${taskId} not found.`,
          };
        }
        return {
          success: true as const,
          taskId: task.id,
          command: task.command,
          status: task.status,
          logs: task.outputBuffer || "(No output logs yet)",
        };
      }

      if (action === "kill") {
        const task = getTask(taskId);
        if (!task) {
          return {
            success: false as const,
            error: `Task ${taskId} not found.`,
          };
        }
        if (task.status !== "running") {
          return {
            success: false as const,
            error: `Task ${taskId} is not running (status: ${task.status}).`,
          };
        }

        const killed = killTask(taskId);
        if (killed) {
          return {
            success: true as const,
            message: `Successfully terminated background task ${taskId}.`,
          };
        } else {
          return {
            success: false as const,
            error: `Failed to terminate task ${taskId}.`,
          };
        }
      }

      return {
        success: false as const,
        error: `Unsupported action: ${action}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error managing tasks";
      return { success: false as const, error: message };
    }
  },
});
