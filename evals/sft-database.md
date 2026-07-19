# Zizou Executor — SFT Data Generation Prompt

> **Purpose**: Feed this entire document to a data-generation LLM (e.g. GPT-4o, Claude 3.7).
> All `<paste ...>` placeholders from the original template are replaced with real Zizou data.
> Output: N JSON objects saved to `evals/sft-dataset.json`.

---

## Objective

You are generating supervised fine-tuning data for a small (3-4 B) LLM whose only job is:

> Given ONE scoped execution step + minimal file context, emit **EXACTLY ONE** correctly-formatted
> native tool call using the schema below.

The executor **never plans**, **never asks clarifying questions**, **never emits prose**.
When it cannot act, it emits a structured cannot-proceed signal (see section 5).

---

## Section 1 — Real Tool Schemas

Exact Zod-derived JSON Schema objects. Do NOT invent fields outside these definitions.

### readFile
Required: `path: string`

### writeFile
Required: `path: string`, `contents: string`

### editFile
Required: `path: string`, `old_string: string`, `new_string: string`
CRITICAL: old_string must appear EXACTLY ONCE in the file. Fails with error if 0 or 2+ occurrences.

### glob
Required: `pattern: string`
Example patterns: `"*.ts"`, `"**/*.tsx"`, `"**/app.css"`

### grep
Required: `pattern: string`
Optional: `fileGlob: string` (e.g. `"*.ts"`, `"*.tsx"`)

### listDir
Optional: `path: string` (defaults to project root if omitted)

### openFile
Required: `path: string`

### addFileToContext
Required: `path: string`

### runBash
Required: `command: string`
Blocking. 120s timeout. Use for short-lived commands (npm install, tsc, etc.)

### runBackground
Required: `command: string`
Non-blocking. Returns taskId. Use for dev servers, watchers.

### manageTasks
Required: `action: "list" | "kill" | "logs"`
Conditionally required: `taskId: string` — REQUIRED when action is "kill" or "logs", OMIT for "list"

### managePorts
Required: `action: "find" | "kill"`, `port: number`
CRITICAL: port must be a NUMBER (e.g. 3000), not a string (e.g. "3000")

### fileOperations
Required: `action: "delete" | "createDirectory" | "copy" | "move"`, `source: string`
Conditionally required: `destination: string` — REQUIRED for "copy" and "move", OMIT otherwise

---

## Section 2 — Real Executor System Prompt

Assembled by `src/context/build-system-prompt.ts` at runtime:

```
You are Zizou, an AI coding agent running inside a terminal UI (built with Ink/React).
Your only job right now is to execute ONE scoped step from a plan.

--- SESSION CONTEXT ---
Workspace root: /Users/Arnv/ZIZOUv1
Path resolution rule: always use paths relative to the workspace root.

--- TOOL GUIDE ---

FILE READING
  readFile(path)
    Returns { success: true, contents: string } or { success: false, error: string }
    Use this before editFile to verify exact whitespace in old_string.

FILE WRITING
  writeFile(path, contents)
    Creates a new file or overwrites an existing one entirely.
    Use for NEW files or when the full file is short enough to rewrite safely.
    NEVER use to partially update a file — use editFile instead.

FILE EDITING
  editFile(path, old_string, new_string)
    Replaces EXACTLY ONE occurrence of old_string with new_string.
    Fails if old_string appears 0 times ("not found") or more than 1 time ("not unique").
    Include enough surrounding context in old_string to make it unique.
    File uses LF line endings. Match whitespace exactly.

EXPLORATION
  glob(pattern)             Find files by name pattern. Cap: 50 results.
  grep(pattern, fileGlob?)  Search file contents by regex. Cap: 50 results.
  listDir(path?)            List immediate children of one directory.

PROCESS MANAGEMENT
  runBash(command)          Blocking shell. 120s timeout, 1 MB output.
  runBackground(command)    Non-blocking. Returns taskId. Use for dev servers.
  manageTasks(action, taskId?)
    action: "list" | "kill" | "logs"
    taskId required for "kill" and "logs", omit for "list"
  managePorts(action, port)
    action: "find" | "kill"  — port is a NUMBER — resolves EADDRINUSE errors

FILE SYSTEM (no shell)
  fileOperations(action, source, destination?)
    action: "delete" | "createDirectory" | "copy" | "move"
    destination required only for "copy" and "move"

UTILITY
  openFile(path)          Open file with OS default app. Fire-and-forget.
  addFileToContext(path)  Pin a file's contents into the context window.

--- EXECUTION RULES ---
1. Call exactly ONE tool per response. No prose before or after the tool call.
2. For editFile: read the file first if not 100% certain of exact whitespace.
3. For manageTasks kill/logs: taskId is REQUIRED.
4. For managePorts: port must be a NUMBER not a string.
5. If you cannot proceed, emit the cannot-proceed signal instead of guessing.

--- REPO MAP (excerpt) ---
src/agent/executor.ts:128:  export async function executeStep(
src/agent/run-turn.ts:209:  export async function* runTurn(
src/agent/types.ts:32:      export interface PlanStep {
src/tools/index.ts:14:      export { readFile } from "./read-file.js";
src/tools/edit-file.ts:25:  export const createEditFileTool = ...
src/tools/write-file.ts:18: export const createWriteFileTool = ...
src/tools/run-bash.ts:42:   export const createRunBashTool = ...
src/tools/manage-tasks.ts:5: export const manageTasks = tool({
src/tools/manage-ports.ts:103: export const managePorts = tool({
src/tools/file-operations.ts:18: export const createFileOperationsTool = ...
```

---

## Section 3 — Step Input Shape

Every `step_input` must match the `PlanStep` interface from `src/agent/types.ts`:

```typescript
interface PlanStep {
  index:       number;    // zero-based position in the plan array
  description: string;    // human-readable description of what this step does
  targetFiles: string[];  // files this step expects to create or modify
  dependsOn:   number[];  // indices of steps that must complete first (empty = no deps)
}
```

The executor receives one step at a time with a fresh, isolated context window.
It has **no memory** of previous steps beyond what is in `file_context`.

---

## Section 4 — Output Record Schema

Generate N = 30 examples. Each example is a JSON object:

```json
{
  "_meta": {
    "id": "sft-NNN",
    "category": "straightforward | multi-field | cannot-proceed | recovery | near-miss-negative",
    "tool": "toolName or null"
  },
  "step_input": {
    "index": 0,
    "description": "human-readable description",
    "targetFiles": ["src/path/to/file.ts"],
    "dependsOn": []
  },
  "file_context": "// realistic minimal snippet, 5-15 lines",
  "correct_tool_call": {
    "toolName": "toolName",
    "input": { "exactFieldsMatchingSchema": "values" }
  },
  "reasoning_note": "1 line internal annotation — NOT part of training target"
}
```

For **near-miss-negative** examples, also include:
```json
{
  "incorrect_tool_call": {
    "toolName": "toolName",
    "input": { "wrongFields": "values" },
    "_why_wrong": "explanation of the specific mistake"
  }
}
```

For **cannot-proceed** examples, `correct_tool_call` uses the shape in Section 5.

---

## Section 5 — Cannot-Proceed Signal (Real Format)

When the executor cannot take any valid action, emit this structured object
instead of a tool call. This is the agreed no-op format:

```json
{
  "toolName": null,
  "signal": "cannot-proceed",
  "reason": "One sentence explaining exactly why no tool call is valid.",
  "suggested_clarification": "One sentence the orchestrator can show the user."
}
```

Trigger conditions:
- Target file does not exist and cannot be inferred from repo structure
- old_string cannot be constructed because the step is underspecified
- Step references a resource (taskId, port process) that provably does not exist
- Step is ambiguous between two or more incompatible tool calls

---

## Section 6 — Real Pseudo-Call Malformed Patterns

From `src/agent/run-turn.ts` lines 100-153. These are the two classes of malformed
output observed from small/quantized models. Use them for near-miss-negative examples.

### CLASS 1 — function pseudo-tags (observed from llama-3.3-70b via Groq)

Three delimiter variants between the function name and the JSON blob:

```
<function/runBash({"command": "npm install chess.js"})</function>
<function/writeFile>{"path": "index.html", "contents": "..."}</function>
<function/runBash{"command": "npm install chess.js"}></function>
```

The fallback parser in extractRawToolCall() catches these at runtime, but
training data must show only the correct native function-calling format.

### CLASS 2 — Raw JSON block

```json
{"name": "writeFile", "arguments": {"path": "...", "contents": "..."}}
```

Wrong because: correct native format uses "toolName" not "name", and args
go directly under "input" not under "arguments".

### Field-level near-misses observed in practice

| Tool | Wrong field names | Correct field names |
|---|---|---|
| writeFile | filePath, content | path, contents |
| editFile | file, oldString, newString | path, old_string, new_string |
| managePorts | port: "3000" (string) | port: 3000 (number) |
| manageTasks | action: "stop" | action: "kill" |
| fileOperations | target, dest | source, destination |

---

## Section 7 — Real Execution Traces

Ground your examples in these 8 real traces from session logs and context.md.

### Trace A — Simple file creation (build mode)
```
[user]      "write an index.html file with a working calculator"
[assistant] TOOL CALL: listDir({ "path": "." })
[tool]      { success: true, entries: [{name:"src",type:"dir"}, {name:"package.json",type:"file"}, ...] }
[assistant] TOOL CALL: writeFile({ "path": "index.html", "contents": "<!DOCTYPE html>..." })
[tool]      { success: true, message: "Successfully wrote file to /Users/Arnv/ZIZOUv1/index.html" }
[assistant] TEXT: "I've created index.html with a working calculator..."
```

### Trace B — Edit with prior read (plan mode executor step)
```
STEP: "Add error boundary to src/ui/Chat.tsx"

TOOL CALL: readFile({ "path": "src/ui/Chat.tsx" })
RESULT:    { "success": true, "contents": "import React from 'react';\nimport { Box } from 'ink';\n\nexport default function Chat() {\n..." }

TOOL CALL: editFile({
  "path": "src/ui/Chat.tsx",
  "old_string": "export default function Chat() {",
  "new_string": "class ErrorBoundary extends React.Component {\n  render() { return this.props.children; }\n}\n\nexport default function Chat() {"
})
RESULT: { "success": true, "message": "Successfully replaced 1 occurrence in .../Chat.tsx" }
```

### Trace C — editFile failure, recovery via readFile
```
TOOL CALL: editFile({
  "path": "src/agent/executor.ts",
  "old_string": "maxSteps: 15",
  "new_string": "maxSteps: 20"
})
RESULT: { "success": false, "error": "The exact string appeared 2 times in the file. You must provide a unique string to replace." }

CORRECT NEXT CALL: readFile({ "path": "src/agent/executor.ts" })
```

### Trace D — EADDRINUSE, recovery via managePorts
```
TOOL CALL: runBackground({ "command": "npm run dev" })
RESULT: { "success": false, "error": "listen EADDRINUSE: address already in use :::3000" }

CORRECT NEXT CALL: managePorts({ "action": "find", "port": 3000 })
```

### Trace E — manageTasks kill with taskId
```
TOOL CALL: runBackground({ "command": "bun run --hot src/cli.tsx" })
RESULT: { "success": true, "taskId": "bg_x7f2k9", "pid": 14822 }

TOOL CALL: manageTasks({ "action": "kill", "taskId": "bg_x7f2k9" })
RESULT: { "success": true, "message": "Successfully terminated background task bg_x7f2k9." }
```

### Trace F — FALLBACK PSEUDO-CALL (malformed — near-miss reference)
```
[FALLBACK PSEUDO-CALL PARSED — not a native tool call]
  Tool Name: writeFile
  How Sent:  Parsed from raw text via fallback pseudo-call parser
  Arguments: { "path": "hello.txt", "contents": "Hello, World!" }

Raw model output was:
  <function/writeFile>{"path":"hello.txt","contents":"Hello, World!"}</function>

Correct native format would be:
  toolName: "writeFile", input: { "path": "hello.txt", "contents": "Hello, World!" }
```

### Trace G — listDir exploration before writeFile
```
STEP: "Create a new tool file src/tools/format-code.ts"

TOOL CALL: listDir({ "path": "src/tools" })
RESULT: { "success": true, "entries": [
  {"name":"read-file.ts","type":"file"},
  {"name":"write-file.ts","type":"file"},
  {"name":"edit-file.ts","type":"file"},
  {"name":"glob.ts","type":"file"},
  {"name":"grep.ts","type":"file"},
  {"name":"index.ts","type":"file"}
]}

TOOL CALL: writeFile({
  "path": "src/tools/format-code.ts",
  "contents": "import { z } from 'zod';\nimport { tool } from 'ai';\n\nexport const formatCode = tool({\n  description: 'Format a code string using prettier',\n  inputSchema: z.object({ code: z.string(), parser: z.string().optional() }),\n  execute: async ({ code, parser }) => { return { success: true, formatted: code }; }\n});\n"
})
```

### Trace H — grep to find usages before refactor
```
STEP: "Search for all imports of PlanStep before renaming the interface"

TOOL CALL: grep({ "pattern": "PlanStep", "fileGlob": "*.ts" })
RESULT: { "success": true, "matches": [
  "src/agent/types.ts:32:export interface PlanStep {",
  "src/agent/executor.ts:40:import type { PlanStep, StepResult, ToolCall, ProjectContext }",
  "src/agent/planner.ts:8:import type { PlanStep } from './types.js';",
  "src/agent/orchestrator.ts:12:import type { PlanStep } from './types.js';"
]}
```

---

## Section 8 — Distribution Requirements

Generate exactly 30 examples with this distribution:

| Category | Count | Tools / scenarios to cover |
|---|---|---|
| Straightforward (40%) | 12 | readFile, writeFile, editFile, glob, grep, listDir, runBash, runBackground, manageTasks (list), fileOperations (createDirectory), openFile, addFileToContext |
| Multi-field / nested (20%) | 6 | editFile (multi-line old_string with leading whitespace), manageTasks (kill + taskId), managePorts (enum + number port), fileOperations (copy with destination), grep (pattern + fileGlob), writeFile (multi-line contents with escaped newlines) |
| Cannot-Proceed (15%) | 4-5 | Missing target file, underspecified old_string, empty task registry for kill, ambiguous step between two tools |
| Recovery (15%) | 4-5 | editFile "not found" to readFile, editFile "not unique" to writeFile rewrite, EADDRINUSE to managePorts find, denied writeFile to runBash cat, crashed task to manageTasks logs |
| Near-Miss Negatives (10%) | 3 | function pseudo-tag CLASS 1, raw name+arguments JSON block CLASS 2, wrong field names (filePath/content, port-as-string, action "stop") |

Realism constraints:
- File paths must be realistic for a TypeScript / Bun / Ink codebase (.ts, .tsx, .json, .md)
- Directory structure must match: src/agent/, src/tools/, src/config/, src/ui/, src/context/, src/session/, evals/, docs/, frontend/
- dependsOn indices must be logically consistent (step 2 can depend on [0,1] but not [3])
- file_context must be a minimal realistic snippet (5-15 lines), not a full file
- Do NOT invent tools outside the 13 schemas in Section 1

---

## Section 9 — Per-Example Validation Checklist

Before finalizing each example, verify:

- [ ] All required fields for the chosen tool are present in input
- [ ] No extra fields outside the schema are present in input
- [ ] port is a number (not "3000") when using managePorts
- [ ] taskId is present when manageTasks action is "kill" or "logs"
- [ ] destination is present when fileOperations action is "copy" or "move"
- [ ] old_string in editFile appears exactly once in the provided file_context
- [ ] step_input.index is consistent with dependsOn (no self-reference, no forward reference)
- [ ] file_context is a plausible snippet consistent with the step_input description
- [ ] reasoning_note is one line and is internal-only (not in training target)

---

## Section 10 — Winners & Losers

This section defines the **training signal boundary**: exactly what the fine-tuned executor must produce (winners) versus what it must never produce (losers). Use these pairs when writing or reviewing examples.

---

### 10.1 — Tool-Call Format

| # | ✅ WINNER | ❌ LOSER |
|---|---|---|
| W1 | Native function-call: `toolName: "writeFile", input: { path: "...", contents: "..." }` | Raw JSON block: `{"name": "writeFile", "arguments": {...}}` |
| W2 | Native function-call with correct field names | Pseudo-tag: `<function/writeFile>{"path":"..."}</function>` |
| W3 | Single tool call, no surrounding prose | Prose explanation followed by tool call, or prose instead of tool call |

**Winner statement**: The model emits exactly one native tool call per response — correct `toolName`, correct fields inside `input`, zero surrounding text.

**Loser statement**: The model wraps the call in any non-native format (raw JSON, function pseudo-tags, plain text description of what it "would" call), or emits multiple tool calls in one response.

---

### 10.2 — Field Names & Types

| # | ✅ WINNER | ❌ LOSER |
|---|---|---|
| W4 | `writeFile` with `path` + `contents` | `writeFile` with `filePath` or `content` |
| W5 | `editFile` with `path`, `old_string`, `new_string` | `editFile` with `file`, `oldString`, `newString` |
| W6 | `managePorts` with `port: 3000` (number) | `managePorts` with `port: "3000"` (string) |
| W7 | `manageTasks` with `action: "kill"` | `manageTasks` with `action: "stop"` or `action: "terminate"` |
| W8 | `fileOperations` with `source` + `destination` (copy/move) | `fileOperations` with `target` + `dest` |

**Winner statement**: Every field name and type exactly matches the Zod schema in Section 1. No aliases, no camelCase variants, no stringified numbers.

**Loser statement**: The model uses intuitive but wrong field names (filePath, oldString, dest) or wrong value types (port as a string), causing runtime schema validation failure.

---

### 10.3 — editFile Precondition

| # | ✅ WINNER | ❌ LOSER |
|---|---|---|
| W9 | `readFile` → verify exact whitespace → `editFile` with confirmed `old_string` | `editFile` directly with a guessed `old_string` |
| W10 | `old_string` scoped to a unique, minimal window of text | `old_string` too short (e.g. a single common keyword), matching 2+ places |

**Winner statement**: The executor always reads before editing. `old_string` is taken verbatim from the file contents and is unique within the file.

**Loser statement**: The executor guesses `old_string` from the step description alone, producing a "not found" or "not unique" error that wastes a turn.

---

### 10.4 — Clarifying Questions

| # | ✅ WINNER | ❌ LOSER |
|---|---|---|
| W11 | Acts on a clear step immediately with a tool call | Asks a clarifying question when the step is unambiguous |
| W12 | Emits `cannot-proceed` signal (Section 5) when genuinely blocked | Asks the user for more info in plain prose |

**Winner statement**: The executor never asks clarifying questions. When blocked, it emits the structured `cannot-proceed` signal so the orchestrator can surface it to the user cleanly.

**Loser statement**: The executor responds with "Could you please clarify…" or any prose question — this breaks the executor contract, inflates latency, and confuses the orchestrator loop.

---

### 10.5 — Cannot-Proceed Signal

| # | ✅ WINNER | ❌ LOSER |
|---|---|---|
| W13 | `{ "toolName": null, "signal": "cannot-proceed", "reason": "...", "suggested_clarification": "..." }` | `{ "toolName": null, "error": "missing file" }` (wrong shape) |
| W14 | `reason` is one sentence, specific and actionable | `reason` is vague ("something is wrong") or multi-paragraph |

**Winner statement**: When the executor cannot act, it emits the exact cannot-proceed shape from Section 5 — `toolName: null`, `signal: "cannot-proceed"`, a single-sentence `reason`, and a single-sentence `suggested_clarification`.

**Loser statement**: The executor emits a different error shape, omits required fields, or writes a multi-line prose explanation — the orchestrator cannot parse any of these as a structured signal.

---

### 10.6 — Summary Table

| Dimension | Winner | Loser |
|---|---|---|
| Format | Native function call | Raw JSON / pseudo-tag / prose |
| Field names | Exact schema names | Aliases (filePath, oldString, dest…) |
| Field types | Correct (port = number) | Wrong (port = "3000") |
| editFile precondition | readFile first | Guess old_string |
| Ambiguity | cannot-proceed signal | Prose clarifying question |
| Response length | One tool call, no surrounding text | Tool call + explanation, or explanation only |
