# Zizou - AI Coding Agent CLI

Zizou is an open-source AI coding agent CLI tool built with TypeScript, React (Ink), and the Vercel AI SDK. It allows you to chat with Claude 3.5 Sonnet or GPT-4o directly in your terminal, and grants the AI the ability to read files, edit files (safely), and run sandboxed terminal commands with your explicit approval.

## Installation

Ensure you have [Bun](https://bun.sh) installed.

```bash
# Clone the repository
git clone https://github.com/arnvG17/zizou.git
cd zizou

# Install dependencies
bun install
```

## Running Zizou

You can run Zizou directly using Bun:
```bash
bun run src/cli.tsx
```
*(On first run, the CLI will present a setup screen asking you to select a provider and input an API key).*

## File Structure & Layering

The codebase strictly adheres to a layered architecture. Higher layers may import from lower layers, but never vice-versa:

1. **`ui/`** (`App.tsx`, `Chat.tsx`, `ApiKeySetup.tsx`)
   - The React/Ink terminal interface. Responsible *only* for rendering state and handling user input.
2. **`agent/`** (`run-turn.ts`)
   - The core AI loop. Uses `streamText` to communicate with the model, execute tools, and yield incremental events (text deltas, tool calls) back to the UI.
3. **`provider/`** (`resolve-model.ts`)
   - Responsible for instantiating the correct `LanguageModel` via `@ai-sdk/anthropic` or `@ai-sdk/openai`, dynamically injecting API keys.
4. **`tools/`** (`read-file.ts`, `edit-file.ts`, `run-bash.ts`, etc.)
   - Pure functions that define the capabilities of the agent. They return deterministic JSON payloads (never throwing errors). `runBash` strictly relies on an injected `ConfirmFn` callback to ask the user for permission.
5. **`config/`** (`api-keys.ts`)
   - The base layer handling persistent local storage using `conf`.

## Security & API Key Storage

**🚨 IMPORTANT:** API keys entered via the initial setup screen are stored in **plain text** within a JSON file in your OS's default configuration directory (e.g., `~/.config/zizou/config.json`). They are **NOT encrypted**.

To avoid writing your key to disk entirely, you can provide it via environment variables instead, which will always take precedence:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
# or
export OPENAI_API_KEY="sk-proj-..."
```

## Known Limitations (Future Work)
- **No File Indexing:** Zizou currently cannot index or search across the entire repository (no tree-sitter integration).
- **No Session Persistence:** Chat history is lost when you exit the CLI.
- **No Keychain Storage:** API keys are stored in unencrypted plain text.
- **No Cost Tracking:** Token usage and cost tracking are not yet displayed in the UI.
