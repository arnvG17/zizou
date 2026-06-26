#!/usr/bin/env bun
// src/cli.tsx
//
// This is the file Bun will actually execute when someone runs
// `zizou` from their terminal (after `bun install -g zizou` or `bunx zizou`).
// The shebang says `bun` specifically (not `node`) because Bun runs
// TypeScript + JSX files natively with zero build step — Node cannot
// execute a .tsx file directly, so this package genuinely requires Bun
// as the runtime, which is the choice you made earlier in this project.

import React from "react";
import { render } from "ink";
import { App } from "./ui/App.js";

render(<App />);
