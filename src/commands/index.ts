import { ModelMessage } from "ai";
import {
  ProviderChoice,
  setDefaultProvider,
  getDefaultProvider,
  setProviderModel,
  setOllamaBaseUrl,
  getOllamaBaseUrl,
  ContextMode,
  getContextMode,
  setContextMode,
} from "../config/api-keys.js";
import { addPinnedFile, clearPinnedFiles } from "../context/build-system-prompt.js";
import { getActiveModelId } from "../sdk/resolve-model.js";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

export interface SlashCommandInfo {
  command: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandInfo[] = [
  { command: "/settings", description: "Modify agent configuration (aliases: /keys)" },
  { command: "/model", description: "Switch provider and/or set custom model name" },
  { command: "/modelid", description: "Set custom model ID for the active provider" },
  { command: "/ollama", description: "Set the Ollama base URL" },
  { command: "/context", description: "Set context mode (light, default, max)" },
  { command: "/add", description: "Pin a file's contents permanently to context" },
  { command: "/file", description: "Pin a file's contents permanently to context (alias: /add)" },
  { command: "/prompt", description: "Dump the full system prompt sent to LLM" },
  { command: "/skills", description: "List available custom agent skills" },
  { command: "/clear", description: "Reset conversation history & start new session" },
  { command: "/help", description: "Show available commands & active provider" },
  { command: "/exit", description: "Close Zizou" },
];

export const WELCOME_MESSAGE = `\x1b[1m\x1b[38;2;59;95;224mZIZOU AI — Pair Programming Agent\x1b[0m

\x1b[1m\x1b[38;5;208mHow can I help you today?\x1b[0m
Ask me to edit files, run commands, or design features.

Type \x1b[38;2;59;95;224m/help\x1b[0m for all settings. Let's create something cool!`;

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
  ollama: "Ollama (local)",
};

export function getSkills(): string[] {
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
  onSelectModel?: () => void;
  onContextChange?: () => void;
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

  if (command === "exit" || command === "quit") {
    process.exit(0);
  }

  if (command === "help") {
    const provider = getDefaultProvider() || "groq";
    const modelId = getActiveModelId(provider);
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text: `Available slash commands:

  /model <provider>         Switch active provider
                            Providers: groq, google, openrouter, anthropic, openai, ollama
  /model <provider> <name>  Switch provider AND set a custom model name
                            e.g. /model groq mixtral-8x7b-32768
                            e.g. /model ollama mistral
  /modelid <name>           Set a custom model ID for the current provider
                            e.g. /modelid llama3:70b
  /ollama <url>             Set the Ollama base URL
                            e.g. /ollama http://localhost:11434
  /context <mode>           Set context mode (light, default, max)
  /add <filepath>           Pin a file's contents permanently to the system prompt
  /keys                     Change API keys / select provider
  /prompt                   Dump the full system prompt sent to the LLM
  /skills                   List available custom agent skills
  /clear                    Reset conversation history & start new session
  /exit                     Close Zizou

  Active: ${SHORT_LABELS[provider]} › ${modelId}
  Context: ${getContextMode()}`,
      },
    ]);
    return true;
  }

  if (command === "clear" || command === "reset") {
    ctx.history.current = [];
    clearPinnedFiles();
    const provider = getDefaultProvider() || "groq";
    ctx.setLog((_l: LogEntry[]) => []);
    ctx.setTokenStats(ctx.calculateTokenStats([], ctx.systemPrompt, undefined, provider));
    return true;
  }

  if (command === "keys" || command === "settings") {
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
    const validProviders: ProviderChoice[] = [
      "groq", "google", "openrouter", "anthropic", "openai", "ollama",
    ];
    const choice = args[0]?.toLowerCase() as ProviderChoice | undefined;
    const customModel = args[1]; // optional second arg: specific model name

    if (!choice) {
      if (ctx.onSelectModel) {
        ctx.onSelectModel();
        return true;
      }
      // Show current state
      const provider = getDefaultProvider() || "groq";
      const modelId = getActiveModelId(provider);
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "assistant",
          text: `Active provider: ${SHORT_LABELS[provider]}\nActive model:    ${modelId}\n\nUsage: /model <provider> [model-name]\nProviders: ${validProviders.join(", ")}`,
        },
      ]);
      return true;
    }

    if (!validProviders.includes(choice)) {
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "error",
          text: `Unknown provider "${choice}". Available: ${validProviders.join(", ")}`,
        },
      ]);
      return true;
    }

    setDefaultProvider(choice);
    if (customModel) {
      setProviderModel(choice, customModel);
    }

    const modelId = getActiveModelId(choice);
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text: `Switched to ${SHORT_LABELS[choice]} › ${modelId}${customModel ? " (custom model)" : ""}`,
      },
    ]);
    ctx.setTokenStats(
      ctx.calculateTokenStats(ctx.history.current, ctx.systemPrompt, undefined, choice)
    );
    return true;
  }

  if (command === "modelid") {
    const modelName = args[0];
    if (!modelName) {
      const provider = getDefaultProvider() || "groq";
      const modelId = getActiveModelId(provider);
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "assistant",
          text: `Current model ID: ${modelId}\nUsage: /modelid <model-name>  — sets a custom model for the current provider`,
        },
      ]);
      return true;
    }
    const provider = getDefaultProvider() || "groq";
    setProviderModel(provider, modelName);
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text: `Model for ${SHORT_LABELS[provider]} set to: ${modelName}`,
      },
    ]);
    return true;
  }

  if (command === "ollama") {
    const url = args[0];
    if (!url) {
      const current = getOllamaBaseUrl();
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "assistant",
          text: `Ollama base URL: ${current}\nUsage: /ollama <url>  — e.g. /ollama http://192.168.1.10:11434`,
        },
      ]);
      return true;
    }
    setOllamaBaseUrl(url);
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      { kind: "assistant", text: `Ollama base URL set to: ${url}` },
    ]);
    return true;
  }

  if (command === "context") {
    const mode = args[0]?.toLowerCase() as ContextMode | undefined;
    const validModes: ContextMode[] = ["light", "default", "max"];

    if (!mode || !validModes.includes(mode)) {
      const current = getContextMode();
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "assistant",
          text: `Current context mode: ${current}\nUsage: /context <mode>\nModes: ${validModes.join(", ")}\n\n  light   - Minimal prompt, no repo map (best for 3B/4B models)\n  default - Standard repo map\n  max     - Expanded repo map`,
        },
      ]);
      return true;
    }

    setContextMode(mode);
    if (ctx.onContextChange) {
      ctx.onContextChange();
    }
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      { kind: "assistant", text: `Context mode set to: ${mode}. System prompt will be regenerated.` },
    ]);
    return true;
  }

  if (command === "skills") {
    const skillsList = getSkills();
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text:
          skillsList.length > 0
            ? `Available agent skills:\n` + skillsList.map((s) => `  • ${s}`).join("\n")
            : `No custom agent skills found in customizations directories.`,
      },
    ]);
    return true;
  }

  if (command === "add" || command === "file") {
    const filePath = args.join(" ");
    if (!filePath) {
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: `Usage: /${command} <filepath>\nPins a file to the system prompt so the AI always has its contents in context.` },
      ]);
      return true;
    }
    
    try {
      const absolutePath = addPinnedFile(process.cwd(), filePath);
      if (ctx.onContextChange) {
        ctx.onContextChange();
      }
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: `Pinned file to context: ${absolutePath}\nSystem prompt regenerating...` },
      ]);
    } catch (err: any) {
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "error", text: err.message },
      ]);
    }
    return true;
  }

  // Fallback for unknown slash command
  ctx.setLog((l: LogEntry[]) => [
    ...l,
    { kind: "user", text },
    { kind: "error", text: `Unknown command: /${command}. Type /help for available commands.` },
  ]);
  return true;
}


