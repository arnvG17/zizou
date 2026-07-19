import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { generateText } from "ai";
import {
  ProviderChoice,
  setApiKey,
  setDefaultProvider,
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
  // When true, the user can press Enter to skip validation and save the key anyway
  const [canSaveAnyway, setCanSaveAnyway] = useState(false);

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
          setStep("enter-ollama-model");
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
        setStep("enter-ollama-url");
      }
    }
  });

  React.useEffect(() => {
    if (step === "enter-ollama-model" && ollamaModels.length === 0 && !isValidating) {
      const fetchInitialModels = async () => {
        setIsValidating(true);
        setValidationError(null);
        const defaultUrl = "http://localhost:11434";
        try {
          let models: string[] = [];

          // Try fetching tags API on default URL
          try {
            const res = await fetch(`${defaultUrl}/api/tags`);
            if (res.ok) {
              const data = await res.json() as any;
              models = data?.models?.map((m: any) => m.name) || [];
            }
          } catch (err) {
            // Fetch failed. Try auto-starting Ollama server locally
            try {
              const { spawn } = await import("child_process");
              const child = spawn("ollama", ["serve"], {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
              });
              child.unref();

              // Poll tags API up to 10 times (every 500ms, total 5 seconds)
              for (let i = 0; i < 10; i++) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                try {
                  const res = await fetch(`${defaultUrl}/api/tags`);
                  if (res.ok) {
                    const data = await res.json() as any;
                    models = data?.models?.map((m: any) => m.name) || [];
                    if (models.length > 0) {
                      break;
                    }
                  }
                } catch (pollErr) {
                  // Ignore and retry
                }
              }
            } catch (spawnErr) {
              // Ignore spawn error
            }
          }

          // Fallback: Try running `ollama list` CLI command directly
          if (models.length === 0) {
            try {
              const { execSync } = await import("child_process");
              const stdout = execSync("ollama list", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
              const lines = stdout.trim().split(/\r?\n/);
              if (lines.length > 1) {
                for (let i = 1; i < lines.length; i++) {
                  const line = lines[i].trim();
                  if (!line) continue;
                  const parts = line.split(/\s+/);
                  if (parts[0]) {
                    models.push(parts[0]);
                  }
                }
              }
            } catch (cliErr) {
              // Ignore CLI error
            }
          }

          if (models.length === 0) {
            throw new Error("Could not find any local Ollama models. Please check if Ollama is running and has models.");
          }

          setOllamaModels(models);
          setSelectedOllamaModel(models[0]);
        } catch (err: any) {
          setValidationError(err.message ?? String(err));
          // Fallback to at least show the default model so selection doesn't break
          setOllamaModels([DEFAULT_MODELS["ollama"]]);
          setSelectedOllamaModel(DEFAULT_MODELS["ollama"]);
        } finally {
          setIsValidating(false);
        }
      };

      fetchInitialModels();
    }
  }, [step, ollamaModels.length, isValidating]);

  // ── Ollama URL submit (final validation & save) ───────────────────────────
  const handleUrlSubmit = async (value: string) => {
    const url = value.trim() || "http://localhost:11434";
    setUrlInput(url);
    setOllamaBaseUrl(url);
    setIsValidating(true);
    setValidationError(null);

    try {
      const model = selectedOllamaModel || DEFAULT_MODELS["ollama"];
      setModelInput(model);
      setProviderModel("ollama", model);
      setDefaultProvider("ollama");

      // Validate by generating a single token
      const lm = resolveModel("ollama");
      await generateText({ model: lm, prompt: "hi", maxTokens: 1 });
      onComplete();
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

  // ── "Save anyway" — skip validation and accept the key as-is ─────────────
  const handleSaveAnyway = () => {
    setApiKey(provider, keyInput.trim());
    setDefaultProvider(provider);
    onComplete();
  };

  // ── OpenRouter-specific key validation ──────────────────────────────────
  // Uses the dedicated /api/v1/key endpoint instead of a generative ping.
  // Free model pings fail for many reasons (data policy, overloaded endpoints,
  // maxTokens:1 quirks) — the /key endpoint is fast, reliable, and keycheck-only.
  const validateOpenRouterKey = async (key: string): Promise<void> => {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      if (res.status === 401) throw new Error("401 Unauthorized — invalid OpenRouter API key.");
      if (res.status === 403) throw new Error("403 Forbidden — key lacks permissions.");
      throw new Error(`OpenRouter key check failed (HTTP ${res.status}).`);
    }
    // Key is valid — we don't need to parse the body
  };

  // ── Regular provider key submit ──────────────────────────────────────────
  const handleKeySubmit = async (value: string) => {
    // If a previous validation failed and canSaveAnyway is true,
    // pressing Enter a second time saves the key without re-validating.
    if (canSaveAnyway && validationError) {
      handleSaveAnyway();
      return;
    }

    if (value.trim().length === 0 || isValidating) return;

    setCanSaveAnyway(false);
    setIsValidating(true);
    setValidationError(null);

    try {
      setApiKey(provider, value.trim());

      if (provider === "openrouter") {
        // Use the dedicated key-check endpoint — no free model ping needed.
        await validateOpenRouterKey(value.trim());
      } else {
        // For all other providers, do a tiny generative ping.
        // maxTokens:10 avoids the known maxTokens:1 edge-case failures.
        const model = resolveModel(provider);
        await generateText({ model, prompt: "hi", maxTokens: 10, maxRetries: 0 });
      }

      setDefaultProvider(provider);
      onComplete();
    } catch (err: any) {
      // Keep the key stored — don't remove it. The user can save anyway.
      // (Previously we called removeApiKey here, which prevented saving.)

      let errMsg = err.message ?? String(err);
      let canBypass = true; // allow saving anyway by default

      // ── Provider-specific error messages ──────────────────────────────
      if (
        errMsg.includes("401") ||
        errMsg.toLowerCase().includes("unauthorized") ||
        errMsg.toLowerCase().includes("invalid api key") ||
        errMsg.toLowerCase().includes("invalid x-api-key") ||
        errMsg.toLowerCase().includes("incorrect api key")
      ) {
        errMsg = `Invalid ${SHORT_LABELS[provider]} API key. Double-check it or press Enter to save anyway.`;
      } else if (errMsg.includes("No endpoints found") || errMsg.includes("No available model")) {
        errMsg = "No models available for this key. Press Enter to save anyway.";
      } else if (errMsg.includes("403") || errMsg.toLowerCase().includes("forbidden")) {
        errMsg = `Access denied — your key may lack permissions. Press Enter to save anyway.`;
      } else if (errMsg.includes("429") || errMsg.toLowerCase().includes("rate limit")) {
        // Key is valid but rate-limited — accept it immediately
        setDefaultProvider(provider);
        onComplete();
        return;
      } else if (errMsg.includes("ECONNREFUSED") || errMsg.includes("fetch failed")) {
        errMsg = `Cannot reach ${SHORT_LABELS[provider]}. Check your network. Press Enter to save anyway.`;
      } else if (errMsg.includes("AI_APICallError")) {
        errMsg = "API call failed. Press Enter to save anyway.";
      }

      setValidationError(errMsg);
      setCanSaveAnyway(canBypass);
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
          {isValidating ? (
            <Text color="yellow">Connecting and checking Ollama server... please wait.</Text>
          ) : (
            <>
              <Text color="white">URL: </Text>
              <TextInput
                value={urlInput}
                onChange={setUrlInput}
                onSubmit={handleUrlSubmit}
                placeholder="http://localhost:11434"
              />
            </>
          )}
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
        <Box marginTop={1} paddingX={1} borderStyle="single" borderColor={canSaveAnyway ? "yellow" : "red"} backgroundColor="#15171C">
          <Text color={canSaveAnyway ? "yellow" : "red"} bold>Validation failed: </Text>
          <Text color={canSaveAnyway ? "yellow" : "red"}>{validationError}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="white">Key: </Text>
        {isValidating ? (
          <Text color="yellow">Validating API key… please wait.</Text>
        ) : (
          <TextInput
            value={canSaveAnyway && validationError ? "[press Enter to save anyway, or type a new key]" : keyInput}
            onChange={(v) => {
              // If the user starts typing after a failed validation, reset the bypass state
              if (canSaveAnyway && validationError) {
                setCanSaveAnyway(false);
                setValidationError(null);
                setKeyInput(v);
              } else {
                setKeyInput(v);
              }
            }}
            onSubmit={handleKeySubmit}
            mask={canSaveAnyway && validationError ? undefined : "*"}
          />
        )}
      </Box>
      {canSaveAnyway && validationError && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>↵ Enter = save key anyway  •  Type new key to retry</Text>
        </Box>
      )}
    </Box>
  );
}

