import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { generateText } from "ai";
import { ProviderChoice, setApiKey, setDefaultProvider, clearApiKeys } from "../config/api-keys.js";
import { resolveModel } from "../provider/resolve-model.js";

interface ApiKeySetupProps {
  onComplete: () => void;
}

const PROVIDERS: ProviderChoice[] = ["groq", "google", "openrouter", "anthropic", "openai"];

const PROVIDER_LABELS: Record<ProviderChoice, string> = {
  groq: "Groq (LLaMA 3.3)",
  google: "Google Gemini (Gemini 2.0 Flash)",
  openrouter: "OpenRouter (Any Model)",
  anthropic: "Anthropic (Claude 3.5 Sonnet)",
  openai: "OpenAI (GPT-4o)",
};

const SHORT_LABELS: Record<ProviderChoice, string> = {
  groq: "Groq",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

export function ApiKeySetup({ onComplete }: ApiKeySetupProps) {
  const [step, setStep] = useState<"choose-provider" | "enter-key">("choose-provider");
  const [provider, setProvider] = useState<ProviderChoice>("groq"); // groq as default
  const [keyInput, setKeyInput] = useState("");
  const [isValidating, setIsValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useInput((input, key) => {
    if (isValidating) return;

    if (step === "choose-provider") {
      if (key.downArrow) {
        setProvider((prev) => {
          const idx = PROVIDERS.indexOf(prev);
          return PROVIDERS[(idx + 1) % PROVIDERS.length];
        });
      }
      if (key.upArrow) {
        setProvider((prev) => {
          const idx = PROVIDERS.indexOf(prev);
          return PROVIDERS[(idx - 1 + PROVIDERS.length) % PROVIDERS.length];
        });
      }
      if (key.return) {
        setStep("enter-key");
      }
    }
  });

  const handleKeySubmit = async (value: string) => {
    if (value.trim().length === 0 || isValidating) return;

    setIsValidating(true);
    setValidationError(null);

    try {
      // Temporarily save the key to config so resolveModel can fetch it
      setApiKey(provider, value.trim());

      const model = resolveModel(provider);
      
      // Attempt a minimal call to verify API key and model availability
      await generateText({
        model,
        prompt: "Verify API key and connection",
        maxTokens: 1,
      });

      // Verification succeeded!
      setDefaultProvider(provider);
      onComplete();
    } catch (err: any) {
      // Verification failed! Clean up the saved config
      clearApiKeys();
      
      let errMsg = err.message ?? String(err);
      if (errMsg.includes("No endpoints found")) {
        errMsg = "Invalid OpenRouter API key or insufficient balance.";
      } else if (errMsg.includes("401") || errMsg.toLowerCase().includes("unauthorized") || errMsg.toLowerCase().includes("invalid api key")) {
        errMsg = "Unauthorized. Please check that your API key is correct.";
      }
      setValidationError(errMsg);
    } finally {
      setIsValidating(false);
    }
  };

  if (step === "choose-provider") {
    return (
      <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
        <Text>Please choose your preferred AI provider to get started.</Text>
        <Text color="gray">(Use Up/Down arrows to select, Enter to confirm)</Text>
        <Box flexDirection="column" marginTop={1}>
          {PROVIDERS.map((p) => (
            <Text key={p} color={provider === p ? "green" : undefined}>
              {provider === p ? "❯ " : "  "}{PROVIDER_LABELS[p]}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
      <Text bold>Enter your {SHORT_LABELS[provider]} API Key</Text>
      <Text color="gray">This will be stored in plain text in your OS config directory.</Text>
      
      {validationError && (
        <Box marginTop={1} paddingX={1} borderStyle="single" borderColor="red">
          <Text color="red" bold>Validation failed:</Text>
          <Text color="red">{validationError}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text>Key: </Text>
        {isValidating ? (
          <Text color="yellow">Validating API key... please wait.</Text>
        ) : (
          <TextInput
            value={keyInput}
            onChange={setKeyInput}
            onSubmit={handleKeySubmit}
            mask="*"
          />
        )}
      </Box>
    </Box>
  );
}
