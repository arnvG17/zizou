// evals/sft/scenarios/shell-fs.ts
//
// BANDS: shell-process and fs-ops.
//
// These cover the tools that field-level mistakes cluster around, and the
// mistakes are specific rather than general:
//
//   managePorts   port must be a NUMBER. `port: "3000"` fails schema
//                 validation, and a string is what a model reaches for
//                 because it just read "3000" out of an error message.
//   manageTasks   taskId is REQUIRED for kill and logs, and must be OMITTED
//                 for list. The action enum is list|kill|logs — "stop" and
//                 "terminate" are the wrong guesses.
//   fileOperations destination is required for copy and move, omitted for
//                 delete and createDirectory.
//
// Conditional-required fields are the hardest thing in the whole tool surface
// for a small model, because the schema alone does not express them — the
// rule lives in the description. So both branches of each conditional appear
// here, adjacent, with the same tool.
//
// runBash records carry `say` text. The system prompt asks for it: "Before
// any shell command: briefly state what it does if non-obvious." This is the
// one place prose before a tool call is correct, and the model needs to see
// where the line is.

import type { Scenario } from "../types.js";
import { baseProject, serviceFile, pick, SERVICE_NAMES } from "../fixtures.js";

export function shellProcessScenarios(): Scenario[] {
  const out: Scenario[] = [];

  // ── runBash: read-only inspection commands ─────────────────────────────
  //
  // Deliberately harmless commands. A training set full of `npm install` and
  // `rm -rf` teaches reaching for the shell; these teach that the shell is
  // for questions the file tools cannot answer.
  const inspections: Array<{ cmd: string; ask: string; say: string }> = [
    { cmd: "node --version", ask: "What Node version is this?", say: "Checking the Node version." },
    { cmd: "git status --short", ask: "What's changed?", say: "Listing the working tree changes." },
    { cmd: "git rev-parse --abbrev-ref HEAD", ask: "What branch am I on?", say: "Reading the current branch name." },
    { cmd: "git log --oneline -5", ask: "Show me the last few commits.", say: "Reading the last five commits." },
  ];
  for (let i = 0; i < 40; i++) {
    const insp = inspections[i % inspections.length]!;
    out.push({
      id: `shell-inspect-${i}`,
      band: "shell-process",
      prompt: insp.ask,
      fixture: baseProject(),
      // Three of these four shell out to git, and a workspace without a repo
      // answers every one of them with "fatal: not a git repository".
      git: true,
      steps: [{ tool: "runBash", args: { command: insp.cmd }, say: insp.say }],
      finalText: `That's the output of \`${insp.cmd}\` for this workspace.`,
    });
  }

  // ── manageTasks: list takes NO taskId ──────────────────────────────────
  for (let i = 0; i < 25; i++) {
    out.push({
      id: `shell-tasks-list-${i}`,
      band: "shell-process",
      prompt: ["What's running in the background?", "Any background tasks?", "List the running tasks."][i % 3]!,
      fixture: baseProject(),
      steps: [{ tool: "manageTasks", args: { action: "list" } }],
      finalText: `No background tasks are running right now.`,
    });
  }

  // ── managePorts: port is a NUMBER ──────────────────────────────────────
  //
  // The request states the port as text ("port 3000"), which is exactly the
  // context in which a model emits "3000" as a string.
  for (let i = 0; i < 30; i++) {
    const port = [3000, 5173, 8080, 4000, 8000, 5000][i % 6]!;
    out.push({
      id: `shell-ports-find-${i}`,
      band: "shell-process",
      prompt: `Something's already listening on port ${port} — what is it?`,
      fixture: baseProject(),
      steps: [{ tool: "managePorts", args: { action: "find", port } }],
      finalText: `Nothing is currently holding port ${port} in this environment.`,
    });
  }

  // ── managePorts: kill, also a number ───────────────────────────────────
  //
  // Nothing is actually listening in a temp workspace, so the kill genuinely
  // fails and the record says so. That is the point of generating against
  // real tools: the alternative was inventing a "port freed" result that
  // never happens, which teaches the model to report success it did not get.
  //
  // The field-level lesson survives intact — `action: "kill"` (not "stop")
  // with `port` as a NUMBER (not "3000") — and a second lesson comes free:
  // when a tool reports nothing to do, say that rather than claiming a fix.
  for (let i = 0; i < 20; i++) {
    const port = [3000, 5173, 8080, 4000][i % 4]!;
    out.push({
      id: `shell-ports-kill-${i}`,
      band: "shell-process",
      prompt: `Free up port ${port}.`,
      fixture: baseProject(),
      steps: [
        { tool: "managePorts", args: { action: "find", port } },
        { tool: "managePorts", args: { action: "kill", port }, expectFailure: true },
      ],
      finalText: `Nothing is listening on port ${port}, so there was nothing to free — it's already available.`,
    });
  }

  // ── runBackground → manageTasks logs → manageTasks kill ────────────────
  //
  // The full lifecycle, and the only place manageTasks gets a real taskId to
  // work with. The command is a bare idle Node process rather than a dev
  // server: generation must not depend on a port being free or on npm
  // resolving, and what the model needs to learn from the record is the
  // SHAPE — spawn returns an id, and that id is what kill and logs require.
  //
  // This is also the conditional-field lesson in its sharpest form. `list`
  // above takes no taskId; `logs` and `kill` here cannot work without one.
  const idleCommand = `node -e "setInterval(() => {}, 1000)"`;
  for (let i = 0; i < 20; i++) {
    out.push({
      id: `shell-background-lifecycle-${i}`,
      band: "shell-process",
      prompt: ["Start a watcher in the background.", "Kick off a long-running process for me.", "Run something in the background and then stop it."][i % 3]!,
      fixture: baseProject(),
      steps: [
        {
          tool: "runBackground",
          args: { command: idleCommand },
          say: "Starting it in the background so it doesn't block.",
        },
        { tool: "manageTasks", args: { action: "list" } },
        // {{taskId}} is replaced with the id runBackground actually returned.
        // Using the real one is the lesson: read the id out of the result,
        // don't invent one.
        { tool: "manageTasks", args: { action: "logs", taskId: "{{taskId}}" } },
        { tool: "manageTasks", args: { action: "kill", taskId: "{{taskId}}" } },
      ],
      finalText: `Started it, checked its output, then stopped it. Background tasks keep running until killed, so the taskId from runBackground is what you need to hold on to.`,
    });
  }

  // ── addFileToContext: pin a file the user will keep referring to ───────
  for (let i = 0; i < 20; i++) {
    const name = pick(SERVICE_NAMES, i);
    const path = `src/services/${name}.ts`;
    out.push({
      id: `shell-pin-context-${i}`,
      band: "shell-process",
      prompt: `We're going to be working on ${path} for a while — keep it handy.`,
      fixture: { ...baseProject(), [path]: serviceFile(name) },
      steps: [{ tool: "addFileToContext", args: { path } }],
      finalText: `Pinned ${path} — it'll stay in context for the rest of the session, so I won't need to re-read it.`,
    });
  }

  // ── runBash for a real question about the tree ─────────────────────────
  for (let i = 0; i < 25; i++) {
    const name = pick(SERVICE_NAMES, i);
    out.push({
      id: `shell-count-${i}`,
      band: "shell-process",
      prompt: `How many TypeScript files are in src?`,
      fixture: { ...baseProject(), [`src/services/${name}.ts`]: serviceFile(name) },
      git: true,
      steps: [
        {
          tool: "runBash",
          args: { command: "git ls-files src | wc -l" },
          say: "Counting tracked files under src.",
        },
      ],
      finalText: `That's the count of tracked files under src.`,
    });
  }

  return out;
}

export function fsOpsScenarios(): Scenario[] {
  const out: Scenario[] = [];

  // ── createDirectory: NO destination ────────────────────────────────────
  for (let i = 0; i < 25; i++) {
    const dir = ["src/utils", "src/lib", "src/adapters", "src/schemas", "src/workers"][i % 5]!;
    out.push({
      id: `fs-mkdir-${i}`,
      band: "fs-ops",
      prompt: `Create a ${dir} folder.`,
      fixture: baseProject(),
      steps: [{ tool: "fileOperations", args: { action: "createDirectory", source: dir } }],
      finalText: `Created ${dir}.`,
    });
  }

  // ── copy: destination REQUIRED ─────────────────────────────────────────
  for (let i = 0; i < 25; i++) {
    const name = pick(SERVICE_NAMES, i);
    const from = `src/services/${name}.ts`;
    const to = `src/services/${name}-backup.ts`;
    out.push({
      id: `fs-copy-${i}`,
      band: "fs-ops",
      prompt: `Make a backup copy of ${from} before I refactor it.`,
      fixture: { ...baseProject(), [from]: serviceFile(name) },
      steps: [
        { tool: "fileOperations", args: { action: "copy", source: from, destination: to } },
      ],
      finalText: `Copied it to ${to}.`,
    });
  }

  // ── move: destination REQUIRED ─────────────────────────────────────────
  for (let i = 0; i < 20; i++) {
    const name = pick(SERVICE_NAMES, i + 3);
    const from = `src/${name}.ts`;
    const to = `src/services/${name}.ts`;
    out.push({
      id: `fs-move-${i}`,
      band: "fs-ops",
      prompt: `${from} is in the wrong place — it belongs with the other services.`,
      fixture: { ...baseProject(), [from]: serviceFile(name) },
      steps: [
        { tool: "listDir", args: { path: "src" } },
        { tool: "fileOperations", args: { action: "createDirectory", source: "src/services" } },
        { tool: "fileOperations", args: { action: "move", source: from, destination: to } },
      ],
      finalText: `Moved it to ${to}.`,
    });
  }

  // ── delete: NO destination ─────────────────────────────────────────────
  for (let i = 0; i < 15; i++) {
    const name = pick(SERVICE_NAMES, i + 7);
    const path = `src/services/${name}-old.ts`;
    out.push({
      id: `fs-delete-${i}`,
      band: "fs-ops",
      prompt: `Delete ${path}, it's dead code.`,
      fixture: { ...baseProject(), [path]: serviceFile(name) },
      steps: [{ tool: "fileOperations", args: { action: "delete", source: path } }],
      finalText: `Deleted ${path}.`,
    });
  }

  return out;
}
