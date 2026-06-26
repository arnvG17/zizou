# Zizou

An open-source AI coding agent for your terminal. Bring your own API key
(Anthropic or OpenAI). Built with Bun, the Vercel AI SDK, and Ink.

## Setup

```bash
bun install
bun run src/cli.tsx
```

On first run, Zizou will ask you to choose a provider and paste in your
API key. It's saved locally in plaintext at your OS config directory
(printed by `getConfigPath()` in `src/config.ts`) — this is the same
storage tier most CLI tools start with, NOT an encrypted vault. Don't
commit or share that file. A future version should move this to the
OS keychain (e.g. via the `keytar` package) before calling this
production-secure.

You can also skip the setup screen entirely by exporting an env var
instead:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
bun run src/cli.tsx
```

## Architecture

- `src/config.ts` — API key storage (via the `conf` package)
- `src/provider.ts` — resolves which LLM provider/model to use based on
  saved config. This is the ONLY file that needs to know about
  provider-specific SDK differences (e.g. `createAnthropic` vs
  `createOpenAI` factory functions).
- `src/tools.ts` — the actual agent tools: `read_file`, `edit_file`
  (old_string/new_string matching, NOT line numbers or full rewrites),
  and `run_bash` (gated behind a confirmation callback).
- `src/ui/App.tsx` — root component, decides setup screen vs chat
- `src/ui/ApiKeySetup.tsx` — first-run provider + key entry screen
- `src/ui/Chat.tsx` — the main agent loop, wired to Ink for live
  streaming output. Uses `streamText` + `fullStream` instead of
  `generateText` so text/tool-calls render token-by-token instead of
  all at once.

## Known limitations (intentionally left for you to extend)

- No repo map / codebase indexing yet (see Phase 3/4 of the build plan —
  this version only has grep-free read/edit/bash tools, the model has to
  be told which files to look at)
- API key storage is plaintext, not OS-keychain-backed
- No cost/token tracking shown to the user yet
- `run_bash` has no allowlist — EVERY command prompts for confirmation,
  which is safe but a little tedious; a real v1 should auto-approve
  clearly read-only commands like `ls`, `cat`, `git status`
- Single-turn history only lives in memory — closing Zizou loses the
  conversation; no session persistence/resume yet

## Build a standalone binary (no Bun required to run it)

```bash
bun build src/cli.tsx --compile --outfile zizou-bin
./zizou-bin
```
