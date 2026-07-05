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
import {
  createSession,
  listSessions,
  switchSession,
  deleteSession,
  getActiveSession,
  getActiveSessionId,
} from "../session/registry.js";
import { revertSession, listSessionCommits, gitGetDiff } from "../git/git.js";
import type { ConfirmFn } from "../tools/index.js";

export interface SlashCommandInfo {
  command: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandInfo[] = [
  { command: "/settings", description: "Modify agent configuration (aliases: /keys)" },
  { command: "/plan", description: "Switch to plan mode (clarify → plan → execute → verify)" },
  { command: "/build", description: "Switch to build mode (single-step execution)" },
  { command: "/model", description: "Switch provider and/or set custom model name" },
  { command: "/modelid", description: "Set custom model ID for the active provider" },
  { command: "/ollama", description: "Set the Ollama base URL" },
  { command: "/context", description: "Set context mode (light, default, max)" },
  { command: "/add", description: "Pin a file's contents permanently to context" },
  { command: "/file", description: "Pin a file's contents permanently to context (alias: /add)" },
  { command: "/prompt", description: "Dump the full system prompt sent to LLM" },
  { command: "/skills", description: "List available custom agent skills" },
  { command: "/clear", description: "Reset conversation history & start new session" },
  { command: "/session", description: "Session management (new, list, switch, delete)" },
  { command: "/revert", description: "Revert session to a previous step" },
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
  /** Callback to switch between build and plan mode from within the TUI. */
  onModeChange?: (mode: "build" | "plan") => void;
  /** Returns the current mode so /help can display it. */
  getCurrentMode?: () => "build" | "plan";
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
export async function handleSlashCommand(ctx: CommandContext): Promise<boolean> {
  const text = ctx.userText.trim();
  if (!text.startsWith("/")) return false;

  const parts = text.slice(1).split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (command === "exit" || command === "quit") {
    process.exit(0);
  }

  // ── /plan and /build — switch orchestrator mode ────────────────────────
  // Toggles between the two operating modes from within the TUI.
  // /plan  → full pipeline: clarifier → planner → execute → verify
  // /build → single-step execution (default)
  if (command === "plan") {
    if (ctx.onModeChange) {
      ctx.onModeChange("plan");
    }
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text: `Switched to ◆ Plan mode.\nYour next prompt will run: clarify → plan → confirm → execute → verify.\nUse /build to switch back to single-step mode.`,
      },
    ]);
    return true;
  }

  if (command === "build") {
    if (ctx.onModeChange) {
      ctx.onModeChange("build");
    }
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text: `Switched to ● Build mode.\nYour next prompt will execute directly as a single step.\nUse /plan to switch to multi-step planning mode.`,
      },
    ]);
    return true;
  }

  if (command === "help") {
    const provider = getDefaultProvider() || "groq";
    const modelId = getActiveModelId(provider);
    const currentMode = ctx.getCurrentMode ? ctx.getCurrentMode() : "build";
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text: `Available slash commands:

  /plan                     Switch to plan mode (clarify → plan → execute → verify)
  /build                    Switch to build mode (single-step execution)
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

  Mode:    ${currentMode === "plan" ? "◆ Plan" : "● Build"}
  Active:  ${SHORT_LABELS[provider]} › ${modelId}
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

  // ── /session — session management ───────────────────────────────────────
  if (command === "session") {
    const subCommand = args[0]?.toLowerCase();
    const sessionArg = args[1];

    if (!subCommand) {
      const active = getActiveSession();
      const sessions = listSessions();
      
      let output = "Session Management\n\n";
      if (active) {
        output += `Active: ${active.name} (last active: ${new Date(active.lastActiveAt).toLocaleString()})\n\n`;
      } else {
        output += "Active: none\n\n";
      }
      
      if (sessions.length === 0) {
        output += "No sessions exist. Use /session new <name> to create one.";
      } else {
        output += "All sessions:\n";
        for (const session of sessions) {
          const isActive = active?.id === session.id ? " [ACTIVE]" : "";
          output += `  • ${session.name}${isActive} (created: ${new Date(session.createdAt).toLocaleDateString()})\n`;
        }
      }
      
      output += "\nUsage:\n  /session new <name>     Create a new session\n  /session list           List all sessions\n  /session switch <name>   Switch to a session\n  /session delete <name>   Delete a session";
      
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: output },
      ]);
      return true;
    }

    if (subCommand === "new") {
      if (!sessionArg) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: "Usage: /session new <name>" },
        ]);
        return true;
      }

      try {
        const session = createSession(sessionArg);
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: `Created session "${session.name}" and set as active.` },
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

    if (subCommand === "list") {
      const active = getActiveSession();
      const sessions = listSessions();
      
      let output = "Sessions:\n\n";
      if (sessions.length === 0) {
        output += "No sessions exist. Use /session new <name> to create one.";
      } else {
        for (const session of sessions) {
          const isActive = active?.id === session.id ? " [ACTIVE]" : "";
          const lastActive = new Date(session.lastActiveAt).toLocaleString();
          output += `  • ${session.name}${isActive}\n    Last active: ${lastActive}\n`;
        }
      }
      
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: output },
      ]);
      return true;
    }

    if (subCommand === "switch") {
      if (!sessionArg) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: "Usage: /session switch <name>" },
        ]);
        return true;
      }

      try {
        switchSession(sessionArg);
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: `Switched to session "${sessionArg}".` },
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

    if (subCommand === "delete") {
      if (!sessionArg) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: "Usage: /session delete <name>" },
        ]);
        return true;
      }

      try {
        deleteSession(sessionArg);
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: `Deleted session "${sessionArg}". State archived to .deleted/` },
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

    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      { kind: "error", text: `Unknown session subcommand: ${subCommand}. Use /session for help.` },
    ]);
    return true;
  }

  // ── /revert — revert session to previous step ─────────────────────────────
  if (command === "revert") {
    const activeSessionId = getActiveSessionId();
    if (!activeSessionId) {
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "error", text: "No active session. Use /session new <name> to create one." },
      ]);
      return true;
    }

    const subCommand = args[0]?.toLowerCase();
    const target = args[1];

    if (subCommand === "list") {
      const commits = listSessionCommits(activeSessionId);
      if (commits.length === 0) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: "No commits found for this session." },
        ]);
        return true;
      }

      let output = "Session commits:\n\n";
      for (const commit of commits) {
        output += `  Step ${commit.stepIndex}: ${commit.description}\n    SHA: ${commit.sha}\n    Time: ${new Date(commit.timestamp).toLocaleString()}\n`;
      }
      
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: output },
      ]);
      return true;
    }

    if (subCommand === "diff") {
      const commits = listSessionCommits(activeSessionId);
      if (commits.length === 0) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: "No commits found for this session." },
        ]);
        return true;
      }

      let diffTarget: string | undefined;
      
      if (target !== undefined) {
        const numTarget = parseInt(target, 10);
        if (!isNaN(numTarget)) {
          // Find commit by step index
          const commit = commits.find(c => c.stepIndex === numTarget);
          if (!commit) {
            ctx.setLog((l: LogEntry[]) => [
              ...l,
              { kind: "user", text },
              { kind: "error", text: `Step ${numTarget} not found in session history.` },
            ]);
            return true;
          }
          diffTarget = commit.sha;
        } else {
          // Use as SHA directly
          const commit = commits.find(c => c.sha.startsWith(target));
          if (!commit) {
            ctx.setLog((l: LogEntry[]) => [
              ...l,
              { kind: "user", text },
              { kind: "error", text: `Commit ${target} not found in session history.` },
            ]);
            return true;
          }
          diffTarget = commit.sha;
        }
      }

      try {
        const diff = gitGetDiff(diffTarget);
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: `Changes${diffTarget ? ` for commit ${diffTarget.slice(0, 8)}` : " in last commit"}:\n\n${diff}` },
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

    if (subCommand === "to" || subCommand === undefined) {
      const revertTarget = subCommand === "to" ? target : undefined;
      
      // Parse target: could be a number (stepIndex) or string (SHA)
      let parsedTarget: number | string | undefined;
      if (revertTarget !== undefined) {
        const numTarget = parseInt(revertTarget, 10);
        if (!isNaN(numTarget)) {
          parsedTarget = numTarget;
        } else {
          parsedTarget = revertTarget;
        }
      }

      try {
        // Use the confirmFn from context if available
        const confirmFn: ConfirmFn = (description) => {
          return new Promise((resolve) => {
            // We can't directly set pendingConfirm here since we're in a command handler
            // For now, we'll skip confirmation in CLI mode
            resolve(true);
          });
        };

        await revertSession(activeSessionId, parsedTarget, confirmFn);
        
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: `Reverted to ${parsedTarget !== undefined ? `step ${parsedTarget}` : "previous step"}.` },
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

    // Show usage if no subcommand
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      { kind: "assistant", text: "Usage:\n  /revert              Revert to previous step\n  /revert to <n>       Revert to step number n\n  /revert to <sha>     Revert to commit SHA\n  /revert list         Show all commits\n  /revert diff          Show changes in last commit\n  /revert diff <n>     Show changes in step n\n  /revert diff <sha>   Show changes in commit" },
    ]);
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


