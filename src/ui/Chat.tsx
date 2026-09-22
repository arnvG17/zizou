// src/ui/Chat.tsx
//
// This is the main TUI screen after the splash screen.
// It implements the responsive two-column layout from zizou_cli_full_flow_v3.html:
// - Left column: Conversation log and pill-style input box with badges.
// - Right column: Sidebar with session info, estimated tokens/cost, LSP status,
//   and the mini-wordmark. Automatically hidden on narrower terminals.
//
// ORCHESTRATOR INTEGRATION (new):
//   The Chat component now routes user input through the orchestrator
//   instead of calling runTurn() directly. The orchestrator manages the
//   full pipeline (clarify → plan → execute → verify) and yields events
//   that the Chat renders as new log entry types.
//
//   New log entry kinds:
//     - "plan-display"   → shows the structured plan for Y/n confirmation
//     - "step-progress"  → shows which step is executing (e.g., "Step 2/5")
//     - "verification"   → shows per-step verification result
//     - "escalation"     → shows escalation prompt with Y/n
//     - "mode-switch"    → shows mode change notifications
//     - "clarification"  → shows clarifying questions from the clarifier

import React, { useState, useRef, useReducer, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import pkg from "../../package.json";
import type { ModelMessage } from "ai";
import { resolveModel, getActiveModelId } from "../sdk/resolve-model.js";
import { explainOllamaError, drainOllamaWarnings } from "../sdk/ollama.js";
import { resolveAgentConfig } from "../config/agent-config.js";
import {
  getDefaultProvider,
  setDefaultProvider,
  setProviderModel,
  ProviderChoice,
} from "../config/api-keys.js";
import type { ConfirmFn } from "../tools/index.js";
import { sessionPermissions } from "../tools/index.js";
import { listServices } from "../tools/service-registry.js";
import { repairHistory } from "../agent/history.js";
import { runTurn } from "../agent/run-turn.js";
import { buildSystemPrompt, addPinnedFile, pinnedContextFiles } from "../context/build-system-prompt.js";
import { buildRepoMap } from "../context/repo-map.js";
import { useTerminalSize, SidebarWordmark, SidebarMountains } from "./Figurine.js";
import { handleSlashCommand, SLASH_COMMANDS, WELCOME_MESSAGE, getSkills, PLAN_GATE_PROMPT, parseRestoredLog } from "../commands/index.js";
import type { LogEntry as SharedLogEntry } from "../commands/index.js";
import { readdirSync, statSync, existsSync } from "fs";
import { join, relative, resolve as resolvePath } from "path";
import { loadActiveSessionState, saveActiveSessionState, listSessions, getActiveSession, getActiveSessionId, createSession } from "../session/registry.js";
import { getChanges } from "../trace/query.js";
import { FileSearchOverlay } from "../tui/file-search-overlay.js";
import { estimateCost, formatCost, getModelRate } from "../tui/cost-tracker.js";
import { execSync } from "node:child_process";
import { TokenStatsPanel, EvalStatsPanel } from "./SidebarStats.js";

// ─── Orchestrator imports ────────────────────────────────────────────────────
// These enable the full clarify → plan → execute → verify pipeline.
import type { Mode, Route } from "../agent/mode.js";
import { isCurrentSessionSchema } from "../session/types.js";
import {
  flowReducer,
  initialFlowState,
  type FlowAction,
  type OrchestratorFlowState,
} from "./orchestrator-flow.js";
import { runOrchestrator, type OrchestratorEvent } from "../agent/orchestrator.js";
import { autoVerifyEnabled } from "../agent/verification-plan.js";
import { toPersisted as persistTaskState } from "../agent/task-state.js";
import type { PlanStep, PlanRevision } from "../agent/types.js";

const PROVIDERS: ProviderChoice[] = ["groq", "google", "openrouter", "anthropic", "openai", "ollama"];

/**
 * How each mode is presented in the three badges (header, input footer,
 * sidebar). Kept in one table so a new mode can't be added to the type and
 * then silently render as another mode's colour.
 */
const MODE_BADGE: Record<Mode, { label: string; glyph: string; color: string }> = {
  auto: { label: "Auto", glyph: "◇", color: "#8A6FD4" },
  chat: { label: "Chat", glyph: "○", color: "#5BA37F" },
  ask: { label: "Ask", glyph: "?", color: "#4EA5C0" },
  build: { label: "Build", glyph: "●", color: "#3B5FE0" },
  plan: { label: "Plan", glyph: "◆", color: "#D08A4E" },
};

/**
 * What the badge shows, given the pin and what actually ran.
 *
 * In auto mode the pin and the route disagree on every turn, and both matter:
 * the route is what just happened, the pin is what will happen next time.
 * Showing only the route would make auto look like it silently switched the
 * user's mode; showing only the pin would hide what it chose.
 */
/**
 * Does this planned target file already exist?
 *
 * Used only to mark a step's files as new or edited at the plan gate, so a
 * wrong answer costs a wrong marker and nothing more — hence swallowing the
 * error rather than surfacing it. An unreadable path is shown as new, which
 * is the reading that prompts the user to look.
 */
function fileExists(projectRoot: string | undefined, file: string): boolean {
  try {
    return existsSync(resolvePath(projectRoot ?? process.cwd(), file));
  } catch {
    return false;
  }
}

function badgeFor(pinnedMode: Mode, lastRoute: Route | null) {
  const pin = MODE_BADGE[pinnedMode];
  if (pinnedMode !== "auto" || !lastRoute) return pin;

  const route = MODE_BADGE[lastRoute];
  return {
    label: `${pin.label} → ${route.label}`,
    glyph: pin.glyph,
    // The route's colour, because the route is what the line is about.
    color: route.color,
  };
}

const SHORT_LABELS: Record<ProviderChoice, string> = {
  groq: "Groq",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  ollama: "Ollama (local)",
};

const COMMON_MODELS: Record<ProviderChoice, string[]> = {
  groq: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768", "llama-3.1-8b-instant", "gemma2-9b-it"],
  google: ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
  openrouter: ["google/gemma-4-31b-it:free", "meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-chat"],
  anthropic: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-3-opus-20240229"],
  openai: ["gpt-4o", "gpt-4o-mini", "o1-mini"],
  ollama: ["llama3", "mistral", "phi3"],
};

interface ModelOption {
  label: string;
  provider: ProviderChoice;
  modelId: string;
}

const MODEL_OPTIONS: ModelOption[] = [
  { label: "LLaMA 3.3 70B (Groq)", provider: "groq", modelId: "llama-3.3-70b-versatile" },
  { label: "Mixtral 8x7B (Groq)", provider: "groq", modelId: "mixtral-8x7b-32768" },
  { label: "LLaMA 3.1 8B (Groq)", provider: "groq", modelId: "llama-3.1-8b-instant" },
  { label: "Gemini 2.5 Flash (Google)", provider: "google", modelId: "gemini-2.5-flash" },
  { label: "Gemini 2.5 Pro (Google)", provider: "google", modelId: "gemini-2.5-pro" },
  { label: "Claude 3.5 Sonnet (Anthropic)", provider: "anthropic", modelId: "claude-3-5-sonnet-latest" },
  { label: "Claude 3.5 Haiku (Anthropic)", provider: "anthropic", modelId: "claude-3-5-haiku-latest" },
  { label: "GPT-4o (OpenAI)", provider: "openai", modelId: "gpt-4o" },
  { label: "GPT-4o Mini (OpenAI)", provider: "openai", modelId: "gpt-4o-mini" },
  { label: "Gemma 4 31B (OpenRouter - Free)", provider: "openrouter", modelId: "google/gemma-4-31b-it:free" },
  { label: "LLaMA 3.3 70B (OpenRouter - Free)", provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" },
  { label: "DeepSeek Chat (OpenRouter)", provider: "openrouter", modelId: "deepseek/deepseek-chat" },
  { label: "LLaMA 3 (Ollama - Local)", provider: "ollama", modelId: "llama3" },
  { label: "Mistral (Ollama - Local)", provider: "ollama", modelId: "mistral" },
];

// --- Types for our scrolling log ---
//
// EXTENDED: New entry kinds for orchestrator events (plan display,
// verification results, escalation prompts, step progress, etc.).
// The original kinds (user, assistant, tool-call, error) are unchanged.
// LogEntry is defined once, in commands/index.ts, because slash-command
// handlers receive setLog and must agree on the shape. Chat.tsx used to
// declare a near-duplicate with six extra variants.
type LogEntry = SharedLogEntry;

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function calculateTokenStats(
  history: ModelMessage[],
  systemPrompt: string,
  actualUsage?: { inputTokens: number; outputTokens: number },
  provider: ProviderChoice = "groq",
  usageEntries?: Array<{ model: string; inputTokens: number; outputTokens: number }>
) {
  let inputTokens = 0;
  let outputTokens = 0;

  if (actualUsage) {
    inputTokens = actualUsage.inputTokens;
    outputTokens = actualUsage.outputTokens;
  } else {
    // Fallback naive estimation if we don't have actual usage yet
    const systemPromptLength = systemPrompt.length;
    let inputChars = systemPromptLength;
    let outputChars = 0;

    for (const msg of history) {
      if (msg.role === "user") {
        inputChars += (msg.content || "").length;
      } else {
        if (typeof msg.content === "string") {
          outputChars += msg.content.length;
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === "text") {
              outputChars += part.text.length;
            }
          }
        }
      }
    }

    inputTokens = Math.floor(inputChars / 4);
    outputTokens = Math.floor(outputChars / 4);
  }

  const totalTokens = inputTokens + outputTokens;
  
  const modelId = getActiveModelId(provider);
  let contextLimit = 128000; // default for many modern models
  if (modelId.includes("claude-3-5") || modelId.includes("claude-3-opus")) contextLimit = 200000;
  else if (modelId.includes("gemini-2.0") || modelId.includes("gemini-1.5")) contextLimit = 1000000;
  else if (modelId.includes("gemma-3") || modelId.includes("llama-3.3")) contextLimit = 128000;

  const pctUsed = Math.min(100, parseFloat(((totalTokens / contextLimit) * 100).toFixed(1)));

  // Calculate cost from usage entries if available
  let cost = 0;
  if (usageEntries && usageEntries.length > 0) {
    cost = estimateCost(usageEntries);
  } else {
    // Fallback to simple calculation
    let inputRate = 0.000003; // default $3/M (Anthropic)
    let outputRate = 0.000015; // default $15/M (Anthropic)

    if (provider === "openai") {
      inputRate = 0.0000025; // $2.5/M
      outputRate = 0.00001; // $10/M
    } else if (provider === "google") {
      inputRate = 0.000000075; // $0.075/M
      outputRate = 0.0000003; // $0.3/M
    } else if (provider === "groq") {
      inputRate = 0.00000059; // $0.59/M
      outputRate = 0.00000079; // $0.79/M
    } else if (provider === "ollama") {
      // Ollama runs locally — no cost
      inputRate = 0;
      outputRate = 0;
    }

    cost = parseFloat((inputTokens * inputRate + outputTokens * outputRate).toFixed(4));
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    pctUsed,
    cost,
    contextLimit,
  };
}

function getAllFilesRecursively(dir: string, rootDir: string): string[] {
  const files: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        files.push(...getAllFilesRecursively(full, rootDir));
      } else {
        files.push(relative(rootDir, full).replace(/\\/g, "/"));
      }
    }
  } catch {}
  return files;
}

// ─── Thinking / Loading Animation Constants & Component ─────────────────────
const THINKING_WORDS = [
  "beaming", "booping", "bouncing", "brewing", "bubbling", "chasing", "churning",
  "coalescing", "conjuring", "cooking", "crafting", "crunching", "cuddling",
  "dancing", "dazzling", "discovering", "doodling", "dreaming", "drifting",
  "enchanting", "exploring", "finding", "floating", "fluttering", "foraging",
  "forging", "frolicking", "gathering", "giggling", "gliding", "greeting",
  "growing", "hatching", "herding", "honking", "hopping", "hugging", "humming",
  "imagining", "inventing", "jingling", "juggling", "jumping", "kindling",
  "knitting", "launching", "leaping", "mapping", "marinating", "meandering",
  "mixing", "moseying", "munching", "napping", "nibbling", "noodling", "orbiting",
  "painting", "percolating", "petting", "plotting", "pondering", "popping",
  "prancing", "purring", "puzzling", "questing", "riding", "roaming", "rolling",
  "sauteeing", "scribbling", "seeking", "shimmying", "singing", "skipping",
  "sleeping", "snacking", "sniffing", "snuggling", "soaring", "sparking",
  "spinning", "splashing", "sprouting", "squishing", "stargazing", "stirring",
  "strolling", "swimming", "swinging", "tickling", "tinkering", "toasting",
  "tumbling", "twirling", "waddling", "wandering", "watching", "weaving",
  "whistling", "wibbling", "wiggling", "wishing", "wobbling", "wondering",
  "yawning", "zooming"
];

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * How often streamed assistant text is committed to the log, in ms.
 *
 * ~16 frames a second: fast enough to read as live typing, slow enough that
 * the terminal is not asked to repaint the whole screen once per token.
 */
const STREAM_FLUSH_MS = 60;

/** Widest thinking word plus its ellipsis, so the spinner slot never resizes. */
const WORD_SLOT_WIDTH =
  THINKING_WORDS.reduce((max, w) => Math.max(max, w.length), 0) + 1;

/**
 * One line showing what the agent currently has running.
 *
 * Services are killed when the CLI exits, so without this the user has no way
 * to know a dev server is theirs to lose — or to notice that the "running"
 * server they are debugging actually crashed two steps ago.
 *
 * Polls rather than subscribing: the registry is a plain module-level map with
 * no change events, and a 1s poll over a handful of entries is cheaper than
 * wiring an emitter through it.
 */
function RunningServices() {
  const [items, setItems] = useState<ReturnType<typeof listServices>>([]);

  useEffect(() => {
    const tick = () => setItems(listServices().filter((s) => s.status !== "stopped"));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  if (items.length === 0) return null;

  return (
    <Box flexDirection="row" paddingX={1} gap={2}>
      {items.map((s) => {
        const color = s.status === "ready" ? "#5FB87A" : s.status === "crashed" ? "red" : "yellow";
        return (
          <Text key={s.name} color={color}>
            {s.status === "crashed" ? "○" : "●"} {s.name}
            {s.port ? ` :${s.port}` : ""} {s.status}
          </Text>
        );
      })}
    </Box>
  );
}

function ThinkingLoader() {
  const [word, setWord] = useState(() => {
    const randomIndex = Math.floor(Math.random() * THINKING_WORDS.length);
    return THINKING_WORDS[randomIndex];
  });
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    // Randomly switch the word every 10 seconds (10000ms)
    const wordInterval = setInterval(() => {
      const randomIndex = Math.floor(Math.random() * THINKING_WORDS.length);
      setWord(THINKING_WORDS[randomIndex]);
    }, 10000);

    // Spin the loader frame every 80ms for smooth animation
    const spinnerInterval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => {
      clearInterval(wordInterval);
      clearInterval(spinnerInterval);
    };
  }, []);

  // The "esc to stop" hint rides along with the spinner because that is the
  // only moment it is true, and the only moment anyone needs it. A cancel key
  // nobody knows about is the same as no cancel key — which is why the only
  // way out of a long run used to be Ctrl+C and a dead session.
  // The word is padded to a FIXED width. Without it, "booping" and
  // "percolating" render four columns apart, so every word swap shoves
  // "esc to stop" sideways and the input row appears to twitch.
  const label = (word + "…").padEnd(WORD_SLOT_WIDTH, " ");

  return (
    <Text>
      <Text color="#39FF14"> ({SPINNER_FRAMES[frameIndex]} {label})</Text>
      <Text color="#6B7280" dimColor>  esc to stop</Text>
    </Text>
  );
}

export interface ChatProps {
  onChangeKeys?: () => void;
  /** The pinned mode from CLI args. Defaults to auto — see agent/mode.ts. */
  mode?: Mode;
  /** If provided, auto-submit this prompt on startup. */
  initialPrompt?: string;
}

export function Chat({ onChangeKeys, mode: initialMode = "auto", initialPrompt }: ChatProps) {
  // Ensure model_config.md exists on first startup so users can find and edit it

  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * Cancels the turn in flight. Null when nothing is running.
   *
   * A ref, not state: the Esc handler must reach the CURRENT controller from
   * inside a stable useInput callback, and a re-render is not needed to abort.
   */
  const abortRef = useRef<AbortController | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{
    description: string;
    resolve: (approved: boolean) => void;
  } | null>(null);

  const [isSelectingModel, setIsSelectingModel] = useState(false);
  const [modelSelectStep, setModelSelectStep] = useState<"choose-provider" | "choose-model" | "enter-custom-model">("choose-model");
  const [selectedProvider, setSelectedProvider] = useState<ProviderChoice>("groq");
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [customModelInput, setCustomModelInput] = useState("");

  const [showFileSearch, setShowFileSearch] = useState(false);
  /**
   * True while the @ overlay has matches and therefore owns the Enter key.
   *
   * A ref because handleSubmit must read the value AT KEYPRESS TIME, and Ink
   * fires the TextInput's onSubmit in the same tick as the overlay's own
   * handler — a state read there would see the previous render.
   */
  const fileSearchOwnsEnterRef = useRef(false);

  const { cols } = useTerminalSize();
  const showSidebar = cols >= 90 && log.length > 0;

  const [sessionName, setSessionName] = useState<string>("Untitled");

  const sessionId = useMemo(() => {
    const d = new Date();
    return d.toISOString().replace(/\.\d+Z$/, "Z");
  }, []);

  const cwd = useMemo(() => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const full = process.cwd();
    if (home && full.startsWith(home)) {
      return "/~" + full.slice(home.length).replace(/\\/g, "/");
    }
    return full.replace(/\\/g, "/");
  }, []);

  // ── Sidebar stat inputs ──────────────────────────────────────────────────
  //
  // The unabbreviated cwd, kept separate from the display form above: the eval
  // reader opens evals/reports/ under it, and "/~/ZIZOUv1" is not a path.
  const projectRoot = useMemo(() => process.cwd(), []);

  // Bumped whenever /model writes a new provider or model, so the memos below
  // recompute. The active model lives in the Conf store rather than in React
  // state, so there is nothing for a memo to depend on without this.
  const [modelSwitchNonce, setModelSwitchNonce] = useState(0);

  // Recomputed whenever the model changes, so /model is reflected immediately
  // in both the cost rate and the eval lookup.
  const activeProvider = useMemo(
    () => getDefaultProvider() || "groq",
    [modelSwitchNonce],
  );
  const activeModelId = useMemo(
    () => getActiveModelId(activeProvider),
    [activeProvider, modelSwitchNonce],
  );

  // Marks an eval report as stale when it predates the working tree. Resolved
  // once: a shelling out per render would be absurd for a value that changes
  // when the user commits, not when they type.
  const currentSha = useMemo(() => {
    try {
      return execSync("git rev-parse --short HEAD", {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      // Not a git repo, or git is absent. Staleness simply goes unmarked.
      return undefined;
    }
  }, [projectRoot]);

  // Conversation history persists across turns
  const history = useRef<ModelMessage[]>([]);
  const systemPromptRef = useRef<string>("");
  const [contextReady, setContextReady] = useState(false);
  const [systemPromptText, setSystemPromptText] = useState<string>("");
  const [repoMap, setRepoMap] = useState<string>("");

  // ─── Orchestrator state ──────────────────────────────────────────────
  //
  // One reducer, not nine useState hooks. Plan mode spans several renders:
  // the orchestrator yields, stops, and is re-invoked with what the user
  // supplied — so handlers must pass this state back in. Reading it from the
  // render closure read whatever it was when that closure was created.
  // See orchestrator-flow.ts for the four bugs that caused.
  const [flow, dispatchFlow] = useReducer(flowReducer, {
    ...initialFlowState,
    pinnedMode: initialMode,
  });

  // A synchronously-current mirror of `flow`. React state updates are async,
  // but the escalation and clarification handlers must re-invoke the
  // orchestrator with the state they JUST produced, within the same tick.
  const flowRef = useRef(flow);

  /**
   * Applies an action to both the ref (immediately) and React (for render),
   * and returns the resulting state so the caller can pass it straight on.
   */
  function applyFlow(action: FlowAction): OrchestratorFlowState {
    const next = flowReducer(flowRef.current, action);
    flowRef.current = next;
    dispatchFlow(action);
    return next;
  }

  const [tokenStats, setTokenStats] = useState({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    pctUsed: 0,
    cost: 0,
    contextLimit: 128000,
  });

  // Track usage entries for cost calculation
  const [usageEntries, setUsageEntries] = useState<Array<{ model: string; inputTokens: number; outputTokens: number }>>([]);

  useEffect(() => {
    // Load session state
    const sessionState = loadActiveSessionState();
    const activeSession = getActiveSession();
    
    // Set session name from active session
    if (activeSession) {
      setSessionName(activeSession.name);
    } else {
      // Auto-create a new session if none exists
      try {
        createSession("Untitled");
        setSessionName("Untitled");
      } catch (error) {
        console.warn("Failed to create auto session:", error);
      }
    }
    
    if (sessionState) {
      // Repaired on the way in: a session saved by an older build can hold
      // tool results in a shape the model API rejects, which would otherwise
      // make the session impossible to reopen. See repairHistory.
      history.current = repairHistory(sessionState.conversation || []);
      setTokenStats(sessionState.tokenStats || {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        pctUsed: 0,
        cost: 0,
        contextLimit: 128000,
      });
      
      // Restore the log, repairing entries written by older versions.
      //
      // parseRestoredLog never throws and never returns a shape the renderer
      // cannot handle. This was a bare JSON.parse cast to LogEntry[], so a
      // session saved before a field existed — plan-display without
      // `assumptions`, for one — crashed the entire TUI on open and left the
      // session permanently unopenable.
      const restoredLog = parseRestoredLog(sessionState.log);

      if (restoredLog.length > 0) {
        setLog(restoredLog);
      } else {
        // Nothing salvageable. Rebuild a transcript from the conversation so
        // the session still opens with its history visible.
        const reconstructedLog: LogEntry[] = [];
        for (const msg of (sessionState.conversation || [])) {
          if (msg.role === "user") {
            reconstructedLog.push({ kind: "user", text: String(msg.content) });
          } else if (msg.role === "assistant") {
            reconstructedLog.push({ kind: "assistant", text: String(msg.content) });
          }
        }
        setLog(reconstructedLog);
      }
      
      // ── Restore the orchestrator flow ────────────────────────────────
      //
      // Schema-versioned: if the stored shape predates the reducer we keep
      // the conversation transcript and drop the flow, rather than resuming
      // a half-understood state.
      const orchState = isCurrentSessionSchema(sessionState)
        ? sessionState.orchestratorState
        : undefined;

      applyFlow({
        type: "restore",
        state: {
          // A session saved before auto existed has no currentMode, and gets
          // the new default. A session that saved one keeps it — nobody is
          // switched out from under themselves mid-session.
          pinnedMode: sessionState.currentMode ?? "auto",
          pendingPlan: orchState?.pendingPlan ?? null,
          pendingAssumptions: orchState?.pendingAssumptions ?? [],
          originalPrompt: orchState?.originalPrompt ?? "",
          completedStepIndices: orchState?.completedStepIndices ?? [],
          isAwaitingPlanApproval: orchState?.isAwaitingPlanApproval ?? false,
        },
      });

      // A plan left pending from last time is OFFERED, never auto-run.
      // It used to re-execute itself on mount via setTimeout, with
      // completedStepIndices still empty — silently redoing finished steps.
      if (orchState?.pendingPlan && orchState.originalPrompt) {
        setLog((l) => [
          ...l,
          {
            kind: "plan-display",
            steps: orchState.pendingPlan!,
            assumptions: orchState.pendingAssumptions ?? [],
          },
          {
            kind: "assistant",
            text: "This plan was left pending in this session. Execute it? (y/n)",
          },
        ]);
      }
    } else {
      // Complete reset if no sessionState
      history.current = [];
      setLog([]);
      applyFlow({ type: "reset" });
    }

    buildSystemPrompt(process.cwd()).then((prompt) => {
      systemPromptRef.current = prompt;
      setSystemPromptText(prompt);
      setContextReady(true);
      const provider = getDefaultProvider() || "groq";
      setTokenStats(calculateTokenStats(history.current, prompt, undefined, provider, usageEntries));
    });
    try {
      const map = buildRepoMap(process.cwd());
      setRepoMap(map);
    } catch {}
    sessionPermissions.reset();
  }, [sessionName]);

  // ── Auto-submit the CLI prompt ───────────────────────────────────────
  //
  // `zizou "fix the typo"` and `zizou plan "add auth"` pass the prompt down
  // as initialPrompt. It was accepted and never referenced, so the prompt was
  // silently dropped and the user was left at an empty input — even though
  // App.tsx documents this as auto-submitting.
  //
  // Waits for contextReady so the system prompt is built before the turn,
  // and guards with a ref so a re-render can't submit it twice.
  const autoSubmittedRef = useRef(false);
  useEffect(() => {
    if (!contextReady || !initialPrompt || autoSubmittedRef.current) return;
    autoSubmittedRef.current = true;
    handleSubmit(initialPrompt);
  }, [contextReady, initialPrompt]);

  const confirmFn: ConfirmFn = (description) => {
    if (sessionPermissions.isPermitted(description)) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      setPendingConfirm({
        description,
        resolve: (approved: boolean) => {
          if (approved) {
            sessionPermissions.grantPermission(description);
          }
          resolve(approved);
        },
      });
    });
  };

  // Load workspace files and available skills list
  const allFilesRef = useRef<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<string[]>([]);

  useEffect(() => {
    try {
      allFilesRef.current = getAllFilesRecursively(process.cwd(), process.cwd());
    } catch {}
    try {
      setAvailableSkills(getSkills());
    } catch {}
  }, []);

  // Autocomplete popup state
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [closedSuggestions, setClosedSuggestions] = useState(false);

  // If input doesn't start with / or is reset, reset closedSuggestions
  useEffect(() => {
    if (!input.startsWith("/")) {
      setClosedSuggestions(false);
    }
    
    // Detect @ for file search
    // A bare "@" opens the picker (showing the first matches) rather than
    // requiring a character first — typing "@" and getting nothing reads as
    // the feature not existing.
    const atMatch = input.match(/@([^\s]*)$/);
    setShowFileSearch(!!atMatch);
  }, [input]);

  const showSuggestions = input.startsWith("/") && !closedSuggestions;

  const suggestionMode = useMemo(() => {
    if (!showSuggestions) return null;
    if (input.startsWith("/file ") || input.startsWith("/add ")) return "files";
    if (input.startsWith("/skills ")) return "skills";
    if (input.startsWith("/model ")) {
      const parts = input.trim().split(/\s+/);
      if (parts.length === 2 && input.endsWith(" ")) {
        return "model-names";
      }
      if (parts.length > 2) {
        return "model-names";
      }
      return "model-providers";
    }
    if (input.startsWith("/session ")) {
      const parts = input.trim().split(/\s+/);
      if (parts.length === 1) {
        return "session-subcommands";
      }
      if (parts.length === 2 && (parts[1] === "switch" || parts[1] === "delete")) {
        return "session-names";
      }
      return null;
    }
    if (input.startsWith("/context ")) {
      const parts = input.trim().split(/\s+/);
      if (parts.length === 1) {
        return "context-modes";
      }
      return null;
    }
    if (input.startsWith("/changes ")) {
      const parts = input.trim().split(/\s+/);
      if (parts.length === 1) {
        return "changes-subcommands";
      }
      if (parts.length === 2 && (parts[1] === "diff" || parts[1] === "revert")) {
        return "changes-targets";
      }
      return null;
    }
    if (input.includes(" ")) return null; // normal typing, no autocomplete
    return "commands";
  }, [input, showSuggestions]);

  const filteredCommands = useMemo(() => {
    if (suggestionMode !== "commands") return [];
    return SLASH_COMMANDS.filter((cmd) =>
      cmd.command.toLowerCase().startsWith(input.toLowerCase())
    );
  }, [input, suggestionMode]);

  const fileSearchQuery = useMemo(() => {
    if (input.startsWith("/file ")) return input.slice("/file ".length).trim();
    if (input.startsWith("/add ")) return input.slice("/add ".length).trim();
    return "";
  }, [input]);

  const filteredFiles = useMemo(() => {
    if (suggestionMode !== "files") return [];
    return allFilesRef.current
      .filter((file) => file.toLowerCase().includes(fileSearchQuery.toLowerCase()))
      .slice(0, 30);
  }, [suggestionMode, fileSearchQuery]);

  const skillSearchQuery = useMemo(() => {
    if (input.startsWith("/skills ")) return input.slice("/skills ".length).trim();
    return "";
  }, [input]);

  const filteredSkills = useMemo(() => {
    if (suggestionMode !== "skills") return [];
    return availableSkills
      .filter((skill) => skill.toLowerCase().includes(skillSearchQuery.toLowerCase()))
      .slice(0, 30);
  }, [suggestionMode, skillSearchQuery, availableSkills]);

  const sessionSubcommands = useMemo(() => {
    if (suggestionMode !== "session-subcommands") return [];
    return [
      { value: "new", label: "new <name> - Create a new session" },
      { value: "list", label: "list - List all sessions" },
      { value: "switch", label: "switch <name> - Switch to a session" },
      { value: "delete", label: "delete <name> - Delete a session" },
    ];
  }, [suggestionMode]);

  const sessionNames = useMemo(() => {
    if (suggestionMode !== "session-names") return [];
    const sessions = listSessions();
    const activeSession = getActiveSession();
    return sessions.map((s) => ({
      value: s.name,
      label: `${s.name}${s.id === activeSession?.id ? " [ACTIVE]" : ""}`,
    }));
  }, [suggestionMode]);

  const contextModes = useMemo(() => {
    if (suggestionMode !== "context-modes") return [];
    return [
      { value: "light", label: "light - Minimal context" },
      { value: "default", label: "default - Balanced context" },
      { value: "max", label: "max - Maximum context" },
    ];
  }, [suggestionMode]);

  const changesSubcommands = useMemo(() => {
    if (suggestionMode !== "changes-subcommands") return [];
    return [
      { value: "diff", label: "diff <n> - Show what changed in that file" },
      { value: "revert", label: "revert <n> - Revert just that file" },
    ];
  }, [suggestionMode]);

  // Numbered to match what /changes prints, so the number the user sees in the
  // list is the number they type.
  const changesTargets = useMemo(() => {
    if (suggestionMode !== "changes-targets") return [];
    try {
      const { files } = getChanges(process.cwd(), getActiveSessionId() ?? null);
      return files.map((f, i) => ({
        value: String(i + 1),
        label: `${f.displayPath} (+${f.added} -${f.removed})`,
      }));
    } catch {
      return [];
    }
  }, [suggestionMode]);

  const providerSearchQuery = useMemo(() => {
    if (!input.startsWith("/model ")) return "";
    const parts = input.split(/\s+/);
    return parts[1] || "";
  }, [input]);

  const filteredProviders = useMemo(() => {
    if (suggestionMode !== "model-providers") return [];
    return PROVIDERS.filter((p) => p.startsWith(providerSearchQuery.toLowerCase()));
  }, [suggestionMode, providerSearchQuery]);

  const modelSearchQuery = useMemo(() => {
    if (!input.startsWith("/model ")) return { provider: "", query: "" };
    const parts = input.split(/\s+/);
    const provider = parts[1] || "";
    const query = parts[2] || "";
    return { provider: provider.toLowerCase(), query: query.toLowerCase() };
  }, [input]);

  const filteredModelNames = useMemo(() => {
    if (suggestionMode !== "model-names") return [];
    const { provider, query } = modelSearchQuery;
    const models = COMMON_MODELS[provider as ProviderChoice] || [];
    return models.filter((m) => m.toLowerCase().includes(query));
  }, [suggestionMode, modelSearchQuery]);

  const activeSuggestions = useMemo(() => {
    if (suggestionMode === "commands") {
      return filteredCommands.map((c) => ({ value: c.command, description: c.description }));
    }
    if (suggestionMode === "files") {
      return filteredFiles.map((f) => ({ value: f, description: "file" }));
    }
    if (suggestionMode === "skills") {
      return filteredSkills.map((s) => ({ value: s, description: "agent skill" }));
    }
    if (suggestionMode === "model-providers") {
      return filteredProviders.map((p) => ({ value: p, description: "provider" }));
    }
    if (suggestionMode === "model-names") {
      return filteredModelNames.map((m) => ({ value: m, description: "model" }));
    }
    if (suggestionMode === "session-subcommands") {
      return sessionSubcommands.map((s) => ({ value: s.value, description: s.label }));
    }
    if (suggestionMode === "session-names") {
      return sessionNames.map((s) => ({ value: s.value, description: s.label }));
    }
    if (suggestionMode === "context-modes") {
      return contextModes.map((m) => ({ value: m.value, description: m.label }));
    }
    if (suggestionMode === "changes-subcommands") {
      return changesSubcommands.map((s) => ({ value: s.value, description: s.label }));
    }
    if (suggestionMode === "changes-targets") {
      return changesTargets.map((t) => ({ value: t.value, description: t.label }));
    }
    return [];
  }, [suggestionMode, filteredCommands, filteredFiles, filteredSkills, filteredProviders, filteredModelNames, sessionSubcommands, sessionNames, contextModes, changesSubcommands, changesTargets]);

  const completedValue = useMemo(() => {
    if (activeSuggestions.length === 0 || selectedIndex >= activeSuggestions.length) return "";
    const selected = activeSuggestions[selectedIndex].value;
    if (suggestionMode === "commands") {
      return selected + " ";
    }
    if (suggestionMode === "files") {
      const prefix = input.startsWith("/file ") ? "/file " : "/add ";
      return prefix + selected + " ";
    }
    if (suggestionMode === "skills") {
      return "/skills " + selected + " ";
    }
    if (suggestionMode === "model-providers") {
      return "/model " + selected + " ";
    }
    if (suggestionMode === "model-names") {
      const provider = modelSearchQuery.provider;
      return `/model ${provider} ${selected} `;
    }
    if (suggestionMode === "session-subcommands") {
      return "/session " + selected + " ";
    }
    if (suggestionMode === "session-names") {
      const parts = input.split(/\s+/);
      const subcommand = parts[1] || "";
      return `/session ${subcommand} ${selected} `;
    }
    if (suggestionMode === "context-modes") {
      return "/context " + selected + " ";
    }
    if (suggestionMode === "changes-subcommands") {
      return "/changes " + selected + " ";
    }
    if (suggestionMode === "changes-targets") {
      const parts = input.split(/\s+/);
      const subcommand = parts[1] || "";
      return `/changes ${subcommand} ${selected} `;
    }
    return "";
  }, [input, suggestionMode, activeSuggestions, selectedIndex, modelSearchQuery]);

  // Reset indices when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
    setScrollOffset(0);
  }, [activeSuggestions.length]);

  const MAX_VISIBLE_SUGGESTIONS = 6;

  // Sync scrollOffset when selectedIndex changes
  useEffect(() => {
    if (activeSuggestions.length === 0) return;
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + MAX_VISIBLE_SUGGESTIONS) {
      setScrollOffset(selectedIndex - MAX_VISIBLE_SUGGESTIONS + 1);
    }
  }, [selectedIndex, activeSuggestions.length, scrollOffset]);

  const visibleCommands = useMemo(() => {
    return activeSuggestions.slice(scrollOffset, scrollOffset + MAX_VISIBLE_SUGGESTIONS);
  }, [activeSuggestions, scrollOffset]);

  const remainingBelow = activeSuggestions.length - (scrollOffset + MAX_VISIBLE_SUGGESTIONS);

  // Ref to always access the latest values inside useInput
  const inputStateRef = useRef({
    pendingConfirm,
    showSuggestions,
    activeSuggestions,
    selectedIndex,
    completedValue,
    isSelectingModel,
    modelSelectStep,
    selectedProvider,
    selectedModelIndex,
    customModelInput,
    suggestionMode,
  });
  inputStateRef.current = {
    pendingConfirm,
    showSuggestions,
    activeSuggestions,
    selectedIndex,
    completedValue,
    isSelectingModel,
    modelSelectStep,
    selectedProvider,
    selectedModelIndex,
    customModelInput,
    suggestionMode,
  };

  useInput((inputChar, key) => {
    const state = inputStateRef.current;

    // ── Esc cancels the run in flight ──────────────────────────────────
    //
    // Checked FIRST, and deliberately ahead of the confirmation prompt: a
    // permission dialog is exactly where a user realises the agent is doing
    // the wrong thing, and "deny this one write" is not the same as "stop".
    // Denying leaves the agent running and free to try something else.
    //
    // Before this, the only way out of a bad run was Ctrl+C, which kills the
    // whole CLI and takes the session with it.
    if (key.escape && abortRef.current) {
      abortRef.current.abort();
      // Release a pending confirmation too, or the aborted turn sits waiting
      // on a promise nobody will ever resolve.
      if (state.pendingConfirm) {
        state.pendingConfirm.resolve(false);
        setPendingConfirm(null);
      }
      return;
    }

    if (state.pendingConfirm) {
      if (inputChar.toLowerCase() === "y") {
        state.pendingConfirm.resolve(true);
        setPendingConfirm(null);
      } else if (inputChar.toLowerCase() === "n") {
        state.pendingConfirm.resolve(false);
        setPendingConfirm(null);
      }
      return;
    }

    if (state.isSelectingModel) {
      if (state.modelSelectStep === "choose-model") {
        if (key.downArrow) {
          setSelectedModelIndex((prev) => (prev + 1) % (MODEL_OPTIONS.length + 1));
        } else if (key.upArrow) {
          setSelectedModelIndex((prev) => (prev - 1 + MODEL_OPTIONS.length + 1) % (MODEL_OPTIONS.length + 1));
        } else if (key.return) {
          if (state.selectedModelIndex < MODEL_OPTIONS.length) {
            const option = MODEL_OPTIONS[state.selectedModelIndex];
            setDefaultProvider(option.provider);
            setProviderModel(option.provider, option.modelId);
            setModelSwitchNonce((n) => n + 1);
            setLog((l) => [
              ...l,
              { kind: "assistant", text: `Switched provider to ${SHORT_LABELS[option.provider]} and model to ${option.modelId}` },
            ]);
            setIsSelectingModel(false);
          } else {
            setModelSelectStep("choose-provider");
            setSelectedProvider("groq");
          }
        } else if (key.escape) {
          setIsSelectingModel(false);
        }
      } else if (state.modelSelectStep === "choose-provider") {
        if (key.downArrow) {
          setSelectedProvider((prev) => {
            const idx = PROVIDERS.indexOf(prev);
            return PROVIDERS[(idx + 1) % PROVIDERS.length];
          });
        } else if (key.upArrow) {
          setSelectedProvider((prev) => {
            const idx = PROVIDERS.indexOf(prev);
            return PROVIDERS[(idx - 1 + PROVIDERS.length) % PROVIDERS.length];
          });
        } else if (key.return) {
          setModelSelectStep("enter-custom-model");
          setCustomModelInput("");
        } else if (key.escape) {
          setModelSelectStep("choose-model");
          setSelectedModelIndex(0);
        }
      } else if (state.modelSelectStep === "enter-custom-model") {
        if (key.escape) {
          setModelSelectStep("choose-model");
          setSelectedModelIndex(0);
        }
      }
      return;
    }

    if (state.showSuggestions && state.activeSuggestions.length > 0) {
      if (key.downArrow) {
        setSelectedIndex((prev) => (prev + 1) % state.activeSuggestions.length);
      } else if (key.upArrow) {
        setSelectedIndex((prev) => (prev - 1 + state.activeSuggestions.length) % state.activeSuggestions.length);
      } else if (key.tab) {
        setInput(state.completedValue);
      } else if (key.escape) {
        setClosedSuggestions(true);
      }
    }
  });

  async function handleSubmit(userText: string) {
    // The @ overlay is open and has matches, so this Enter was the user
    // PICKING A FILE, not sending the prompt. Ink hands the keypress to every
    // mounted handler, so without this the file got inserted AND the
    // half-typed "@que" prompt got submitted in the same keystroke.
    if (fileSearchOwnsEnterRef.current) return;

    if (showSuggestions && activeSuggestions.length > 0) {
      const selected = activeSuggestions[selectedIndex].value;
      const cmdToRun = completedValue.trim();

      let shouldExecute = false;

      if (suggestionMode === "commands") {
        const executableCommands = [
          "/settings", "/keys", "/clear", "/reset", "/exit", "/quit", "/prompt", "/skills", "/help", "/model", "/auto", "/chat", "/ask", "/plan", "/build", "/effort", "/init"
        ];
        if (executableCommands.includes(selected)) {
          shouldExecute = true;
        }
      } else if (suggestionMode === "files" || suggestionMode === "skills" || suggestionMode === "session-subcommands" || suggestionMode === "session-names" || suggestionMode === "context-modes" || suggestionMode === "changes-subcommands" || suggestionMode === "changes-targets") {
        shouldExecute = true;
      }

      if (shouldExecute) {
        setInput("");
        const isCommand = await handleSlashCommand({
          userText: cmdToRun,
          history,
          systemPrompt: systemPromptRef.current,
          systemPromptText,
          onChangeKeys,
          onSelectModel: () => {
            setIsSelectingModel(true);
            setModelSelectStep("choose-model");
            setSelectedModelIndex(0);
          },
          onContextChange: () => {
            setContextReady(false);
            buildSystemPrompt(process.cwd()).then((prompt) => {
              systemPromptRef.current = prompt;
              setSystemPromptText(prompt);
              setContextReady(true);
              const provider = getDefaultProvider() || "groq";
              setTokenStats(calculateTokenStats(history.current, prompt, undefined, provider, usageEntries));
            });
            try {
              const map = buildRepoMap(process.cwd());
              setRepoMap(map);
            } catch {}
          },
          onModeChange: (mode: Mode) => applyFlow({ type: "set-mode", mode }),
          getCurrentMode: () => flowRef.current.pinnedMode,
          setLog,
          setTokenStats,
          calculateTokenStats,
        });
        return;
      }

      setInput(completedValue);
      return;
    }

    if (!userText.trim()) return;
    setInput("");

    // --- Slash Commands Interceptor ---
    // Slash commands bypass the busy guard so they work even while the agent is thinking
    const isCommand = await handleSlashCommand({
      userText,
      history,
      systemPrompt: systemPromptRef.current,
      systemPromptText,
      onChangeKeys,
      onSelectModel: () => {
        setIsSelectingModel(true);
        setModelSelectStep("choose-model");
        setSelectedModelIndex(0);
      },
      onContextChange: () => {
        setContextReady(false);
        buildSystemPrompt(process.cwd()).then((prompt) => {
          systemPromptRef.current = prompt;
          setSystemPromptText(prompt);
          setContextReady(true);
          const provider = getDefaultProvider() || "groq";
          setTokenStats(calculateTokenStats(history.current, prompt, undefined, provider, usageEntries));
        });
        try {
          const map = buildRepoMap(process.cwd());
          setRepoMap(map);
        } catch {}
      },
      onModeChange: (mode: Mode) => applyFlow({ type: "set-mode", mode }),
      getCurrentMode: () => flowRef.current.pinnedMode,
      setLog,
      setTokenStats,
      calculateTokenStats,
      onSessionChange: (sessionName: string) => setSessionName(sessionName),
    });
    if (isCommand) return;

    if (busy) return; // Only block normal messages, not commands

    const currentFlow = flowRef.current;

    // ── The plan gate ────────────────────────────────────────────────
    //
    // This is the ONLY place plan mode asks the user anything. There is no
    // clarification round beforehand — the planner states its assumptions and
    // this gate is where they get accepted, corrected, or thrown out.
    //
    // It accepts four short answers and, for anything else, treats what was
    // typed as a CORRECTION rather than a rejection. The old gate took y/n
    // only, so one wrong destination directory cost the user the whole prompt.
    if (currentFlow.isAwaitingPlanApproval && currentFlow.pendingPlan) {
      const answer = userText.trim().toLowerCase();
      setLog((l) => [...l, { kind: "user", text: userText }]);

      const rerunAs = (mode: Mode, note: string) => {
        // Discard the plan and rerun the ORIGINAL prompt on another route.
        // A misrouted plan is the router's mistake to undo, not the user's to
        // work around by retyping.
        const prompt = currentFlow.originalPrompt;
        applyFlow({ type: "plan-rejected" });
        const next = applyFlow({ type: "set-mode", mode });
        setLog((l) => [...l, { kind: "assistant", text: note }]);
        runOrchestratorFlow(prompt, { ...next, originalPrompt: prompt });
      };

      if (answer === "y" || answer === "yes" || answer === "continue") {
        const approvedSteps = currentFlow.pendingPlan;
        const next = applyFlow({ type: "plan-approved" });
        runOrchestratorFlow(next.originalPrompt, next, { approvedSteps });
        return;
      }

      if (answer === "n" || answer === "no" || answer === "cancel") {
        applyFlow({ type: "plan-rejected" });
        setLog((l) => [
          ...l,
          {
            kind: "assistant",
            text: "Plan cancelled. Nothing was written.",
          },
        ]);
        setBusy(false);
        return;
      }

      if (answer === "b" || answer === "build") {
        rerunAs("build", "Running it as a single build step instead.");
        return;
      }

      if (answer === "a" || answer === "ask") {
        rerunAs("ask", "Answering instead — nothing will be written.");
        return;
      }

      // Anything else is a correction. Re-plan with it and come back here.
      const revision = {
        previousSteps: currentFlow.pendingPlan,
        previousAssumptions: currentFlow.pendingAssumptions,
        feedback: userText.trim(),
      };
      const next = applyFlow({ type: "plan-revision-requested" });
      setLog((l) => [...l, { kind: "assistant", text: "Revising the plan…" }]);
      runOrchestratorFlow(next.originalPrompt, next, { planRevision: revision });
      return;
    }

    setLog((l) => [...l, { kind: "user", text: userText }]);
    history.current.push({ role: "user", content: userText });
    setBusy(true);

    // A new prompt starts a fresh flow: any pending plan and the
    // completed-step indices reset. Carrying completedStepIndices over used
    // to make the NEXT plan skip the steps at those indices.
    const freshFlow = applyFlow({ type: "prompt-submitted", prompt: userText });

    // Update token stats immediately for the user prompt
    const provider = getDefaultProvider() || "groq";
    setTokenStats(calculateTokenStats(history.current, systemPromptRef.current, undefined, provider, usageEntries));

    // ── Route through orchestrator ───────────────────────────────────────
    // Chat, build and plan mode all go through the orchestrator.
    // The orchestrator yields OrchestratorEvents that we render as log entries.
    runOrchestratorFlow(userText, freshFlow);
  }

  // ─── Orchestrator Flow Runner ────────────────────────────────────────
  //
  // Drives the orchestrator async generator and translates its events
  // into log entries and flow-state transitions.
  //
  // `flow` is passed IN rather than read from the render closure. This
  // function is re-invoked mid-turn (after clarifications, after plan
  // approval, after escalation) and must see the state the caller just
  // produced — not the state captured when this closure was created.
  async function runOrchestratorFlow(
    prompt: string,
    flowState: OrchestratorFlowState,
    opts: { approvedSteps?: PlanStep[]; planRevision?: PlanRevision } = {},
  ) {
    setBusy(true);

    // One controller per turn. Any previous one is aborted first so a stale
    // run cannot keep streaming behind the new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const submitTime = Date.now();
    let currentAssistantText = "";
    let assistantEntryAdded = false;
    let firstPartReceived = false;
    let thoughtDuration = "";
    let hasActualUsage = false;

    // Deltas arrive far faster than a terminal can usefully repaint: a quick
    // provider lands dozens per second, and every setLog redraws the header,
    // the whole transcript, the input box and the sidebar. That full-frame
    // repaint at token rate is what makes the prompt row jitter mid-answer.
    // So deltas accumulate in `currentAssistantText` and are committed to the
    // log on a fixed cadence instead — the text still reads as streaming,
    // but the frame rate is one a terminal can actually keep up with.
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const commitAssistantText = () => {
      setLog((l) => {
        if (!assistantEntryAdded) {
          assistantEntryAdded = true;
          return [
            ...l,
            { kind: "assistant", text: currentAssistantText, thoughtDuration },
          ];
        }
        const updated = [...l];
        updated[updated.length - 1] = {
          kind: "assistant",
          text: currentAssistantText,
          thoughtDuration,
        };
        return updated;
      });
    };

    /**
     * Commits what has accumulated and cancels any pending repaint.
     *
     * Every non-delta event calls this FIRST. A queued flush rewrites
     * `log[log.length - 1]`, so if a tool-call entry were appended while one
     * was still pending, that flush would land on the tool call and overwrite
     * it with assistant text.
     */
    const flushAssistantText = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (currentAssistantText) commitAssistantText();
    };

    const scheduleAssistantFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        commitAssistantText();
      }, STREAM_FLUSH_MS);
    };

    try {
      // One resolution point for provider, model, and every sampling knob.
      // Effort drives all of them together, so they cannot contradict.
      const agentConfig = resolveAgentConfig();
      const provider = agentConfig.provider;
      const model = resolveModel(provider, agentConfig.modelId);

      // Build the project context for the orchestrator
      const projectContext = {
        projectRoot: process.cwd(),
        systemPrompt: systemPromptRef.current,
        maxSteps: agentConfig.maxSteps,
        temperature: agentConfig.temperature,
        maxOutputTokens: agentConfig.maxOutputTokens,
        autoVerify: autoVerifyEnabled(),
      };

      // Mode comes from the flow state passed in, not from the render
      // closure, so a mode the user just set is honoured on this very call.
      const modeContext = {
        mode: flowState.pinnedMode,
        reason: "user-flag" as const,
      };

      // ── Drive the orchestrator ──────────────────────────────────────────
      const orchestrator = runOrchestrator({
        userPrompt: prompt,
        modeContext,
        context: projectContext,
        model,
        onConfirm: confirmFn,
        approvedPlan: opts.approvedSteps,
        planRevision: opts.planRevision,
        completedStepIndices: flowState.completedStepIndices,
        history: history.current,
        provider,
        abortSignal: controller.signal,
      });

      let result = await orchestrator.next();
      while (!result.done) {
        // The signal stops the provider request; this stops US. Without it the
        // loop would keep draining buffered events after the user said stop.
        if (controller.signal.aborted) {
          await orchestrator.return(undefined as never).catch(() => {});
          break;
        }

        const event = result.value;

        // Anything that is not a text delta is about to touch the log, so the
        // buffered text has to land first and in order.
        if (!(event.kind === "agent-event" && event.event.kind === "text-delta")) {
          flushAssistantText();
        }

        // ── Handle orchestrator-level events ──────────────────────────────
        switch (event.kind) {
          case "route-decided":
            // Auto mode only. Handled by "mode-info" below for both the badge
            // and the log line — this event exists so the route can be
            // observed without inferring it, and is where a future "wrong
            // route, redirect me" affordance would hang.
            break;

          case "mode-info":
            // Record the route WITHOUT touching the pinned mode. In auto mode
            // these differ every turn, and overwriting the pin would mean one
            // routed prompt silently ended auto mode for the session.
            applyFlow({ type: "route-reported", route: event.mode, reason: event.reason });
            setLog((l) => [
              ...l,
              { kind: "mode-switch", mode: event.mode, reason: event.reason },
            ]);
            break;

          case "plan-ready":
            // The planner generated a plan — display it at the gate.
            applyFlow({
              type: "plan-received",
              steps: event.steps,
              assumptions: event.assumptions,
            });

            setLog((l) => [
              ...l,
              {
                kind: "plan-display",
                steps: event.steps,
                assumptions: event.assumptions,
                routeReason: event.routeReason,
                projectRoot: process.cwd(),
              },
              { kind: "assistant", text: PLAN_GATE_PROMPT },
            ]);

            // STOP processing — we'll re-invoke once the user decides.
            setBusy(false);
            return;

          case "step-start":
            // Show step progress in the log
            setLog((l) => [
              ...l,
              {
                kind: "step-progress",
                stepIndex: event.step.index,
                totalSteps: event.totalSteps,
                description: event.step.description,
                modelTier: event.modelTier,
              },
            ]);
            break;

          case "step-verified":
            // Show verification result
            setLog((l) => [
              ...l,
              {
                kind: "verification",
                stepIndex: event.step.index,
                verified: event.verification.verified,
                findings: event.verification.findings,
                mismatches: event.verification.mismatches,
                verboseFeedback: event.verification.verboseFeedback,
                modelTier: event.modelTier,
              },
            ]);
            // Record completion. The reducer ignores duplicates, which the
            // orchestrator produces for steps it skipped as already-done.
            applyFlow({
              type: "step-verified",
              stepIndex: event.step.index,
              verified: event.verification.verified,
            });
            break;

          case "step-retry": {
            // The step failed on something real and is being run again with
            // the error fed back. Say WHY, or the user just sees the same step
            // run twice with no explanation.
            const reason = event.findings
              .map((f) => f.detail?.split("\n")[0] ?? f.code)
              .join("; ");
            setLog((l) => [
              ...l,
              { kind: "step-retry", stepIndex: event.step.index, reason, attempt: event.attempt },
            ]);
            break;
          }

          case "recovery-exhausted": {
            // The loud one. A step that could not be repaired used to look
            // exactly like an ordinary failed verification and scroll past
            // with it; the whole point of surfacing this separately is that
            // the user now has to decide something.
            const reason = event.findings
              .map((f) => f.detail?.split("\n")[0] ?? f.code)
              .join("; ");
            setLog((l) => [
              ...l,
              {
                kind: "recovery-exhausted",
                stepIndex: event.step.index,
                reason,
                attempts: event.attempts,
                cause: event.reason,
              },
            ]);
            break;
          }

          case "history-updated":
            history.current = event.history;
            break;

          case "scope-hint": {
            // ADVISORY. One line in the log, then the turn carries on.
            //
            // This used to be a modal y/n offering to restart the request in
            // plan mode. It fired on verification failure too, which the
            // verifier reports routinely, so ordinary turns were interrupted
            // to ask whether to throw away the work just done. Worse, the
            // confirm overlay was never cleared when the flow moved on, so
            // the prompt stayed on screen underneath whatever came next.
            const { reason, fileCount } = event.hint;
            const message =
              reason === "touched-many-files"
                ? `This touched ${fileCount} files. For changes this size, /plan gives you a reviewable plan before anything runs.`
                : "Verification found mismatches above. Worth a look before you build on this \u2014 or re-run it in /plan for step-by-step checks.";
            setLog((l) => [...l, { kind: "scope-hint", text: message }]);
            break;
          }

          case "agent-event": {
            // Forward raw agent events — same rendering as before
            const agentEvent = event.event;

            if (!firstPartReceived && (agentEvent.kind === "text-delta" || agentEvent.kind === "tool-call")) {
              firstPartReceived = true;
              thoughtDuration = formatDuration(Date.now() - submitTime);
            }

            if (agentEvent.kind === "text-delta") {
              currentAssistantText += agentEvent.text;
              scheduleAssistantFlush();
            } else if (agentEvent.kind === "tool-call") {
              assistantEntryAdded = false;
              currentAssistantText = "";
              setLog((l) => [
                ...l,
                {
                  kind: "tool-call",
                  toolCallId: agentEvent.toolCallId,
                  name: agentEvent.toolName,
                  input: agentEvent.input,
                  startTime: Date.now(),
                  status: "running",
                },
              ]);
            } else if (agentEvent.kind === "tool-result") {
              setLog((l) =>
                l.map((entry) => {
                  if (entry.kind === "tool-call" && entry.toolCallId === agentEvent.toolCallId) {
                    return {
                      ...entry,
                      status: "success",
                      output: agentEvent.output,
                      duration: formatDuration(Date.now() - entry.startTime),
                    };
                  }
                  return entry;
                })
              );
            } else if (agentEvent.kind === "tool-error") {
              const errMsg = String(agentEvent.error);
              setLog((l) =>
                l.map((entry) => {
                  if (entry.kind === "tool-call" && entry.toolCallId === agentEvent.toolCallId) {
                    return {
                      ...entry,
                      status: "error",
                      errorMessage: errMsg,
                      duration: formatDuration(Date.now() - entry.startTime),
                    };
                  }
                  return entry;
                })
              );
            } else if (agentEvent.kind === "finish") {
              if (agentEvent.usage) {
                hasActualUsage = true;
                const modelId = getActiveModelId(provider);
                // Bind once: the setState callbacks below are closures, so the
                // `if` narrowing above doesn't reach inside them.
                const usage = agentEvent.usage;

                // Add to usage entries for cost tracking
                setUsageEntries((prev) => [
                  ...prev,
                  {
                    model: modelId,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                  },
                ]);
                
                setTokenStats(
                  calculateTokenStats(
                    history.current,
                    systemPromptRef.current,
                    {
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                    },
                    provider,
                    usageEntries
                  )
                );
              }
            }
            break;
          }

          case "complete":
            // Orchestration finished successfully
            {
              const isConversational = (p: string) => {
                const cleaned = p.trim().toLowerCase();
                if (/^(hi|hello|hey|yo|hola|greetings|good morning|good afternoon|good evening|howdy|sup|whats up|what's up)(?:\s|[.,!?]|$)/i.test(cleaned)) {
                  return true;
                }
                if (cleaned === "test" || cleaned === "ping" || cleaned === "how are you" || cleaned === "who are you" || cleaned === "what is your name") {
                  return true;
                }
                return false;
              };
              if (isConversational(prompt)) {
                history.current.push({ role: "assistant", content: currentAssistantText });
              }
            }
            break;
        }

        result = await orchestrator.next();
      }

      // Update token stats at the end if actual usage wasn't received
      if (!hasActualUsage) {
        setTokenStats(calculateTokenStats(history.current, systemPromptRef.current, undefined, provider, usageEntries));
      }
    } catch (err: any) {
      // A user-initiated stop is not a failure, and it can surface here as
      // AbortError or APICallError depending on where it lands — so the
      // controller's own state is the reliable signal, not the error shape.
      // The message itself is emitted in `finally`, because aborting between
      // events breaks the loop cleanly and never reaches this catch.
      if (!controller.signal.aborted) {
        const raw = err.message ?? String(err);
        // Ollama reports failures as raw llama-server stderr, which says
        // nothing a user can act on — "failed to allocate CPU_REPACK buffer"
        // means "close some apps or pick a smaller model". Falls through to
        // the original whenever the message is not one we recognise: a worse
        // guess is not an improvement.
        const explained =
          getDefaultProvider() === "ollama"
            ? explainOllamaError(raw, getActiveModelId("ollama"))
            : null;
        setLog((l) => [...l, { kind: "error", text: explained ?? raw }]);
      }
    } finally {
      // A pending flush outlives the turn otherwise, and would repaint the
      // transcript after the spinner is already gone.
      flushAssistantText();

      // Findings published by the local-model request hook, e.g. that Ollama
      // ignored our num_ctx and is silently truncating the prompt. Drained
      // here rather than printed at the source because the sdk layer cannot
      // reach the UI, and a console write would corrupt the Ink frame.
      for (const warning of drainOllamaWarnings()) {
        setLog((l) => [...l, { kind: "error", text: warning }]);
      }

      // One place for the stopped notice, covering both exits: the throw above
      // and the clean `break` in the event loop.
      if (controller.signal.aborted) {
        setLog((l) => [
          ...l,
          {
            kind: "assistant",
            text: "Stopped. Anything already written to disk is still there — /undo rolls back the last step.",
          },
        ]);
      }
      abortRef.current = null;
      setBusy(false);
      // Auto-save session state after each turn
      try {
        const pinnedFilesArray = Array.from(pinnedContextFiles);
        saveActiveSessionState(
          history.current,
          tokenStats,
          pinnedFilesArray,
          log,
          flowRef.current.pinnedMode,
          {
            pendingPlan: flowRef.current.pendingPlan,
            pendingAssumptions: flowRef.current.pendingAssumptions,
            isAwaitingPlanApproval: flowRef.current.isAwaitingPlanApproval,
            originalPrompt: flowRef.current.originalPrompt,
            completedStepIndices: flowRef.current.completedStepIndices,
          },
          // What this turn read, changed, ran and verified. Undefined for a
          // route that did no work (chat, ask), which leaves the previous
          // task's record in place rather than blanking it.
          persistTaskState(),
        );
      } catch {}
    }
  }

  // Format token counts beautifully (e.g. 8407 -> 8.4K)
  const formattedTokensStr = useMemo(() => {
    const t = tokenStats.totalTokens;
    if (t >= 1000) {
      return `${(t / 1000).toFixed(1)}K`;
    }
    return String(t);
  }, [tokenStats.totalTokens]);

  // One computation for all three badges (header, input footer, sidebar), so
  // they cannot disagree about what mode the session is in.
  const modeBadge = useMemo(
    () => badgeFor(flow.pinnedMode, flow.lastRoute),
    [flow.pinnedMode, flow.lastRoute],
  );

  // The repo map is split three times over in the sidebar. It runs to
  // thousands of lines and never changes mid-session, so redoing that on
  // every streamed frame is pure cost against the redraw budget.
  const repoMapPreview = useMemo(() => {
    if (!repoMap) return null;
    const lines = repoMap.split("\n");
    return { total: lines.length, head: lines.slice(0, 10) };
  }, [repoMap]);

  return (
    <Box flexDirection="row" width="100%">
      {/* Left conversation pane */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingRight={showSidebar ? 1 : 0}>
        {/* Chat Header */}
        <Box flexDirection="row" justifyContent="space-between" paddingX={1} paddingY={1} borderStyle="single" borderColor="gray" backgroundColor="#0A0C0E">
          <Box flexDirection="row" gap={2}>
            <Text color="#E6E6E6" bold>{sessionName}</Text>
            <Text color="gray">•</Text>
            <Text color="gray">{sessionId}</Text>
          </Box>
          <Box flexDirection="row" gap={2}>
            <Text color={modeBadge.color} bold>{modeBadge.glyph} {modeBadge.label}</Text>
            <Text color="gray">{formattedTokensStr} tokens</Text>
          </Box>
        </Box>
        
        {/* Chat History Pane */}
        <Box flexDirection="column" flexGrow={1} minHeight={10} padding={1}>
          {log.map((entry, i) => <LogLine key={i} entry={entry} />)}
        </Box>

        {/* Input box */}
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          {pendingConfirm ? (
            <Box borderStyle="round" borderColor="yellow" paddingX={1} backgroundColor="#15171C">
              <Text color="yellow">⚠ {pendingConfirm.description} — Allow? (y/n)</Text>
            </Box>
          ) : !contextReady ? (
            <Text dimColor>Scanning project for context…</Text>
          ) : isSelectingModel ? (
            <Box flexDirection="column" borderStyle="round" borderColor="#3B5FE0" paddingX={1} paddingY={1} backgroundColor="#15171C">
              {modelSelectStep === "choose-model" && (
                <Box flexDirection="column">
                  <Text bold color="white">Select Active Model</Text>
                  <Text color="gray">(↑/↓ to select, Enter to confirm, Esc to cancel)</Text>
                  <Box flexDirection="column" marginTop={1}>
                    {MODEL_OPTIONS.map((opt, idx) => {
                      const isSel = idx === selectedModelIndex;
                      return (
                        <Text key={opt.label} color={isSel ? "#3B5FE0" : undefined} bold={isSel}>
                          {isSel ? "❯ " : "  "}
                          {opt.label}
                        </Text>
                      );
                    })}
                    <Text color={selectedModelIndex === MODEL_OPTIONS.length ? "#3B5FE0" : undefined} bold={selectedModelIndex === MODEL_OPTIONS.length}>
                      {selectedModelIndex === MODEL_OPTIONS.length ? "❯ " : "  "}
                      Custom model...
                    </Text>
                  </Box>
                </Box>
              )}
              {modelSelectStep === "choose-provider" && (
                <Box flexDirection="column">
                  <Text bold color="white">Select Provider for Custom Model</Text>
                  <Text color="gray">(↑/↓ to select, Enter to confirm, Esc to go back)</Text>
                  <Box flexDirection="column" marginTop={1}>
                    {PROVIDERS.map((p) => {
                      const isSel = p === selectedProvider;
                      return (
                        <Text key={p} color={isSel ? "#3B5FE0" : undefined} bold={isSel}>
                          {isSel ? "❯ " : "  "}
                          {SHORT_LABELS[p]}
                        </Text>
                      );
                    })}
                  </Box>
                </Box>
              )}
              {modelSelectStep === "enter-custom-model" && (
                <Box flexDirection="column">
                  <Text bold color="white">Enter Custom Model Name for {SHORT_LABELS[selectedProvider]}</Text>
                  <Text color="gray">(Enter to confirm, Esc to go back)</Text>
                  <Box marginTop={1} flexDirection="row">
                    <Text color="#3B5FE0" bold>❯ </Text>
                    <TextInput
                      value={customModelInput}
                      onChange={setCustomModelInput}
                      onSubmit={(val) => {
                        const modelName = val.trim();
                        if (modelName) {
                          setDefaultProvider(selectedProvider);
                          setProviderModel(selectedProvider, modelName);
                          setModelSwitchNonce((n) => n + 1);
                          setLog((l) => [
                            ...l,
                            { kind: "assistant", text: `Switched provider to ${SHORT_LABELS[selectedProvider]} and model to ${modelName}` },
                          ]);
                          setIsSelectingModel(false);
                        }
                      }}
                    />
                  </Box>
                </Box>
              )}
            </Box>
          ) : (
            <Box flexDirection="column">
              {showSuggestions && activeSuggestions.length > 0 && (
                <Box
                  flexDirection="column"
                  borderStyle="round"
                  borderColor="gray"
                  backgroundColor="#15171C"
                  paddingY={0}
                  paddingX={0}
                  marginBottom={1}
                >
                  {scrollOffset > 0 && (
                    <Box paddingX={1} paddingY={0}>
                      <Text color="gray">
                        {"  "}▲ {scrollOffset} more
                      </Text>
                    </Box>
                  )}
                  {visibleCommands.map((cmd, idx) => {
                    const actualIdx = scrollOffset + idx;
                    const isSelected = actualIdx === selectedIndex;
                    return (
                      <Box
                        key={cmd.value}
                        flexDirection="row"
                        justifyContent="space-between"
                        backgroundColor={isSelected ? "cyan" : undefined}
                        paddingX={1}
                      >
                        <Text color={isSelected ? "black" : "white"} bold={isSelected}>
                          {isSelected ? "> " : "  "}
                          {cmd.value}
                        </Text>
                        <Text color={isSelected ? "black" : "gray"}>
                          {cmd.description}
                        </Text>
                      </Box>
                    );
                  })}
                  {remainingBelow > 0 && (
                    <Box paddingX={1} paddingY={0}>
                      <Text color="gray">
                        {"  "}▼ {remainingBelow} more
                      </Text>
                    </Box>
                  )}
                </Box>
              )}

              {/* File Search Overlay */}
              {showFileSearch && (
                <FileSearchOverlay
                  inputValue={input}
                  cursorPosition={input.length}
                  onSelectFile={(filePath) => {
                    // Replace @<query> at the end of input with the selected file path
                    const atMatch = input.match(/@([^\s]*)$/);
                    if (atMatch) {
                      const beforeAt = input.slice(0, atMatch.index);
                      const newInput = beforeAt + filePath;
                      setInput(newInput);
                    }
                    setShowFileSearch(false);
                  }}
                  onActiveChange={(active) => { fileSearchOwnsEnterRef.current = active; }}
                  onClose={() => setShowFileSearch(false)}
                />
              )}

              <Box borderStyle="round" borderColor="#3B5FE0" paddingX={1} paddingY={1} backgroundColor="#15171C">
                <Text color="#3B5FE0" bold>{"❯ "}</Text>
                <TextInput 
                  value={input} 
                  onChange={setInput} 
                  onSubmit={handleSubmit}
                  placeholder={""}
                />
                {busy && <ThinkingLoader />}
              </Box>

              {/* What is currently running. Also the only warning the user
                  gets that quitting takes their dev servers with it. */}
              <RunningServices />

              {/* Input Footer */}
              <Box flexDirection="row" justifyContent="space-between" paddingX={1} marginTop={0}>
                <Box flexDirection="row" gap={1}>
                  <Text backgroundColor={modeBadge.color} color="white" bold> {modeBadge.label} · {resolveAgentConfig().effort} </Text>
                  <Text color="gray">{getActiveModelId(getDefaultProvider() || "groq")}</Text>
                </Box>
                <Box flexDirection="row" gap={2}>
                  <Text color="gray">{formattedTokensStr} ({tokenStats.pctUsed}%)</Text>
                  <Text color="gray">ctrl+p commands · <Text color="#3B5FE0" bold>zizou</Text></Text>
                </Box>
              </Box>
            </Box>
          )}
        </Box>
      </Box>

      {/* Right session sidebar */}
      {showSidebar && (
        <Box
          flexDirection="column"
          width={30}
          borderStyle="single"
          borderColor="gray"
          padding={1}
          justifyContent="space-between"
        >
          {/* Section 1: Session header */}
          <Box flexDirection="column" marginBottom={1}>
            <Text color="#E6E6E6" bold>{sessionName}</Text>
            <Text color="gray">{sessionId}</Text>
            <Box flexDirection="row" gap={1} marginTop={0}>
              <Text color={modeBadge.color} bold>{modeBadge.glyph} {modeBadge.label}</Text>
              <Text color="gray">mode</Text>
            </Box>
          </Box>

          {/* Section 2: Tokens and spend.
              Reads the telemetry ledger directly rather than the `tokenStats`
              state, because that state only ever saw executor usage — the
              router, planner and verifier calls never reached it. See
              src/telemetry/usage.ts. */}
          <TokenStatsPanel
            contextLimit={tokenStats.contextLimit}
            modelId={activeModelId}
            provider={activeProvider}
          />

          {/* Section 3: How this model scored on the golden tasks. */}
          <EvalStatsPanel
            projectRoot={projectRoot}
            modelId={activeModelId}
            currentSha={currentSha}
          />

          {/* Section 3: LSP status */}
          <Box flexDirection="column" marginBottom={1}>
            <Text color="#E6E6E6" bold>LSP</Text>
            <Text color="gray">LSPs are disabled</Text>
          </Box>

          {/* Section 4: Repo Map live view */}
          <Box flexDirection="column" marginBottom={1}>
            <Text color="#E6E6E6" bold>Repo Map</Text>
            {!contextReady || !repoMapPreview ? (
              <Text color="gray" dimColor>loading…</Text>
            ) : (
              <>
                <Text color="gray" dimColor>
                  {repoMapPreview.total} lines
                </Text>
                {repoMapPreview.head.map((line, i) => (
                  <Text key={i} color="#4A5568" dimColor wrap="truncate">
                    {line || " "}
                  </Text>
                ))}
                {repoMapPreview.total > 10 && (
                  <Text color="#4A5568" dimColor>
                    … ({repoMapPreview.total - 10} more lines)
                  </Text>
                )}
              </>
            )}
          </Box>

          {/* Spacer */}
          <Box flexGrow={1} />

          {/* Mountains Art */}
          <Box justifyContent="center" paddingBottom={1} width="100%">
            <SidebarMountains />
          </Box>

          {/* Sidebar Wordmark */}
          <Box justifyContent="center" paddingY={1} width="100%">
            <SidebarWordmark />
          </Box>

          {/* Sidebar Footer Paths */}
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{cwd}</Text>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text color="#5FB87A">●</Text>
              <Text color="#E6E6E6" bold>Zizou</Text>
              <Text color="gray">{pkg.version}</Text>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}

/**
 * Renders one transcript line, and never takes the app down doing it.
 *
 * The log is display history, some of it restored from disk and written by
 * older versions of Zizou. parseRestoredLog repairs what it can on the way in,
 * but this is the second layer: a renderer that throws here unmounts the
 * WHOLE TUI, so the session cannot be opened at all and its history is
 * unreachable. One unreadable line is worth one unreadable line.
 *
 * Ink has no error boundary here, so this is a try/catch rather than one.
 */
const LogLine = React.memo(function LogLine({ entry }: { entry: LogEntry }) {
  try {
    return <LogLineInner entry={entry} />;
  } catch (err) {
    return (
      <Box marginBottom={1}>
        <Text color="#6B7280" dimColor>
          [unreadable log entry: {err instanceof Error ? err.message : String(err)}]
        </Text>
      </Box>
    );
  }
});

function LogLineInner({ entry }: { entry: LogEntry }) {
  if (entry.kind === "user") {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderLeft={true}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor="#3B5FE0"
        paddingLeft={2}
        backgroundColor="#15171C"
        marginBottom={1}
      >
        <Text color="#E6E6E6">{entry.text}</Text>
      </Box>
    );
  }
  if (entry.kind === "assistant") {
    return (
      <Box marginBottom={1} flexDirection="column">
        {entry.thoughtDuration && (
          <Box marginBottom={1}>
            <Text color="#D08A4E">+ Thought: {entry.thoughtDuration}</Text>
          </Box>
        )}
        <Text color="#E6E6E6">{entry.text}</Text>
      </Box>
    );
  }
  if (entry.kind === "tool-call") {
    const isRunning = entry.status === "running";
    const isError = entry.status === "error";
    const isSuccess = entry.status === "success";

    // Format input args as "key=value" pairs (truncated to 80 chars per value)
    const inputArgs = entry.input && typeof entry.input === "object"
      ? Object.entries(entry.input as Record<string, unknown>)
          .map(([k, v]) => {
            const val = typeof v === "string" ? v : JSON.stringify(v);
            return `${k}=${val.length > 80 ? val.slice(0, 77) + "..." : val}`;
          })
          .join("  ")
      : "";

    // Format output preview (success case)
    let outputPreview = "";
    if (isSuccess && entry.output !== undefined) {
      const raw = typeof entry.output === "string" ? entry.output : JSON.stringify(entry.output);
      outputPreview = raw.length > 120 ? raw.slice(0, 117) + "..." : raw;
    }

    return (
      <Box marginBottom={1} flexDirection="column">
        {/* Header row */}
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color={isError ? "red" : isSuccess ? "#5FB87A" : "#3B5FE0"}>■</Text>
          <Text bold color={isError ? "red" : "#E6E6E6"}>{entry.name}</Text>
          <Text color="gray">·</Text>
          <Text color="gray">Zizou</Text>
          <Text color="gray">·</Text>
          <Text color={isError ? "red" : isRunning ? "yellow" : "gray"}>
            {isRunning ? "running…" : entry.duration}
          </Text>
          {isSuccess && <Text color="#5FB87A"> ✓ done</Text>}
          {isError && <Text color="red"> ✗ failed</Text>}
        </Box>
        {/* Args row */}
        {inputArgs !== "" && (
          <Box paddingLeft={2}>
            <Text color="#6B7280" dimColor>↳ {inputArgs}</Text>
          </Box>
        )}
        {/* Success output preview */}
        {isSuccess && outputPreview !== "" && (
          <Box paddingLeft={2}>
            <Text color="#5FB87A" dimColor>↳ {outputPreview}</Text>
          </Box>
        )}
        {/* Error message */}
        {isError && entry.errorMessage && (
          <Box paddingLeft={2}>
            <Text color="red">↳ {entry.errorMessage}</Text>
          </Box>
        )}
      </Box>
    );
  }
  if (entry.kind === "error") {
    return (
      <Box marginBottom={1}>
        <Text color="red">Error: {entry.text}</Text>
      </Box>
    );
  }

  // ── New orchestrator log entry renderers ────────────────────────────

  if (entry.kind === "plan-display") {
    // Renders the structured plan as a numbered list for user review.
    // Each step shows its description and target files.
    return (
      <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="#D08A4E" paddingX={1} paddingY={1} backgroundColor="#15171C">
        <Text color="#D08A4E" bold>📋 Execution Plan</Text>
        <Text color="gray" dimColor>─────────────────────</Text>
        {/*
          Assumptions come FIRST, above the steps.

          They are what the planner decided for you, and the whole reason plan
          mode no longer asks questions up front: you review concrete choices
          next to the plan they produced, and reject with a correction if one
          is wrong. Putting them below the steps would bury the part most
          likely to be wrong.
        */}
        {/*
          Why the router picked plan, when it did. A pinned /plan gets nothing
          here — telling someone who typed /plan that they are in plan mode is
          noise. A ROUTED plan is a guess, and the guess should be visible
          next to the thing it produced.
        */}
        {entry.routeReason && (
          <Box marginBottom={1}>
            <Text color="#8A6FD4">{entry.routeReason}</Text>
          </Box>
        )}
        {entry.assumptions.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="#5BA37F" bold>Assumptions — say what to change, or n to cancel:</Text>
            {entry.assumptions.map((assumption, ai) => (
              <Box key={ai} paddingLeft={2}>
                <Text color="gray">• {assumption}</Text>
              </Box>
            ))}
          </Box>
        )}
        {entry.steps.map((step) => (
          <Box key={step.index} flexDirection="column" marginTop={step.index > 0 ? 1 : 0}>
            <Box flexDirection="row" gap={1}>
              <Text color="#3B5FE0" bold>Step {step.index + 1}.</Text>
              <Text color="#E6E6E6">{step.description}</Text>
            </Box>
            {/*
              Each file marked new (+) or existing (~).

              This is the part of the gate that earns its keep: it is where
              "it is about to create chess.html at the repo root" becomes
              visible BEFORE approval rather than after, while a correction
              still costs one line of typing.
            */}
            {step.targetFiles.length > 0 && (
              <Box paddingLeft={2} flexDirection="column">
                {step.targetFiles.map((file, fi) => {
                  const isNew = !fileExists(entry.projectRoot, file);
                  return (
                    <Box key={fi} flexDirection="row" gap={1}>
                      <Text color={isNew ? "#5BA37F" : "#D08A4E"} bold>{isNew ? "+" : "~"}</Text>
                      <Text color="gray" dimColor>{file}</Text>
                      <Text color={isNew ? "#5BA37F" : "gray"} dimColor>
                        {isNew ? "(new)" : "(edit)"}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            )}
            {step.dependsOn.length > 0 && (
              <Box paddingLeft={2}>
                <Text color="gray" dimColor>⤷ depends on: step {step.dependsOn.map(d => d + 1).join(", ")}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    );
  }

  if (entry.kind === "step-progress") {
    // Shows which step is currently executing (e.g., "Step 2/5: ...")
    const tierLabel = entry.modelTier === "local" ? "[local]" : entry.modelTier === "hosted" ? "[hosted]" : "";
    const tierColor = entry.modelTier === "local" ? "green" : entry.modelTier === "hosted" ? "yellow" : "gray";
    
    return (
      <Box marginBottom={1} flexDirection="row" gap={1}>
        <Text color="#3B5FE0" bold>▶</Text>
        <Text color="#E6E6E6" bold>Step {entry.stepIndex + 1}/{entry.totalSteps}:</Text>
        {tierLabel && <Text color={tierColor} bold>{tierLabel}</Text>}
        <Text color="gray">{entry.description}</Text>
      </Box>
    );
  }

  if (entry.kind === "verification") {
    // A step can PASS WITH NOTES. Hard findings are failures and print red;
    // soft ones are predictions that did not pan out and print as dim amber
    // notes under a green tick. Rendering both in red is what taught everyone
    // to scroll past the real ones.
    const tierLabel = entry.modelTier === "local" ? "[local]" : entry.modelTier === "hosted" ? "[hosted]" : "";
    const tierColor = entry.modelTier === "local" ? "green" : entry.modelTier === "hosted" ? "yellow" : "gray";

    const findings = entry.findings ?? [];
    const hard = findings.filter((f) => f.severity === "hard");
    const soft = findings.filter((f) => f.severity === "soft");

    const line = (f: { code: string; file?: string; detail?: string }) =>
      `${f.code}${f.file ? `: ${f.file}` : ""}${f.detail ? ` — ${f.detail.split("\n")[0]}` : ""}`;

    return (
      <Box marginBottom={1} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={entry.verified ? "#5FB87A" : "red"}>{entry.verified ? "✓" : "✗"}</Text>
          {tierLabel && <Text color={tierColor} bold>{tierLabel}</Text>}
          <Text color={entry.verified ? "#5FB87A" : "red"} bold>
            Step {entry.stepIndex + 1} verification {entry.verified ? "passed" : "failed"}
            {entry.verified && soft.length > 0 ? ` (${soft.length} note${soft.length > 1 ? "s" : ""})` : ""}
          </Text>
        </Box>
        {hard.length > 0 && (
          <Box paddingLeft={2} flexDirection="column">
            {hard.map((f, i) => (
              <Text key={`h${i}`} color="red">↳ {line(f)}</Text>
            ))}
          </Box>
        )}
        {soft.length > 0 && (
          <Box paddingLeft={2} flexDirection="column">
            {soft.map((f, i) => (
              <Text key={`s${i}`} color="yellow" dimColor>⚠ {line(f)}</Text>
            ))}
          </Box>
        )}
        {entry.verboseFeedback && (
          <Box paddingLeft={2} marginTop={0.5}>
            <Text color="gray" italic>Feedback: {entry.verboseFeedback}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (entry.kind === "step-retry") {
    return (
      <Box marginBottom={1} flexDirection="row" gap={1}>
        <Text color="#D9A441">↻</Text>
        <Text color="#D9A441" bold>Retrying step {entry.stepIndex + 1}</Text>
        <Text color="gray">{entry.reason}</Text>
      </Box>
    );
  }

  if (entry.kind === "recovery-exhausted") {
    // Red and boxed, unlike the amber retry line: a retry is the agent still
    // working, this is the agent stopping. Saying WHICH kind of stuck matters
    // — "failed the same way twice" tells the user a third attempt is
    // pointless, which is the one thing they would otherwise try first.
    const because =
      entry.cause === "no-progress"
        ? `attempt ${entry.attempts} failed in exactly the same way as the one before it`
        : `no attempts left after ${entry.attempts}`;

    return (
      <Box marginBottom={1} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color="red">✗</Text>
          <Text color="red" bold>
            Step {entry.stepIndex + 1} could not be repaired
          </Text>
          <Text color="gray">— {because}</Text>
        </Box>
        {entry.reason ? (
          <Box marginLeft={2}>
            <Text color="gray">{entry.reason}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (entry.kind === "scope-hint") {
    // Advisory only — a dim single line, deliberately quieter than a warning
    // box. Nothing has gone wrong and nothing is waiting on the user.
    return (
      <Box marginBottom={1} flexDirection="row" gap={1}>
        <Text color="gray">ℹ</Text>
        <Text color="gray" dimColor>{entry.text}</Text>
      </Box>
    );
  }

  if (entry.kind === "mode-switch") {
    // Which route this turn ran, and why.
    //
    // Driven off MODE_BADGE rather than a plan-vs-build ternary: the ternary
    // rendered every non-plan mode with build's glyph and colour, so chat and
    // ask would both have announced themselves as build.
    const badge = MODE_BADGE[entry.mode];
    return (
      <Box marginBottom={1} flexDirection="row" gap={1}>
        <Text color={badge.color} bold>{badge.glyph}</Text>
        <Text color="#E6E6E6">{entry.reason}</Text>
      </Box>
    );
  }


  return null;
}
