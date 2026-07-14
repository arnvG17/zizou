# ══════════════════════════════════════════════════════════════════════════════
#  zizou_demo.tape
#
#  Cinematic VHS terminal demo for Zizou — the open-source AI coding agent CLI.
#  Tuned to the actual Zizou TUI:
#    • Animated footballer splash screen (Figurine.tsx)
#    • Two-column layout: chat log (left) + sidebar token/session info (right)
#    • Coloured tool-call log rows (read-file, glob, edit-file, run-bash …)
#    • Orchestrator pipeline: clarify → plan display → step-progress → verify
#    • Y/n approval for file writes and shell commands
#    • /checkpoint diff  — green/red coloured line-by-line diff
#
#  Suitable for: X / LinkedIn / Product Hunt / README hero GIF
#
#  Prerequisites:
#    brew install vhs
#    npm install -g zizou-ai           # or: bun install -g zizou-ai
#    bash demo/setup-sample-repo.sh    # creates ~/demos/zizou-sample-repo
# ══════════════════════════════════════════════════════════════════════════════

# ─── Output ───────────────────────────────────────────────────────────────────
Output zizou_demo.gif
Output zizou_demo.mp4
Output zizou_demo.webm

# ─── Canvas ───────────────────────────────────────────────────────────────────
Set Shell "zsh"
Set FontSize 22
Set Width 1280
Set Height 720
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 48ms
Set Framerate 60

# ══════════════════════════════════════════════════════════════════════════════
# PART 0 — Hidden setup (never visible to viewer)
# ══════════════════════════════════════════════════════════════════════════════

Hide
Type "cd ~/demos/zizou-sample-repo && clear"
Enter
Sleep 400ms

# Pre-warm: make sure git is clean for the demo
Type "git checkout . && git clean -fd -q 2>/dev/null; clear"
Enter
Sleep 600ms
Show

# ══════════════════════════════════════════════════════════════════════════════
# PART 1 — Orient the viewer: show the repo before anything runs
# ══════════════════════════════════════════════════════════════════════════════

Type "pwd"
Enter
Sleep 700ms

Type "ls"
Enter
Sleep 1200ms

Type "cat package.json"
Enter
Sleep 1800ms

Type "git log --oneline -5"
Enter
Sleep 1200ms

Type "git status"
Enter
Sleep 1500ms

# ══════════════════════════════════════════════════════════════════════════════
# PART 2 — Launch Zizou
# (Viewer sees: animated footballer splash + ZIZOU block-pixel wordmark
#  + welcome bar with provider/model/cwd)
# ══════════════════════════════════════════════════════════════════════════════

Type "clear"
Enter
Sleep 300ms

Type "zizou"
Enter

# ── Splash screen is now animating ──────────────────────────────────────────
# Let the footballer run across the screen and the wordmark fade in
Sleep 2500ms

# ── Two-column TUI loads; sidebar shows session / token stats ───────────────
Sleep 1500ms

# ══════════════════════════════════════════════════════════════════════════════
# PART 3 — Natural-language task
# ══════════════════════════════════════════════════════════════════════════════

# Viewer now sees the pill-style input box with provider badge.
# We type slowly so the audience can read every word.
Type "Add JWT authentication to the Express API — middleware that validates tokens on protected routes, a POST /auth/login endpoint, and refresh token support. Don't break existing tests."
Enter

# ── Clarification phase (orchestrator asks a question) ──────────────────────
# Zizou renders a clarification card with numbered questions
Sleep 3000ms

# Answer the clarification: use the existing user model
Type "Use the existing User model in models/user.js. Store refresh tokens in Redis if it's already configured, otherwise in-memory is fine."
Enter

# ─── Repo-map + context scan ────────────────────────────────────────────────
# Tool-call rows light up: glob → list-dir → read-file (x3)
Sleep 2500ms
Sleep 2000ms
Sleep 2000ms
Sleep 1800ms
Sleep 1800ms

# ─── Plan display ───────────────────────────────────────────────────────────
# Zizou renders the structured plan with numbered steps and Y/n prompt
Sleep 3500ms

# Viewer reads the plan — pause long enough for them to absorb all steps
Sleep 4000ms

# Approve the plan
Type "y"
Enter

# ══════════════════════════════════════════════════════════════════════════════
# PART 4 — Execution  (step-progress rows + tool-call rows)
# ══════════════════════════════════════════════════════════════════════════════

# Step 1/4 — Install jsonwebtoken + bcryptjs
Sleep 2000ms
# run-bash: npm install jsonwebtoken bcryptjs  → Y/n prompt
Type "y"
Enter
Sleep 4500ms

# Step 2/4 — Write src/middleware/auth.js
Sleep 2500ms
# write-file prompt → Y/n
Type "y"
Enter
Sleep 2000ms

# Step 3/4 — Write src/routes/auth.js (login + refresh endpoints)
Sleep 2500ms
# write-file prompt → Y/n
Type "y"
Enter
Sleep 2000ms

# Step 4/4 — Wire middleware into server.js
Sleep 2000ms
# edit-file prompt (patch) → Y/n
Type "y"
Enter
Sleep 2000ms

# ── Verification phase ───────────────────────────────────────────────────────
# run-bash: npm test
Sleep 2000ms
Type "y"
Enter
# Tests run — let output scroll
Sleep 6000ms

# ── Orchestrator summary ─────────────────────────────────────────────────────
# Zizou prints a verification card: all 4 steps verified
Sleep 2500ms

# ══════════════════════════════════════════════════════════════════════════════
# PART 5 — Post-task: inspect what changed
# ══════════════════════════════════════════════════════════════════════════════

Type "/checkpoint diff"
Enter
# Green/red coloured line-by-line diff renders in the chat log
Sleep 4500ms

# ══════════════════════════════════════════════════════════════════════════════
# PART 6 — Exit Zizou, verify in the shell
# ══════════════════════════════════════════════════════════════════════════════

Type "/exit"
Enter
Sleep 800ms

Type "git diff --stat"
Enter
Sleep 2500ms

Type "npm test"
Enter
Sleep 6000ms

Type "git status"
Enter
Sleep 2000ms

# ── Final frame: clean terminal with all tests green ─────────────────────────
Sleep 3000ms
