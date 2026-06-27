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
import type { ModelMessage } from "ai";
import { resolveModel } from "../provider/resolve-model.js";
import { getDefaultProvider, ProviderChoice } from "../config/api-keys.js";
import type { ConfirmFn } from "../tools/index.js";
import { runTurn } from "../agent/run-turn.js";
import { buildSystemPrompt } from "../context/build-system-prompt.js";
import { useTerminalSize, SidebarWordmark } from "./Figurine.js";

// --- Types for our scrolling log ---
type LogEntry =
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

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function calculateTokenStats(history: ModelMessage[], systemPrompt: string) {
  const systemPromptLength = systemPrompt.length;
  let inputChars = systemPromptLength;
  let outputChars = 0;

  for (const msg of history) {
    if (msg.role === "user") {
      inputChars += (msg.content || "").length;
    } else {
      outputChars += (msg.content || "").length;
    }
  }

  const inputTokens = Math.floor(inputChars / 4);
  const outputTokens = Math.floor(outputChars / 4);
  const totalTokens = inputTokens + outputTokens;
  const pctUsed = Math.min(100, parseFloat(((totalTokens / 200000) * 100).toFixed(1)));
  const cost = parseFloat((inputTokens * 0.000003 + outputTokens * 0.000015).toFixed(4));

  return {
    totalTokens,
    pctUsed,
    cost,
  };
}

export function Chat() {
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

  const [tokenStats, setTokenStats] = useState({
    totalTokens: 0,
    pctUsed: 0,
    cost: 0,
  });

  useEffect(() => {
    buildSystemPrompt(process.cwd()).then((prompt) => {
      systemPromptRef.current = prompt;
      setContextReady(true);
      setTokenStats(calculateTokenStats(history.current, prompt));
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
    if (!userText.trim() || busy) return;
    setInput("");
    setLog((l) => [...l, { kind: "user", text: userText }]);
    history.current.push({ role: "user", content: userText });
    setBusy(true);

    // Update token stats immediately for the user prompt
    setTokenStats(calculateTokenStats(history.current, systemPromptRef.current));

    const submitTime = Date.now();
    let currentAssistantText = "";
    let assistantEntryAdded = false;
    let firstPartReceived = false;
    let thoughtDuration = "";

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
                  duration: formatDuration(Date.now() - entry.startTime),
                };
              }
              return entry;
            })
          );
        } else if (event.kind === "tool-error") {
          setLog((l) =>
            l.map((entry) => {
              if (entry.kind === "tool-call" && entry.toolCallId === event.toolCallId) {
                return {
                  ...entry,
                  status: "error",
                  duration: formatDuration(Date.now() - entry.startTime),
                };
              }
              return entry;
            })
          );
          setLog((l) => [
            ...l,
            { kind: "error", text: `Tool ${event.toolName} threw: ${String(event.error)}` },
          ]);
        }

        result = await turn.next();
      }

      history.current = result.value;
      // Update token stats at the end of the turn
      setTokenStats(calculateTokenStats(history.current, systemPromptRef.current));
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
                  <Text backgroundColor="#3B5FE0" color="white" bold> Build </Text>
                  <Text color="gray">{
                    ({
                      groq: "llama-3.3-70b",
                      google: "gemini-2.0-flash",
                      openrouter: "claude-3.5-sonnet (or)",
                      anthropic: "claude-3.5-sonnet",
                      openai: "gpt-4o"
                    } as Record<ProviderChoice, string>)[getDefaultProvider() || "groq"]
                  }</Text>
                </Box>
                <Box flexDirection="row" gap={2}>
                  <Text color="gray">{formattedTokensStr} ({tokenStats.pctUsed}%)</Text>
                  <Text color="gray">ctrl+p commands</Text>
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
            <Text color="gray">{tokenStats.totalTokens.toLocaleString()} tokens</Text>
            <Text color="gray">{tokenStats.pctUsed}% used</Text>
            <Text color="gray">${tokenStats.cost.toFixed(4)} spent</Text>
          </Box>

          {/* Section 3: LSP status */}
          <Box flexDirection="column" marginBottom={1}>
            <Text color="#E6E6E6" bold>LSP</Text>
            <Text color="gray">LSPs are disabled</Text>
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
              <Text color="gray">1.0.0</Text>
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

    return (
      <Box marginBottom={1} flexDirection="row" gap={1} alignItems="center">
        <Text color={isError ? "red" : "#3B5FE0"}>■</Text>
        <Text bold color={isError ? "red" : "#E6E6E6"}>{entry.name}</Text>
        <Text color="gray">·</Text>
        <Text color="gray">Zizou</Text>
        <Text color="gray">·</Text>
        <Text color="gray">{isRunning ? "running..." : entry.duration}</Text>
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
