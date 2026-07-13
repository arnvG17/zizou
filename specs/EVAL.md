# EVAL.md — What the Eval Tests Actually Do

This is a plain-language explanation of the eval suite — what it checks, why each test exists, and how to read the results. For the technical build spec, see `ADD_EVAL_HARNESS.md`. This doc is for understanding what's actually being tested, not for building it.

## Why this exists

Before this, testing Zizou meant typing something like "make a todo app," watching what happened, and deciding if it looked okay. That doesn't catch anything reliably — every real bug found so far (tool calls silently failing, plans running off the rails after a failure, files landing in the wrong place) was only found by manually reading a debug log after the fact, not by testing catching it.

The eval suite replaces "does it look right" with "did it actually do the thing" — checked by code, automatically, every time.

## The core idea

Each test is called a **golden task**. A golden task is three things:
1. **A prompt** — something you'd actually type into Zizou, like "add a login form" or "create a chess game."
2. **A check** — a small piece of code that looks at the result and answers a yes/no question, like "does `index.html` actually exist at the path the plan said it would?"
3. **A clean slate** — every task runs in a brand-new, empty temporary folder, never inside the real Zizou project. This matters because a few of the demo files sitting in the project already (the tic-tac-toe, chess, and todo test files) got there exactly because tasks were run inside the real project folder before — the eval suite is built specifically to never repeat that.

No LLM ever judges whether a test passed. It's always a hard, mechanical check: a file exists or it doesn't, a command exits cleanly or it doesn't, a pattern is found in a file or it isn't.

## The tests, one by one

**`build-single-file-fix`**
What it does: asks for a small, single-file change in build mode — the simplest possible request.
What it checks: did the file actually get edited.
Why it exists: this is the fastest possible sanity check. If this one fails, something fundamental broke (like tool-calling not firing at all) — the kind of bug that made "hi" or a simple edit silently do nothing in earlier sessions.

**`plan-mode-dependency-ordering`**
What it does: asks for a small feature made of a few files where one file depends on another (e.g. a component that imports a hook that has to exist first).
What it checks: did the files get created in the right order, with the dependent file created after the thing it depends on.
Why it exists: the planner is responsible for figuring out step order. If this breaks, you'd see something like a file trying to import something that doesn't exist yet.

**`plan-mode-deliberate-failure`**
What it does: asks for something rigged to fail partway through — one step is designed to not work.
What it checks: does the whole plan stop and ask what to do, instead of quietly continuing to the next steps as if nothing went wrong.
Why it exists: this is a direct test for the bug where a chess-game plan kept executing steps 2 and 3 even after step 1 had already failed — building on top of a foundation that was never actually there.

**`ambiguous-prompt-clarifier`**
What it does: asks something genuinely vague, on purpose (not enough detail to plan from).
What it checks: does the clarifier actually ask something useful back, instead of crashing or guessing silently.
Why it exists: lowest-confidence test of the group — it's hard to automatically judge whether a *question* is a *good* question. This one just confirms the clarifier engages instead of skipping straight to a bad guess.

**`plan-mode-nested-directory-structure`**
What it does: asks for a small multi-file app that needs files inside a subfolder (like a `css/` and `js/` folder next to an `index.html`).
What it checks: do the files end up at the *exact* paths the plan said they would — not just "somewhere reasonable."
Why it exists: a real session showed the plan saying files would live at the project root, while the executor (reasonably, but differently) nested them inside subfolders instead. The files existed — just not where anything expected them to be, so the check failed even though the app itself was fine. This test exists to catch that exact mismatch happening again.

## How a run actually works

Every task gets its own throwaway folder. Zizou runs against that folder like it would against a real project. Once the check runs (pass or fail), that folder either gets deleted (if it passed) or kept around (if it failed, so you can go look at what actually got built). Your real project folder is never touched by any of this.

## What "pass" means

A pass means the check function returned true — a specific, concrete thing was verified to be true on disk. It does not mean "the code looks reasonable" or "an AI reviewed it and approved." If a task's check is "does `chess-game/index.html` exist," then either it exists or the task fails — there's no partial credit and no judgment call.

## Flaky tests and pass rate

Since Zizou is powered by an LLM, the exact same prompt can behave slightly differently between runs. For tasks where that's expected, the suite can run the same task multiple times (e.g. 5 times) and report a pass rate — "4 out of 5" — instead of a single pass/fail. A dropping pass rate over time is a real signal even if it's never a clean 0% or 100%.

## When to run it

Run the full suite before making a change, and again after. The comparison between the two is the actual answer to "did this fix work" — not rereading a debug log and deciding it looks better.
