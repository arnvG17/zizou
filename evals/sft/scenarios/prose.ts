// evals/sft/scenarios/prose.ts
//
// BANDS: blocked and no-tool-chat — the records with no tool calls.
//
// A dataset where every single example ends in a tool call teaches a model
// that a tool call is always the answer. It is not, and the two cases where
// it is not are different from each other:
//
//   blocked       The request is a real request, but underspecified in a way
//                 that guessing would make worse. The answer is one short
//                 question, and then stopping.
//   no-tool-chat  The request is not a request at all. "What does this repo
//                 do?" wants prose.
//
// WHY THERE IS NO cannot-proceed SIGNAL HERE. specs/010-sft-dataset.md §5
// specifies a structured no-op:
//
//     {"toolName": null, "signal": "cannot-proceed", "reason": "...",
//      "suggested_clarification": "..."}
//
// Nothing in src/ parses that. Not run-turn.ts, not orchestrator.ts, not
// fallback-tool-parse.ts. Training a model to emit it would produce a JSON
// blob rendered to the user as literal text, while the orchestrator waits for
// a turn that never structurally arrives. Plain text is what runTurn already
// handles, so plain text is what these teach.
//
// The system prompt's own rule is the standard being met here: "Act
// immediately on clear requests. Ask only when the intent is genuinely
// ambiguous." So `blocked` scenarios are genuinely ambiguous — not merely
// underspecified in a way a glob would settle. A model that asks instead of
// searching is its own failure mode, and the search-then-act band is the
// counterweight to this one.

import type { Scenario } from "../types.js";
import { baseProject, serviceFile, inkComponent, pick, SERVICE_NAMES, COMPONENT_NAMES } from "../fixtures.js";

export function blockedScenarios(): Scenario[] {
  const out: Scenario[] = [];

  // ── Ambiguous between two existing things ──────────────────────────────
  //
  // Searching cannot settle this: both candidates exist and both fit the
  // request. Only the user knows which was meant.
  for (let i = 0; i < 25; i++) {
    const a = pick(SERVICE_NAMES, i);
    const b = pick(SERVICE_NAMES, i + 6);
    if (a === b) continue;
    out.push({
      id: `blocked-ambiguous-target-${i}`,
      band: "blocked",
      prompt: `Bump the timeout.`,
      fixture: {
        ...baseProject(),
        [`src/services/${a}.ts`]: serviceFile(a),
        [`src/services/${b}.ts`]: serviceFile(b),
      },
      steps: [],
      finalText: `Both ${a} and ${b} have a 5000ms timeout — which one did you mean, and what should it be?`,
    });
  }

  // ── Missing the value the change depends on ────────────────────────────
  for (let i = 0; i < 20; i++) {
    const name = pick(SERVICE_NAMES, i + 2);
    out.push({
      id: `blocked-missing-value-${i}`,
      band: "blocked",
      prompt: `Change the ${name} retry count.`,
      fixture: { ...baseProject(), [`src/services/${name}.ts`]: serviceFile(name) },
      steps: [],
      finalText: `${name} currently retries 3 times — what should it be instead?`,
    });
  }

  // ── A request that names nothing in the repo ───────────────────────────
  const absentThings = [
    "the auth middleware", "the payment webhook", "the admin dashboard",
    "the migration script", "the rate limiter", "the email templates",
    "the websocket handler", "the feature flag service", "the audit log",
    "the onboarding flow", "the billing cron", "the search indexer",
    "the notification worker", "the export pipeline", "the tenant resolver",
  ];
  for (let i = 0; i < absentThings.length; i++) {
    const thing = absentThings[i]!;
    out.push({
      id: `blocked-no-such-thing-${i}`,
      band: "blocked",
      prompt: `Fix the bug in ${thing}.`,
      fixture: baseProject(),
      steps: [
        { tool: "glob", args: { pattern: "src/**/*.ts" } },
        { tool: "listDir", args: { path: "src" } },
      ],
      // Searched first, THEN asked. The question is earned by the search —
      // asking before looking is the failure this record is shaped against.
      finalText: `I don't see anything matching ${thing} in this repo — src has cli.tsx and a ui folder, nothing else. Can you point me at the file, or describe what the bug looks like?`,
    });
  }

  return out;
}

export function noToolChatScenarios(): Scenario[] {
  const out: Scenario[] = [];

  // ── Questions about the conversation, not the code ─────────────────────
  //
  // The system prompt is explicit: "For general questions / conversation —
  // answer directly, no tool calls."
  const general: Array<{ q: string; a: string }> = [
    {
      q: "What's the difference between editFile and writeFile?",
      a: "editFile replaces one exact string inside a file, leaving everything else untouched — it needs the old text verbatim, whitespace included. writeFile replaces the whole file. Use editFile for changes to existing files and writeFile for new ones, or when a file is short enough that rewriting it entirely is safer than matching a string.",
    },
    {
      q: "Why do you read a file before editing it?",
      a: "Because editFile matches an exact string, including indentation. Guessing what the text looks like usually produces a near-miss that fails, which costs a turn and tells you nothing you couldn't have learned by reading it first.",
    },
    {
      q: "thanks!",
      a: "Anytime — shout if you want anything else changed.",
    },
    {
      q: "hey",
      a: "Hey. What are we working on?",
    },
    {
      q: "What does 'not unique' mean when an edit fails?",
      a: "It means the text you asked to replace appears more than once in the file, so replacing it would be ambiguous. Either include more surrounding lines to pin down the one you want, or pass near_line with the line number nearest your intended match.",
    },
    {
      q: "Can you run arbitrary shell commands?",
      a: "Yes, through runBash, but it asks for your confirmation first and has a 120-second timeout. For long-running things like a dev server, runBackground is the right tool — it returns a task id you can use to read logs or kill it later.",
    },
    {
      q: "What's near_line for?",
      a: "It disambiguates an edit. When your old_string matches several places, near_line says which one you meant by giving the line number closest to it, and the nearest match wins. It's the alternative to widening old_string until it happens to be unique.",
    },
    {
      q: "How do I stop a background task?",
      a: "manageTasks with action 'kill' and the taskId that runBackground gave you. Action 'list' shows what's running if you've lost the id, and 'logs' reads its output.",
    },
    {
      q: "Why did you ask before running that command?",
      a: "Shell commands, file writes and edits all go through a confirmation gate — they can change or destroy things outside what you asked for, so you get to see the command before it runs. Reads and searches don't ask.",
    },
    {
      q: "Do you remember our earlier conversations?",
      a: "Only within this session. Each session starts fresh, though sessions are saved and you can switch back to one with /session. If there's context you want me to have every time, ZIZOU.md is the place — it's read into my prompt on every run.",
    },
    {
      q: "what's the difference between glob and grep here?",
      a: "glob matches filenames, grep matches file contents. 'Where are the .tsx files' is glob; 'where is this string used' is grep. If you're not sure a file exists at all, glob first — it's cheaper than searching every file's text.",
    },
    {
      q: "Is there a way to undo what you just did?",
      a: "Yes — /undo reverts every file the last request changed, as one unit, and /redo puts it back. /changes shows what was touched with a diff before you decide.",
    },
    {
      q: "can you see my whole codebase?",
      a: "Not upfront. I get the system prompt and whatever's in this conversation, then I find things with glob, grep, listDir and readFile as I need them. If there's a file you want permanently in view, /add pins it.",
    },
    {
      q: "ok cool",
      a: "👍 Let me know what's next.",
    },
    {
      q: "what are you?",
      a: "Zizou — a coding agent that runs in your terminal. I can read and search your code, edit and create files, and run commands, all in this workspace.",
    },
    {
      q: "Why did that edit say 'not found'?",
      a: "The old_string didn't match the file byte for byte — almost always whitespace: a different indent level, spaces where the file has tabs, or a trailing space. Re-reading the file and copying the text exactly fixes it.",
    },
    {
      q: "should I use writeFile or editFile for a small change?",
      a: "editFile. writeFile replaces the entire file, so a small change made with it risks losing anything you didn't reproduce exactly. writeFile is for new files, or for when a file needs rewriting wholesale.",
    },
    {
      q: "how long do commands get to run?",
      a: "runBash gives a command 120 seconds and caps output at 1 MB. Anything longer-lived — a dev server, a watcher — should go through runBackground, which returns immediately with a task id.",
    },
    {
      q: "does it matter if I give you a relative or absolute path?",
      a: "Either works. Relative paths resolve from the workspace root, so src/ui/App.tsx and the full path reach the same file.",
    },
  ];

  // One record per pair. Cycling a short list to hit a record count produces
  // byte-identical records, which cost an epoch and teach nothing — the
  // duplicate check in validate.ts exists because that is what happened here.
  for (const [i, item] of general.entries()) {
    out.push({
      id: `chat-general-${i}`,
      band: "no-tool-chat",
      prompt: item.q,
      fixture: baseProject(),
      steps: [],
      finalText: item.a,
    });
  }

  // ── Explaining code already in the conversation ────────────────────────
  //
  // The file is right there in the prompt. Reading it off disk would be a
  // wasted turn, and on a local model a wasted turn is a large fraction of
  // the whole budget.
  for (let i = 0; i < 24; i++) {
    const name = pick(COMPONENT_NAMES, i);
    const snippet = inkComponent(name).split("\n").slice(0, 14).join("\n");
    out.push({
      id: `chat-explain-snippet-${i}`,
      band: "no-tool-chat",
      prompt: `What does this do?\n\n\`\`\`tsx\n${snippet}\n\`\`\``,
      fixture: baseProject(),
      steps: [],
      finalText: `It's an Ink component that renders a label and a value side by side in a row. The label takes a dimColor that defaults to off, and the value is always bold. It's presentational — no state, no effects, nothing it can fail at.`,
    });
  }

  return out;
}
