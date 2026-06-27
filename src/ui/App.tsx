/**
 * App.tsx — Root Ink application component.
 *
 * Layer: ui
 * Allowed imports: config/, ui/ components
 */

import React, { useState, useEffect } from "react";
import { Box, useInput } from "ink";
import { hasAnyApiKey } from "../config/api-keys.js";
import { ApiKeySetup } from "./ApiKeySetup.js";
import { Figurine } from "./Figurine.js";
import { Chat } from "./Chat.js";

export function App({ forceSetup = false }: { forceSetup?: boolean }) {
  const [showSplash, setShowSplash] = useState(true);
  const [hasKey, setHasKey] = useState(() => {
    if (process.env.GROQ_API_KEY) return true;
    if (forceSetup) return false;
    return hasAnyApiKey();
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowSplash(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  useInput((_input, key) => {
    if (showSplash) {
      setShowSplash(false);
    }
  });

  if (showSplash) {
    return <Figurine />;
  }

  return (
    <Box flexDirection="column">
      {!hasKey ? (
        <Box padding={1}>
          <ApiKeySetup onComplete={() => setHasKey(true)} />
        </Box>
      ) : (
        <Chat onChangeKeys={() => setHasKey(false)} />
      )}
    </Box>
  );
}
