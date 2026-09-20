
/**
 * cli.tsx — Entry point for the Zizou CLI.
 *
 * Shebang Reasoning: `#!/usr/bin/env bun`
 * Since Zizou is written in TypeScript and JSX (React/Ink) and is executed 
 * using the Bun runtime, we use the `bun` shebang. Bun natively transpiles 
 * TS/JSX on the fly, eliminating the need for a separate `tsc` or Babel build
 * step before running the CLI in development or when distributed as a bun-specific 
 * package.
 *
 * MODE DETECTION:
 *   The CLI detects the operating mode from positional args and flags:
 *     - `zizou "<prompt>"`          → build mode (default)
 *     - `zizou plan "<prompt>"`     → plan mode
 *     - `zizou --plan "<prompt>"`   → plan mode (flag variant)
 *   No LLM call is involved in mode selection — it's a pure flag check.
 *   See src/agent/mode.ts for the type definitions and rationale.
 */

import React from "react";
import { render } from "ink";
import { App } from "./ui/App.js";
import { clearApiKeys } from "./config/api-keys.js";
import { resolveMode, type Mode } from "./agent/mode.js";

// ─── Parse CLI Arguments ─────────────────────────────────────────────────────
//
// We parse manually (no yargs/commander dependency) because the argument
// surface is small: --reset, --setup, the mode flags, and the positional
// "plan" subcommand. Adding a full arg parser isn't worth the dep.

const args = process.argv.slice(2);

// Handle --reset/--setup: clears stored API keys, forces re-setup flow
const forceSetup = args.includes("--reset") || args.includes("--setup");
if (forceSetup) {
  clearApiKeys();
}

// ─── Mode Detection ──────────────────────────────────────────────────────────
//
// Plan mode is detectable two ways, both kept for compatibility:
//   1. `zizou plan "prompt"` — "plan" as a positional subcommand
//   2. `zizou --plan "prompt"` — --plan as a flag
//
// The other modes have a flag each. WITH NO FLAG AT ALL the mode is "auto":
// the router reads the prompt and picks, rather than running every request
// as a single build step regardless of what was asked.
//
// resolveMode is still a pure flag check with no heuristics — the classifier
// runs later, inside the orchestrator, and only when this returns "auto".

const hasPlanFlag = args.includes("--plan");

// Check for "plan" as the first non-flag argument (positional subcommand).
// e.g., `zizou plan "add auth"` → planPositional = true
const nonFlagArgs = args.filter((a) => !a.startsWith("--"));
const planPositional = nonFlagArgs[0] === "plan";

const modeContext = resolveMode({
  planFlag: hasPlanFlag || planPositional,
  buildFlag: args.includes("--build"),
  askFlag: args.includes("--ask"),
  chatFlag: args.includes("--chat"),
  autoFlag: args.includes("--auto"),
});

// ─── Initial Prompt Extraction ───────────────────────────────────────────────
//
// If the user provided a prompt on the command line, extract it and pass
// it to the App so it can auto-submit on startup. This supports:
//   - `zizou "fix the typo in README"`
//   - `zizou plan "add authentication system"`
//
// We strip out every flag and the "plan" subcommand to get the actual prompt
// text. A flag left in here would become part of the prompt, and in auto mode
// it would also become part of what the router classifies.

const flagsToStrip = new Set([
  "--plan",
  "--build",
  "--ask",
  "--chat",
  "--auto",
  "--reset",
  "--setup",
]);
const promptArgs = args.filter((a) => !flagsToStrip.has(a));

// If "plan" was used as a positional subcommand, remove it too
const initialPromptParts = planPositional
  ? promptArgs.slice(1)  // skip the "plan" word
  : promptArgs;

// Join remaining args as the initial prompt (may be empty if user wants
// interactive mode)
const initialPrompt = initialPromptParts.join(" ").trim() || undefined;

// ─── Render ──────────────────────────────────────────────────────────────────

import { getDefaultProvider, getOllamaBaseUrl } from "./config/api-keys.js";
import { getActiveModelId } from "./sdk/resolve-model.js";
import { primeOllamaCache } from "./sdk/ollama.js";
import { join } from "node:path";
import { RunJournal, setActiveJournal } from "./agent/debug/index.js";

// ─── Debug journal ───────────────────────────────────────────────────────────
//
// One journal per process, registered as the active one so runTurn records into
// it without every layer having to pass it down. Writes to .zizou/journal/ in
// the project rather than a file at the repo root — a debug log dropped beside
// the user's source is a file they then have to gitignore.
//
// Off unless asked for: the journal records file contents and diffs, and a tool
// that silently writes the user's source into a log file on every run is not
// something to enable by default. ZIZOU_DEBUG=1 turns it on.
if (process.env.ZIZOU_DEBUG === "1" || process.env.ZIZOU_DEBUG === "true") {
  const journal = new RunJournal({
    dir: join(process.cwd(), ".zizou", "journal"),
    runId: `session-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    label: "interactive",
    root: process.cwd(),
  });
  setActiveJournal(journal);
  console.log(`zizou: debug journal -> ${journal.logPath}`);
}

// Read the local model catalogue before the first render.
//
// getActiveModelId() is synchronous and is called from render paths, but for
// Ollama the answer lives on the server — the catalogue is whatever the user
// pulled. Priming here means the very first frame names the model that will
// actually be called, instead of a built-in default the user may not have
// installed. Fails soft: Ollama being off is not a reason not to start.
if (getDefaultProvider() === "ollama") {
  await primeOllamaCache();
}

const instance = render(
  <App
    forceSetup={forceSetup}
    mode={modeContext.mode}
    initialPrompt={initialPrompt}
  />
);

instance.waitUntilExit().then(async () => {
  // Auto-unload the Ollama model from memory when Zizou exits
  try {
    const provider = getDefaultProvider();
    if (provider === "ollama") {
      const model = getActiveModelId("ollama");
      const baseUrl = getOllamaBaseUrl();
      
      // Sending keep_alive: 0 instantly unloads the model from VRAM/RAM
      // and terminates any ongoing generation on the Ollama server side.
      await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, keep_alive: 0 }),
      });
    }
  } catch (err) {
    // Silently ignore fetch errors on exit
  }
  process.exit(0);
});
