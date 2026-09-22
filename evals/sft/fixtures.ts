// evals/sft/fixtures.ts
//
// Realistic source files for scenarios to operate on.
//
// These are parameterized rather than literal because the dataset needs ~1500
// records and 1500 hand-written files would be both unmaintainable and
// suspiciously uniform. A family takes a name and a few knobs and produces a
// file that looks like it belongs in this repo — same import style, same
// comment density, same `{ success, error }` tool convention.
//
// TWO PROPERTIES EVERY FIXTURE MUST HAVE, because editFile depends on them:
//
//   1. Any string a scenario uses as `old_string` must appear EXACTLY ONCE,
//      unless the scenario is deliberately testing the ambiguous-match path.
//   2. Line endings are LF. editFile matches whitespace exactly, and a file
//      written with CRLF would make every old_string in the dataset wrong on
//      the machine that regenerates it.
//
// The generator runs the real editFile against these, so a violation of (1)
// surfaces as a failed scenario rather than as quietly bad training data.

// Name pools.
//
// SIZE MATTERS HERE. Scenario loops index these with `i % length`, so a pool
// shorter than its loop silently produces byte-identical records — the
// validator's duplicate check caught exactly that, 53 of them, on the first
// full build. Keep each pool at least as long as the largest loop that
// draws from it.

export const SERVICE_NAMES = [
  "cache", "queue", "logger", "parser", "router", "session", "registry",
  "watcher", "scheduler", "formatter", "validator", "uploader", "indexer",
  "resolver", "tracker", "collector", "reporter", "dispatcher",
  "throttler", "serializer", "migrator", "notifier", "sampler", "archiver",
  "compactor", "snapshotter", "auditor", "planner", "renderer", "linker",
  "bundler", "profiler", "sweeper", "reconciler", "broadcaster", "shaper",
  "loader", "prefetcher", "estimator", "classifier", "extractor", "merger",
  "splitter", "grouper", "ranker", "filterer", "batcher", "replayer",
];

export const COMPONENT_NAMES = [
  "StatusBar", "FileTree", "DiffView", "PromptInput", "TokenMeter",
  "PlanPreview", "StepList", "ToolCallRow", "ErrorBanner", "ModelBadge",
  "CostTicker", "SpinnerRow", "ConfirmGate", "SessionList", "HelpPanel",
  "ScopeHint", "UndoNotice", "SearchOverlay", "BranchLabel", "TaskList",
  "PortBadge", "ContextGauge", "RouteChip", "VerifyMark", "LogViewport",
  "KeyHintBar", "EffortDial", "ProviderTag", "PinnedFiles", "StepTimer",
  "QueueDepth", "ThemeToggle", "TraceRow", "PromptHistory", "ExitPrompt",
];

export const HOOK_NAMES = [
  "useDebounce", "useInterval", "useClipboard", "useKeyPress",
  "useScrollLock", "useTerminalSize", "usePrevious", "useThrottle",
  "useMountedRef", "useAsyncValue", "useLatestRef", "useToggle",
  "useCountdown", "useIdleTimer", "useFocusTrap", "useBoundedList",
  "useRetry", "useStableId", "useRenderCount", "useEventQueue",
];

/** Deterministic pick, so regenerating the dataset gives the same records. */
export function pick<T>(items: T[], i: number): T {
  return items[i % items.length]!;
}

// ─── File families ───────────────────────────────────────────────────────────

/**
 * A service module in this repo's idiom: typed options, a default, and
 * functions that return results rather than throwing.
 */
export function serviceFile(name: string, timeoutMs = 5000): string {
  const Cap = name[0]!.toUpperCase() + name.slice(1);
  return `// src/services/${name}.ts
//
// ${Cap} service. Returns results, never throws — callers branch on success.

export interface ${Cap}Options {
  timeoutMs: number;
  retries: number;
  verbose: boolean;
}

export const DEFAULT_${name.toUpperCase()}_OPTIONS: ${Cap}Options = {
  timeoutMs: ${timeoutMs},
  retries: 3,
  verbose: false,
};

export async function run${Cap}(
  input: string,
  options: ${Cap}Options = DEFAULT_${name.toUpperCase()}_OPTIONS,
): Promise<{ success: boolean; value?: string; error?: string }> {
  if (!input) {
    return { success: false, error: "${name}: empty input" };
  }
  if (options.verbose) {
    console.log(\`${name}: processing \${input.length} chars\`);
  }
  return { success: true, value: input.trim() };
}
`;
}

/** An Ink component, matching src/ui and src/tui conventions. */
export function inkComponent(name: string): string {
  return `// src/ui/${name}.tsx

import React from "react";
import { Box, Text } from "ink";

interface ${name}Props {
  label: string;
  value: string;
  dim?: boolean;
}

export function ${name}({ label, value, dim = false }: ${name}Props) {
  return (
    <Box flexDirection="row" gap={1}>
      <Text dimColor={dim}>{label}</Text>
      <Text bold>{value}</Text>
    </Box>
  );
}
`;
}

/** A React hook file. */
export function hookFile(name: string, delay = 300): string {
  return `// src/hooks/${name}.ts

import { useEffect, useRef, useState } from "react";

export function ${name}<T>(value: T, delay = ${delay}): T {
  const [current, setCurrent] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timer.current = setTimeout(() => setCurrent(value), delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delay]);

  return current;
}
`;
}

/**
 * A file where one identifier appears in several places.
 *
 * For the recovery band: an old_string of just the bare name matches more
 * than once, which is exactly the "appeared N times" failure that near_line
 * exists to resolve. The repetition is the point, not an oversight.
 */
export function repeatedSymbolFile(symbol: string): string {
  return `// src/config/${symbol}-config.ts

export interface Config {
  ${symbol}: number;
  fallback: number;
}

export const DEFAULTS: Config = {
  ${symbol}: 10,
  fallback: 5,
};

export const TEST_DEFAULTS: Config = {
  ${symbol}: 10,
  fallback: 5,
};

export function resolveConfig(partial: Partial<Config>): Config {
  return {
    ${symbol}: partial.${symbol} ?? DEFAULTS.${symbol},
    fallback: partial.fallback ?? DEFAULTS.fallback,
  };
}

export function describeConfig(config: Config): string {
  return \`${symbol}=\${config.${symbol}} fallback=\${config.fallback}\`;
}
`;
}

/**
 * Line number (1-based) of the nth occurrence of `needle`, or -1.
 *
 * Used to compute `near_line` for the recovery band instead of hardcoding it.
 * A literal line number would be correct until someone adds a line to the
 * fixture above it, at which point every near_line record would quietly start
 * pointing at the wrong occurrence — still valid, still passing, teaching the
 * model to aim badly.
 */
export function lineOf(contents: string, needle: string, occurrence = 1): number {
  const lines = contents.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(needle)) {
      seen++;
      if (seen === occurrence) return i + 1;
    }
  }
  return -1;
}

/** A tool module in src/tools idiom — used by scenarios about adding tools. */
export function toolFile(name: string): string {
  return `// src/tools/${name}.ts

import { z } from "zod";
import { tool } from "ai";

export const ${name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())} = tool({
  description: "Placeholder for the ${name} tool",
  inputSchema: z.object({
    path: z.string().describe("Path to operate on"),
  }),
  execute: async ({ path }) => {
    return { success: true as const, path };
  },
});
`;
}

/** A package.json with the scripts scenarios reference. */
export function packageJson(name = "zizou-fixture"): string {
  return JSON.stringify(
    {
      name,
      version: "1.0.0",
      type: "module",
      scripts: {
        dev: "bun run src/cli.tsx",
        build: "bun run build.ts",
        test: "bun test src/",
        typecheck: "tsc --noEmit",
      },
      dependencies: { ai: "^7.0.0", ink: "^7.1.0", react: "^19.2.7", zod: "^3.24.0" },
    },
    null,
    2,
  ) + "\n";
}

export function tsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        jsx: "react-jsx",
        noEmit: true,
      },
      include: ["src"],
    },
    null,
    2,
  ) + "\n";
}

export function readme(name = "Fixture Project"): string {
  return `# ${name}

A small TypeScript project built with Bun and Ink.

## Scripts

- \`bun run dev\` — start the CLI
- \`bun test\` — run the test suite
`;
}

/**
 * The baseline every fixture starts from.
 *
 * A non-empty repo is not decoration: FILE_PLACEMENT_RULES tells the model to
 * put new files beside similar ones and to write at the root only when the
 * repo is empty. Generating against an empty workspace would train the exact
 * behaviour those rules exist to prevent.
 */
export function baseProject(): Record<string, string> {
  return {
    "package.json": packageJson(),
    "tsconfig.json": tsconfig(),
    "README.md": readme(),
    "src/cli.tsx": `// src/cli.tsx
import React from "react";
import { render } from "ink";
import { App } from "./ui/App.js";

render(<App />);
`,
    "src/ui/App.tsx": `// src/ui/App.tsx
import React from "react";
import { Box, Text } from "ink";

export function App() {
  return (
    <Box flexDirection="column">
      <Text bold>Fixture App</Text>
    </Box>
  );
}
`,
  };
}
