// src/ui/Chat.tsx
//
// This is the main TUI screen after the splash screen.
// It implements the responsive two-column layout from zizou_cli_full_flow_v3.html:
// - Left column: Conversation log and pill-style input box with badges.
// - Right column: Sidebar with session info, estimated tokens/cost, LSP status,
//   and the mini-wordmark. Automatically hidden on narrower terminals.

import React, { useState, useRef, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import pkg from "../../package.json";
import type { ModelMessage } from "ai";
import { resolveModel, getActiveModelId } from "../sdk/resolve-model.js";
import { getDefaultProvider, ProviderChoice, getContextMode } from "../config/api-keys.js";
import type { ConfirmFn } from "../tools/index.js";
import { runTurn } from "../agent/run-turn.js";
import { buildSystemPrompt } from "../context/build-system-prompt.js";
import { useTerminalSize, SidebarWordmark } from "./Figurine.js";
import { handleSlashCommand } from "../commands/index.js";

// --- Types for our scrolling log ---
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
  | { kind: "error"; text: string };

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

export interface ChatProps {
  onChangeKeys?: () => void;
}

export function Chat({ onChangeKeys }: ChatProps) {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{
    description: string;
    resolve: (approved: boolean) => void;
  } | null>(null);

  const { cols } = useTerminalSize();
  const showSidebar = cols >= 90;

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
  }, []);

  const confirmFn: ConfirmFn = (description) => {
    return new Promise((resolve) => {
      setPendingConfirm({ description, resolve });
    });
  };

  useInput((inputChar) => {
    if (pendingConfirm) {
      if (inputChar.toLowerCase() === "y") {
        pendingConfirm.resolve(true);
        setPendingConfirm(null);
      } else if (inputChar.toLowerCase() === "n") {
        pendingConfirm.resolve(false);
        setPendingConfirm(null);
      }
    }
  });

  async function handleSubmit(userText: string) {
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
      onContextChange: () => {
        setContextReady(false);
        buildSystemPrompt(process.cwd()).then((prompt) => {
          systemPromptRef.current = prompt;
          setSystemPromptText(prompt);
          setContextReady(true);
          const provider = getDefaultProvider() || "groq";
          setTokenStats(calculateTokenStats(history.current, prompt, undefined, provider));
        });
      },
      setLog,
      setTokenStats,
      calculateTokenStats,
    });
    if (isCommand) return;

    if (busy) return; // Only block normal messages, not commands

    setLog((l) => [...l, { kind: "user", text: userText }]);
    history.current.push({ role: "user", content: userText });
    setBusy(true);

    // Update token stats immediately for the user prompt
    const provider = getDefaultProvider() || "groq";
    setTokenStats(calculateTokenStats(history.current, systemPromptRef.current, undefined, provider));

    const submitTime = Date.now();
    let currentAssistantText = "";
    let assistantEntryAdded = false;
    let firstPartReceived = false;
    let thoughtDuration = "";

    let hasActualUsage = false;

    try {
      const provider = getDefaultProvider() || "groq";
      const model = resolveModel(provider);

      const turn = runTurn({
        history: history.current,
        model,
        onConfirm: confirmFn,
        systemPrompt: systemPromptRef.current,
      });

      let result = await turn.next();
      while (!result.done) {
        const event = result.value;

        if (!firstPartReceived && (event.kind === "text-delta" || event.kind === "tool-call")) {
          firstPartReceived = true;
          thoughtDuration = formatDuration(Date.now() - submitTime);
        }

        if (event.kind === "text-delta") {
          currentAssistantText += event.text;
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
        } else if (event.kind === "tool-call") {
          assistantEntryAdded = false;
          currentAssistantText = "";
          setLog((l) => [
            ...l,
            {
              kind: "tool-call",
              toolCallId: event.toolCallId,
              name: event.toolName,
              input: event.input,
              startTime: Date.now(),
              status: "running",
            },
          ]);
        } else if (event.kind === "tool-result") {
          setLog((l) =>
            l.map((entry) => {
              if (entry.kind === "tool-call" && entry.toolCallId === event.toolCallId) {
                return {
                  ...entry,
                  status: "success",
                  output: event.output,
                  duration: formatDuration(Date.now() - entry.startTime),
                };
              }
              return entry;
            })
          );
        } else if (event.kind === "tool-error") {
          const errMsg = String(event.error);
          setLog((l) =>
            l.map((entry) => {
              if (entry.kind === "tool-call" && entry.toolCallId === event.toolCallId) {
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
        } else if (event.kind === "finish") {
          if (event.usage) {
            hasActualUsage = true;
            setTokenStats(
              calculateTokenStats(
                history.current,
                systemPromptRef.current,
                {
                  inputTokens: event.usage.inputTokens,
                  outputTokens: event.usage.outputTokens,
                },
                provider
              )
            );
          }
        }

        result = await turn.next();
      }

      history.current = result.value;
      // Update token stats at the end of the turn if actual usage wasn't received
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
          ) : (
            <Box flexDirection="column">
              <Box borderStyle="round" borderColor="#3B5FE0" paddingX={1} backgroundColor="#15171C">
                <Text color="#3B5FE0" bold>{"❯ "}</Text>
                <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
                {busy && <Text dimColor> (thinking…)</Text>}
              </Box>

              {/* Input Footer */}
              <Box flexDirection="row" justifyContent="space-between" paddingX={1} marginTop={0}>
                <Box flexDirection="row" gap={1}>
                  <Text backgroundColor="#3B5FE0" color="white" bold> Build ({getContextMode()}) </Text>
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

          {/* Section 4: System Prompt live view */}
          <Box flexDirection="column" marginBottom={1}>
            <Text color="#E6E6E6" bold>System Prompt</Text>
            {!contextReady ? (
              <Text color="gray" dimColor>loading…</Text>
            ) : (
              <>
                <Text color="gray" dimColor>
                  {systemPromptText.length.toLocaleString()} chars
                  {" · "}
                  {systemPromptText.split("\n").length} lines
                </Text>
                {systemPromptText.split("\n").slice(0, 8).map((line, i) => (
                  <Text key={i} color="#4A5568" dimColor wrap="truncate">
                    {line || " "}
                  </Text>
                ))}
                {systemPromptText.split("\n").length > 8 && (
                  <Text color="#4A5568" dimColor>
                    … ({systemPromptText.split("\n").length - 8} more lines)
                    {" · type /prompt for full text"}
                  </Text>
                )}
              </>
            )}
          </Box>

          {/* Spacer */}
          <Box flexGrow={1} />

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
  return null;
}
