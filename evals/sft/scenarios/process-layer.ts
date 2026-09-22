// evals/sft/scenarios/process-layer.ts
//
// BAND: shell-process — the four tools for running things, and knowing which.
//
// WHY THIS FILE EXISTS
//
// buildToolMap() comments the process layer as "the order the model should
// reach for it":
//
//   terminal — a sequence sharing state, or anything that may prompt
//   service  — anything that does not exit (dev servers, watchers)
//   checkUrl — proof that a server actually serves
//
// plus runBash for a command that simply runs and finishes. The dataset
// covered none of the first three, so a model trained without this file
// reaches for the superseded runBackground and never learns that a dev server
// belongs to `service`.
//
// THE LESSON IS TOOL CHOICE, TAUGHT BY CONTRAST. Each tool appears as the
// right answer to a request the others fit badly:
//
//   "what version of node"        -> runBash   (runs, finishes, done)
//   "install then build"          -> terminal  (second command needs the first's cwd)
//   "start the dev server"        -> service   (never exits; needs supervising)
//   "is it actually up?"          -> checkUrl  (started != serving)
//
// SECOND LESSON: conditional-required fields, which the schema alone cannot
// express. `name` is required for every terminal and service action EXCEPT
// `list`. `command` only for send/start. `keys` only for sendKeys. Both
// branches of each conditional appear here, adjacent, on the same tool.
//
// Commands are all `node -e`, deliberately. Every scenario here really runs,
// so the commands must be fast, dependency-free and identical on every
// platform that regenerates the dataset. `npm install` would be realistic and
// would also make a full build take an hour and fail without a network.

import type { Scenario, ScenarioStep } from "../types.js";
import { baseProject, serviceFile, pick, SERVICE_NAMES } from "../fixtures.js";

/** A server that answers on $PORT. Used with autoPort so nothing collides. */
const SERVER_CMD =
  `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)"`;

/** A command that finishes, for `service --exit` (installs, scaffolders). */
const INSTALL_CMD = `node -e "console.log('added 42 packages')"`;

/** Blocks until something is written to stdin. For the sendKeys path. */
const PROMPT_CMD =
  `node -e "process.stdout.write('Overwrite? (y/n) ');process.stdin.once('data',d=>{console.log('got '+d.toString().trim());process.exit(0)})"`;

export function processLayerScenarios(): Scenario[] {
  const out: Scenario[] = [];

  // ══ terminal ═══════════════════════════════════════════════════════════

  // ── create → send → close: the basic shape ────────────────────────────
  for (let i = 0; i < 18; i++) {
    const name = ["build", "api", "web", "test", "tools", "db"][i % 6]!;
    out.push({
      id: `proc-terminal-basic-${i}`,
      band: "shell-process",
      prompt: `Open a terminal called ${name} and check the node version in it.`,
      fixture: baseProject(),
      steps: [
        { tool: "terminal", args: { action: "create", name } },
        {
          tool: "terminal",
          args: { action: "send", name, command: `node -e "console.log(process.version)"` },
          say: "Checking the Node version.",
        },
        { tool: "terminal", args: { action: "close", name } },
      ],
      finalText: `That's the Node version in the ${name} terminal. Closed it again.`,
    });
  }

  // ── Two commands sharing state ────────────────────────────────────────
  //
  // The reason terminal exists at all. Each runBash call is its own process,
  // so a `cd` in one is invisible to the next; a terminal keeps the shell.
  for (let i = 0; i < 16; i++) {
    const svc = pick(SERVICE_NAMES, i);
    out.push({
      id: `proc-terminal-state-${i}`,
      band: "shell-process",
      prompt: `Run two commands in a row in the same shell — I need the second to see the first's working directory.`,
      fixture: { ...baseProject(), [`src/services/${svc}.ts`]: serviceFile(svc) },
      steps: [
        { tool: "terminal", args: { action: "create", name: "work", cwd: "src/services" } },
        {
          tool: "terminal",
          args: { action: "send", name: "work", command: `node -e "console.log('step one')"` },
        },
        {
          tool: "terminal",
          args: { action: "send", name: "work", command: `node -e "console.log('step two, same shell')"` },
        },
        { tool: "terminal", args: { action: "close", name: "work" } },
      ],
      finalText: `Both ran in the same shell, rooted at src/services — the second saw the first's state.`,
    });
  }

  // ── read, and list (which takes NO name) ──────────────────────────────
  for (let i = 0; i < 12; i++) {
    out.push({
      id: `proc-terminal-read-${i}`,
      band: "shell-process",
      prompt: `What did the build terminal print?`,
      fixture: baseProject(),
      steps: [
        { tool: "terminal", args: { action: "create", name: "build" } },
        {
          tool: "terminal",
          args: { action: "send", name: "build", command: `node -e "console.log('build finished')"` },
        },
        { tool: "terminal", args: { action: "read", name: "build", lines: 20 } },
        // `list` is the one action that must NOT carry a name.
        { tool: "terminal", args: { action: "list" } },
        { tool: "terminal", args: { action: "close", name: "build" } },
      ],
      finalText: `The build terminal printed "build finished", and it's the only one open.`,
    });
  }

  // ── A command that prompts → sendKeys ─────────────────────────────────
  //
  // The send genuinely times out: `success` is false whenever the command is
  // still running, so this is a declared failure. That result is not an error
  // to recover from — it carries `stillRunning: true` and a note saying to use
  // read or sendKeys. Answering the prompt is the lesson.
  for (let i = 0; i < 10; i++) {
    out.push({
      id: `proc-terminal-prompt-${i}`,
      band: "shell-process",
      prompt: `Run the migration script — it'll ask for confirmation, answer yes.`,
      fixture: baseProject(),
      steps: [
        { tool: "terminal", args: { action: "create", name: "migrate" } },
        {
          tool: "terminal",
          args: { action: "send", name: "migrate", command: PROMPT_CMD, timeoutMs: 2000 },
          say: "Running it — it will stop and wait for an answer.",
          expectFailure: true,
        },
        { tool: "terminal", args: { action: "sendKeys", name: "migrate", keys: "y\n" } },
        { tool: "terminal", args: { action: "read", name: "migrate" } },
        { tool: "terminal", args: { action: "close", name: "migrate" } },
      ],
      finalText: `It asked for confirmation, I answered yes, and it completed.`,
    });
  }

  // ══ service ════════════════════════════════════════════════════════════

  // ── start --exit: a command that is SUPPOSED to finish ────────────────
  //
  // The distinction `exit` exists to draw. Without it the registry waits for
  // a readiness signal that an install will never send, then reports a
  // timeout on a command that succeeded.
  for (let i = 0; i < 16; i++) {
    out.push({
      id: `proc-service-install-${i}`,
      band: "shell-process",
      prompt: [`Install the dependencies.`, `Run the setup script.`, `Install packages for me.`][i % 3]!,
      fixture: baseProject(),
      steps: [
        {
          tool: "service",
          args: { action: "start", name: "install", command: INSTALL_CMD, exit: true },
          say: "Running the install and waiting for it to finish.",
        },
        { tool: "service", args: { action: "logs", name: "install" } },
      ],
      finalText: `Install finished with exit code 0.`,
    });
  }

  // ── start a real server, prove it serves, stop it ─────────────────────
  //
  // The full arc, and the only place checkUrl has a live target. `autoPort`
  // both avoids collisions and teaches the pattern: the tool allocates the
  // port and tells you the url, so read it from the result rather than
  // assuming 3000.
  for (let i = 0; i < 18; i++) {
    out.push({
      id: `proc-service-serve-${i}`,
      band: "shell-process",
      prompt: [
        `Start the dev server and make sure it's actually up.`,
        `Bring up the web server and confirm it responds.`,
        `Start the app and check it's serving.`,
      ][i % 3]!,
      fixture: baseProject(),
      steps: [
        {
          tool: "service",
          args: { action: "start", name: "web", command: SERVER_CMD, autoPort: true },
          say: "Starting it on a free port so nothing collides.",
        },
        // Started is not serving. This is the step that knows the difference.
        { tool: "checkUrl", args: { url: "{{serviceUrl}}", service: "web" } },
        { tool: "service", args: { action: "stop", name: "web" } },
      ],
      finalText: `It came up and answered with 200, so it's genuinely serving — then I stopped it.`,
    });
  }

  // ── status / logs / restart on a running service ──────────────────────
  for (let i = 0; i < 14; i++) {
    const action = (["status", "logs", "restart"] as const)[i % 3]!;
    const asked = {
      status: "Is the web server still running?",
      logs: "What has the web server logged?",
      restart: "Restart the web server.",
    }[action];
    const said = {
      status: "It's running and ready.",
      logs: "That's everything it has logged so far.",
      restart: "Restarted, and it came back ready.",
    }[action];

    const steps: ScenarioStep[] = [
      { tool: "service", args: { action: "start", name: "web", command: SERVER_CMD, autoPort: true } },
      { tool: "service", args: { action, name: "web" } },
      { tool: "service", args: { action: "stop", name: "web" } },
    ];

    out.push({
      id: `proc-service-${action}-${i}`,
      band: "shell-process",
      prompt: asked,
      fixture: baseProject(),
      steps,
      finalText: said,
    });
  }

  // ── list: the action that takes NO name ───────────────────────────────
  for (let i = 0; i < 8; i++) {
    out.push({
      id: `proc-service-list-${i}`,
      band: "shell-process",
      prompt: [`What's running?`, `Any services up right now?`, `Show me the running services.`][i % 3]!,
      fixture: baseProject(),
      steps: [
        { tool: "service", args: { action: "start", name: "web", command: SERVER_CMD, autoPort: true } },
        // No `name`. Passing one here would be the mirror-image mistake of
        // omitting it from `stop`.
        { tool: "service", args: { action: "list" } },
        { tool: "service", args: { action: "stop", name: "web" } },
      ],
      finalText: `One service running: web, ready on its allocated port.`,
    });
  }

  // ══ checkUrl on its own ════════════════════════════════════════════════

  // ── A url that answers, with an expected status ───────────────────────
  for (let i = 0; i < 8; i++) {
    out.push({
      id: `proc-checkurl-status-${i}`,
      band: "shell-process",
      prompt: `Start the server and check it returns a 200, not just that the port is open.`,
      fixture: baseProject(),
      steps: [
        { tool: "service", args: { action: "start", name: "api", command: SERVER_CMD, autoPort: true } },
        { tool: "checkUrl", args: { url: "{{serviceUrl}}", expectStatus: 200, service: "api" } },
        { tool: "service", args: { action: "stop", name: "api" } },
      ],
      finalText: `It returns 200.`,
    });
  }

  // ── Nothing is listening: the honest negative ─────────────────────────
  //
  // A short timeout on purpose. The default retries for 30s, which is right
  // for a server still booting and wrong for a dataset — and the lesson is
  // reading the failure, not waiting for it.
  for (let i = 0; i < 6; i++) {
    const port = [4173, 5174, 8081, 3001, 9090, 7070][i % 6]!;
    out.push({
      id: `proc-checkurl-down-${i}`,
      band: "shell-process",
      prompt: `Is anything serving on port ${port}?`,
      fixture: baseProject(),
      steps: [
        {
          tool: "checkUrl",
          args: { url: `http://localhost:${port}`, timeoutMs: 2000 },
          expectFailure: true,
        },
      ],
      finalText: `Nothing is listening on port ${port} — it couldn't connect at all, so there's no server there rather than a server returning an error.`,
    });
  }

  // ══ Tool choice by contrast ════════════════════════════════════════════

  // runBash is still right for a command that runs and finishes. Without
  // these, a model taught `terminal` and `service` would reach for a shell
  // session to ask what version of node is installed.
  for (let i = 0; i < 10; i++) {
    out.push({
      id: `proc-choice-runbash-${i}`,
      band: "shell-process",
      prompt: [`What node version is installed?`, `Print the node version.`][i % 2]!,
      fixture: baseProject(),
      steps: [
        {
          tool: "runBash",
          args: { command: `node -e "console.log(process.version)"` },
          say: "One-off command, so a plain shell call is enough.",
        },
      ],
      finalText: `That's the installed Node version.`,
    });
  }

  return out;
}
