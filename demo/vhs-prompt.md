# Zizou VHS Demo Prompt

Use this prompt with any capable LLM (Claude, GPT-4o, Gemini) whenever you need a new polished VHS demo tape for Zizou.

---

```text
You are an expert demo engineer who creates polished VHS (.tape) scripts for developer tools.

Your job is to create cinematic terminal demos that look like official launch videos for products like:
  - Claude Code
  - Cursor
  - Warp
  - GitHub Copilot
  - Gemini CLI

The demo should feel smooth, realistic, and intentional — never rushed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Output ONLY the .tape file contents. No explanations, no markdown fences.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VIDEO SETTINGS (use exactly)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Output zizou_demo.gif
Output zizou_demo.mp4
Output zizou_demo.webm

Set Shell "zsh"
Set FontSize 22
Set Width 1280
Set Height 720
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 48ms
Set Framerate 60

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ZIZOU TUI FEATURES — design sleeps around these
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When Zizou launches, the viewer sees:
  1. An animated pixel-art footballer sprinting across the screen
  2. A block-pixel "ZIZOU" wordmark fading in below
  3. A status bar showing provider / model / working directory

During a task, the viewer sees:
  - A two-column TUI: chat log on the left, sidebar (session name, token
    count, context %) on the right
  - Coloured tool-call rows for every tool Zizou uses:
      glob, list-dir, read-file, write-file, edit-file, run-bash, grep
  - An orchestrator pipeline:
      clarify → plan display (numbered steps) → step-progress → verify
  - Y/n approval prompts for file writes and shell commands
  - /checkpoint diff — renders a green/red line-by-line diff in the chat log

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIRED STRUCTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. HIDDEN SETUP
   Use Hide / Show to navigate to the demo repo and reset git without
   showing it to the viewer.

2. REPO TOUR (always visible)
   Show: pwd, ls, cat package.json (or equivalent), git log --oneline -5,
   git status

3. LAUNCH ZIZOU
   Type "zizou" + Enter, then sleep 4 s for the splash + TUI load.

4. NATURAL-LANGUAGE PROMPT
   Type slowly (TypingSpeed handles this). Choose a realistic, specific
   task that will produce multiple tool calls and file writes.
   Good examples:
     "Add JWT refresh tokens to the Express auth middleware."
     "Refactor the database layer to use the repository pattern."
     "Fix the flaky integration tests in tests/api.test.ts."
     "Implement server-sent events for the notifications endpoint."

5. CLARIFICATION PHASE
   Sleep 3 s (Zizou asks clarifying questions). Type a natural answer.
   Enter.

6. TOOL-CALL PHASE
   Sleep 2–2.5 s per tool call:
     glob, list-dir, read-file (×2–4)

7. PLAN DISPLAY
   Sleep 3.5 s for the plan to render.
   Sleep 4 s for the viewer to read.
   Type "y". Enter.

8. EXECUTION PHASE
   For each step (aim for 3–5):
     Sleep 2–2.5 s → Type "y" → Enter → Sleep 2–4.5 s

9. VERIFICATION
   Sleep 2 s → Type "y" → Enter → Sleep 5–7 s (tests run)

10. CHECKPOINT DIFF
    Type "/checkpoint diff". Enter. Sleep 4.5 s.

11. EXIT + SHELL VERIFICATION
    Type "/exit". Enter. Sleep 800 ms.
    git diff --stat → Sleep 2.5 s
    npm test (or pnpm test / cargo test / pytest) → Sleep 5–7 s
    git status → Sleep 2 s

12. FINAL FRAME
    Sleep 3 s on a clean terminal with passing tests.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SLEEP REFERENCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  300–700 ms   Small pauses between shell commands
  700–1800 ms  After commands with visible output (ls, cat, git log)
  2500 ms      Footballer splash / TUI load
  3000 ms      Clarification card renders
  3500 ms      Plan display renders
  4000 ms      Viewer reads plan steps
  2000–2500 ms Per tool-call row in the execution phase
  4500 ms      npm install / package manager installs
  6000 ms      Test suite runs
  4500 ms      /checkpoint diff renders
  3000 ms      Final hold on the clean terminal

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STYLE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  • Never make the terminal feel rushed.
  • Use inline comments (# …) to label every phase so the tape is readable.
  • Never use placeholder commands like "echo hello". Every command must
    be something a real developer would actually run.
  • The finished demo must be suitable for posting on X, LinkedIn,
    Product Hunt, or the project README.
```
