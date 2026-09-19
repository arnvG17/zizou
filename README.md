# Zizou - AI Coding Agent CLI

Zizou is an open-source, interactive terminal-based AI coding partner built with TypeScript, React (Ink), and the Vercel AI SDK. It allows you to chat with models like Claude 3.5 Sonnet or GPT-4o directly in your terminal, granting the AI the ability to read files, write code, and execute shell commands—all safely managed by your explicit approval.

---

## Getting Started

You can launch and use Zizou using NPM or Docker. On the first run, the CLI will present a setup screen asking you to select a provider and input your API key.

> [!NOTE]
> **Developing or building from source?** If you want to contribute, run evals, or build Zizou locally, please refer to the developer-focused [CONTRIBUTING.md](file:///c:/Users/Arnv/ZIZOUv1/CONTRIBUTING.md).

### Option 1: Using NPM (Recommended)
You can download and install Zizou globally via NPM (requires Node.js):
```bash
npm install -g zizou-ai
```
Once installed, launch the CLI from any directory by running:
```bash
zizou
```

### Option 2: Using Docker
You can run Zizou inside an isolated Docker container without installing local dependencies:
```bash
docker run -it arnv17/zizou:latest
```

---

## Core Features

- **Auto Mode (default):** Zizou reads your prompt and picks how to handle it — conversation, a read-only answer, a single edit, or a reviewed multi-step plan. You do not pick the mode; you can still pin one.
- **Safe Code Modification:** The AI can read and write files, but every modification requires your review and approval.
- **Controlled Command Execution:** The AI can execute bash/powershell commands, prompting you for permission before running them.
- **Git-Independent Version Control:** Zizou tracks file modifications in an internal checkpoint database. You can diff and revert AI edits without polluting your git history.
- **Parallel Chat Sessions:** Switch between different tasks or topics without losing context.

---

## Operating Modes

Zizou has one pinned mode and four execution routes. The default pin is **Auto**,
which classifies each prompt with one small, fast model call and runs the route
it picks. The badge shows both — `Auto → Build` — so you can see what it chose.

| Route | What it does | Tools |
| --- | --- | --- |
| `◇ Auto` | Reads the prompt, picks one of the four below | — |
| `○ Chat` | Greetings and small talk | None when pinned; read-only via Auto |
| `? Ask` | Answers questions about your codebase | Read-only — never writes |
| `● Build` | One concrete change, executed and verified | Full |
| `◆ Plan` | Multi-file work: plan → review → execute → verify | Full, after approval |

Pin one with `/auto`, `/chat`, `/ask`, `/build`, `/plan`, or the matching CLI
flag. **The classification call happens only in Auto mode** — pin any other
mode and no router call is made.

The router is treated as a guess: low-confidence answers resolve toward the
cheaper mistake, a routed plan still stops at the review gate, and if the
provider is slow or down the turn continues on a deterministic fallback rather
than failing.

### The Plan Gate

Before any step runs, Zizou shows the plan, its assumptions, and every file each
step will touch — marked `+` for new and `~` for existing. That is where "it is
about to create `game.html` at the repo root" becomes visible *before* approval.

The gate takes `y` to run, `n` to cancel, `b` to run it as a single build step,
`a` to just answer — and **anything else as a correction**. Typing
`put it in src/games/, not the root` revises the plan in place instead of making
you retype the request.

### Where Files Go

New files go beside the files of their kind that already exist; the workspace
root is for files that belong at a root by convention. Before creating a file,
the agent searches for the one that already does that job — editing it is
almost always what was meant. A `## Layout` section in your `ZIZOU.md`
overrides both; run `/init` for a template.

---

## Slash Commands

Zizou supports several built-in slash commands you can type into the chat input to manage the agent:

- **/auto, /chat, /ask, /build, /plan**: Pin an operating mode (see above). `/auto` is the default.
- **/effort `<fast|balanced|max>`**: One dial for speed vs quality — sets the model, sampling and tool-round cap together. Shorthands: `/fast`, `/balanced`, `/max`.
- **/keys**: Opens the interactive setup screen to switch AI providers and enter/update your API keys.
- **/model `<provider> [name]`**: Switch the active provider, optionally pinning a model.
- **/models**: Lists every available model option for all providers.
- **/add `<filepath>`**: Pins a file's contents permanently to context. Type `@` for fuzzy file search.
- **/init**: Creates a `ZIZOU.md` for project settings, layout conventions and coding standards.
- **/session**: Manages parallel chat sessions (`/session list`, `/session switch <name>`, `/session new`).
- **/checkpoint**: Rollback, branch, diff, and revert tools for AI changes (see details below).
- **/undo, /redo**: Step back and forward through the last steps' file changes.
- **/export**: Exports the conversation transcript to markdown.
- **/permissions**: Views or clears session-cached file and command permissions.
- **/help**: Shows available commands, the active mode, effort and model.
- **/exit**: Closes the Zizou CLI.

---

## Checkpoint & Session Management (`/checkpoint`)

Zizou records your file state automatically after each successful verification step. This gives you a safe "undo/redo" system for AI modifications that works independently of your Git history.

### Subcommands & Flags

- **/checkpoint list**: Lists all checkpoints created in the active session, sorted by step index and timestamp.
- **/checkpoint diff**: Displays a detailed **line-by-line diff** of local uncommitted changes in your workspace since the last checkpoint.
  - Diff outputs use **green highlights** for added lines (`+`) and **red highlights** for deleted lines (`-`).
  - To prevent terminal clutter, newly created files are truncated to show only their **top 10 lines**.
- **/checkpoint diff session**: Shows all changes made during the **entire session** (from the start of the session/branch to the current workspace state).
- **/checkpoint diff --full** or **-f**: Can be appended to any diff command (e.g., `/checkpoint diff session --full`) to expand and view the entire content of truncated files.
- **/checkpoint diff <id>**: Displays the line-by-line colored diff for a specific checkpoint compared to its parent.
- **/checkpoint diff <from> <to>**: Performs a content comparison between two checkpoints and shows the difference.
- **/checkpoint restore <id>**: Reconstructs and restores the workspace to the exact state at the specified checkpoint.
- **/checkpoint revert**: Reverts all local uncommitted changes in the workspace back to the head checkpoint.
- **/checkpoint revert session**: Reverts the entire workspace back to the initial state **before the session began** (deleting files created in the session and restoring modified/deleted files to their starting states).
- **/checkpoint branch <name> [from-checkpoint-id]**: Creates a new branch from a checkpoint (defaults to current head).
- **/checkpoint switch <branch>**: Switches the active branch, restoring the workspace to its head checkpoint.
- **/checkpoint delete <id>**: Deletes a specific checkpoint (protected from deleting branch heads and roots).

---

## LLM Compatibility & Connection

Zizou is provider-agnostic and supports:

- **Anthropic**: High-quality reasoning (Claude 3.5 Sonnet).
- **OpenAI**: GPT-4o capabilities.
- **Groq**: Fast inference for Llama 3 models.
- **Google**: Gemini capabilities.
- **OpenRouter**: Access to a massive ecosystem of models.
- **Ollama**: Free, local execution (runs models locally via `http://localhost:11434/v1`).

To connect to any provider, run `/keys` inside the CLI or set environment variables before launching:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-proj-..."
export OPENROUTER_API_KEY="sk-or-..."
export GEMINI_API_KEY="AIza..."
export GROQ_API_KEY="gsk_..."
export OLLAMA_BASE_URL="http://localhost:11434" # optional
```

---

## Security & API Key Storage

**🚨 IMPORTANT:** API keys entered via the setup screen are stored in **plain text** within a JSON file in your OS's configuration directory (e.g., `~/.config/zizou-nodejs/config.json`). They are **NOT encrypted**.

To avoid writing keys to disk, provide them via environment variables instead, which will always take precedence over configuration files.

---

## Known Limitations
- **No Semantic Code Index:** Zizou has no tree-sitter symbol index. It finds code with `glob`, `grep` and `readFile` rather than from a pre-computed map, which is accurate but costs tool calls on large repos.
- **No Keychain Storage:** API keys are stored in unencrypted plain text (see above).
- **Auto Mode Adds Latency:** The routing call costs roughly 0.5–4s before the turn starts, depending on the provider. Pin a mode to skip it.
- **The Router Can Be Wrong:** It is a classifier, not an oracle. A wrong route is visible in the badge, and a routed plan is correctable at the gate before anything runs.
