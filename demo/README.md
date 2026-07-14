# Zizou Demo

This directory contains everything needed to record the official Zizou product demo.

## Files

| File | Purpose |
|---|---|
| `zizou_demo.tape` | VHS tape — the cinematic terminal recording script |
| `setup-sample-repo.sh` | Creates a clean Express.js sample repo for the demo |
| `vhs-prompt.md` | Reusable LLM prompt for generating new VHS tapes |

---

## Quick Start

```bash
# 1. Install VHS (macOS/Linux)
brew install vhs

# 2. Install Zizou globally
npm install -g zizou-ai

# 3. Create the sample repo
bash demo/setup-sample-repo.sh

# 4. Set your API key (Zizou uses this during the demo)
export ANTHROPIC_API_KEY="sk-ant-..."

# 5. Record
cd demo
vhs zizou_demo.tape
```

Outputs: `zizou_demo.gif`, `zizou_demo.mp4`, `zizou_demo.webm`

---

## Pacing Reference

The tape is structured around what the viewer actually sees in Zizou's TUI:

| Phase | What the viewer sees | Sleep |
|---|---|---|
| Repo tour | `pwd`, `ls`, `cat package.json`, `git log` | 0.7–1.8 s |
| Splash | Animated footballer + block ZIZOU wordmark | 4 s |
| Typing prompt | Slow character-by-character input | 48 ms/char |
| Clarification card | Numbered questions from the orchestrator | 3 s |
| Tool-call rows | glob → list-dir → read-file (×3) | 2 s each |
| Plan display | Numbered steps with Y/n prompt | 3.5 + 4 s |
| Step execution | write-file / edit-file approval × 4 | 2–2.5 s each |
| Test run | `npm test` scrolling output | 6 s |
| `/checkpoint diff` | Green/red coloured diff in chat log | 4.5 s |
| Shell verification | `git diff --stat`, `npm test` | 2.5 + 6 s |

---

## Tips for a Great Recording

1. **Terminal font**: Use a Nerd Font or JetBrains Mono so Zizou's box-drawing characters render correctly.
2. **Screen size**: 1280×720 matches the tape settings — don't resize during recording.
3. **API key**: Use Anthropic (Claude) for the demo — fastest and most reliable tool-call formatting.
4. **Dry run first**: Run the tape once with a short `Sleep 500ms` at the end to check timing before the full render.
5. **Checkpoint state**: The `Hide` block resets the repo on every run — you can re-record without any manual cleanup.
