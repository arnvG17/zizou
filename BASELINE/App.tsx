// src/ui/App.tsx
import React, { useState } from "react";
import { ApiKeySetup } from "./ApiKeySetup.js";
import { Chat } from "./Chat.js";
import { hasAnyApiKey } from "../config.js";

export function App() {
  const [ready, setReady] = useState(hasAnyApiKey());

  if (!ready) {
    return <ApiKeySetup onComplete={() => setReady(true)} />;
  }
  return <Chat />;
}
