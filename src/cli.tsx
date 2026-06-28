
/**
 * cli.tsx — Entry point for the Zizou CLI.
 *
 * Shebang Reasoning: `#!/usr/bin/env bun`
 * Since Zizou is written in TypeScript and JSX (React/Ink) and is executed 
 * using the Bun runtime, we use the `bun` shebang. Bun natively transpiles 
 * TS/JSX on the fly, eliminating the need for a separate `tsc` or Babel build
 * step before running the CLI in development or when distributed as a bun-specific 
 * package.
 */

import React from "react";
import { render } from "ink";
import { App } from "./ui/App.js";
import { clearApiKeys } from "./config/api-keys.js";

const args = process.argv.slice(2);
const forceSetup = args.includes("--reset") || args.includes("--setup");
if (forceSetup) {
  clearApiKeys();
}

// Render the root Ink component
render(<App forceSetup={forceSetup} />);
