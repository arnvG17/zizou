import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { tool } from "ai";

const execAsync = promisify(exec);

async function findProcessOnPort(port: number): Promise<{ pid: number; name?: string; details?: string }[]> {
  const results: { pid: number; name?: string; details?: string }[] = [];

  if (process.platform === "win32") {
    try {
      // Find PID using netstat (faster and always works without admin rights)
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
      const lines = stdout.split("\n");
      const pids = new Set<number>();

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          // Local address is parts[1] (e.g. 0.0.0.0:3000)
          const localAddr = parts[1];
          if (localAddr.endsWith(`:${port}`)) {
            const pid = parseInt(parts[parts.length - 1], 10);
            if (!isNaN(pid) && pid > 0) {
              pids.add(pid);
            }
          }
        }
      }

      for (const pid of pids) {
        let name = "Unknown";
        let details = "";
        try {
          // Get process details using tasklist
          const { stdout: taskStdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /NH`);
          const taskParts = taskStdout.trim().split(/\s+/);
          if (taskParts.length > 0 && taskParts[0] !== "INFO:") {
            name = taskParts[0];
          }
          details = `PID: ${pid}, Name: ${name}`;
        } catch {
          details = `PID: ${pid}`;
        }
        results.push({ pid, name, details });
      }
    } catch {
      // ignore failures (usually means no process listening)
    }
  } else {
    try {
      // macOS/Linux: use lsof
      const { stdout } = await execAsync(`lsof -i :${port} -F p c`);
      const lines = stdout.trim().split("\n");
      let currentPid: number | null = null;
      
      for (const line of lines) {
        if (line.startsWith("p")) {
          currentPid = parseInt(line.substring(1), 10);
        } else if (line.startsWith("c") && currentPid !== null) {
          const name = line.substring(1);
          results.push({
            pid: currentPid,
            name,
            details: `PID: ${currentPid}, Command: ${name}`,
          });
          currentPid = null;
        }
      }

      // If no name found but PIDs found
      if (results.length === 0 && lines.length > 0) {
        const pids = lines
          .filter(l => l.startsWith("p"))
          .map(l => parseInt(l.substring(1), 10))
          .filter(pid => !isNaN(pid));
        for (const pid of pids) {
          results.push({ pid, details: `PID: ${pid}` });
        }
      }
    } catch {
      // ignore failures
    }
  }

  return results;
}

async function killProcess(pid: number): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await execAsync(`taskkill /F /PID ${pid}`);
    } else {
      await execAsync(`kill -9 ${pid}`);
    }
    return true;
  } catch {
    return false;
  }
}

export const managePorts = tool({
  description:
    "Find and terminate processes listening on a specific port. " +
    "Useful for resolving 'Port already in use' errors during web server startup.",
  inputSchema: z.object({
    action: z
      .enum(["find", "kill"])
      .describe("Action to perform: 'find' (view what process is on the port), 'kill' (terminate the process on the port)"),
    port: z.number().describe("The local port number (e.g. 3000, 8080)"),
  }),
  execute: async ({ action, port }) => {
    try {
      if (action === "find") {
        const found = await findProcessOnPort(port);
        if (found.length === 0) {
          return {
            success: true as const,
            message: `No active processes found listening on port ${port}.`,
            processes: [],
          };
        }
        return {
          success: true as const,
          message: `Found ${found.length} process(es) listening on port ${port}.`,
          processes: found,
        };
      }

      if (action === "kill") {
        const found = await findProcessOnPort(port);
        if (found.length === 0) {
          return {
            success: false as const,
            error: `No active processes found listening on port ${port} to terminate.`,
          };
        }

        const killedPids: number[] = [];
        const failedPids: number[] = [];

        for (const proc of found) {
          const ok = await killProcess(proc.pid);
          if (ok) {
            killedPids.push(proc.pid);
          } else {
            failedPids.push(proc.pid);
          }
        }

        if (failedPids.length > 0) {
          return {
            success: false as const,
            error: `Successfully killed PID(s) ${killedPids.join(", ")}, but failed to kill PID(s) ${failedPids.join(", ")}.`,
          };
        }

        return {
          success: true as const,
          message: `Successfully terminated all process(es) on port ${port} (PID(s): ${killedPids.join(", ")}).`,
        };
      }

      return {
        success: false as const,
        error: `Unsupported action: ${action}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error managing ports";
      return { success: false as const, error: message };
    }
  },
});
