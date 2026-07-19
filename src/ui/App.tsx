/**
 * App.tsx — Root Ink application component.
 *
 * Layer: ui
 * Allowed imports: config/, ui/ components
 *
 * UPDATED: Now threads `mode` and `initialPrompt` props from the CLI
 * entry point down to the Chat component. The Chat component uses these
 * to determine which orchestrator path to take and to auto-submit
 * the initial prompt if one was provided on the command line.
 */

import React, { useState } from "react";
import { Box } from "ink";
import { hasAnyApiKey } from "../config/api-keys.js";
import { ApiKeySetup } from "./ApiKeySetup.js";
import { Figurine } from "./Figurine.js";
import { Chat } from "./Chat.js";
import type { Mode } from "../agent/mode.js";

/**
 * Props for the root App component.
 *
 * @param forceSetup - If true, forces the API key setup flow.
 * @param mode - The operating mode (build or plan) determined by CLI args.
 *               Defaults to "build" if not specified.
 * @param initialPrompt - If provided, the Chat component will auto-submit
 *                        this prompt on startup. Supports `zizou "prompt"`.
 */
interface AppProps {
  forceSetup?: boolean;
  mode?: Mode;
  initialPrompt?: string;
}

export function App({ forceSetup = false, mode = "build", initialPrompt }: AppProps) {
  const [hasKey, setHasKey] = useState(() => {
    if (process.env.GROQ_API_KEY) return true;
    if (process.env.OPENAI_API_KEY) return true;
    if (process.env.OPENROUTER_API_KEY) return true;
    if (process.env.ANTHROPIC_API_KEY) return true;
    if (process.env.GEMINI_API_KEY) return true;
    if (forceSetup) return false;
    return hasAnyApiKey();
  });

  return (
    <Box flexDirection="column">
      <Figurine />
      <Box flexDirection="column">
        {!hasKey ? (
          <Box padding={1}>
            <ApiKeySetup onComplete={() => setHasKey(true)} />
          </Box>
        ) : (
          <Chat
            onChangeKeys={() => setHasKey(false)}
            mode={mode}
            initialPrompt={initialPrompt}
          />
        )}
      </Box>
    </Box>
  );
}
