import { getContextMode, setContextMode, ContextMode } from "../../../config/api-keys.js";
import { CommandContext, LogEntry } from "../types.js";

export function context(ctx: CommandContext, args: string[]) {
  const mode = args[0]?.toLowerCase();
  const validModes: string[] = ["light", "default", "max", "plan"];

  if (!mode || !validModes.includes(mode)) {
    const currentMode = getContextMode();
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text: "/context" },
      {
        kind: "assistant",
        text: `Current context mode: ${currentMode}\nUsage: /context <mode>\nModes: ${validModes.join(", ")}`,
      },
    ]);
    return;
  }

  setContextMode(mode as ContextMode);
  ctx.onContextChange();

  ctx.setLog((l: LogEntry[]) => [
    ...l,
    { kind: "user", text: "/context " + mode },
    { kind: "assistant", text: `Context mode set to: ${mode}` },
  ]);
}