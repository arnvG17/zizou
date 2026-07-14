# Zizou - Complete System Specification

## Table of Contents
1. [Project Overview](#project-overview)
2. [Architecture & Layering](#architecture--layering)
3. [The Agent Loop](#the-agent-loop)
4. [The Orchestrator](#the-orchestrator)
5. [SDK Integration](#sdk-integration)
6. [Tools System](#tools-system)
7. [Context Building](#context-building)
8. [Configuration & Security](#configuration--security)
9. [Models & Providers](#models--providers)
10. [UI Layer](#ui-layer)
11. [Execution Modes](#execution-modes)
12. [Verification System](#verification-system)
13. [Escalation Logic](#escalation-logic)
14. [Debug Logging](#debug-logging)

---

## Project Overview

**Zizou** is an open-source AI coding agent CLI tool built with TypeScript, React (Ink), and the Vercel AI SDK. It allows users to chat with LLMs (Claude 3.5 Sonnet, GPT-4o, etc.) directly in their terminal, granting the AI the ability to read files, edit files safely, and run sandboxed terminal commands with explicit user approval.

### Key Characteristics
- **Provider-agnostic**: Supports Anthropic, OpenAI, Groq, Google Gemini, OpenRouter, and local Ollama
- **Real-time streaming**: Token-by-token response rendering for immediate feedback
- **Tool-based execution**: The LLM uses structured tool calls to interact with the filesystem and shell
- **Dual execution modes**: Build mode (simple fixes) and Plan mode (complex multi-step features)
- **Deterministic escalation**: Automatic detection when a "simple" request exceeds scope
- **Layered architecture**: Strict dependency direction from UI → agent → tools/sdk → config

---

## Architecture & Layering

The codebase follows a strict layered architecture. Higher layers may import from lower layers, but never vice-versa.

```
┌─────────────────────────────────────────────────────────────┐
│ ui/                    (React/Ink terminal interface)         │
│ - App.tsx, Chat.tsx, ApiKeySetup.tsx, Figurine.tsx          │
└─────────────────────────────────────────────────────────────┘
                            ↓ imports
┌─────────────────────────────────────────────────────────────┐
│ agent/                  (Core AI orchestration)            │
│ - orchestrator.ts, run-turn.ts, clarifier.ts                │
│ - planner.ts, executor.ts, verifier.ts, mode.ts             │
└─────────────────────────────────────────────────────────────┘
                            ↓ imports
┌─────────────────────────────────────────────────────────────┐
│ context/                (System prompt & repo map)          │
│ - build-system-prompt.ts, repo-map.ts                        │
├─────────────────────────────────────────────────────────────┤
│ sdk/                    (Model resolution)                   │
│ - resolve-model.ts                                            │
├─────────────────────────────────────────────────────────────┤
│ tools/                  (Agent capabilities)                │
│ - read-file.ts, write-file.ts, edit-file.ts, glob.ts        │
│ - grep.ts, list-dir.ts, run-bash.ts, etc.                   │
└─────────────────────────────────────────────────────────────┘
                            ↓ imports
┌─────────────────────────────────────────────────────────────┐
│ config/                 (Persistent storage)                │
│ - api-keys.ts                                                 │
└─────────────────────────────────────────────────────────────┘
```

### Dependency Rules
- **ui/**: May import from agent/, context/, sdk/, tools/, config/
- **agent/**: May import from context/, sdk/, tools/, config/. Must NOT import from ui/
- **context/**: May import from config/. Must NOT import from agent/, ui/, tools/, sdk/
- **sdk/**: May import from config/. Must NOT import from agent/, ui/, tools/
- **tools/**: May import from config/. Must NOT import from agent/, ui/, sdk/
- **config/**: Base layer. Must NOT import from any other project layer

---

## The Agent Loop

**Location**: `src/agent/run-turn.ts`

The agent loop is the heart of Zizou. It takes a user message, talks to the LLM, runs whatever tools the model requests, and keeps iterating until the model is done.

### Core Function: `runTurn()`

```typescript
export async function* runTurn(
  options: RunTurnOptions,
): AsyncGenerator<AgentEvent, ModelMessage[]>
```

**Parameters**:
- `history`: Full conversation history (including the new user message)
- `model`: The resolved LanguageModel from the SDK
- `onConfirm`: Callback for user confirmation of shell commands
- `systemPrompt`: Extra system-prompt text (repo map, context)
- `maxSteps`: Safety cap on internal tool-call rounds (default: 15)

**Returns**: An async generator yielding `AgentEvent` objects, finally returning the updated conversation history.

### Event Types

The agent loop collapses the AI SDK's ~15 stream-part variants into 5 event types:

```typescript
export type AgentEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { kind: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { kind: "tool-error"; toolCallId: string; toolName: string; error: unknown }
  | { kind: "turn-complete" }
  | { kind: "finish"; usage?: { inputTokens: number; outputTokens: number } };
```

### Tool Registration

All tools are registered in the `runTurn()` function:

```typescript
const tools = {
  readFile,
  writeFile,
  editFile,
  glob,
  grep,
  listDir,
  openFile,
  addFileToContext,
  runBash: createRunBashTool(onConfirm),
  runBackground: createRunBackgroundTool(onConfirm),
  manageTasks,
  managePorts,
  fileOperations,
};
```

### The Streaming Loop

```typescript
const result = streamText({
  model,
  system: systemPrompt,
  tools,
  stopWhen: stepCountIs(maxSteps),
  messages: history,
  maxRetries: 0,  // Disabled to avoid token waste on rate limits
});

for await (const part of result.fullStream) {
  switch (part.type) {
    case "text-delta":
      yield { kind: "text-delta", text: part.text };
      break;
    case "tool-call":
      yield { kind: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input };
      break;
    case "tool-result":
      yield { kind: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: part.output };
      break;
    case "tool-error":
      yield { kind: "tool-error", toolCallId: part.toolCallId, toolName: part.toolName, error: part.error };
      break;
    // ... other cases
  }
}
```

### Rate Limit Detection

The agent loop includes special handling for API rate limits (HTTP 429). When detected, it:
- Surfaces a clean, actionable message to the user
- Does NOT retry (to avoid tripling token consumption)
- Returns the current history unchanged

```typescript
const isRateLimit =
  errMsg.includes("Rate limit") ||
  errMsg.includes("429") ||
  errMsg.includes("Too Many Requests") ||
  // ... other patterns

if (isRateLimit) {
  yield { kind: "text-delta", text: friendlyMsg };
  return history;
}
```

### Fallback Parser for Small Models

Small LLMs (3B) often can't do native tool calling and instead dump raw JSON in their text response. The agent loop includes a fallback parser that:
- Extracts raw JSON tool calls from text
- Executes the tool manually
- Morphs the assistant message to look like a native tool call
- Recursively continues with remaining step budget

```typescript
function extractRawToolCall(text: string): { name: string; arguments: any } | null {
  const match = text.match(/(?:```(?:json)?\s*)?(\{[\s\S]*?\})(?:\s*```)?/);
  if (!match) return null;
  // ... parse and validate
}
```

### History Persistence

**Critical**: `streamText()` does NOT persist history automatically. The agent loop must append `responseMessages` itself:

```typescript
return [...history, ...responseMessages];
```

Without this, the LLM has no memory of previous turns.

---

## The Orchestrator

**Location**: `src/agent/orchestrator.ts`

The orchestrator is the integration point where all agent modules (clarifier, planner, executor, verifier) are composed into a working pipeline. It owns plan state and drives the execution loop differently per mode.

### Core Function: `runOrchestrator()`

```typescript
export async function* runOrchestrator(
  userPrompt: string,
  modeContext: ModeContext,
  context: ProjectContext,
  model: LanguageModel,
  onConfirm: ConfirmFn,
  clarificationAnswers?: Record<string, string>,
  approvedPlan?: PlanStep[],
): AsyncGenerator<OrchestratorEvent>
```

### Orchestrator Events

```typescript
export type OrchestratorEvent =
  | { kind: "agent-event"; event: AgentEvent }
  | { kind: "mode-info"; mode: Mode; reason: string }
  | { kind: "clarification-needed"; questions: ClarifyingQuestion[] }
  | { kind: "plan-ready"; steps: PlanStep[] }
  | { kind: "step-start"; step: PlanStep; totalSteps: number }
  | { kind: "step-verified"; step: PlanStep; verification: VerificationResult }
  | { kind: "escalation-prompt"; trigger: EscalationTrigger }
  | { kind: "complete" };
```

### Build Mode (Default)

Build mode is the simple path: synthesize a single step from the user's prompt, execute it, verify it, check for escalation.

```typescript
async function* runBuildMode(
  userPrompt: string,
  context: ProjectContext,
  model: LanguageModel,
  onConfirm: ConfirmFn,
): AsyncGenerator<OrchestratorEvent> {
  yield { kind: "mode-info", mode: "build", reason: "Direct execution — single step" };

  const syntheticStep: PlanStep = {
    index: 0,
    description: userPrompt,
    targetFiles: [],
    dependsOn: [],
  };

  yield { kind: "step-start", step: syntheticStep, totalSteps: 1 };

  const preSnapshots = capturePreSnapshot(syntheticStep, context.projectRoot);
  const stepResult = await executeStep(syntheticStep, context, model, onConfirm);
  const verification = await verifyStep(syntheticStep, stepResult, context.projectRoot, preSnapshots);

  yield { kind: "step-verified", step: syntheticStep, verification };

  const escalation = shouldEscalate(stepResult, verification);
  if (escalation) {
    yield { kind: "escalation-prompt", trigger: escalation };
    return;
  }

  yield { kind: "complete" };
}
```

### Plan Mode (--plan flag)

Plan mode is the full path: clarify → plan → confirm → execute each step → verify each.

```typescript
async function* runPlanMode(
  userPrompt: string,
  context: ProjectContext,
  model: LanguageModel,
  onConfirm: ConfirmFn,
  clarificationAnswers: Record<string, string> = {},
  approvedPlan?: PlanStep[],
): AsyncGenerator<OrchestratorEvent> {
  yield { kind: "mode-info", mode: "plan", reason: "Full planning pipeline" };

  let steps: PlanStep[];

  if (approvedPlan) {
    steps = approvedPlan;
  } else {
    // Phase 1: Clarification
    if (Object.keys(clarificationAnswers).length === 0) {
      const questions = await clarify(userPrompt, context, model);
      if (questions.length > 0) {
        yield { kind: "clarification-needed", questions };
        return;
      }
    }

    // Phase 2: Planning
    steps = await plan(userPrompt, clarificationAnswers, context, model);
    yield { kind: "plan-ready", steps };
    return;
  }

  // Phase 3: Execution (in dependency order)
  const sortedSteps = topologicalSort(steps);
  for (const step of sortedSteps) {
    yield { kind: "step-start", step, totalSteps: sortedSteps.length };
    const preSnapshots = capturePreSnapshot(step, context.projectRoot);
    const stepResult = await executeStep(step, context, model, onConfirm);
    const verification = await verifyStep(step, stepResult, context.projectRoot, preSnapshots);
    yield { kind: "step-verified", step, verification };
  }

  yield { kind: "complete" };
}
```

### Dependency Ordering

The orchestrator uses topological sort to execute steps in an order that respects dependencies:

```typescript
function topologicalSort(steps: PlanStep[]): PlanStep[] {
  const stepMap = new Map<number, PlanStep>();
  for (const step of steps) {
    stepMap.set(step.index, step);
  }

  const sorted: PlanStep[] = [];
  const visited = new Set<number>();
  const visiting = new Set<number>();

  function visit(index: number): void {
    if (visited.has(index)) return;
    if (visiting.has(index)) {
      throw new Error(`Cycle detected in plan dependencies at step ${index}`);
    }

    visiting.add(index);
    const step = stepMap.get(index);
    if (!step) return;

    for (const dep of step.dependsOn) {
      visit(dep);
    }

    visiting.delete(index);
    visited.add(index);
    sorted.push(step);
  }

  for (const step of steps) {
    visit(step.index);
  }

  return sorted;
}
```

---

## SDK Integration

**Location**: `src/sdk/resolve-model.ts`

The SDK layer is responsible for instantiating the correct `LanguageModel` via the Vercel AI SDK provider factories, dynamically injecting API keys.

### Supported Providers

```typescript
export type ProviderChoice = "anthropic" | "openai" | "openrouter" | "google" | "groq" | "ollama";
```

### Default Models

```typescript
export const DEFAULT_MODELS: Record<ProviderChoice, string> = {
  anthropic: "claude-3-5-sonnet-latest",
  openrouter: "google/gemma-3-27b-it:free",
  openai: "gpt-4o",
  google: "gemini-2.5-flash",
  groq: "llama-3.3-70b-versatile",
  ollama: "llama3",
};
```

### Model Resolution

```typescript
export function resolveModel(provider: ProviderChoice): LanguageModel {
  const modelId = getActiveModelId(provider);

  if (provider === "anthropic") {
    const apiKey = getApiKey("anthropic");
    if (!apiKey) throw new Error(`No API key for Anthropic. Run /keys to set one.`);
    const anthropic = createAnthropic({ apiKey });
    return anthropic(modelId);
  }

  if (provider === "openrouter") {
    const apiKey = getApiKey("openrouter");
    if (!apiKey) throw new Error(`No API key for OpenRouter. Run /keys to set one.`);
    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey,
      headers: {
        "HTTP-Referer": "https://github.com/arnv/zizou",
        "X-Title": "Zizou CLI",
      },
    });
    return openrouter(modelId);
  }

  // ... similar for other providers

  if (provider === "ollama") {
    const baseURL = getOllamaBaseUrl();
    const apiKey = getApiKey("ollama") ?? "ollama";
    const ollama = createOpenAI({
      baseURL: `${baseURL}/v1`,
      apiKey,
    });
    return ollama(modelId);
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
```

### Ollama Integration

Ollama exposes an OpenAI-compatible REST API at `localhost:11434` by default. No real API key is needed for a local instance, but the SDK requires one (we use a placeholder "ollama").

---

## Tools System

**Location**: `src/tools/`

Tools are pure functions that define the capabilities of the agent. They return deterministic JSON payloads (never throwing errors). Each tool is defined in its own file and re-exported from `src/tools/index.ts`.

### Tool Registration

```typescript
// src/tools/index.ts
export { readFile } from "./read-file.js";
export { writeFile } from "./write-file.js";
export { editFile } from "./edit-file.js";
export { glob } from "./glob.js";
export { grep } from "./grep.js";
export { listDir } from "./list-dir.js";
export { openFile } from "./open-file.js";
export { addFileToContext } from "./add-context.js";
export { createRunBashTool } from "./run-bash.js";
export { createRunBackgroundTool } from "./run-background.js";
export { manageTasks } from "./manage-tasks.js";
export { managePorts } from "./manage-ports.js";
export { fileOperations } from "./file-operations.js";
export type { ConfirmFn } from "./types.js";
```

### Available Tools

| Tool | Input Schema | What `execute()` does |
|------|-------------|----------------------|
| `readFile` | `path: string` | `readFileSync(path, "utf-8")` |
| `writeFile` | `path, contents` | `resolve(cwd, path)` → `mkdirSync` → `writeFileSync` |
| `editFile` | `path, old_string, new_string` | Read → count occurrences → replace exactly 1 → write |
| `glob` | `pattern: string` | `readdirSync` walk, regex match filenames, cap 50 results |
| `grep` | `query: string` | Walk files, `indexOf` search inside contents |
| `listDir` | `path?: string` | `readdirSync + statSync` on resolved dir, skip node_modules |
| `openFile` | `path: string` | `spawn("start"/"open"/"xdg-open", [absPath])` detached |
| `runBash` | `command: string` | ConfirmFn → user y/n → `exec(command, {timeout: 15s})` |
| `runBackground` | `command: string` | ConfirmFn → spawn detached process, track in task registry |
| `manageTasks` | `action, taskId?` | List, logs, kill background tasks |
| `managePorts` | `action, port?` | Check, kill processes on ports |
| `fileOperations` | `action, path, target?` | Delete, copy, move, create directories |
| `addFileToContext` | `path: string` | Pin file contents to permanent context |

### Tool Schema Transmission

The Vercel AI SDK converts each tool's `inputSchema` (Zod schema) into a JSON Schema object. This is sent in the `tools` array of the API request:

```json
{
  "name": "writeFile",
  "description": "Create a new file or completely overwrite...",
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Path to the file..." },
      "contents": { "type": "string", "description": "The complete string content..." }
    },
    "required": ["path", "contents"]
  }
}
```

**The LLM does not see `execute()`** — it only sees the name, description, and parameter schema.

### Tool Call Lifecycle

1. LLM outputs: `{"type": "tool-call", "toolName": "writeFile", "input": {...}}`
2. SDK intercepts: calls `writeFile.execute({path, contents})` locally
3. `execute()` runs: `path.resolve(cwd, path)` → `mkdirSync` → `writeFileSync`
4. `execute()` returns: `{success: true, message: "Written to ..."}`
5. SDK injects: `{"role":"tool","content":[{"type":"tool-result","result":{...}}]}`
6. SDK re-prompts: sends the full updated history back to the LLM
7. LLM continues: reads the tool-result and decides what to do next

Steps 2–7 happen automatically inside `streamText()` for each tool call, up to `maxSteps=15` rounds.

### ConfirmFn for User Approval

Tools that require user approval (like `runBash`) receive a `ConfirmFn` callback:

```typescript
export type ConfirmFn = (command: string) => Promise<boolean>;

// Usage in runBash
const approved = await onConfirm(command);
if (!approved) {
  return { success: false, message: "Command rejected by user" };
}
```

---

## Context Building

**Location**: `src/context/build-system-prompt.ts`, `src/context/repo-map.ts`

Context building produces the actual TEXT that gets injected as the system prompt, combining:
1. General instructions about how to behave as a coding agent
2. The pre-computed repo map
3. Session context (workspace root, OS, shell)
4. Pinned files (user-specified permanent context)

### Role-Aware Repo Map

The repo-map inclusion decision is gated by WHICH AGENT ROLE is requesting context, not just by the budget level alone:

```typescript
export type AgentRole = "clarifier" | "planner" | "executor";

function shouldIncludeRepoMap(
  role: AgentRole | undefined,
  budget: string,
  targetFiles?: string[],
): boolean {
  // Clarifier and planner always need the repo map
  if (role === "clarifier" || role === "planner") return true;

  // Executor with empty targetFiles has nothing to orient a map around
  if (role === "executor" && targetFiles !== undefined && targetFiles.length === 0) {
    return false;
  }

  // Executor: existing budget behavior
  return budget !== "light";
}
```

**Why**: Taking the repo map away from planning causes the write-before-scaffold ordering bug — the planner needs a project overview to know what files already exist.

### System Prompt Structure

```
BASE_INSTRUCTIONS
  +
SESSION_CONTEXT (workspace root, OS, shell)
  +
PINNED FILES (if any)
  +
REPO MAP (if included)
```

### Repo Map Generation

**Location**: `src/context/repo-map.ts`

The repo map walks the entire project directory (excluding `node_modules`, `.git`, `dist`, `build`, `.next`) using `readdirSync` and extracts:
- Function names (`function foo(` / `const foo = (` / `async function foo`)
- Class names (`class Foo`)
- Interface names (`interface Foo`)
- Type aliases (`type Foo =`)
- Export statements

Each symbol is recorded as `filename:lineNumber: symbolSignature`.

**Limitation**: Regex-based extraction — may miss symbols defined as `const foo = tool({...})` patterns. The agent is told to use `glob`/`grep` to verify when in doubt.

### Pinned Files

Users can pin specific files to permanent context:

```typescript
export const pinnedContextFiles = new Set<string>();

export function addPinnedFile(projectRoot: string, filePath: string): string {
  const absolutePath = resolve(projectRoot, filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }
  pinnedContextFiles.add(absolutePath);
  return absolutePath;
}
```

Pinned files are injected as full file contents in the system prompt.

---

## Configuration & Security

**Location**: `src/config/api-keys.ts`

Configuration storage uses the `conf` library, which persists data in the OS's default configuration directory (e.g., `~/.config/zizou-nodejs/config.json` on Linux, `~/Library/Preferences/zizou-nodejs/config.json` on macOS, `%APPDATA%\zizou-nodejs\Config\config.json` on Windows).

### Config Schema

```typescript
interface ConfigSchema {
  apiKeys: {
    anthropic?: string;
    openai?: string;
    openrouter?: string;
    google?: string;
    groq?: string;
    ollama?: string;
  };
  defaultProvider?: ProviderChoice;
  providerModels?: Partial<Record<ProviderChoice, string>>;
  ollamaBaseUrl?: string;
  contextMode?: ContextMode;
}
```

### API Key Retrieval

**Environment variables ALWAYS take precedence over saved config:**

```typescript
export function getApiKey(provider: ProviderChoice): string | undefined {
  if (provider === "anthropic") {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    return config.get("apiKeys.anthropic");
  }
  // ... similar for other providers
}
```

### Security Warning

**🚨 IMPORTANT**: API keys entered via the initial setup screen are stored in **plain text** within the JSON config file. They are **NOT encrypted**.

To avoid writing your key to disk entirely, provide it via environment variables instead.

### Context Modes

```typescript
export type ContextMode = "light" | "default" | "max";

export function getContextMode(): ContextMode {
  return config.get("contextMode") || "default";
}
```

- **light**: Excludes repo map for executor (but NOT for clarifier/planner)
- **default**: Includes repo map for executor
- **max**: Reserved for future use (may include more context)

---

## Models & Providers

### Supported Providers

1. **Anthropic**: High-quality reasoning (Claude 3.5 Sonnet)
   - Default model: `claude-3-5-sonnet-latest`
   - Env var: `ANTHROPIC_API_KEY`

2. **OpenAI**: GPT-4o capabilities
   - Default model: `gpt-4o`
   - Env var: `OPENAI_API_KEY`

3. **Groq**: Extremely fast inference for Llama 3 models
   - Default model: `llama-3.3-70b-versatile`
   - Env var: `GROQ_API_KEY`

4. **Google**: Gemini capabilities
   - Default model: `gemini-2.5-flash`
   - Env var: `GEMINI_API_KEY`

5. **OpenRouter**: Access to a massive ecosystem of models
   - Default model: `google/gemma-3-27b-it:free`
   - Env var: `OPENROUTER_API_KEY`

6. **Ollama**: 100% free, local execution
   - Default model: `llama3`
   - Base URL: `http://localhost:11434` (configurable)
   - Env var: `OLLAMA_API_KEY` (optional, uses placeholder if not set)

### Model Overrides

Users can override the default model for any provider:

```typescript
export function setProviderModel(provider: ProviderChoice, model: string): void {
  const models = config.get("providerModels") ?? {};
  models[provider] = model;
  config.set("providerModels", models);
}
```

---

## UI Layer

**Location**: `src/ui/`

The UI layer is built with React (Ink) for terminal rendering. It is responsible ONLY for rendering state and handling user input.

### Components

- **App.tsx**: Root component, handles CLI argument parsing and mode selection
- **Chat.tsx**: Main chat interface, manages conversation history and orchestrator integration
- **ApiKeySetup.tsx**: Interactive setup screen for API key configuration
- **Figurine.tsx**: ASCII art mascot display

### Chat.tsx Responsibilities

- Manages conversation history (`history` ref)
- Caches system prompt (`systemPromptRef`)
- Handles user input and submission
- Consumes `OrchestratorEvent` stream from the orchestrator
- Renders text deltas, tool calls, verification results
- Handles interactive prompts (clarification, plan approval, escalation)

### Slash Commands

- **/keys**: Opens interactive setup screen to switch providers and enter/update API keys
- **/models**: Allows overriding the default model for a provider
- **/context**: Displays a panel showing what files the AI currently has in its context window

---

## Execution Modes

### Mode Type

```typescript
export type Mode = "build" | "plan";

export interface ModeContext {
  mode: Mode;
  reason: "user-flag" | "escalated";
}
```

### Build Mode

- **Trigger**: Default invocation (`zizou "<prompt>"`)
- **Behavior**: Single step execution
  1. Synthesize a single `PlanStep` from the raw user prompt
  2. Execute it via `executeStep()`
  3. Verify it via `verifyStep()`
  4. Check `shouldEscalate()` — if triggered, surface a prompt to the user
- **No clarifier or planner call**
- **Escalation possible**: If verification fails or too many files touched

### Plan Mode

- **Trigger**: `--plan` flag (`zizou plan "<prompt>"`)
- **Behavior**: Full pipeline
  1. Run clarifier to gather questions
  2. Present questions to user, collect answers
  3. Run planner to generate structured plan
  4. Display full plan for user review (Y/n gate)
  5. For each step in `dependsOn` order:
     - Capture pre-snapshot
     - Execute step
     - Verify step
     - Record result
  6. Report completion
- **No escalation**: Plan mode steps are pre-scoped by the plan

### Mode Resolution

```typescript
export function resolveMode(args: { planFlag: boolean }): ModeContext {
  return { mode: args.planFlag ? "plan" : "build", reason: "user-flag" };
}
```

No LLM call involved — pure flag check.

---

## Verification System

**Location**: `src/agent/verifier.ts`

The verifier independently checks filesystem state against the executor's claims. It never trusts the model's self-report alone.

### Verification Result

```typescript
export interface VerificationResult {
  verified: boolean;
  mismatches: string[];
}
```

### Verification Process

1. **Capture pre-snapshot**: Record filesystem state (mtime/hash) of target files before execution
2. **Execute step**: Executor runs and returns `StepResult` with `claimedFiles`
3. **Capture post-snapshot**: Record filesystem state after execution
4. **Compare**: Check if claimed files actually changed and no unexpected files were modified

### Mismatch Types

- `"claimed-changed-but-unchanged: src/foo.ts"`: Executor claimed to change a file, but it didn't change
- `"changed-but-not-claimed: src/bar.ts"`: A file changed that the executor didn't claim

---

## Escalation Logic

**Location**: `src/agent/orchestrator.ts`

Escalation is deterministic (non-LLM) and only applies in build mode. It detects when a "simple" request exceeds scope.

### Escalation Triggers

```typescript
export interface EscalationTrigger {
  reason: "verification-failed" | "touched-too-many-files" | "step-implies-dependency";
}
```

### shouldEscalate()

```typescript
const FILE_THRESHOLD = 3;

function shouldEscalate(
  result: StepResult,
  verification: VerificationResult,
): EscalationTrigger | null {
  // Trigger 1: Verification failed
  if (!verification.verified) {
    return { reason: "verification-failed" };
  }

  // Trigger 2: Too many files touched
  if (result.claimedFiles.length > FILE_THRESHOLD) {
    return { reason: "touched-too-many-files" };
  }

  return null;
}
```

### Escalation Behavior

On escalation:
1. Orchestrator stops immediately
2. Surfaces a prompt: *"This touched more than expected — switch to plan mode? [y/n]"*
3. Does NOT auto-switch modes or silently continue
4. If user says yes, re-enter as plan mode FROM SCRATCH (fresh clarifier run, do NOT reuse partial build-mode state)

---

## Debug Logging

**Location**: `src/agent/debug/`

Zizou writes verbose debug logs to `<workspace-root>/zizou-debug.log` on every message.

### Log Sections

| Section | What it contains |
|---------|------------------|
| **Header** | Timestamp, cwd, model ID, message count, prompt size |
| **1 · System Prompt** | Full text of the system prompt sent to the LLM |
| **2 · Section Breakdown** | Which layers are present (BASE / SESSION_CONTEXT / REPO MAP) |
| **3 · Conversation History** | Every message, expanded: role, content type, full content |
| **4 · Tools** | All tools with descriptions, parameter schemas, and how each runs |
| **5 · SDK Call Parameters** | Exact arguments passed to `streamText()` |
| **6 · Live Stream Events** | Appended in real time: STEP-START, TEXT-DELTA, TOOL-CALL, TOOL-RESULT, TOOL-ERROR, STEP-FINISH, FINISH |
| **Final Usage** | Input/output token counts from the provider |

### Live Stream Events

```
[timestamp]  STEP-START     step=1
[timestamp]  TOOL-CALL      ► writeFile  (id=call_abc123)
             INPUT ARGUMENTS:
               {
                 "path": "index.html",
                 "contents": "<!DOCTYPE html>..."
               }
[timestamp]  TOOL-RESULT    ◄ writeFile  (id=call_abc123)
             RESULT OUTPUT:
               {
                 "success": true,
                 "message": "Successfully wrote file to C:\\Users\\Arnv\\ZIZOUv1\\index.html"
               }
[timestamp]  STEP-FINISH    step=1  finishReason="tool-calls"
[timestamp]  TEXT-DELTA     chars=42  fragment="I've created index.html with..."
[timestamp]  FINISH         finishReason="stop"  usage={inputTokens:1200, outputTokens:80}
```

---

## Known Limitations

- **No File Indexing**: Cannot index or search across the entire repository (no tree-sitter integration)
- **No Session Persistence**: Chat history is lost when you exit the CLI
- **No Keychain Storage**: API keys are stored in unencrypted plain text
- **No Cost Tracking**: Token usage and cost tracking are not yet displayed in the UI

---

## Dependencies

### Core Dependencies

```json
{
  "@ai-sdk/anthropic": "^4.0.0",
  "@ai-sdk/google": "^4.0.0",
  "@ai-sdk/groq": "^4.0.0",
  "@ai-sdk/openai": "^4.0.0",
  "ai": "^7.0.0",
  "conf": "^12.0.0",
  "esbuild": "^0.28.1",
  "ink": "^7.1.0",
  "ink-text-input": "^6.0.0",
  "react": "^19.2.7",
  "zod": "^3.24.0"
}
```

### Build System

- **Bun**: Package manager and runtime
- **TypeScript**: Type checking
- **esbuild**: Bundling for distribution

---

## File Structure Summary

```
zizou/
├── src/
│   ├── agent/           # Core AI orchestration
│   │   ├── orchestrator.ts
│   │   ├── run-turn.ts
│   │   ├── clarifier.ts
│   │   ├── planner.ts
│   │   ├── executor.ts
│   │   ├── verifier.ts
│   │   ├── mode.ts
│   │   ├── types.ts
│   │   └── debug/
│   ├── context/         # System prompt & repo map
│   │   ├── build-system-prompt.ts
│   │   └── repo-map.ts
│   ├── sdk/             # Model resolution
│   │   ├── resolve-model.ts
│   │   └── index.ts
│   ├── tools/           # Agent capabilities
│   │   ├── read-file.ts
│   │   ├── write-file.ts
│   │   ├── edit-file.ts
│   │   ├── glob.ts
│   │   ├── grep.ts
│   │   ├── list-dir.ts
│   │   ├── open-file.ts
│   │   ├── run-bash.ts
│   │   ├── run-background.ts
│   │   ├── manage-tasks.ts
│   │   ├── manage-ports.ts
│   │   ├── file-operations.ts
│   │   ├── add-context.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── config/          # Persistent storage
│   │   ├── api-keys.ts
│   │   └── index.ts
│   ├── ui/              # React/Ink terminal interface
│   │   ├── App.tsx
│   │   ├── Chat.tsx
│   │   ├── ApiKeySetup.tsx
│   │   └── Figurine.tsx
│   ├── commands/        # CLI commands
│   └── cli.tsx          # CLI entry point
├── specs/               # Specification documents
├── package.json
├── tsconfig.json
├── build.ts
└── README.md
```

---

## End-to-End Flow

### User Message → Response

```
User types message → Enter
        ↓
Chat.tsx handleSubmit()
  ├─ push to history.current
  ├─ call resolveModel(provider) → LanguageModel
  └─ call runOrchestrator()
        ↓
runOrchestrator()
  ├─ Determine mode (build/plan)
  └─ Route to runBuildMode() or runPlanMode()
        ↓
[Build Mode]
  ├─ Synthesize single PlanStep
  ├─ executeStep() → calls runTurn()
  └─ verifyStep()
        ↓
[Plan Mode]
  ├─ clarify() → LLM call for questions
  ├─ plan() → LLM call for structured plan
  ├─ User approves plan
  └─ For each step (in dependency order):
      ├─ executeStep() → calls runTurn()
      └─ verifyStep()
        ↓
executeStep()
  └─ runTurn()
      ├─ Build tool map
      ├─ streamText({ model, tools, messages })
      └─ Consume stream, yield AgentEvents
        ↓
streamText()
  ├─ HTTP request to provider API
  ├─ Stream response chunks
  ├─ Auto-execute tools
  └─ Re-prompt with tool results
        ↓
Chat.tsx renders AgentEvents
  ├─ text-delta → append to message
  ├─ tool-call → show loading badge
  ├─ tool-result → show completion
  └─ finish → show token usage
        ↓
History updated with responseMessages
Ready for next turn
```

---

## Security Considerations

### API Key Storage

- **Stored in plain text** in OS config directory
- **Environment variables take precedence** (recommended for sensitive keys)
- No encryption at rest

### Command Execution

- **User approval required** for all shell commands via `runBash`
- **Timeout protection**: 120 second timeout for blocking commands
- **Background processes**: Tracked in task registry, can be listed/killed

### File Operations

- **Safe edits**: `editFile` requires exact `old_string` match
- **Path resolution**: All relative paths resolved from workspace root
- **No arbitrary file access**: Tools operate within workspace context

### Rate Limit Protection

- **No automatic retries** on rate limits (prevents token waste)
- **Clear error messages** when rate limit hit
- **User can switch providers** without losing quota

---

## Extension Points

### Adding a New Tool

1. Create file in `src/tools/` (e.g., `my-tool.ts`)
2. Export tool with Zod schema
3. Add export to `src/tools/index.ts`
4. Tool automatically available to agent

### Adding a New Provider

1. Install corresponding `@ai-sdk/*` package
2. Add provider to `ProviderChoice` type in `src/config/api-keys.ts`
3. Add case to `resolveModel()` in `src/sdk/resolve-model.ts`
4. Add default model to `DEFAULT_MODELS`
5. Add env var check in `getApiKey()`

### Adding a New Agent Role

1. Add role to `AgentRole` type in `src/context/build-system-prompt.ts`
2. Update `shouldIncludeRepoMap()` logic if needed
3. Implement role-specific module in `src/agent/`
4. Integrate into orchestrator flow

---

## Performance Considerations

### Streaming

- **Token-by-token rendering** for immediate feedback
- **No waiting for full response** before displaying
- **Reduces perceived latency**

### Context Caching

- **System prompt cached** per session (not rebuilt per turn)
- **Repo map generated once** at startup
- **Pinned files read once** and cached in memory

### Step Budget

- **maxSteps=15** prevents infinite loops
- **Deterministic escalation** catches runaway execution
- **No automatic retries** on rate limits

---

## Testing Strategy

### Unit Testing

- Tool functions: Test with mock filesystem
- Context building: Test with mock directory structure
- Model resolution: Test with mock config

### Integration Testing

- Agent loop: Test with mock LLM responses
- Orchestrator: Test mode routing and escalation
- Verification: Test with real filesystem changes

### Manual Testing

- Build mode: Simple one-file fixes
- Plan mode: Multi-step features
- Escalation: Prompts that exceed FILE_THRESHOLD
- Rate limits: Trigger 429 errors
- Small models: Test fallback parser

---

## Future Work

- **File indexing**: Tree-sitter integration for better symbol extraction
- **Session persistence**: Save/load chat history
- **Keychain storage**: Encrypt API keys at rest
- **Cost tracking**: Display token usage and cost estimates
- **Multi-file edits**: Batch edit operations
- **Git integration**: Commit/branch tools
- **Web search**: External knowledge retrieval
- **MCP support**: Model Context Protocol for external tools
