// src/ui/ApiKeySetup.tsx
//
// This is the screen shown the FIRST time someone runs `zizou` with no
// API key saved. It's deliberately simple: ask which provider, ask for
// the key (masked, like a password field), save it via config.ts, then
// hand off to the main app.

import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { setApiKey, type ProviderName } from "../config.js";

type Step = "choose-provider" | "enter-key" | "done";

export function ApiKeySetup({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>("choose-provider");
  const [provider, setProvider] = useState<ProviderName>("anthropic");
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState("");

  if (step === "choose-provider") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
        <Text bold color="cyan">
          Welcome to Zizou — first-time setup
        </Text>
        <Text>Which provider's API key do you want to add?</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={provider === "anthropic" ? "green" : undefined}>
            {provider === "anthropic" ? "→ " : "  "}1. Anthropic (Claude)
          </Text>
          <Text color={provider === "openai" ? "green" : undefined}>
            {provider === "openai" ? "→ " : "  "}2. OpenAI (GPT)
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press 1 or 2, then Enter</Text>
        </Box>
        <KeyChooser
          onChoose={(p) => {
            setProvider(p);
            setStep("enter-key");
          }}
        />
      </Box>
    );
  }

  if (step === "enter-key") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
        <Text bold color="cyan">
          Enter your {provider === "anthropic" ? "Anthropic" : "OpenAI"} API key
        </Text>
        <Text dimColor>
          (It will be saved locally and masked as you type. Stored in plaintext config —
          don't share this machine's config file.)
        </Text>
        <Box marginTop={1}>
          <Text>Key: </Text>
          <TextInput
            value={keyInput}
            onChange={setKeyInput}
            mask="*"
            onSubmit={(value) => {
              if (!value.trim()) {
                setError("Key cannot be empty.");
                return;
              }
              setApiKey(provider, value.trim());
              setStep("done");
              setTimeout(onComplete, 600); // brief pause so "Saved!" is visible
            }}
          />
        </Box>
        {error && <Text color="red">{error}</Text>}
      </Box>
    );
  }

  return (
    <Box borderStyle="round" borderColor="green" padding={1}>
      <Text color="green">✓ Saved! Starting Zizou…</Text>
    </Box>
  );
}

// Tiny helper component: listens for "1" or "2" keypresses to pick a provider.
// Separated out because Ink's useInput hook needs to be inside the render tree.
import { useInput } from "ink";
function KeyChooser({ onChoose }: { onChoose: (p: ProviderName) => void }) {
  useInput((input) => {
    if (input === "1") onChoose("anthropic");
    if (input === "2") onChoose("openai");
  });
  return null;
}
