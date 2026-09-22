# How the Router Works — Plain English

A readable explanation of what happens when you type something into Zizou.

For the implementation details — constants, function signatures, failure tables — see [008-auto-mode-and-routing.md](./008-auto-mode-and-routing.md). This document is the one to read first.

---

## The one-sentence version

**Zizou reads your message, works out what kind of thing you asked for, and picks one of four ways to handle it.**

That's auto mode. It's the default, and you don't have to do anything to use it.

---

## The four ways it can handle you

Think of them as four different people sitting at the keyboard.

| | Who | What they do | Can they change your files? |
|---|---|---|---|
| `○` | **Chat** | Talks to you | No |
| `?` | **Ask** | Reads your code and answers | No — reading only |
| `●` | **Build** | Does the thing you asked | Yes |
| `◆` | **Plan** | Writes a plan, shows it to you, then does it | Yes, after you say go |

The badge in the corner tells you which one you got, like `Auto → Build`.

---

## How it decides

It asks two questions, in order.

### Question 1: Are you asking, or telling?

**Asking** → Chat or Ask. **Telling** → Build or Plan.

```
"hey"                              →  asking (sort of)     →  Chat
"how does the login work?"         →  asking               →  Ask
"fix the typo"                     →  telling              →  Build
"build me a chess game"            →  telling              →  Plan
```

The catch is that **grammar lies.** People phrase instructions as questions all the time:

```
"can you add a dark mode toggle?"   →  looks like a question, IS an instruction  →  Build
"should I be using useEffect here?" →  looks like a question, IS a question      →  Ask
```

So it goes by what you *want*, not by whether there's a question mark.

A short command counts as telling, even a two-word one:

```
"open it"      →  Build
"run it"       →  Build
"try it"       →  Build
```

### Question 2 (if you're telling): how big, and how clear?

This is the part that used to be wrong, so it's worth dwelling on.

There are **two** reasons to write a plan first, not one.

**Reason A — it's big.** Several files, several steps, and the order matters.

```
"add dark mode to the settings page, the header, and the theme provider"
"migrate us from express to fastify"
"refactor auth into separate services"
```

Do these in the wrong order and you redo work. So: Plan.

**Reason B — it's vague.** You asked for something *new* and didn't say what it should do. Even if it's one file.

```
"create a new todoapp.html"
"make me a scraper"
"build a dashboard"
```

"A todo app" sounds specific until you try to build one. Does it save between refreshes? Can you edit a task, or only add and delete? Is there a "completed" filter? What does it look like?

**You didn't say. Somebody has to decide.** If it goes straight to Build, the agent decides all of it silently and you find out by reading 200 lines of finished HTML. If it goes to Plan, you get:

```
Assumptions — say what to change, or n to cancel:
  • Plain HTML/CSS/JS, no framework
  • Tasks saved to localStorage
  • Add, complete and delete — no editing
```

and you can type `no framework is right but I want editing too` before a single line is written.

**Everything else is Build.** Small *and* clear:

```
"fix the typo in the README"          →  nothing left open
"add a --verbose flag to the CLI"     →  nothing left open
"rename parseConfig to loadConfig"    →  nothing left open
```

### "Small" and "clear" are not the same thing

This is the whole point of Reason B, and the trap the router originally fell into.

| Prompt | Size | Specified? | Route |
|---|---|---|---|
| `create hello.txt containing exactly: hi` | one file | **yes** — you said the contents | Build |
| `create a new todoapp.html` | one file | **no** — you named a thing, not its behaviour | Plan |

Same length. Both start with "create". Both make one file. **Different routes**, because one of them leaves a dozen decisions open and the other leaves none.

---

## The full picture

```
your message
     │
     ├── asking? ──┬── just being friendly ──────────────→  ○ Chat
     │             └── wants to understand something ────→  ? Ask
     │
     └── telling? ─┬── big, or several ordered steps ────→  ◆ Plan
                   ├── new thing, behaviour unstated ────→  ◆ Plan
                   └── small and clear ──────────────────→  ● Build
```

---

## Examples, all four routes

### Chat — just talking

```
"hey"                    "thanks!"
"what can you do?"       "what mode am I in?"
```

No tools when you pin `/chat`. If the router *chose* Chat on its own, it keeps read-only tools, so a message like `"hey, is this repo on React 19?"` can actually go and look instead of guessing.

### Ask — questions about your code

```
"how does the checkpoint system work?"
"where do we handle rate limits?"
"why is this test failing?"
"what does resolveAgentConfig do?"
```

Ask can read anything — `readFile`, `glob`, `grep`, `listDir`, and `openFile`. It **cannot write, edit, or run commands.** It quotes what it found as `path:line` so you can check it.

This route exists because those questions used to have nowhere good to go: Chat had no tools and would guess, Build had write tools and might "helpfully" rewrite the file you were asking about.

### Build — do this one thing

```
"fix the typo in the README"       "open it"
"add a --verbose flag"             "run the tests"
"make the button blue"             "install zod"
"write a test for parseConfig"     "now add tests for that"
```

Note that the last four change no code at all. **That doesn't make them questions.** Opening a file, running tests, installing a package — you want them *done*, so they're Build.

Build touching more than 3 files prints a one-line note that Plan mode exists. It doesn't stop or ask — the work is already done.

### Plan — show me first

```
"create a new todoapp.html"                    (vague)
"build me a chess game"                        (vague)
"migrate us from express to fastify"           (big)
"add dark mode across settings and the header" (big)
```

You get the plan, the assumptions, and **every file each step will touch** — marked `+` for new and `~` for existing:

```
Step 1. Create the game board markup
  + apps/chess/index.html   (new)
Step 2. Add move validation
  ~ apps/chess/game.js      (edit)
```

Those markers are there so you can catch *"wait, why is it creating that at the root?"* **before** it happens.

Then:

| You type | What happens |
|---|---|
| `y` | Run it |
| `n` | Cancel — nothing written |
| `b` | Forget the plan, just build it |
| `a` | Forget the plan, just answer me |
| **anything else** | **It's a correction** — re-plans with your note, shows you again |

That last row is the useful one. Type `put it in src/games/, not the root` and you get a fixed plan. You don't have to cancel and retype your request.

---

## When it gets it wrong

It's a classifier. It will be wrong sometimes. Three things soften that:

**1. It leans toward the cheaper mistake.** When it isn't confident, it downgrades:

- Not sure if Plan → does Build. *(A wrong Plan wastes a planning round-trip. A wrong Build is one step you can `/undo`.)*
- Not sure if Chat → does Ask. *(A wrong Chat answers your real question out of thin air. A wrong Ask reads a couple of files it didn't need.)*

**2. Plan always stops at the gate.** A wrong guess about a big job can't run away with your repo — you see the plan first, and `b` bails out to a plain Build.

**3. You can always just tell it.** Pin a mode and the router doesn't run at all:

```
/auto     let it decide (default)
/chat     just talk
/ask      read-only, answer me
/build    single step
/plan     plan first
```

Same as CLI flags: `--auto`, `--chat`, `--ask`, `--build`, `--plan`.

---

## Does it cost anything?

**In auto mode, yes:** one small extra call before your turn starts. It uses the cheap/fast model regardless of your `/effort` setting, because choosing between four labels doesn't need your best model. Figure roughly half a second to four seconds depending on the provider.

**If you pin a mode, no.** The router isn't even loaded. `/build`, `/plan`, `/chat`, `/ask` cost exactly what they always did.

**If it breaks, nothing breaks.** Provider down, request times out, gibberish comes back — it quietly falls back to a simple rule (greeting → Chat, everything else → Build) and your turn carries on. It never fails your prompt and never throws.

---

## How well does it actually work?

Measured against 27 prompts covering all four routes, including the deliberately tricky ones — questions phrased as commands, commands phrased as questions, greetings with a task attached, and the small-but-vague vs small-and-clear pair:

**27 / 27 correct.**

That is a spot check on one provider, not a guarantee. The honest claim is that it handles the common cases and the known-awkward seams; it is still a language model making a judgement call, which is why the gate and the pinned modes exist.

---

## Things that surprise people

**"I said `/chat` and it won't read my file."**
That's on purpose. Pinning `/chat` means *just talk* — it's the one mode with no tools at all. Use `/ask` if you want it to look at your code without changing anything.

**"It routed my one-file request to Plan."**
If you asked it to *create* something and didn't say what it should do, that's deliberate — see Reason B. Press `b` at the gate to build it directly.

**"It went to Build when I wanted to think first."**
Type `/plan` and ask again. Pinning always wins.

**"Why did it route `open it` to Build? It doesn't change any code."**
Because you wanted something *done*, not explained. "Changes no code" doesn't make it a question.

**"Can I stop it mid-run?"**
Press **Esc**. It cancels the actual request, not just the display. Anything already written stays — `/undo` rolls back the last step.
