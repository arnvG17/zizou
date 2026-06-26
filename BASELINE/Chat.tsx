// src/ui/Chat.tsx
//
// This is the heart of the TUI. It does three things:
//   1. Keeps a scrolling log of everything that happened (user messages,
//      assistant text, tool calls, tool results) — this is `history`.
//   2. Runs the SAME agent loop from Phase 1-3, but using `streamText`
//      instead of `generateText` so output appears live, token by token,
//      instead of all at once after waiting.
//   3. Intercepts run_bash's confirmation request and renders an actual
//      y/n prompt in the UI instead of using readline (readline doesn't
//      play nicely with Ink, which takes over the whole terminal).

import React, { useState, useRef } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { resolveModel } from "../provider.js";
import { createAllTools, type ConfirmFn } from "../tools.js";

// --- Types for our scrolling log ---
type LogEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool-call"; name: string; input: unknown }
  | { kind: "tool-result"; name: string; output: unknown }
  | { kind: "error"; text: string };

export function Chat() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{
    description: string;
    resolve: (approved: boolean) => void;
  } | null>(null);

  // Conversation history persists across turns, same as any chat app —
  // this IS the "memory" of the session, just an array of messages.
  const history = useRef<ModelMessage[]>([]);

  // This function is passed into the run_bash tool. When the tool wants
  // to ask "is it ok to run this?", it calls this, which pauses (via the
  // Promise) until the human presses y/n in the UI below.
  const confirmFn: ConfirmFn = (description) => {
    return new Promise((resolve) => {
      setPendingConfirm({ description, resolve });
    });
  };

  async function handleSubmit(userText: string) {
    if (!userText.trim() || busy) return;
    setInput("");
    setLog((l) => [...l, { kind: "user", text: userText }]);
    history.current.push({ role: "user", content: userText });
    setBusy(true);

    try {
      const result = streamText({
        model: resolveModel(),
        tools: createAllTools(confirmFn),
        stopWhen: stepCountIs(15),
        messages: history.current,
      });

      let currentAssistantText = "";
      let assistantEntryAdded = false;

      // fullStream gives us every event as it happens: text chunks,
      // tool calls, tool results — interleaved in real time order.
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          currentAssistantText += part.text;
          setLog((l) => {
            if (!assistantEntryAdded) {
              assistantEntryAdded = true;
              return [...l, { kind: "assistant", text: currentAssistantText }];
            }
            // Replace the last entry (the in-progress assistant message)
            // with the updated, longer text — this is what makes it look
            // like it's "typing" live instead of appearing all at once.
            const updated = [...l];
            updated[updated.length - 1] = { kind: "assistant", text: currentAssistantText };
            return updated;
          });
        } else if (part.type === "tool-call") {
          assistantEntryAdded = false; // next text-delta (if any) starts a fresh bubble
          setLog((l) => [...l, { kind: "tool-call", name: part.toolName, input: part.input }]);
        } else if (part.type === "tool-result") {
          setLog((l) => [...l, { kind: "tool-result", name: part.toolName, output: part.output }]);
        }
      }

      // Save the final assistant turn (with any tool calls it made) back
      // into history so the NEXT message has full context, same as
      // generateText's automatic behavior in Phase 1-3 — streamText
      // requires us to do this ourselves.
      const finalMessages = await result.response;
      history.current.push(...finalMessages.messages);
    } catch (err: any) {
      setLog((l) => [...l, { kind: "error", text: err.message ?? String(err) }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">
          Zizou — AI coding agent
        </Text>
      </Box>

      {log.map((entry, i) => <LogLine key={i} entry={entry} />)}

      {pendingConfirm ? (
        <ConfirmPrompt
          description={pendingConfirm.description}
          onAnswer={(approved) => {
            pendingConfirm.resolve(approved);
            setPendingConfirm(null);
          }}
        />
      ) : (
        <Box>
          <Text color="green">{"> "}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
          {busy && <Text dimColor> (thinking…)</Text>}
        </Box>
      )}
    </Box>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  if (entry.kind === "user") {
    return (
      <Box marginBottom={1}>
        <Text color="green" bold>
          You:{" "}
        </Text>
        <Text>{entry.text}</Text>
      </Box>
    );
  }
  if (entry.kind === "assistant") {
    return (
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          Zizou:{" "}
        </Text>
        <Text>{entry.text}</Text>
      </Box>
    );
  }
  if (entry.kind === "tool-call") {
    return (
      <Box marginBottom={0}>
        <Text dimColor>
          🔧 {entry.name}({JSON.stringify(entry.input).slice(0, 80)})
        </Text>
      </Box>
    );
  }
  if (entry.kind === "tool-result") {
    const outputStr = JSON.stringify(entry.output).slice(0, 100);
    return (
      <Box marginBottom={1}>
        <Text dimColor>   → {outputStr}</Text>
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

function ConfirmPrompt({
  description,
  onAnswer,
}: {
  description: string;
  onAnswer: (approved: boolean) => void;
}) {
  useInput((inputChar) => {
    if (inputChar.toLowerCase() === "y") onAnswer(true);
    if (inputChar.toLowerCase() === "n") onAnswer(false);
  });
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">⚠ {description} — Allow? (y/n)</Text>
    </Box>
  );
}
