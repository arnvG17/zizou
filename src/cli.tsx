
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
// surface is small: --reset, --setup, --plan, and the positional "plan"
// subcommand. Adding a full arg parser for 3 flags isn't worth the dep.

const args = process.argv.slice(2);

// Handle --reset/--setup: clears stored API keys, forces re-setup flow
const forceSetup = args.includes("--reset") || args.includes("--setup");
if (forceSetup) {
  clearApiKeys();
}

// ─── Mode Detection ──────────────────────────────────────────────────────────
//
// Detect plan mode from either:
//   1. `zizou plan "prompt"` — "plan" as a positional subcommand
//   2. `zizou --plan "prompt"` — --plan as a flag
//
// Everything else defaults to build mode. The resolveMode function in
// mode.ts is intentionally trivial — a pure flag check, no heuristics.

const hasPlanFlag = args.includes("--plan");

// Check for "plan" as the first non-flag argument (positional subcommand).
// e.g., `zizou plan "add auth"` → planPositional = true
const nonFlagArgs = args.filter((a) => !a.startsWith("--"));
const planPositional = nonFlagArgs[0] === "plan";

// Resolve the mode using the pure flag-check function
const modeContext = resolveMode({ planFlag: hasPlanFlag || planPositional });

// ─── Initial Prompt Extraction ───────────────────────────────────────────────
//
// If the user provided a prompt on the command line, extract it and pass
// it to the App so it can auto-submit on startup. This supports:
//   - `zizou "fix the typo in README"`
//   - `zizou plan "add authentication system"`
//
// We strip out flags (--plan, --reset, --setup) and the "plan" subcommand
// to get the actual prompt text.

const flagsToStrip = new Set(["--plan", "--reset", "--setup"]);
const promptArgs = args.filter((a) => !flagsToStrip.has(a));

// If "plan" was used as a positional subcommand, remove it too
const initialPromptParts = planPositional
  ? promptArgs.slice(1)  // skip the "plan" word
  : promptArgs;

// Join remaining args as the initial prompt (may be empty if user wants
// interactive mode)
const initialPrompt = initialPromptParts.join(" ").trim() || undefined;

// ─── Render ──────────────────────────────────────────────────────────────────

render(
  <App
    forceSetup={forceSetup}
    mode={modeContext.mode}
    initialPrompt={initialPrompt}
  />
);
