import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { generateText } from "ai";
import {
  ProviderChoice,
  setApiKey,
  setDefaultProvider,
  removeApiKey,
  setProviderModel,
  setOllamaBaseUrl,
  getOllamaBaseUrl,
} from "../config/api-keys.js";
import { resolveModel, DEFAULT_MODELS } from "../sdk/resolve-model.js";

interface ApiKeySetupProps {
  onComplete: () => void;
}

const PROVIDERS: ProviderChoice[] = ["groq", "google", "openrouter", "anthropic", "openai", "ollama"];

const PROVIDER_LABELS: Record<ProviderChoice, string> = {
  groq: "Groq (LLaMA 3.3 — free, fast)",
  google: "Google Gemini (Gemini 2.0 Flash)",
  openrouter: "OpenRouter (free cloud models)",
  anthropic: "Anthropic (Claude 3.5 Sonnet)",
  openai: "OpenAI (GPT-4o)",
  ollama: "Ollama (local models — no API key needed)",
};

const SHORT_LABELS: Record<ProviderChoice, string> = {
  groq: "Groq",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  ollama: "Ollama (local)",
};

type Step = "choose-provider" | "enter-ollama-url" | "enter-ollama-model" | "enter-key" | "enter-model-override";

export function ApiKeySetup({ onComplete }: ApiKeySetupProps) {
  const [step, setStep] = useState<Step>("choose-provider");
  const [provider, setProvider] = useState<ProviderChoice>("groq");
  const [keyInput, setKeyInput] = useState("");
  const [urlInput, setUrlInput] = useState("http://localhost:11434");
  const [modelInput, setModelInput] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [selectedOllamaModel, setSelectedOllamaModel] = useState<string>("");
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
        if (provider === "ollama") {
          setStep("enter-ollama-url");
        } else {
          setStep("enter-key");
        }
      }
    } else if (step === "enter-ollama-model") {
      if (key.downArrow && ollamaModels.length > 0) {
        setSelectedOllamaModel((prev) => {
          const idx = ollamaModels.indexOf(prev);
          return ollamaModels[(idx + 1) % ollamaModels.length];
        });
      }
      if (key.upArrow && ollamaModels.length > 0) {
        setSelectedOllamaModel((prev) => {
          const idx = ollamaModels.indexOf(prev);
          return ollamaModels[(idx - 1 + ollamaModels.length) % ollamaModels.length];
        });
      }
      if (key.return && ollamaModels.length > 0) {
        handleOllamaModelSubmit(selectedOllamaModel);
      }
    }
  });

  // ── Ollama URL submit ────────────────────────────────────────────────────
  const handleUrlSubmit = async (value: string) => {
    const url = value.trim() || "http://localhost:11434";
    setUrlInput(url);
    setOllamaBaseUrl(url);
    setIsValidating(true);
    setValidationError(null);

    try {
      // Fetch available models from Ollama
      const res = await fetch(`${url}/api/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as any;
      const models = data?.models?.map((m: any) => m.name) || [];
      
      setOllamaModels(models.length > 0 ? models : [DEFAULT_MODELS["ollama"]]);
      setSelectedOllamaModel(models.length > 0 ? models[0] : DEFAULT_MODELS["ollama"]);
      setStep("enter-ollama-model");
    } catch (err: any) {
      let msg = err.message ?? String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch")) {
        msg = `Cannot reach Ollama at ${url}. Is 'ollama serve' running?`;
      }
      setValidationError(msg);
    } finally {
      setIsValidating(false);
    }
  };

  // ── Ollama model submit (then validate) ──────────────────────────────────
  const handleOllamaModelSubmit = async (value: string) => {
    const model = value.trim() || DEFAULT_MODELS["ollama"];
    setModelInput(model);
    setProviderModel("ollama", model);
    setIsValidating(true);
    setValidationError(null);

    try {
      setDefaultProvider("ollama");
      const lm = resolveModel("ollama");
      await generateText({ model: lm, prompt: "hi", maxTokens: 1 });
      onComplete();
    } catch (err: any) {
      let msg = err.message ?? String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch")) {
        msg = `Cannot reach Ollama at ${urlInput}. Is 'ollama serve' running?`;
      }
      setValidationError(msg);
    } finally {
      setIsValidating(false);
    }
  };

  // ── Regular provider key submit ──────────────────────────────────────────
  const handleKeySubmit = async (value: string) => {
    if (value.trim().length === 0 || isValidating) return;

    setIsValidating(true);
    setValidationError(null);

    try {
      setApiKey(provider, value.trim());

      // Validate the key by sending a tiny 1-token ping to the provider.
      // This catches bad keys immediately instead of failing on first real use.
      const model = resolveModel(provider);
      await generateText({ model, prompt: "hi", maxTokens: 1, maxRetries: 0 });

      setDefaultProvider(provider);
      onComplete();
    } catch (err: any) {
      // Only remove the key we just set — don't nuke other providers' keys
      removeApiKey(provider);

      let errMsg = err.message ?? String(err);

      // ── Provider-specific error messages ──────────────────────────────
      if (
        errMsg.includes("401") ||
        errMsg.toLowerCase().includes("unauthorized") ||
        errMsg.toLowerCase().includes("invalid api key") ||
        errMsg.toLowerCase().includes("invalid x-api-key") ||
        errMsg.toLowerCase().includes("incorrect api key")
      ) {
        errMsg = `Invalid ${SHORT_LABELS[provider]} API key. Please check and try again.`;
      } else if (errMsg.includes("No endpoints found") || errMsg.includes("No available model")) {
        errMsg = "Invalid API key or no models available. Check your key and account balance.";
      } else if (errMsg.includes("403") || errMsg.toLowerCase().includes("forbidden")) {
        errMsg = `Access denied. Your ${SHORT_LABELS[provider]} API key may lack permissions.`;
      } else if (errMsg.includes("429") || errMsg.toLowerCase().includes("rate limit")) {
        // Key is valid but rate-limited — accept it anyway
        setApiKey(provider, value.trim());
        setDefaultProvider(provider);
        onComplete();
        return;
      } else if (errMsg.includes("ECONNREFUSED") || errMsg.includes("fetch failed")) {
        errMsg = `Cannot reach ${SHORT_LABELS[provider]}. Check your network connection.`;
      } else if (errMsg.includes("AI_APICallError")) {
        errMsg = "API call failed. This might be due to model availability. Try again or use a different provider.";
      }
      setValidationError(errMsg);
    } finally {
      setIsValidating(false);
    }
  };

  // ── Provider chooser ─────────────────────────────────────────────────────
  if (step === "choose-provider") {
    return (
      <Box flexDirection="column" padding={1} borderStyle="round" borderColor="#3B5FE0" backgroundColor="#15171C">
        <Text bold color="white">Choose your AI provider to get started.</Text>
        <Text color="gray">(↑/↓ to select, Enter to confirm)</Text>
        <Box flexDirection="column" marginTop={1}>
          {PROVIDERS.map((p) => (
            <Text key={p} color={provider === p ? "#3B5FE0" : undefined} bold={provider === p}>
              {provider === p ? "❯ " : "  "}
              {PROVIDER_LABELS[p]}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Ollama lets you run local models (LLaMA, Mistral, Gemma…) for free.
          </Text>
        </Box>
      </Box>
    );
  }

  // ── Ollama URL step ──────────────────────────────────────────────────────
  if (step === "enter-ollama-url") {
    return (
      <Box flexDirection="column" padding={1} borderStyle="round" borderColor="#3B5FE0" backgroundColor="#15171C">
        <Text bold color="white">Ollama — Base URL</Text>
        <Text color="gray">Leave blank to use the default (http://localhost:11434).</Text>
        <Text color="gray">Change this if Ollama is running on a different host/port.</Text>
        {validationError && (
          <Box marginTop={1} paddingX={1} borderStyle="single" borderColor="red" backgroundColor="#15171C">
            <Text color="red" bold>Error: </Text>
            <Text color="red">{validationError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color="white">URL: </Text>
          <TextInput
            value={urlInput}
            onChange={setUrlInput}
            onSubmit={handleUrlSubmit}
            placeholder="http://localhost:11434"
          />
        </Box>
      </Box>
    );
  }

  // ── Ollama model step ────────────────────────────────────────────────────
  if (step === "enter-ollama-model") {
    return (
      <Box flexDirection="column" padding={1} borderStyle="round" borderColor="#3B5FE0" backgroundColor="#15171C">
        <Text bold color="white">Ollama — Choose downloaded model</Text>
        <Text color="gray">
          (↑/↓ to select, Enter to confirm)
        </Text>
        {validationError && (
          <Box marginTop={1} paddingX={1} borderStyle="single" borderColor="red" backgroundColor="#15171C">
            <Text color="red" bold>Error: </Text>
            <Text color="red">{validationError}</Text>
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          {isValidating ? (
            <Text color="yellow">Connecting to Ollama… please wait.</Text>
          ) : (
            ollamaModels.map((m) => (
              <Text key={m} color={selectedOllamaModel === m ? "#3B5FE0" : undefined} bold={selectedOllamaModel === m}>
                {selectedOllamaModel === m ? "❯ " : "  "}
                {m}
              </Text>
            ))
          )}
        </Box>
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            To get more models, run `ollama pull &lt;model-name&gt;` in another terminal.
          </Text>
        </Box>
      </Box>
    );
  }

  // ── Regular API key entry ────────────────────────────────────────────────
  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="#3B5FE0" backgroundColor="#15171C">
      <Text bold color="white">Enter your {SHORT_LABELS[provider]} API Key</Text>
      <Text color="gray">This will be stored in plain text in your OS config directory.</Text>

      {validationError && (
        <Box marginTop={1} paddingX={1} borderStyle="single" borderColor="red" backgroundColor="#15171C">
          <Text color="red" bold>Validation failed: </Text>
          <Text color="red">{validationError}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="white">Key: </Text>
        {isValidating ? (
          <Text color="yellow">Validating API key… please wait.</Text>
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

