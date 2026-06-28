# Zizou Context & LLM Payload Reference

> **What does the LLM actually receive? Where does each piece of information come from?**
> This document is the authoritative answer. Read it alongside `zizou-debug.log`
> which is written fresh on every message you send.

---

## Overview — The Four Inputs to Every LLM Call

Every time you press Enter in Zizou, `streamText()` (Vercel AI SDK) is called with exactly **four inputs**:

| Input | Key | Where it comes from |
|---|---|---|
| System prompt | `system` | `buildSystemPrompt()` in `src/context/` |
| Conversation history | `messages` | `history` ref in `Chat.tsx` |
| Tool definitions | `tools` | `src/tools/*.ts`, registered in `run-turn.ts` |
| Safety cap | `stopWhen` | `stepCountIs(15)` hardcoded in `run-turn.ts` |

The API request body sent to the provider (Groq / Anthropic / OpenAI / etc.) looks like:

```json
{
  "model": "llama-3.3-70b-versatile",
  "system": "You are Zizou...\n\n--- SESSION CONTEXT ---\n...",
  "messages": [
    { "role": "user",      "content": "write an index.html file..." },
    { "role": "assistant", "content": [{"type":"tool-call",...}] },
    { "role": "tool",      "content": [{"type":"tool-result",...}] }
  ],
  "tools": [
    { "name": "readFile",  "description": "...", "parameters": {...} },
    { "name": "writeFile", "description": "...", "parameters": {...} },
    ...
  ]
}
```

---

## 1. System Prompt — How It's Built

**File**: [`src/context/build-system-prompt.ts`](src/context/build-system-prompt.ts)  
**Called once**: at app start in `Chat.tsx` `useEffect`. Cached in `systemPromptRef.current` for the whole session.

The final system prompt is assembled in three layers, concatenated in order:

```
BASE_INSTRUCTIONS  (static string, hardcoded)
      +
SESSION_CONTEXT    (dynamic, injected at runtime)
      +
REPO MAP           (dynamic, scanned from disk at startup)
```

### Layer 1 — BASE_INSTRUCTIONS
Static text telling the agent:
- Its identity ("You are Zizou, an AI coding agent…")
- How to use each tool (`writeFile` for new files, `editFile` for targeted edits)
- When **not** to use tools (general knowledge questions)
- The critical rule about clean tool name formatting (prevents LLaMA tool-call corruption)

### Layer 2 — SESSION_CONTEXT
Injected dynamically at `buildSystemPrompt(projectRoot)` call time.

Contains:
- **Workspace root path** (`process.cwd()`) — so the LLM knows where it is
- **Path resolution rule** — relative paths resolve from workspace root
- **TOOL GUIDE** — a human-readable description of every tool, when to use each one, and what it returns

This is the key section that tells the LLM: *"You are operating in `/Users/Arnv/ZIZOUv1` — all file paths are relative to here."*

### Layer 3 — REPO MAP
**File**: [`src/context/repo-map.ts`](src/context/repo-map.ts)  
**Function**: `buildRepoMap(projectRoot)`

This walks your entire project directory (excluding `node_modules`, `.git`, `dist`, `build`, `.next`) using `readdirSync` and extracts:
- Function names (`function foo(` / `const foo = (` / `async function foo`)
- Class names (`class Foo`)
- Interface names (`interface Foo`)
- Type aliases (`type Foo =`)
- Export statements

Each symbol is recorded as `filename:lineNumber: symbolSignature`.

The result is injected as:
```
--- REPO MAP ---
src/agent/run-turn.ts:84: export async function* runTurn(
src/tools/read-file.ts:37: export const readFile = tool({
...
--- END REPO MAP ---
```

**Why**: This gives the LLM a structural overview of your codebase before it makes any tool calls. Without it, the LLM would have to explore blindly with `glob`/`readFile` to understand what exists.

**Limitation**: Regex-based extraction — may miss symbols defined as `const foo = tool({...})` patterns. The agent is told to use `glob`/`grep` to verify when in doubt.

---

## 2. Conversation History — How It Grows

**Managed in**: `Chat.tsx` → `history` ref (`useRef<ModelMessage[]>([])`)

The history array grows with every turn. Each element is a `ModelMessage`:

### Message Types in the History Array

#### `{ role: "user", content: string }`
Your raw text input. Added immediately when you press Enter, before the API call.

#### `{ role: "assistant", content: ContentPart[] }`
The LLM's response. Can contain a mix of:
- `{ type: "text", text: "..." }` — plain text tokens
- `{ type: "tool-call", toolCallId, toolName, input }` — a tool invocation request

#### `{ role: "tool", content: ToolResultPart[] }`
Injected **by the SDK** after `execute()` completes. Contains:
- `{ type: "tool-result", toolCallId, result: {...} }` — the return value of `execute()`

The SDK auto-appends tool-result messages mid-turn (before the LLM sees them) to close the tool-call loop. At the end of the turn, `result.responseMessages` is awaited and **manually appended** to `history.current` (line 421 of `run-turn.ts`).

> **Important**: If this manual append is missing, the LLM has no memory of previous turns.

### Example — History After "write a calculator"

```
[0] user      "write an index.html file with a working calculator"
[1] assistant [tool-call: listDir({path: "."})]
[2] tool      [tool-result: {success: true, entries: [...]}]
[3] assistant [tool-call: writeFile({path: "index.html", contents: "..."})]
[4] tool      [tool-result: {success: true, message: "Written to C:\...\index.html"}]
[5] assistant [text: "I've created index.html with a working calculator..."]
```

On your **next** message, all 6 messages above are sent alongside it.

---

## 3. Tools — How They're Passed to the LLM

**Registration**: `src/agent/run-turn.ts` — inside `streamText({ tools: {...} })`  
**Definitions**: `src/tools/*.ts` — each exported via `src/tools/index.ts`

### How Tool Schemas Are Transmitted

The Vercel AI SDK converts each tool's `inputSchema` (Zod schema) into a **JSON Schema** object. This is sent in the `tools` array of the API request. The LLM receives:

```json
{
  "name": "writeFile",
  "description": "Create a new file or completely overwrite...",
  "parameters": {
    "type": "object",
    "properties": {
      "path":     { "type": "string", "description": "Path to the file..." },
      "contents": { "type": "string", "description": "The complete string content..." }
    },
    "required": ["path", "contents"]
  }
}
```

**The LLM does not see `execute()`** — it only sees the name, description, and parameter schema.

### Tool Call Lifecycle (one round trip)

```
1. LLM outputs:   {"type": "tool-call", "toolName": "writeFile", "input": {...}}
2. SDK intercepts: calls writeFile.execute({path, contents}) locally
3. execute() runs: path.resolve(cwd, path) → mkdirSync → writeFileSync
4. execute() returns: {success: true, message: "Written to ..."}
5. SDK injects:    {"role":"tool","content":[{"type":"tool-result","result":{...}}]}
6. SDK re-prompts: sends the full updated history back to the LLM
7. LLM continues:  reads the tool-result and decides what to do next
```

Steps 2–7 happen **automatically** inside `streamText()` for each tool call, up to `maxSteps=15` rounds.

### All Registered Tools

| Tool | Input Schema | What `execute()` does |
|---|---|---|
| `readFile` | `path: string` | `readFileSync(path, "utf-8")` |
| `writeFile` | `path, contents` | `resolve(cwd, path)` → `mkdirSync` → `writeFileSync` |
| `editFile` | `path, old_string, new_string` | Read → count occurrences → replace exactly 1 → write |
| `glob` | `pattern: string` | `readdirSync` walk, regex match filenames, cap 50 results |
| `grep` | `query: string` | Walk files, `indexOf` search inside contents |
| `listDir` | `path?: string` | `readdirSync + statSync` on resolved dir, skip node_modules |
| `openFile` | `path: string` | `spawn("start"/"open"/"xdg-open", [absPath])` detached |
| `runBash` | `command: string` | ConfirmFn → user y/n → `exec(command, {timeout: 15s})` |

---

## 4. The `stopWhen` Safety Cap

`stopWhen: stepCountIs(15)` in `run-turn.ts`.

Each "step" is one complete round trip:
```
LLM generates → [possible tool calls run] → LLM re-prompted with results
```

After 15 such steps, `streamText()` stops, returns what it has, and the generator ends. This prevents infinite loops where a confused model keeps calling tools indefinitely.

---

## 5. Debug Log — Reading `zizou-debug.log`

Written to `<workspace-root>/zizou-debug.log` on **every message**. Sections:

| Section | What it contains |
|---|---|
| **Header** | Timestamp, cwd, model ID, message count, prompt size |
| **1 · System Prompt** | Full text of the system prompt sent to the LLM |
| **2 · Section Breakdown** | Which layers are present (BASE / SESSION_CONTEXT / REPO MAP) |
| **3 · Conversation History** | Every message, expanded: role, content type, full content |
| **4 · Tools** | All 8 tools with descriptions, parameter schemas, and how each runs |
| **5 · SDK Call Parameters** | Exact arguments passed to `streamText()` |
| **6 · Live Stream Events** | Appended in real time: STEP-START, TEXT-DELTA, TOOL-CALL, TOOL-RESULT, TOOL-ERROR, STEP-FINISH, FINISH |
| **Final Usage** | Input/output token counts from the provider |

### Reading Live Stream Events

```
[timestamp]  STEP-START     step=1
             All tool-calls below belong to step 1 until STEP-FINISH.

[timestamp]  TOOL-CALL      ► writeFile  (id=call_abc123)
             INPUT ARGUMENTS:
               {
                 "path": "index.html",
                 "contents": "<!DOCTYPE html>..."
               }

[timestamp]  TOOL-RESULT    ◄ writeFile  (id=call_abc123)
             execute() finished. Result injected as a tool-result message.
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

## 6. Context Retrieval Flow — End to End

```
User types message → Enter
        ↓
Chat.tsx handleSubmit()
  ├─ push to history.current
  ├─ call resolveModel(provider)  →  LanguageModel from @ai-sdk/*
  └─ call runTurn({ history, model, systemPrompt, onConfirm })
        ↓
run-turn.ts runTurn()
  ├─ [WRITE] zizou-debug.log sections 1–5
  └─ streamText({ system, messages: history, tools, stopWhen: stepCountIs(15) })
        ↓
  [API REQUEST sent to provider]
        ↓ (streaming response)
  for await (part of result.fullStream)
    ├─ text-delta      → yield AgentEvent → Chat.tsx renders token
    ├─ tool-call       → [APPEND] debug log → yield AgentEvent (shows ■ tool)
    │     ↓ SDK auto-calls execute()
    │   execute() runs locally
    │     ↓
    └─ tool-result     → [APPEND] debug log → yield AgentEvent (shows ✓ done)
                         SDK injects tool-result message into conversation
                         LLM re-prompted with full updated context
        ↓ (repeat up to 15 steps)
  [APPEND] "Turn ended" + final token usage to debug log
        ↓
  yield turn-complete + finish events
        ↓
  await result.responseMessages
  return [...history, ...responseMessages]  ← new history saved to ref
        ↓
Chat.tsx stores new history → ready for next turn
```
