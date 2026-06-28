import { ChildProcess } from "node:child_process";

export interface BackgroundTask {
  id: string;
  command: string;
  pid: number | undefined;
  status: "running" | "exited" | "failed";
  exitCode: number | null;
  outputBuffer: string;
  startTime: Date;
  process: ChildProcess;
}

const tasks = new Map<string, BackgroundTask>();
let taskIdCounter = 1;

// Maximum number of characters to keep in the in-memory output buffer per task (approx 100-200 lines)
const MAX_BUFFER_LENGTH = 10000;

export function registerTask(command: string, process: ChildProcess): BackgroundTask {
  const id = `task_${taskIdCounter++}`;
  
  const task: BackgroundTask = {
    id,
    command,
    pid: process.pid,
    status: "running",
    exitCode: null,
    outputBuffer: "",
    startTime: new Date(),
    process,
  };

  const appendToBuffer = (data: string) => {
    task.outputBuffer += data;
    if (task.outputBuffer.length > MAX_BUFFER_LENGTH) {
      task.outputBuffer = task.outputBuffer.slice(task.outputBuffer.length - MAX_BUFFER_LENGTH);
    }
  };

  // Handle stream outputs
  process.stdout?.setEncoding("utf-8");
  process.stdout?.on("data", (chunk) => {
    appendToBuffer(chunk);
  });

  process.stderr?.setEncoding("utf-8");
  process.stderr?.on("data", (chunk) => {
    appendToBuffer(chunk);
  });

  // Handle process completion/failure
  process.on("close", (code) => {
    task.exitCode = code;
    task.status = code === 0 ? "exited" : "failed";
  });

  process.on("error", (err) => {
    task.status = "failed";
    appendToBuffer(`\n[Task Registry Error]: ${err.message}\n`);
  });

  tasks.set(id, task);
  return task;
}

export function getTask(id: string): BackgroundTask | undefined {
  return tasks.get(id);
}

export function listTasks(): Omit<BackgroundTask, "process">[] {
  return Array.from(tasks.values()).map(({ id, command, pid, status, exitCode, outputBuffer, startTime }) => ({
    id,
    command,
    pid,
    status,
    exitCode,
    outputBuffer,
    startTime,
  }));
}

export function killTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.status !== "running") return false;

  try {
    if (process.platform === "win32") {
      // Windows: use taskkill to kill the process tree of the child process
      const { execSync } = require("node:child_process");
      execSync(`taskkill /pid ${task.process.pid} /T /F`, { stdio: "ignore" });
    } else {
      // Unix: kill process group if possible, or process directly
      task.process.kill("SIGTERM");
      setTimeout(() => {
        if (task.status === "running") {
          task.process.kill("SIGKILL");
        }
      }, 2000);
    }
    task.status = "exited";
    return true;
  } catch (err) {
    // Fallback: direct kill
    try {
      task.process.kill();
      task.status = "exited";
      return true;
    } catch {
      return false;
    }
  }
}

// Graceful cleanup on exit
function cleanup() {
  for (const [id, task] of tasks.entries()) {
    if (task.status === "running") {
      try {
        if (process.platform === "win32") {
          const { execSync } = require("node:child_process");
          execSync(`taskkill /pid ${task.process.pid} /T /F`, { stdio: "ignore" });
        } else {
          task.process.kill("SIGKILL");
        }
      } catch {}
    }
  }
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
