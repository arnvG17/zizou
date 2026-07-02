import { context } from "./context/context.js";
import { CommandContext, LogEntry } from "./types.js";

export function handleSlashCommand(ctx: CommandContext): boolean {
  if (!ctx.userText.startsWith("/")) {
    return false;
  }

  const parts = ctx.userText.trim().slice(1).split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  if (command === "context") {
    context(ctx, args);
    return true;
  }

  // Handle unrecognized slash commands
  ctx.setLog((l: LogEntry[]) => [
    ...l,
    { kind: "user", text: ctx.userText },
    { kind: "error", text: `Unknown command: /${command}` },
  ]);
  return true;
}