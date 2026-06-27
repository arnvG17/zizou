import { ModelMessage } from "ai";
import { ProviderChoice, setDefaultProvider, getDefaultProvider } from "../config/api-keys.js";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

// Types matching the Chat UI state
export type LogEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; thoughtDuration?: string }
  | {
      kind: "tool-call";
      toolCallId: string;
      name: string;
      input: unknown;
      startTime: number;
      duration?: string;
      status: "running" | "success" | "error";
    }
  | { kind: "error"; text: string };

const SHORT_LABELS: Record<ProviderChoice, string> = {
  groq: "Groq",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

function getSkills(): string[] {
  const skills: string[] = [];
  const globalPath = "C:\\Users\\Arnv\\.gemini\\config\\skills";
  const localPath = join(process.cwd(), ".agents", "skills");

  if (existsSync(globalPath)) {
    try {
      const entries = readdirSync(globalPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) skills.push(`global:${entry.name}`);
      }
    } catch {}
  }
  if (existsSync(localPath)) {
    try {
      const entries = readdirSync(localPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) skills.push(`workspace:${entry.name}`);
      }
    } catch {}
  }
  return skills;
}

export interface CommandContext {
  userText: string;
  history: { current: ModelMessage[] };
  systemPrompt: string;
  systemPromptText: string;
  onChangeKeys?: () => void;
  setLog: (updater: (prev: LogEntry[]) => LogEntry[]) => void;
  setTokenStats: (stats: any) => void;
  calculateTokenStats: (
    history: ModelMessage[],
    systemPrompt: string,
    actualUsage?: { inputTokens: number; outputTokens: number },
    provider?: ProviderChoice
  ) => any;
}

/**
 * Intercepts user input and executes a slash command if one is detected.
 * Returns true if a command was handled, false otherwise.
 */
export function handleSlashCommand(ctx: CommandContext): boolean {
  const text = ctx.userText.trim();
  if (!text.startsWith("/")) return false;

  const parts = text.slice(1).split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (command === "exit") {
    process.exit(0);
  }

  if (command === "help") {
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text: `Available commands:
  /model <name>  - Switch active provider (groq, google, openrouter, anthropic, openai)
  /keys          - Change API keys / select provider
  /prompt        - Dump the full system prompt sent to the LLM
  /skills        - List available custom agent skills
  /clear         - Reset conversation history & start new session
  /exit          - Close Zizou
  /help          - Show this command list`,
      },
    ]);
    return true;
  }

  if (command === "clear" || command === "reset") {
    ctx.history.current = [];
    const provider = getDefaultProvider() || "groq";
    ctx.setLog((l: LogEntry[]) => [
      { kind: "assistant", text: "Conversation history cleared. Starting a new session." }
    ]);
    ctx.setTokenStats(ctx.calculateTokenStats([], ctx.systemPrompt, undefined, provider));
    return true;
  }

  if (command === "keys") {
    if (ctx.onChangeKeys) {
      ctx.onChangeKeys();
    }
    return true;
  }

  if (command === "prompt") {
    const prompt = ctx.systemPromptText || ctx.systemPrompt;
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text: prompt
          ? `--- SYSTEM PROMPT (${prompt.length.toLocaleString()} chars) ---\n${prompt}\n--- END SYSTEM PROMPT ---`
          : "System prompt is not yet loaded.",
      },
    ]);
    return true;
  }

  if (command === "model") {
    const choice = args[0]?.toLowerCase() as ProviderChoice | undefined;
    const validProviders: ProviderChoice[] = ["groq", "google", "openrouter", "anthropic", "openai"];
    
    if (choice && validProviders.includes(choice)) {
      setDefaultProvider(choice);
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: `Active model switched to ${SHORT_LABELS[choice]}.` }
      ]);
      // Recalculate stats for the new provider
      ctx.setTokenStats(ctx.calculateTokenStats(ctx.history.current, ctx.systemPrompt, undefined, choice));
    } else {
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "assistant",
          text: `Usage: /model <provider-name>
Available providers: groq, google, openrouter, anthropic, openai
Active provider: ${SHORT_LABELS[getDefaultProvider() || "groq"]}`,
        },
      ]);
    }
    return true;
  }

  if (command === "skills") {
    const skillsList = getSkills();
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text: skillsList.length > 0
          ? `Available agent skills:\n` + skillsList.map(s => `  • ${s}`).join("\n")
          : `No custom agent skills found in customizations directories.`,
      },
    ]);
    return true;
  }

  // Fallback for unknown slash command
  ctx.setLog((l: LogEntry[]) => [
    ...l,
    { kind: "user", text },
    { kind: "error", text: `Unknown command: /${command}. Type /help for assistance.` },
  ]);
  return true;
}
