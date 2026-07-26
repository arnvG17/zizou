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
import {
  getAIConfig,
  setAIConfig,
  applyPreset,
  writeModelConfigMd,
  PROVIDER_PRESETS,
  PRESET_DEFAULTS,
  type PresetName,
  type ReasoningLevel,
} from "../config/ai-config.js";
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
import {
  listCheckpoints,
  restoreCheckpoint,
  createBranch,
  switchBranch,
  listBranches,
  getActiveBranch,
  diffCheckpoints,
  deleteCheckpoint,
  getLocalChanges,
  revertLocalChanges,
  computeLineDiff,
  getSessionChanges,
  revertSessionChanges,
  formatColoredDiff,
} from "../checkpoint/manager.js";
import type { ConfirmFn } from "../tools/index.js";
import { sessionPermissions } from "../tools/index.js";
import type { FilePatch } from "../checkpoint/types.js";

export interface SlashCommandInfo {
  command: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandInfo[] = [
  { command: "/settings", description: "Modify agent configuration (aliases: /keys)" },
  { command: "/plan", description: "Switch to plan mode (clarify → plan → execute → verify)" },
  { command: "/build", description: "Switch to build mode (single-step execution)" },
  { command: "/model", description: "Switch provider and/or set custom model name" },
  { command: "/models", description: "List all available model options for all providers" },
  { command: "/modelid", description: "Set custom model ID for the active provider" },
  { command: "/ollama", description: "Set the Ollama base URL" },
  { command: "/context", description: "Set context mode (light, default, max)" },
  { command: "/expert", description: "Configure AI model presets and inference params" },
  { command: "/reasoning", description: "Set reasoning level (low, medium, high) for any model" },
  { command: "/add", description: "Pin a file's contents permanently to context" },
  { command: "/file", description: "Pin a file's contents permanently to context (alias: /add)" },
  { command: "/prompt", description: "Dump the full system prompt sent to LLM" },
  { command: "/skills", description: "List available custom agent skills" },
  { command: "/clear", description: "Reset conversation history & start new session" },
  { command: "/session", description: "Session management (new, list, switch, delete)" },
  { command: "/checkpoint", description: "Checkpoint management (list, diff, restore, branch, switch, delete, revert)" },
  { command: "/permissions", description: "View or clear active session permissions" },
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
  /** Callback to update session name in UI when session changes. */
  onSessionChange?: (sessionName: string) => void;
  setLog: (updater: (prev: LogEntry[]) => LogEntry[]) => void;
  setTokenStats: (stats: any) => void;
  calculateTokenStats: (
    history: ModelMessage[],
    systemPrompt: string,
    actualUsage?: { inputTokens: number; outputTokens: number },
    provider?: ProviderChoice
  ) => any;
}

function resolveReasoningLevel(input: string | undefined): ReasoningLevel | undefined {
  const normalized = input?.toLowerCase();
  if (normalized === "low" || normalized === "lo") return "low";
  if (normalized === "high" || normalized === "hig") return "high";
  if (normalized === "medium" || normalized === "med" || normalized === "mid" || normalized === "midoue") return "medium";
  return undefined;
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
  /models                   List all available model options for all providers
  /modelid <name>           Set a custom model ID for the current provider
                            e.g. /modelid llama3:70b
  /expert                   Show AI config (model, preset, temperature, max tokens)
  /expert <preset>          Apply a preset: fast | balanced | high | testing
  /expert provider <name>   Switch provider and apply balanced preset
  /expert model <id>        Override model ID for current provider
  /expert reasoning <lvl>   Set reasoning: low | medium | high
  /expert temperature <n>   Set temperature (0.0–1.0)
  /expert maxtokens <n>     Set max output tokens
  /reasoning <lvl>          Shortcut: set reasoning level (low | medium | high)
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
  Context: ${getContextMode()}
  Expert:  preset=${getAIConfig().preset}, temp=${getAIConfig().temperature}, maxTokens=${getAIConfig().maxOutputTokens}, reasoning=${getAIConfig().reasoning}`,
      },
    ]);
    return true;
  }

  if (command === "clear" || command === "reset") {
    ctx.history.current = [];
    clearPinnedFiles();
    sessionPermissions.reset();
    const provider = getDefaultProvider() || "groq";
    ctx.setLog((_l: LogEntry[]) => []);
    ctx.setTokenStats(ctx.calculateTokenStats([], ctx.systemPrompt, undefined, provider));
    
    // Create a new session for the fresh start
    try {
      const session = createSession("Untitled");
      ctx.onSessionChange?.(session.name);
    } catch (error) {
      // If session creation fails, continue anyway (session system might not be available)
      console.warn("Failed to create new session on clear:", error);
    }
    
    return true;
  }

  if (command === "permissions") {
    const sub = args[0]?.toLowerCase();
    if (sub === "clear" || sub === "reset") {
      sessionPermissions.reset();
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: "Session permissions have been reset. Permission prompts will appear again when tools are called." },
      ]);
      return true;
    }

    const summary = sessionPermissions.getSummary();
    const fileList = summary.files.length > 0 ? summary.files.map(f => `  - ${f}`).join("\n") : "  (none)";
    const cmdList = summary.commands.length > 0 ? summary.commands.map(c => `  - ${c}`).join("\n") : "  (none)";

    const textOut = `Active Session Permissions:

Allowed Files (${summary.files.length}):
${fileList}

Allowed Commands (${summary.commands.length}):
${cmdList}

(Use /permissions clear to reset permissions for this session)`;

    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      { kind: "assistant", text: textOut },
    ]);
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

  if (command === "models") {
    const list =
      `Available Models by Provider:\n` +
      `${"-".repeat(40)}\n` +
      `openai      - gpt-4o-mini (default), gpt-4o, o1-mini\n` +
      `groq        - llama-3.3-70b-versatile (default), mixtral-8x7b-32768, llama-3.1-8b-instant, gemma2-9b-it\n` +
      `google      - gemini-2.5-flash (default), gemini-2.5-pro, gemini-2.0-flash, gemini-1.5-pro, gemini-1.5-flash\n` +
      `anthropic   - claude-3-5-sonnet-latest (default), claude-3-5-haiku-latest, claude-3-opus-20240229\n` +
      `openrouter  - google/gemma-4-31b-it:free (default), meta-llama/llama-3.3-70b-instruct:free, deepseek/deepseek-chat\n` +
      `ollama      - llama3 (default), mistral, phi3\n\n` +
      `Use "/model <provider> [model-name]" to switch, or "/modelid <model-name>" to set a custom ID.`;

    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      { kind: "assistant", text: list },
    ]);
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
        ctx.onSessionChange?.(session.name);
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
        const session = switchSession(sessionArg);
        ctx.onSessionChange?.(session.name);
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: `Switched to session "${session.name}".` },
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

  // ── /checkpoint — checkpoint management ─────────────────────────────────────
  if (command === "checkpoint") {
    const subCommand = args[0]?.toLowerCase();
    const target = args[1];
    const target2 = args[2];

    if (subCommand === "list") {
      const checkpoints = listCheckpoints();
      const branches = listBranches();
      const activeBranch = getActiveBranch();

      if (checkpoints.length === 0) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: "No checkpoints found." },
        ]);
        return true;
      }

      let output = "Checkpoints:\n\n";
      for (const checkpoint of checkpoints) {
        const branch = branches.find(b => b.id === checkpoint.branchId);
        const branchName = branch?.name || "unknown";
        const isActive = activeBranch?.id === checkpoint.branchId ? " [ACTIVE]" : "";
        output += `  Step ${checkpoint.stepIndex}: ${checkpoint.description}\n    ID: ${checkpoint.id.slice(0, 8)}\n    Branch: ${branchName}${isActive}\n    Time: ${new Date(checkpoint.timestamp).toLocaleString()}\n`;
      }
      
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: output },
      ]);
      return true;
    }

    if (subCommand === "diff") {
      const checkpoints = listCheckpoints();

      // Check if --full or -f is specified anywhere in the checkpoint args
      const showFull = args.some(arg => arg.toLowerCase() === "--full" || arg.toLowerCase() === "-f");
      const cleanArgs = args.filter(arg => arg.toLowerCase() !== "--full" && arg.toLowerCase() !== "-f");
      const target = cleanArgs[1];
      const target2 = cleanArgs[2];

      if (!target || target === "session") {
        // Show local changes
        const isFullSession = target === "session";
        const changes = isFullSession ? getSessionChanges() : getLocalChanges();
        const activeBranch = getActiveBranch();
        const headId = activeBranch?.headCheckpointId ? activeBranch.headCheckpointId.slice(0, 8) : "none";
        const branchName = activeBranch ? activeBranch.name : "unknown";
        
        if (changes.length === 0) {
          ctx.setLog((l: LogEntry[]) => [
            ...l,
            { kind: "user", text },
            { kind: "assistant", text: isFullSession
                ? `No changes found in the entire session for branch "${branchName}".`
                : `No uncommitted local changes since checkpoint ${headId}.`
            },
          ]);
          return true;
        }

        let output = isFullSession
          ? `Complete changes for the full session on branch "${branchName}":\n\n`
          : `Uncommitted local changes since checkpoint ${headId}:\n\n`;
          
        for (const change of changes) {
          output += `=== ${change.operation.toUpperCase()}: ${change.filePath} ===\n`;
          const diff = formatColoredDiff(change.filePath, change.operation, change.oldContent, change.newContent, showFull);
          output += diff + "\n\n";
        }

        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: output.trim() },
        ]);
        return true;
      }

      if (checkpoints.length === 0) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: "No checkpoints found." },
        ]);
        return true;
      }

      // Find checkpoint by ID or step index
      let fromCheckpoint: typeof checkpoints[0] | undefined;
      let toCheckpoint: typeof checkpoints[0] | undefined;

      if (target2) {
        // Two targets provided: diff between them
        fromCheckpoint = checkpoints.find(c => c.id.startsWith(target) || c.stepIndex.toString() === target);
        toCheckpoint = checkpoints.find(c => c.id.startsWith(target2) || c.stepIndex.toString() === target2);
      } else {
        // One target: diff from its parent to this target
        toCheckpoint = checkpoints.find(c => c.id.startsWith(target) || c.stepIndex.toString() === target);
        if (toCheckpoint) {
          const targetCheckpoint = toCheckpoint;
          fromCheckpoint = checkpoints.find(c => c.id === targetCheckpoint.parentId);
        }
      }

      if (!toCheckpoint) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: `Checkpoint ${target} not found.` },
        ]);
        return true;
      }

      try {
        let patches: FilePatch[] = [];
        let fromDesc = "root";
        if (fromCheckpoint) {
          patches = diffCheckpoints(fromCheckpoint.id, toCheckpoint.id);
          fromDesc = fromCheckpoint.id.slice(0, 8);
        } else {
          patches = toCheckpoint.patches;
        }

        let output = `Changes from ${fromDesc} to ${toCheckpoint.id.slice(0, 8)} (${toCheckpoint.description}):\n\n`;
        if (patches.length === 0) {
          output += "  No changes found.\n";
        } else {
          for (const patch of patches) {
            output += `=== ${patch.operation.toUpperCase()}: ${patch.filePath} ===\n`;
            const diff = formatColoredDiff(patch.filePath, patch.operation, patch.oldContent, patch.newContent, showFull);
            output += diff + "\n\n";
          }
        }
        
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: output.trim() },
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

    if (subCommand === "revert") {
      const isFullSession = target?.toLowerCase() === "session";
      const changes = isFullSession ? getSessionChanges() : getLocalChanges();
      
      if (changes.length === 0) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: isFullSession
              ? "No changes in the session to revert."
              : "No uncommitted local changes to revert."
          },
        ]);
        return true;
      }

      try {
        if (isFullSession) {
          revertSessionChanges();
        } else {
          revertLocalChanges();
        }
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: isFullSession
              ? `Successfully reverted all ${changes.length} change(s) from the full session back to its start.`
              : `Successfully reverted ${changes.length} file change(s) in the workspace back to the head checkpoint.`
          },
        ]);
      } catch (err: any) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: `Failed to revert changes: ${err.message}` },
        ]);
      }
      return true;
    }

    if (subCommand === "restore") {
      if (!target) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: "Usage: /checkpoint restore <checkpoint-id>" },
        ]);
        return true;
      }

      const checkpoints = listCheckpoints();
      const checkpoint = checkpoints.find(c => c.id.startsWith(target) || c.stepIndex.toString() === target);

      if (!checkpoint) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: `Checkpoint ${target} not found.` },
        ]);
        return true;
      }

      try {
        restoreCheckpoint(checkpoint.id);
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: `Restored to checkpoint: ${checkpoint.description}` },
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

    if (subCommand === "branch") {
      if (!target) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: "Usage: /checkpoint branch <name> [from-checkpoint-id]" },
        ]);
        return true;
      }

      const checkpoints = listCheckpoints();
      const fromCheckpointId = target2 
        ? checkpoints.find(c => c.id.startsWith(target2) || c.stepIndex.toString() === target2)?.id
        : (getActiveBranch()?.headCheckpointId || checkpoints[checkpoints.length - 1]?.id);

      if (!fromCheckpointId) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: "No checkpoint to branch from." },
        ]);
        return true;
      }

      try {
        const branch = createBranch(target, fromCheckpointId);
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: `Created branch "${branch.name}" from checkpoint ${fromCheckpointId.slice(0, 8)}` },
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

    if (subCommand === "switch") {
      if (!target) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: "Usage: /checkpoint switch <branch-name>" },
        ]);
        return true;
      }

      const branches = listBranches();
      const branch = branches.find(b => b.name === target || b.id.startsWith(target));

      if (!branch) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: `Branch ${target} not found.` },
        ]);
        return true;
      }

      try {
        switchBranch(branch.id);
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: `Switched to branch "${branch.name}"` },
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
      if (!target) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: "Usage: /checkpoint delete <checkpoint-id>" },
        ]);
        return true;
      }

      const checkpoints = listCheckpoints();
      const checkpoint = checkpoints.find(c => c.id.startsWith(target) || c.stepIndex.toString() === target);

      if (!checkpoint) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: `Checkpoint ${target} not found.` },
        ]);
        return true;
      }

      try {
        deleteCheckpoint(checkpoint.id);
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "assistant", text: `Deleted checkpoint: ${checkpoint.description}` },
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
      { kind: "assistant", text: "Usage:\n  /checkpoint list              List all checkpoints\n  /checkpoint diff               Show local uncommitted changes\n  /checkpoint diff <id>         Show changes in checkpoint\n  /checkpoint diff <from> <to>  Compare two checkpoints\n  /checkpoint restore <id>      Restore to checkpoint\n  /checkpoint branch <name>     Create new branch\n  /checkpoint switch <branch>   Switch to branch\n  /checkpoint delete <id>       Delete checkpoint\n  /checkpoint revert            Revert all uncommitted changes" },
    ]);
    return true;
  }

  // ── /reasoning — standalone reasoning level command ───────────────────────
  if (command === "reasoning") {
    const level = resolveReasoningLevel(args[0]);

    if (!level) {
      const current = getAIConfig();
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "assistant",
          text: `Reasoning level: ${current.reasoning}\n\nUsage: /reasoning <level>\nLevels:\n  low    – Fast, less deliberate (good for simple tasks)\n  medium – Balanced (default)\n  high   – Slow, more thorough (best for complex problems)\n\nThis setting persists in model_config.md and applies to all providers.`,
        },
      ]);
      return true;
    }

    const config = getAIConfig();
    const updated = { ...config, reasoning: level };
    setAIConfig(updated);

    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      { kind: "assistant", text: `Reasoning set to: ${level}\nSaved to model_config.md` },
    ]);
    return true;
  }

  // ── /expert — advanced AI model configuration ─────────────────────────────
  if (command === "expert") {
    const sub = args[0]?.toLowerCase();
    const validPresets: PresetName[] = ["fast", "balanced", "high", "testing"];
    const validProviders: ProviderChoice[] = ["groq", "google", "openrouter", "anthropic", "openai", "ollama"];

    // /expert — show current config
    if (!sub) {
      const cfg = getAIConfig();
      const providerPresets = PROVIDER_PRESETS[cfg.provider] ?? PROVIDER_PRESETS["openai"];
      const presetLines = Object.entries(providerPresets)
        .map(([name, p]) => {
          const def = PRESET_DEFAULTS[name as PresetName];
          const marker = name === cfg.preset ? " ◄ active" : "";
          return `  ${name.padEnd(8)} model: ${p.model}, reasoning: ${p.reasoning}, temp: ${def.temperature}, maxTokens: ${def.maxOutputTokens}${marker}`;
        })
        .join("\n");

      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "assistant",
          text:
            `Expert AI Config\n` +
            `${"-".repeat(40)}\n` +
            `  Provider:    ${cfg.provider}\n` +
            `  Model:       ${cfg.model}\n` +
            `  Preset:      ${cfg.preset}\n` +
            `  Reasoning:   ${cfg.reasoning}\n` +
            `  Temperature: ${cfg.temperature}\n` +
            `  Max Tokens:  ${cfg.maxOutputTokens}\n\n` +
            `Presets for ${cfg.provider}:\n${presetLines}\n\n` +
            `Commands:\n` +
            `  /expert fast|balanced|high|testing\n` +
            `  /expert provider <name>         (groq/google/anthropic/openai/openrouter/ollama)\n` +
            `  /expert model <id>              (override model for current provider)\n` +
            `  /expert reasoning low|medium|high\n` +
            `  /expert temperature <0.0-1.0>\n` +
            `  /expert maxtokens <number>\n\n` +
            `Config persists in model_config.md (edit directly for instant effect).`,
        },
      ]);
      return true;
    }

    // /expert fast|balanced|high|testing — apply preset
    if (validPresets.includes(sub as PresetName)) {
      const preset = sub as PresetName;
      const provider = getDefaultProvider() || "openai";
      const newConfig = applyPreset(provider, preset);
      setAIConfig(newConfig);
      // Also update the active provider model so /model and the status bar reflect it
      setProviderModel(provider as ProviderChoice, newConfig.model);

      const def = PRESET_DEFAULTS[preset];
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "assistant",
          text:
            `Applied preset: ${preset}\n` +
            `  Model:       ${newConfig.model}\n` +
            `  Reasoning:   ${newConfig.reasoning}\n` +
            `  Temperature: ${def.temperature}\n` +
            `  Max Tokens:  ${def.maxOutputTokens}\n` +
            `Saved to model_config.md`,
        },
      ]);
      return true;
    }

    // /expert provider <name>
    if (sub === "provider") {
      const providerArg = args[1]?.toLowerCase() as ProviderChoice | undefined;
      if (!providerArg || !validProviders.includes(providerArg)) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: `Usage: /expert provider <name>\nProviders: ${validProviders.join(", ")}` },
        ]);
        return true;
      }
      // Switch provider + apply balanced preset for the new provider
      setDefaultProvider(providerArg);
      const newConfig = applyPreset(providerArg, "balanced");
      setAIConfig(newConfig);
      setProviderModel(providerArg, newConfig.model);

      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "assistant",
          text:
            `Switched to provider: ${providerArg}\n` +
            `Applied balanced preset: model=${newConfig.model}, reasoning=${newConfig.reasoning}\n` +
            `Saved to model_config.md`,
        },
      ]);
      ctx.setTokenStats(
        ctx.calculateTokenStats(ctx.history.current, ctx.systemPrompt, undefined, providerArg)
      );
      return true;
    }

    // /expert model <id>
    if (sub === "model") {
      const modelId = args.slice(1).join(" ");
      if (!modelId) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: "Usage: /expert model <model-id>" },
        ]);
        return true;
      }
      const cfg = getAIConfig();
      const updated = { ...cfg, model: modelId };
      setAIConfig(updated);
      const provider = getDefaultProvider() || "openai";
      setProviderModel(provider as ProviderChoice, modelId);

      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: `Model set to: ${modelId}\nSaved to model_config.md` },
      ]);
      return true;
    }

    // /expert reasoning low|medium|high
    if (sub === "reasoning") {
      const level = resolveReasoningLevel(args[1]);
      if (!level) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: "Usage: /expert reasoning low|medium|high" },
        ]);
        return true;
      }
      const cfg = getAIConfig();
      const updated = { ...cfg, reasoning: level };
      setAIConfig(updated);

      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: `Reasoning set to: ${level}\nSaved to model_config.md` },
      ]);
      return true;
    }

    // /expert temperature <float>
    if (sub === "temperature") {
      const val = parseFloat(args[1] ?? "");
      if (isNaN(val) || val < 0 || val > 1) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: "Usage: /expert temperature <0.0-1.0>" },
        ]);
        return true;
      }
      const cfg = getAIConfig();
      const updated = { ...cfg, temperature: val };
      setAIConfig(updated);

      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: `Temperature set to: ${val}\nSaved to model_config.md` },
      ]);
      return true;
    }

    // /expert maxtokens <int>
    if (sub === "maxtokens" || sub === "maxoutputtokens" || sub === "max_tokens") {
      const val = parseInt(args[1] ?? "", 10);
      if (isNaN(val) || val < 1) {
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: "error", text: "Usage: /expert maxtokens <number>" },
        ]);
        return true;
      }
      const cfg = getAIConfig();
      const updated = { ...cfg, maxOutputTokens: val };
      setAIConfig(updated);

      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: `Max output tokens set to: ${val}\nSaved to model_config.md` },
      ]);
      return true;
    }

    // Unknown /expert subcommand
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "error",
        text: `Unknown /expert option: "${sub}". Run /expert for usage.`,
      },
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


