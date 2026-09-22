/**
 * terminal.ts — Tool surface over the persistent shell sessions.
 *
 * Layer: tools
 * Allowed imports: ./terminal-registry.js, ./types.js
 *
 * PERMISSION NOTE:
 *   Confirmation is per COMMAND, not per terminal. Approving "open a shell in
 *   frontend/" must not become standing approval for everything subsequently
 *   typed into it — that would turn one click into an unbounded grant.
 *   Creating a terminal is itself harmless (a shell sitting idle changes
 *   nothing), so only `send` and `sendKeys` prompt.
 */

import { z } from "zod";
import { tool } from "ai";
import { ConfirmFn } from "./types.js";
import {
  closeTerminal,
  createTerminal,
  getTerminal,
  listTerminals,
  readTerminal,
  sendCommand,
  sendKeys,
} from "./terminal-registry.js";

export const createTerminalTool = (confirm: ConfirmFn) => {
  return tool({
    description:
      "A persistent named shell session that KEEPS ITS STATE between commands — cwd, environment variables, " +
      "an activated venv, an nvm version. Use this for a sequence of related commands in one project directory, " +
      "and for anything that might ask an interactive question (scaffolders like 'npm create vite'), " +
      "because unlike runBash you can type an answer back with sendKeys. " +
      "Each 'send' returns the command's real exitCode — always check it. " +
      "For a single quick command use runBash; for something that never exits (a dev server) use the 'service' tool.",
    inputSchema: z.object({
      action: z
        .enum(["create", "send", "sendKeys", "read", "list", "close"])
        .describe(
          "'create' opens a shell; 'send' runs a command and waits for it; " +
            "'sendKeys' writes raw input to a running command (e.g. 'y\\n' to answer a prompt, '\\u0003' for Ctrl-C); " +
            "'read' returns output so far without sending; 'list' shows open terminals; 'close' ends one.",
        ),
      name: z
        .string()
        .optional()
        .describe("Terminal name, e.g. 'web' or 'api'. Required for everything except 'list'."),
      cwd: z
        .string()
        .optional()
        .describe("For 'create': directory relative to the workspace root. The shell stays there."),
      command: z.string().optional().describe("For 'send': the command to run."),
      keys: z.string().optional().describe("For 'sendKeys': the literal characters to write."),
      timeoutMs: z
        .number()
        .optional()
        .describe(
          "For 'send': how long to wait. Default 120000. On expiry the command keeps running and " +
            "stillRunning:true is returned — it is not killed.",
        ),
      lines: z.number().optional().describe("For 'read': how many trailing lines to return. Default 100."),
    }),
    execute: async ({ action, name, cwd, command, keys, timeoutMs, lines }) => {
      try {
        if (action === "list") {
          return {
            success: true as const,
            terminals: listTerminals().map((t) => ({
              name: t.name,
              cwd: t.cwd,
              status: t.status,
              runningCommand: t.runningCommand,
              commandsRun: t.history.length,
              startedAt: t.createdAt.toISOString(),
            })),
          };
        }

        if (!name) {
          return { success: false as const, error: `A 'name' is required for action '${action}'.` };
        }

        if (action === "create") {
          const term = createTerminal({ name, cwd });
          return {
            success: true as const,
            name: term.name,
            cwd: term.cwd,
            message: `Terminal "${name}" open in ${term.cwd}. State persists between commands.`,
          };
        }

        if (action === "close") {
          const closed = closeTerminal(name);
          return closed
            ? { success: true as const, message: `Terminal "${name}" closed.` }
            : { success: false as const, error: `No terminal named "${name}".` };
        }

        if (action === "read") {
          return { success: true as const, name, ...readTerminal(name, lines ?? 100) };
        }

        if (action === "sendKeys") {
          if (keys === undefined) {
            return { success: false as const, error: "'keys' is required for action 'sendKeys'." };
          }
          const term = getTerminal(name);
          const context = term?.runningCommand ? ` (answering: ${term.runningCommand})` : "";
          const approved = await confirm(
            `The agent wants to send input to terminal "${name}"${context}:\n  ${JSON.stringify(keys)}\nAllow?`,
          );
          if (!approved) {
            return { success: false as const, error: "User denied permission to send input." };
          }
          sendKeys(name, keys);
          return { success: true as const, message: `Sent ${JSON.stringify(keys)} to "${name}".` };
        }

        if (action === "send") {
          if (!command) {
            return { success: false as const, error: "'command' is required for action 'send'." };
          }
          const term = getTerminal(name);
          const where = term ? ` (in ${term.cwd})` : "";
          const approved = await confirm(
            `The agent wants to run the following command in terminal "${name}"${where}:\n  ${command}\nAllow?`,
          );
          if (!approved) {
            return {
              success: false as const,
              exitCode: null,
              error: "User denied permission to run this command.",
            };
          }

          const result = await sendCommand(name, command, timeoutMs);
          return {
            success: !result.stillRunning && result.exitCode === 0,
            ...result,
            ...(result.stillRunning
              ? {
                  note:
                    "Still running after the timeout — it was NOT killed. Use action 'read' to check again, " +
                    "or 'sendKeys' with '\\u0003' to interrupt it.",
                }
              : {}),
          };
        }

        return { success: false as const, error: `Unsupported action: ${action}` };
      } catch (err) {
        return {
          success: false as const,
          error: err instanceof Error ? err.message : "Unknown terminal error",
        };
      }
    },
  });
};
