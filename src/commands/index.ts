import { ModelMessage } from "ai";
import {
  ProviderChoice,
  setDefaultProvider,
  getDefaultProvider,
  setProviderModel,
  setOllamaBaseUrl,
  getOllamaBaseUrl,
} from "../config/api-keys.js";
import { addPinnedFile, clearPinnedFiles } from "../context/build-system-prompt.js";
import { getActiveModelId } from "../sdk/resolve-model.js";
import { existsSync, readdirSync, writeFileSync } from "fs";
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
  hasSessionBaseline,
  formatColoredDiff,
  undoCheckpoint,
  redoCheckpoint,
  getUndoDepth,
  getRedoDepth,
} from "../checkpoint/manager.js";
import { exportTranscript } from "./export-transcript.js";
import type { ConfirmFn } from "../tools/index.js";
import { sessionPermissions } from "../tools/index.js";
import type { FilePatch } from "../checkpoint/types.js";
import type { PlanStep } from "../agent/types.js";
import type { Mode } from "../agent/mode.js";
import {
  EFFORT_LEVELS,
  EFFORT_PROFILES,
  parseEffort,
  type Effort,
} from "../config/effort.js";
import { resolveAgentConfig, setSessionEffort } from "../config/agent-config.js";
import { ZIZOU_MD_TEMPLATE, getZizouMdPath } from "../config/zizou-md.js";

export interface SlashCommandInfo {
  command: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandInfo[] = [
  { command: "/settings", description: "Modify agent configuration (aliases: /keys)" },
  { command: "/chat", description: "Switch to chat mode (conversation only, tools disabled)" },
  { command: "/plan", description: "Switch to plan mode (plan → review → execute → verify)" },
  { command: "/build", description: "Switch to build mode (single-step execution)" },
  { command: "/model", description: "Switch provider and/or set custom model name" },
  { command: "/models", description: "List all available model options for all providers" },
  { command: "/modelid", description: "Set custom model ID for the active provider" },
  { command: "/ollama", description: "Set the Ollama base URL" },
  { command: "/effort", description: "Set effort: fast, balanced or max (model + context + limits)" },
  { command: "/init", description: "Create ZIZOU.md for project settings and conventions" },
  { command: "/add", description: "Pin a file's contents permanently to context" },
  { command: "/file", description: "Pin a file's contents permanently to context (alias: /add)" },
  { command: "/prompt", description: "Dump the full system prompt sent to LLM" },
  { command: "/skills", description: "List available custom agent skills" },
  { command: "/clear", description: "Reset conversation history & start new session" },
  { command: "/session", description: "Session management (new, list, switch, delete)" },
  { command: "/checkpoint", description: "Checkpoint management (list, diff, restore, branch, switch, delete, revert)" },
  { command: "/undo", description: "Undo the last step's file changes" },
  { command: "/redo", description: "Redo the last undone step" },
  { command: "/export", description: "Export conversation transcript to markdown" },
  { command: "/permissions", description: "View or clear active session permissions" },
  { command: "/help", description: "Show available commands & active provider" },
  { command: "/exit", description: "Close Zizou" },
];

export const WELCOME_MESSAGE = `\x1b[1m\x1b[38;2;59;95;224mZIZOU AI — Pair Programming Agent\x1b[0m

\x1b[1m\x1b[38;5;208mHow can I help you today?\x1b[0m
Ask me to edit files, run commands, or design features.

Type \x1b[38;2;59;95;224m/help\x1b[0m for all settings. Let's create something cool!`;

// Types matching the Chat UI state
/**
 * A single rendered line in the chat transcript.
 *
 * THIS IS THE ONE DEFINITION. Chat.tsx used to declare its own near-copy with
 * six extra orchestrator variants, so `setLog` could not be passed to a command
 * handler without a type error — and because .tsx was excluded from tsconfig,
 * nobody saw it.
 */
export type LogEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; thoughtDuration?: string }
  | {
      kind: "tool-call";
      toolCallId: string;
      name: string;
      input: unknown;
      output?: unknown;
      errorMessage?: string;
      startTime: number;
      duration?: string;
      status: "running" | "success" | "error";
    }
  | { kind: "error"; text: string }
  // ── Orchestrator log entry kinds, rendered by Chat.tsx's LogLine ──────
  | { kind: "plan-display"; steps: PlanStep[]; assumptions: string[] }
  | { kind: "step-progress"; stepIndex: number; totalSteps: number; description: string; modelTier?: "hosted" | "local" }
  | { kind: "verification"; stepIndex: number; verified: boolean; mismatches: string[]; verboseFeedback?: string; modelTier?: "hosted" | "local" | undefined }
  | { kind: "scope-hint"; text: string }
  | { kind: "mode-switch"; mode: Mode; reason: string };

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
  onModeChange?: (mode: Mode) => void;
  /** Returns the current mode so /help can display it. */
  getCurrentMode?: () => Mode;
  /** Callback to update session name in UI when session changes. */
  onSessionChange?: (sessionName: string) => void;
  setLog: (updater: (prev: LogEntry[]) => LogEntry[]) => void;
  setTokenStats: (stats: any) => void;
  calculateTokenStats: (
    history: ModelMessage[],
    systemPrompt: string,
    actualUsage?: { inputTokens: number; outputTokens: number },
    provider?: ProviderChoice,
    usageEntries?: Array<{ model: string; inputTokens: number; outputTokens: number }>
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

  // ── /chat, /plan and /build — switch orchestrator mode ─────────────────
  // /chat  → conversation only, tools disabled
  // /plan  → full pipeline: planner → y/n review → execute → verify
  // /build → single-step execution (default)
  if (command === "chat") {
    if (ctx.onModeChange) {
      ctx.onModeChange("chat");
    }
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text: `Switched to ○ Chat mode.\nTools are disabled — nothing on disk will change.\nUse /build to start making changes again.`,
      },
    ]);
    return true;
  }

  if (command === "plan") {
    if (ctx.onModeChange) {
      ctx.onModeChange("plan");
    }
    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text: `Switched to ◆ Plan mode.\nYour next prompt will produce a plan with its assumptions for you to approve, then execute step by step.\nUse /build to switch back to single-step mode.`,
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

  /chat                     Switch to chat mode (conversation only, tools disabled)
  /plan                     Switch to plan mode (plan → review → execute → verify)
  /build                    Switch to build mode (single-step execution)
  /model <provider>         Switch active provider
                            Providers: groq, google, openrouter, anthropic, openai, ollama
  /model <provider> <name>  Switch provider AND set a custom model name
                            e.g. /model groq mixtral-8x7b-32768
                            e.g. /model ollama mistral
  /models                   List all available model options for all providers
  /modelid <name>           Set a custom model ID for the current provider
                            e.g. /modelid llama3:70b
  /ollama <url>             Set the Ollama base URL
                            e.g. /ollama http://localhost:11434
  /add <filepath>           Pin a file's contents permanently to the system prompt

  Effort — one dial for speed vs quality:
  /effort                   Show the current level and what each one does
  /effort <level>           fast | balanced | max (for this session)
  /fast  /balanced  /max    Shorthands for the above
                            Effort sets the model, the context budget and the
                            token limits together. /model pins a model and
                            overrides the model effort would pick.
  /init                     Create ZIZOU.md — project settings & conventions
                            Put "effort: max" under "## Agent" to make it stick
  /keys                     Change API keys / select provider
  /prompt                   Dump the full system prompt sent to the LLM
  /skills                   List available custom agent skills
  /clear                    Reset conversation history & start new session
  /undo                     Undo the last step's file changes
  /redo                     Redo the last undone step
  /export                   Export conversation transcript to markdown
  /exit                     Close Zizou

  Mode:    ${currentMode === "chat" ? "○ Chat" : currentMode === "plan" ? "◆ Plan" : "● Build"}
  Effort:  ${resolveAgentConfig().effort}${resolveAgentConfig().effortSource === "project" ? " (ZIZOU.md)" : resolveAgentConfig().effortSource === "session" ? " (this session)" : ""}
  Active:  ${SHORT_LABELS[provider]} › ${modelId}${resolveAgentConfig().modelPinned ? " (pinned)" : ""}`,
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

  // ── /init — create ZIZOU.md for this project ─────────────────────────
  //
  // ZIZOU.md is one file holding both the project's agent settings and its
  // conventions, committed so the team shares them.
  if (command === "init") {
    const path = getZizouMdPath();

    if (existsSync(path)) {
      // Never clobber a file that may hold hand-written conventions.
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "assistant",
          text: `ZIZOU.md already exists at ${path}.\nEdit it directly — /init will not overwrite it.`,
        },
      ]);
      return true;
    }

    try {
      writeFileSync(path, ZIZOU_MD_TEMPLATE, "utf-8");
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "assistant",
          text:
            `Created ZIZOU.md.\n\n` +
            `  "## Agent" holds provider and effort for this project.\n` +
            `  Everything below it is injected into the agent's context.\n\n` +
            `Commit it so the whole team shares the same settings.`,
        },
      ]);
    } catch (error) {
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "error",
          text: `Failed to write ZIZOU.md: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ]);
    }
    return true;
  }

  // ── /effort — the one speed/quality dial ───────────────────────────
  //
  // Replaces three commands that were really one decision split three ways:
  //   /expert    picked a model + temperature + maxOutputTokens
  //   /context   picked how much repo context to assemble
  //   /reasoning set a value nothing ever read
  //
  // Effort sets all of them together, so they can no longer contradict each
  // other ("fast" with "max" context was previously expressible).
  if (command === "effort" || EFFORT_LEVELS.includes(command as Effort)) {
    // `/fast` and `/max` are shorthands for `/effort fast` and `/effort max`.
    const requested = EFFORT_LEVELS.includes(command as Effort)
      ? (command as Effort)
      : parseEffort(args[0]);

    const active = resolveAgentConfig();

    if (!requested) {
      const rows = EFFORT_LEVELS.map((level) => {
        const marker = level === active.effort ? "→" : " ";
        return `  ${marker} ${level.padEnd(9)} ${EFFORT_PROFILES[level].description}`;
      }).join("\n");

      const sourceNote =
        active.effortSource === "project"
          ? " (from ZIZOU.md)"
          : active.effortSource === "session"
          ? " (set this session)"
          : "";

      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        {
          kind: "assistant",
          text:
            `Effort: ${active.effort}${sourceNote}\n\n${rows}\n\n` +
            `Model: ${active.modelId}${active.modelPinned ? " (pinned by /model or ZIZOU.md)" : ""}\n` +
            `Usage: /effort <fast|balanced|max>\n` +
            `Set it permanently for this project in ZIZOU.md under "## Agent".`,
        },
      ]);
      return true;
    }

    setSessionEffort(requested);
    const next = resolveAgentConfig();
    const profile = EFFORT_PROFILES[requested];

    ctx.setLog((l: LogEntry[]) => [
      ...l,
      { kind: "user", text },
      {
        kind: "assistant",
        text:
          `Effort set to ${requested} for this session.\n` +
          `${profile.description}\n\n` +
          `  Model    : ${next.modelId}${next.modelPinned ? " (pinned — effort did not change it)" : ""}\n` +
          `  Searches : up to ${profile.maxSteps} tool rounds per turn\n` +
          `  Max out  : ${profile.maxOutputTokens} tokens\n` +
          `  Temp     : ${profile.temperature}\n\n` +
          `To make it stick, add "effort: ${requested}" under "## Agent" in ZIZOU.md.`,
      },
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
        // NOTE: undo history is deliberately NOT cleared here.
        //
        // It used to be, because the undo stack was a separate store that
        // knew nothing about the checkpoint history and could desync from it.
        // Undo is now a head pointer on the project's checkpoint chain, and
        // creating a session changes nothing on disk — so the previous step
        // is still there and still correctly undoable.
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
        // Undo history is per-project, not per-session, and the working tree
        // does not change when you switch sessions — see the note in
        // `/session new` above.
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
          // Distinguish "nothing changed" from "no baseline to compare against".
          const noBaseline = isFullSession && !hasSessionBaseline();
          ctx.setLog((l: LogEntry[]) => [
            ...l,
            { kind: "user", text },
            { kind: "assistant", text: noBaseline
                ? `No session baseline recorded for branch "${branchName}", so a full-session diff isn't available. Use '/checkpoint diff' to see changes since the head checkpoint.`
                : isFullSession
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
        const noBaseline = isFullSession && !hasSessionBaseline();
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          { kind: noBaseline ? "error" : "assistant", text: noBaseline
              ? "No session baseline recorded, so there is no known state to revert to. Use '/checkpoint revert' (without 'session') to revert to the head checkpoint instead."
              : isFullSession
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

  // ── /undo — undo the last step's file changes ───────────────────────────────
  if (command === "undo") {
    // Undo is a POINTER MOVE along the checkpoint chain, not a separate stack.
    // There used to be a parallel undo/redo store that knew nothing about the
    // checkpoint history, so /undo left history.json claiming the undone
    // content was still current and /checkpoint revert would re-apply it.
    if (getUndoDepth() === 0) {
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: "Nothing to undo — no checkpoints have been recorded yet." },
      ]);
      return true;
    }

    try {
      const undone = undoCheckpoint();
      if (undone) {
        const files = undone.patches.map((patch) => patch.filePath);
        const fileList = files.length > 0 ? files.join(", ") : "(no file changes)";
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          {
            kind: "assistant",
            text:
              `Undid "${undone.description}".\n` +
              `Reverted ${files.length} file(s): ${fileList}\n` +
              `${getRedoDepth()} step(s) can be redone.`,
          },
        ]);
      }
    } catch (error) {
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "error", text: `Failed to undo: ${error instanceof Error ? error.message : "Unknown error"}` },
      ]);
    }
    return true;
  }

  // ── /redo — move the head forward again ──────────────────────────────
  if (command === "redo") {
    if (getRedoDepth() === 0) {
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: "Nothing to redo — no steps have been undone." },
      ]);
      return true;
    }

    try {
      const redone = redoCheckpoint();
      if (redone) {
        const files = redone.patches.map((patch) => patch.filePath);
        const fileList = files.length > 0 ? files.join(", ") : "(no file changes)";
        ctx.setLog((l: LogEntry[]) => [
          ...l,
          { kind: "user", text },
          {
            kind: "assistant",
            text:
              `Redid "${redone.description}".\n` +
              `Reapplied ${files.length} file(s): ${fileList}`,
          },
        ]);
      }
    } catch (error) {
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "error", text: `Failed to redo: ${error instanceof Error ? error.message : "Unknown error"}` },
      ]);
    }
    return true;
  }

  // ── /export — export conversation transcript to markdown ───────────────────
  if (command === "export") {
    try {
      const conversation = ctx.history.current;
      const filepath = exportTranscript(conversation);
      
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "assistant", text: `Conversation exported to:\n${filepath}` },
      ]);
    } catch (error) {
      ctx.setLog((l: LogEntry[]) => [
        ...l,
        { kind: "user", text },
        { kind: "error", text: `Failed to export: ${error instanceof Error ? error.message : "Unknown error"}` },
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


