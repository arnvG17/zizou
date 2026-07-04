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

import React, { useState, useRef, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import pkg from "../../package.json";
import type { ModelMessage } from "ai";
import { resolveModel, getActiveModelId } from "../sdk/resolve-model.js";
import {
  getDefaultProvider,
  setDefaultProvider,
  setProviderModel,
  ProviderChoice,
  getContextMode,
} from "../config/api-keys.js";
import type { ConfirmFn } from "../tools/index.js";
import { runTurn } from "../agent/run-turn.js";
import { buildSystemPrompt } from "../context/build-system-prompt.js";
import { buildRepoMap } from "../context/repo-map.js";
import { useTerminalSize, SidebarWordmark, SidebarMountains } from "./Figurine.js";
import { handleSlashCommand, SLASH_COMMANDS, WELCOME_MESSAGE, getSkills } from "../commands/index.js";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

// ─── Orchestrator imports ────────────────────────────────────────────────────
// These enable the full clarify → plan → execute → verify pipeline.
import type { Mode } from "../agent/mode.js";
import { runOrchestrator, type OrchestratorEvent } from "../agent/orchestrator.js";
import type { PlanStep, ClarifyingQuestion } from "../agent/types.js";

const PROVIDERS: ProviderChoice[] = ["groq", "google", "openrouter", "anthropic", "openai", "ollama"];

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
  openrouter: ["google/gemma-3-27b-it:free", "meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-chat"],
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
  { label: "Gemma 3 27B (OpenRouter - Free)", provider: "openrouter", modelId: "google/gemma-3-27b-it:free" },
  { label: "LLaMA 3.3 70B (OpenRouter - Free)", provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct:free" },
  { label: "LLaMA 3 (Ollama - Local)", provider: "ollama", modelId: "llama3" },
  { label: "Mistral (Ollama - Local)", provider: "ollama", modelId: "mistral" },
];

// --- Types for our scrolling log ---
//
// EXTENDED: New entry kinds for orchestrator events (plan display,
// verification results, escalation prompts, step progress, etc.).
// The original kinds (user, assistant, tool-call, error) are unchanged.
type LogEntry =
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
  // ── New orchestrator log entry kinds ──────────────────────────────────
  // Displayed by the LogLine component below to show orchestrator state.
  | { kind: "plan-display"; steps: PlanStep[] }         // Full plan for user review
  | { kind: "step-progress"; stepIndex: number; totalSteps: number; description: string }
  | { kind: "verification"; stepIndex: number; verified: boolean; mismatches: string[] }
  | { kind: "escalation"; reason: string }               // Escalation notification
  | { kind: "mode-switch"; mode: Mode; reason: string }  // Mode change notification
  | { kind: "clarification"; questions: ClarifyingQuestion[] }; // Clarifier questions

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
  provider: ProviderChoice = "groq"
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

  // Cost calculation based on provider rates
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

  const cost = parseFloat((inputTokens * inputRate + outputTokens * outputRate).toFixed(4));

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

export interface ChatProps {
  onChangeKeys?: () => void;
  /** The operating mode (build or plan) determined by CLI args. */
  mode?: Mode;
  /** If provided, auto-submit this prompt on startup. */
  initialPrompt?: string;
}

export function Chat({ onChangeKeys, mode: initialMode = "build", initialPrompt }: ChatProps) {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{
    description: string;
    resolve: (approved: boolean) => void;
  } | null>(null);

  const [isSelectingModel, setIsSelectingModel] = useState(false);
  const [modelSelectStep, setModelSelectStep] = useState<"choose-provider" | "choose-model" | "enter-custom-model">("choose-model");
  const [selectedProvider, setSelectedProvider] = useState<ProviderChoice>("groq");
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [customModelInput, setCustomModelInput] = useState("");

  const { cols } = useTerminalSize();
  const showSidebar = cols >= 90 && log.length > 0;

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

  // Conversation history persists across turns
  const history = useRef<ModelMessage[]>([]);
  const systemPromptRef = useRef<string>("");
  const [contextReady, setContextReady] = useState(false);
  const [systemPromptText, setSystemPromptText] = useState<string>("");
  const [repoMap, setRepoMap] = useState<string>("");

  // ─── Orchestrator state ──────────────────────────────────────────────
  //
  // Tracks the current operating mode, any pending orchestrator flow
  // state (clarification answers, approved plans), and the original
  // prompt for escalation re-entry.
  const [currentMode, setCurrentMode] = useState<Mode>(initialMode);
  const [pendingClarifications, setPendingClarifications] = useState<ClarifyingQuestion[]>([]);
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({});
  const [currentClarificationIndex, setCurrentClarificationIndex] = useState(0);
  const [pendingPlan, setPendingPlan] = useState<PlanStep[] | null>(null);
  const [originalPrompt, setOriginalPrompt] = useState<string>("");
  const [isInClarificationFlow, setIsInClarificationFlow] = useState(false);
  const [isAwaitingPlanApproval, setIsAwaitingPlanApproval] = useState(false);

  const [tokenStats, setTokenStats] = useState({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    pctUsed: 0,
    cost: 0,
    contextLimit: 128000,
  });

  useEffect(() => {
    buildSystemPrompt(process.cwd()).then((prompt) => {
      systemPromptRef.current = prompt;
      setSystemPromptText(prompt);
      setContextReady(true);
      const provider = getDefaultProvider() || "groq";
      setTokenStats(calculateTokenStats(history.current, prompt, undefined, provider));
    });
    try {
      const map = buildRepoMap(process.cwd());
      setRepoMap(map);
    } catch {}
  }, []);

  const confirmFn: ConfirmFn = (description) => {
    return new Promise((resolve) => {
      setPendingConfirm({ description, resolve });
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
    return [];
  }, [suggestionMode, filteredCommands, filteredFiles, filteredSkills, filteredProviders, filteredModelNames]);

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
    if (showSuggestions && activeSuggestions.length > 0) {
      const selected = activeSuggestions[selectedIndex].value;
      const cmdToRun = completedValue.trim();

      let shouldExecute = false;

      if (suggestionMode === "commands") {
        const executableCommands = [
          "/settings", "/keys", "/clear", "/reset", "/exit", "/quit", "/prompt", "/skills", "/help", "/model", "/plan", "/build"
        ];
        if (executableCommands.includes(selected)) {
          shouldExecute = true;
        }
      } else if (suggestionMode === "files" || suggestionMode === "skills") {
        shouldExecute = true;
      }

      if (shouldExecute) {
        setInput("");
        const isCommand = handleSlashCommand({
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
              setTokenStats(calculateTokenStats(history.current, prompt, undefined, provider));
            });
            try {
              const map = buildRepoMap(process.cwd());
              setRepoMap(map);
            } catch {}
          },
          onModeChange: (mode: "build" | "plan") => setCurrentMode(mode),
          getCurrentMode: () => currentMode,
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
    const isCommand = handleSlashCommand({
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
          setTokenStats(calculateTokenStats(history.current, prompt, undefined, provider));
        });
        try {
          const map = buildRepoMap(process.cwd());
          setRepoMap(map);
        } catch {}
      },
      onModeChange: (mode: "build" | "plan") => setCurrentMode(mode),
      getCurrentMode: () => currentMode,
      setLog,
      setTokenStats,
      calculateTokenStats,
    });
    if (isCommand) return;

    if (busy) return; // Only block normal messages, not commands

    // ── Clarification flow: user is answering clarifying questions ────
    // When the orchestrator has yielded clarification questions, we
    // intercept user input as answers instead of new prompts.
    if (isInClarificationFlow && pendingClarifications.length > 0) {
      const currentQ = pendingClarifications[currentClarificationIndex];
      const newAnswers = { ...clarificationAnswers, [currentQ.question]: userText };
      setClarificationAnswers(newAnswers);

      setLog((l) => [
        ...l,
        { kind: "user", text: userText },
      ]);

      // Move to next question or finish clarification
      if (currentClarificationIndex + 1 < pendingClarifications.length) {
        setCurrentClarificationIndex(currentClarificationIndex + 1);
        const nextQ = pendingClarifications[currentClarificationIndex + 1];
        setLog((l) => [
          ...l,
          { kind: "assistant", text: `${nextQ.required ? "(required) " : ""}${nextQ.question}` },
        ]);
      } else {
        // All questions answered — re-invoke orchestrator with answers
        setIsInClarificationFlow(false);
        setPendingClarifications([]);
        setCurrentClarificationIndex(0);

        // Re-run orchestrator in plan mode with collected answers
        runOrchestratorFlow(originalPrompt, newAnswers);
      }
      return;
    }

    // ── Plan approval flow: user is saying Y/n to a displayed plan ────
    if (isAwaitingPlanApproval && pendingPlan) {
      const answer = userText.trim().toLowerCase();
      setLog((l) => [...l, { kind: "user", text: userText }]);

      if (answer === "y" || answer === "yes") {
        setIsAwaitingPlanApproval(false);
        const approvedSteps = pendingPlan;
        setPendingPlan(null);

        // Re-invoke orchestrator with the approved plan
        runOrchestratorFlow(originalPrompt, clarificationAnswers, approvedSteps);
      } else {
        setIsAwaitingPlanApproval(false);
        setPendingPlan(null);
        setLog((l) => [
          ...l,
          { kind: "assistant", text: "Plan cancelled. You can modify your request and try again." },
        ]);
        setBusy(false);
      }
      return;
    }

    setLog((l) => [...l, { kind: "user", text: userText }]);
    history.current.push({ role: "user", content: userText });
    setBusy(true);
    setOriginalPrompt(userText);

    // Update token stats immediately for the user prompt
    const provider = getDefaultProvider() || "groq";
    setTokenStats(calculateTokenStats(history.current, systemPromptRef.current, undefined, provider));

    // ── Route through orchestrator ───────────────────────────────────────
    // Both build and plan mode now go through the orchestrator.
    // The orchestrator yields OrchestratorEvents that we render as log entries.
    runOrchestratorFlow(userText);
  }

  // ─── Orchestrator Flow Runner ────────────────────────────────────────
  //
  // Drives the orchestrator async generator and translates its events
  // into log entries and UI state changes. Separated from handleSubmit
  // so it can be re-invoked during clarification/plan-approval flows.
  async function runOrchestratorFlow(
    prompt: string,
    answers?: Record<string, string>,
    approvedSteps?: PlanStep[],
  ) {
    setBusy(true);
    const submitTime = Date.now();
    let currentAssistantText = "";
    let assistantEntryAdded = false;
    let firstPartReceived = false;
    let thoughtDuration = "";
    let hasActualUsage = false;

    try {
      const provider = getDefaultProvider() || "groq";
      const model = resolveModel(provider);
      const budget = getContextMode() as "light" | "default" | "max";

      // Build the project context for the orchestrator
      const projectContext = {
        projectRoot: process.cwd(),
        systemPrompt: systemPromptRef.current,
        budget,
      };

      // Build the mode context — use current mode state
      const modeContext = {
        mode: currentMode,
        reason: "user-flag" as const,
      };

      // ── Drive the orchestrator ──────────────────────────────────────────
      const orchestrator = runOrchestrator(
        prompt,
        modeContext,
        projectContext,
        model,
        confirmFn,
        answers,
        approvedSteps,
      );

      let result = await orchestrator.next();
      while (!result.done) {
        const event = result.value;

        // ── Handle orchestrator-level events ──────────────────────────────
        switch (event.kind) {
          case "mode-info":
            // Update the mode badge in the footer and show a mode notification
            setCurrentMode(event.mode);
            setLog((l) => [
              ...l,
              { kind: "mode-switch", mode: event.mode, reason: event.reason },
            ]);
            break;

          case "clarification-needed":
            // The clarifier generated questions — enter clarification flow.
            // Present questions one at a time and collect answers.
            setPendingClarifications(event.questions);
            setCurrentClarificationIndex(0);
            setIsInClarificationFlow(true);

            // Show the clarification UI
            setLog((l) => [
              ...l,
              { kind: "clarification", questions: event.questions },
              { kind: "assistant", text: `${event.questions[0].required ? "(required) " : ""}${event.questions[0].question}` },
            ]);

            // STOP processing — we'll re-invoke after answers are collected
            setBusy(false);
            return;

          case "plan-ready":
            // The planner generated a plan — display it for Y/n approval.
            setPendingPlan(event.steps);
            setIsAwaitingPlanApproval(true);

            setLog((l) => [
              ...l,
              { kind: "plan-display", steps: event.steps },
              { kind: "assistant", text: "Execute this plan? (y/n)" },
            ]);

            // STOP processing — we'll re-invoke after Y/n
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
                mismatches: event.verification.mismatches,
              },
            ]);
            break;

          case "escalation-prompt":
            // Build mode: the step exceeded expected scope.
            // Show escalation message and use pendingConfirm for Y/n.
            setLog((l) => [
              ...l,
              { kind: "escalation", reason: event.trigger.reason },
            ]);

            // Ask the user whether to switch to plan mode
            const shouldSwitch = await new Promise<boolean>((resolve) => {
              setPendingConfirm({
                description: `This touched more than expected (${event.trigger.reason}). Switch to plan mode?`,
                resolve,
              });
            });

            if (shouldSwitch) {
              // Switch to plan mode and re-enter from scratch
              setCurrentMode("plan");
              setClarificationAnswers({});
              setLog((l) => [
                ...l,
                { kind: "mode-switch", mode: "plan", reason: "Escalated from build mode" },
              ]);
              // Re-invoke orchestrator in plan mode with the original prompt
              runOrchestratorFlow(originalPrompt);
              return;
            } else {
              setLog((l) => [
                ...l,
                { kind: "assistant", text: "Continuing in build mode. Results may need manual review." },
              ]);
            }
            break;

          case "agent-event": {
            // Forward raw agent events — same rendering as before
            const agentEvent = event.event;

            if (!firstPartReceived && (agentEvent.kind === "text-delta" || agentEvent.kind === "tool-call")) {
              firstPartReceived = true;
              thoughtDuration = formatDuration(Date.now() - submitTime);
            }

            if (agentEvent.kind === "text-delta") {
              currentAssistantText += agentEvent.text;
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
                setTokenStats(
                  calculateTokenStats(
                    history.current,
                    systemPromptRef.current,
                    {
                      inputTokens: agentEvent.usage.inputTokens,
                      outputTokens: agentEvent.usage.outputTokens,
                    },
                    provider
                  )
                );
              }
            }
            break;
          }

          case "complete":
            // Orchestration finished successfully
            break;
        }

        result = await orchestrator.next();
      }

      // Update token stats at the end if actual usage wasn't received
      if (!hasActualUsage) {
        setTokenStats(calculateTokenStats(history.current, systemPromptRef.current, undefined, provider));
      }
    } catch (err: any) {
      setLog((l) => [...l, { kind: "error", text: err.message ?? String(err) }]);
    } finally {
      setBusy(false);
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

  return (
    <Box flexDirection="row" width="100%">
      {/* Left conversation pane */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingRight={showSidebar ? 1 : 0}>
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

              <Box borderStyle="round" borderColor="#3B5FE0" paddingX={1} paddingY={1} backgroundColor="#15171C">
                <Text color="#3B5FE0" bold>{"❯ "}</Text>
                <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
                {busy && <Text dimColor> (thinking…)</Text>}
              </Box>

              {/* Input Footer */}
              <Box flexDirection="row" justifyContent="space-between" paddingX={1} marginTop={0}>
                <Box flexDirection="row" gap={1}>
                  <Text backgroundColor={currentMode === "plan" ? "#D08A4E" : "#3B5FE0"} color="white" bold> {currentMode === "plan" ? "Plan" : "Build"} ({getContextMode()}) </Text>
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
            <Text color="#E6E6E6" bold>New session</Text>
            <Text color="gray">{sessionId}</Text>
            <Box flexDirection="row" gap={1} marginTop={0}>
              <Text color={currentMode === "plan" ? "#D08A4E" : "#3B5FE0"} bold>{currentMode === "plan" ? "◆ Plan" : "● Build"}</Text>
              <Text color="gray">mode</Text>
            </Box>
          </Box>

          {/* Section 2: Context statistics */}
          <Box flexDirection="column" marginBottom={1}>
            <Text color="#E6E6E6" bold marginBottom={0}>Context</Text>
            <Text color="gray">Max: {tokenStats.contextLimit.toLocaleString()} tokens</Text>
            <Text color="gray">In:  {tokenStats.inputTokens.toLocaleString()}</Text>
            <Text color="gray">Out: {tokenStats.outputTokens.toLocaleString()}</Text>
            <Text color="gray">{tokenStats.pctUsed}% used</Text>
            <Text color="gray">${tokenStats.cost.toFixed(4)} spent</Text>
          </Box>

          {/* Section 3: LSP status */}
          <Box flexDirection="column" marginBottom={1}>
            <Text color="#E6E6E6" bold>LSP</Text>
            <Text color="gray">LSPs are disabled</Text>
          </Box>

          {/* Section 4: Repo Map live view */}
          <Box flexDirection="column" marginBottom={1}>
            <Text color="#E6E6E6" bold>Repo Map</Text>
            {getContextMode() === "light" ? (
              <Text color="gray" dimColor>repo map is disabled in light mode</Text>
            ) : !contextReady || !repoMap ? (
              <Text color="gray" dimColor>loading…</Text>
            ) : (
              <>
                <Text color="gray" dimColor>
                  {repoMap.split("\n").length} lines
                </Text>
                {repoMap.split("\n").slice(0, 10).map((line, i) => (
                  <Text key={i} color="#4A5568" dimColor wrap="truncate">
                    {line || " "}
                  </Text>
                ))}
                {repoMap.split("\n").length > 10 && (
                  <Text color="#4A5568" dimColor>
                    … ({repoMap.split("\n").length - 10} more lines)
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

function LogLine({ entry }: { entry: LogEntry }) {
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
        {entry.steps.map((step) => (
          <Box key={step.index} flexDirection="column" marginTop={step.index > 0 ? 1 : 0}>
            <Box flexDirection="row" gap={1}>
              <Text color="#3B5FE0" bold>Step {step.index + 1}.</Text>
              <Text color="#E6E6E6">{step.description}</Text>
            </Box>
            {step.targetFiles.length > 0 && (
              <Box paddingLeft={2} flexDirection="column">
                {step.targetFiles.map((file, fi) => (
                  <Text key={fi} color="gray" dimColor>↳ {file}</Text>
                ))}
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
    return (
      <Box marginBottom={1} flexDirection="row" gap={1}>
        <Text color="#3B5FE0" bold>▶</Text>
        <Text color="#E6E6E6" bold>Step {entry.stepIndex + 1}/{entry.totalSteps}:</Text>
        <Text color="gray">{entry.description}</Text>
      </Box>
    );
  }

  if (entry.kind === "verification") {
    // Shows verification result — green check for pass, red X for fail
    return (
      <Box marginBottom={1} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={entry.verified ? "#5FB87A" : "red"}>{entry.verified ? "✓" : "✗"}</Text>
          <Text color={entry.verified ? "#5FB87A" : "red"} bold>
            Step {entry.stepIndex + 1} verification {entry.verified ? "passed" : "failed"}
          </Text>
        </Box>
        {entry.mismatches.length > 0 && (
          <Box paddingLeft={2} flexDirection="column">
            {entry.mismatches.map((m, i) => (
              <Text key={i} color="red" dimColor>↳ {m}</Text>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  if (entry.kind === "escalation") {
    // Shows escalation notification with warning styling
    return (
      <Box marginBottom={1} borderStyle="round" borderColor="yellow" paddingX={1} backgroundColor="#15171C">
        <Text color="yellow" bold>⚠ Escalation: </Text>
        <Text color="yellow">{entry.reason === "verification-failed" ? "Verification failed — execution may not have completed correctly." : entry.reason === "touched-too-many-files" ? "This touched more files than expected for a simple fix." : "Step implies additional dependencies."}</Text>
      </Box>
    );
  }

  if (entry.kind === "mode-switch") {
    // Shows mode change notification
    return (
      <Box marginBottom={1} flexDirection="row" gap={1}>
        <Text color={entry.mode === "plan" ? "#D08A4E" : "#3B5FE0"} bold>
          {entry.mode === "plan" ? "◆" : "●"}
        </Text>
        <Text color="#E6E6E6">{entry.reason}</Text>
      </Box>
    );
  }

  if (entry.kind === "clarification") {
    // Shows the list of clarifying questions from the clarifier
    return (
      <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="#3B5FE0" paddingX={1} paddingY={1} backgroundColor="#15171C">
        <Text color="#3B5FE0" bold>❓ Clarifying Questions</Text>
        <Text color="gray" dimColor>Please answer the following before planning begins:</Text>
        {entry.questions.map((q, i) => (
          <Box key={i} flexDirection="row" gap={1} marginTop={1}>
            <Text color="gray">{i + 1}.</Text>
            <Text color={q.required ? "#E6E6E6" : "gray"}>{q.required ? "(required) " : ""}{q.question}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  return null;
}
