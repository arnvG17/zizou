/**
 * App.tsx — Root Ink application component.
 *
 * Layer: ui
 * Allowed imports: config/, ui/ components
 */

import React, { useState } from "react";
import { Box } from "ink";
import { hasAnyApiKey } from "../config/api-keys.js";
import { ApiKeySetup } from "./ApiKeySetup.js";
import { Figurine } from "./Figurine.js";
import { Chat } from "./Chat.js";

export function App({ forceSetup = false }: { forceSetup?: boolean }) {
  const [hasKey, setHasKey] = useState(() => {
    if (process.env.GROQ_API_KEY) return true;
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
          <Chat onChangeKeys={() => setHasKey(false)} />
        )}
      </Box>
    </Box>
  );
}
