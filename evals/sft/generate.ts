// evals/sft/generate.ts
//
// Turns scenarios into training records by RUNNING THE REAL TOOLS.
//
// THE POINT OF THIS FILE:
//
// The previous dataset (the old hand-written dataset) had hand-written tool results
// and hand-written file snippets. That is the weakness, and it is a quiet one.
// An editFile whose old_string actually appears twice in the file, a grep
// result that does not match what grep returns, an error string that is close
// to but not the real one — each teaches the model something false, and
// nothing in a hand-written pipeline can catch any of them.
//
// So nothing here is imagined. Each scenario seeds a real workspace, and each
// step calls the real execute() from buildToolMap(). Whatever comes back —
// the exact {success:true, contents:"..."} shape, grep's real 50-result cap,
// editFile's real "appeared 3 times" message — is what lands in the record.
//
// This makes whole classes of bad data structurally impossible rather than
// merely discouraged, and it means the recovery band trains on REAL failures,
// which are the records hardest to fake convincingly and worth the most.
//
// PROCESS-WIDE SIDE EFFECT: the tools resolve paths against process.cwd(), so
// this chdir()s into each workspace, exactly as evals/run-evals.ts does. cwd
// is restored in a finally, and the project is fingerprinted before and after
// as a tripwire against a tool writing into the repo instead.

import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { asSchema } from "ai";
import { buildToolMap } from "../../src/tools/index.js";
import { listServices, stopService } from "../../src/tools/service-registry.js";
import { buildSystemPrompt, clearPinnedFiles } from "../../src/context/build-system-prompt.js";
import {
  WORKSPACE_PLACEHOLDER,
  type Scenario,
  type ScenarioStep,
  type TrainingRecord,
  type TrainingMessage,
  type ToolCallMessage,
} from "./types.js";

// ─── Tool access ─────────────────────────────────────────────────────────────

/**
 * Auto-approves every confirmation.
 *
 * The confirmation gate is a UI concern about consent, not part of what the
 * model has to learn. A denied call produces "User denied permission", which
 * is a fine thing for the agent to handle at runtime and a terrible thing to
 * fill a training set with.
 */
const autoApprove = async () => true;

/** The real tool map. One instance — building it per call is pure waste. */
const TOOLS = buildToolMap(autoApprove);

/**
 * Tool definitions as JSON Schema.
 *
 * Via the AI SDK's own asSchema(), which is the exact converter used to build
 * a real request. Hand-writing these, or adding zod-to-json-schema as a second
 * converter, would let the dataset's schemas drift from the ones the model is
 * actually served — the same class of bug as a stale system prompt.
 */
export function buildToolSchemas(): unknown[] {
  return Object.entries(TOOLS).map(([name, t]: [string, any]) => ({
    type: "function",
    function: {
      name,
      description: t.description ?? "",
      parameters: asSchema(t.inputSchema).jsonSchema,
    },
  }));
}

// ─── Workspace ───────────────────────────────────────────────────────────────

const ROOT = process.cwd();

function createWorkspace(): string {
  const dir = join(tmpdir(), "zizou-sft", randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedFixture(dir: string, fixture: Record<string, string> | undefined): void {
  if (!fixture) return;
  for (const [relPath, contents] of Object.entries(fixture)) {
    const abs = resolve(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf-8");
  }
}

/**
 * Makes the workspace a git repo with a single commit.
 *
 * Identity and signing are forced off locally: the generator must not depend
 * on the machine's git config, and a developer with commit.gpgsign=true would
 * otherwise see every git scenario fail on a passphrase prompt that never
 * arrives.
 */
function initGit(dir: string): void {
  // Fixed dates make the commit SHA deterministic. Without them, `git log
  // --oneline` returns a different hash on every build and the dataset never
  // reproduces byte-for-byte — which makes two versions of it impossible to
  // diff, and impossible to tell "I regenerated" from "something changed".
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
  };
  const run = (cmd: string) =>
    execSync(cmd, { cwd: dir, stdio: "ignore", timeout: 15000, env });
  run("git init -q");
  run('git config user.email "fixture@example.com"');
  run('git config user.name "Fixture"');
  run("git config commit.gpgsign false");
  run("git add -A");
  run('git commit -q -m "initial commit" --no-verify');
}

function removeWorkspace(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A locked file must not fail generation.
  }
}

/**
 * Tripwire against a tool resolving a path wrongly and writing into the repo.
 *
 * run-evals.ts has the same guard for the same reason: everything here runs
 * with cwd pointed at a temp directory, and a single bad resolve() would edit
 * the user's actual source. Cheap to check, catastrophic to miss.
 */
function projectFingerprint(): string {
  const mtime = (p: string) => {
    try {
      return String(statSync(p).mtimeMs);
    } catch {
      return "-";
    }
  };
  return [mtime(join(ROOT, "src")), mtime(join(ROOT, "package.json"))].join("|");
}

// ─── Path scrubbing ──────────────────────────────────────────────────────────

/**
 * Replaces the real workspace path with a stable placeholder.
 *
 * Tool results echo absolute paths ("Successfully wrote file to C:\Users\...\
 * Temp\zizou-sft\<uuid>\src\x.ts"). Left in, the model memorizes one machine's
 * temp directory and a UUID that will never occur again. Both separators are
 * handled because Windows tools return backslashes while the fixture keys use
 * forward slashes.
 */
export function scrubPaths(value: string, workspace: string): string {
  const win = workspace.replace(/\//g, "\\");
  const posix = workspace.replace(/\\/g, "/");

  // The JSON-escaped form matters and is easy to miss: this function is
  // applied to JSON.stringify() output, where C:\Users\... has already become
  // C:\\Users\\..., so the raw path never matches. Leaving it out silently
  // bakes one machine's temp directory and a dead UUID into every tool
  // result — which is what happened on the first run of this generator.
  const variants = [
    workspace,
    posix,
    win,
    win.replace(/\\/g, "\\\\"),
    workspace.replace(/\\/g, "\\\\"),
  ].filter(Boolean);

  let out = value;
  // Longest first, so a prefix never consumes a longer variant's match.
  for (const v of [...new Set(variants)].sort((a, b) => b.length - a.length)) {
    out = out.split(v).join(WORKSPACE_PLACEHOLDER);
  }

  // Normalize the separators of whatever follows the placeholder, so a path
  // reads the same regardless of the platform that regenerated the dataset.
  return out.replace(
    new RegExp(`${WORKSPACE_PLACEHOLDER}((?:\\\\\\\\|\\\\|/)[\\w.\\-/\\\\]*)`, "g"),
    (_m, rest: string) => WORKSPACE_PLACEHOLDER + rest.replace(/\\\\/g, "/").replace(/\\/g, "/"),
  );
}

/**
 * Replaces values that change between runs but carry no lesson.
 *
 * A process id and a wall-clock timestamp are facts about the machine that
 * generated the dataset, not about what the model should do. Left in they do
 * two kinds of harm: the dataset stops reproducing byte-for-byte, so two
 * versions of it cannot be diffed and "I regenerated" is indistinguishable
 * from "something changed"; and the model spends capacity memorizing five
 * digits it will never see again.
 *
 * `taskId` is deliberately NOT scrubbed. It is a sequential counter, so it is
 * already stable, and the whole lesson of the background-task records is
 * carrying the id from the spawn result into the kill call. Normalizing it
 * would erase the relationship the record exists to teach.
 */
export function scrubVolatile(json: string): string {
  return json
    // "pid":16060  →  "pid":1000
    .replace(/"pid"\s*:\s*\d+/g, '"pid":1000')
    // ISO timestamps, however they are escaped inside a JSON string.
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "2025-01-01T00:00:00.000Z")
    // Durations and uptimes reported in ms or s.
    .replace(/"(uptime|durationMs|elapsedMs)"\s*:\s*\d+/g, '"$1":0');
}

// ─── Generation ──────────────────────────────────────────────────────────────

export class ScenarioError extends Error {
  constructor(scenarioId: string, message: string) {
    super(`[${scenarioId}] ${message}`);
    this.name = "ScenarioError";
  }
}

/**
 * Placeholder a scenario writes where a runtime-generated taskId belongs.
 *
 * runBackground mints an id at spawn time, so a scenario that later kills or
 * reads logs from that task cannot know the id when it is authored. The
 * alternative — a hardcoded fake id — would train the model to invent ids
 * instead of using the one the tool just handed it, which is the exact
 * mistake the manageTasks records exist to prevent.
 */
export const TASK_ID_PLACEHOLDER = "{{taskId}}";

/** Substitutes the most recent taskId into any placeholder in the args. */
function resolveArgs(
  args: Record<string, unknown>,
  lastTaskId: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === TASK_ID_PLACEHOLDER) {
      if (!lastTaskId) {
        throw new Error(`${TASK_ID_PLACEHOLDER} used before any runBackground step`);
      }
      out[key] = lastTaskId;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Runs one step against the live tool and returns the serialized result. */
async function executeStep(
  scenario: Scenario,
  step: ScenarioStep,
  workspace: string,
  args: Record<string, unknown>,
): Promise<string> {
  const toolInstance = (TOOLS as Record<string, any>)[step.tool];
  if (!toolInstance) {
    throw new ScenarioError(scenario.id, `unknown tool "${step.tool}"`);
  }

  const result = await toolInstance.execute(args, {});
  const ok = result?.success !== false && !result?.error;

  // A scenario that declares a failure must actually get one, and vice versa.
  // Without this, a recovery example silently degrades into a straightforward
  // one the day a tool's behaviour changes — still valid JSON, no longer
  // teaching what the band exists to teach.
  if (step.expectFailure && ok) {
    throw new ScenarioError(
      scenario.id,
      `step ${step.tool} was marked expectFailure but succeeded: ${JSON.stringify(result).slice(0, 200)}`,
    );
  }
  if (!step.expectFailure && !ok) {
    throw new ScenarioError(
      scenario.id,
      `step ${step.tool} failed unexpectedly: ${JSON.stringify(result).slice(0, 300)}`,
    );
  }

  return scrubVolatile(scrubPaths(JSON.stringify(result), workspace));
}

/**
 * Builds one training record.
 *
 * The system prompt is fetched per record rather than once, because
 * buildSystemPrompt() reads ZIZOU.md from the workspace — a scenario can
 * therefore include project conventions and train the model to honour them.
 */
export async function generateRecord(scenario: Scenario): Promise<TrainingRecord> {
  const workspace = createWorkspace();
  const before = projectFingerprint();
  const originalCwd = process.cwd();

  try {
    seedFixture(workspace, scenario.fixture);
    if (scenario.git) initGit(workspace);
    process.chdir(workspace);

    // addFileToContext pins into a MODULE-LEVEL Set that buildSystemPrompt
    // reads on every call. Without this reset, one scenario's pinned file
    // would appear in every subsequent record's system prompt — referencing
    // a path from a workspace that no longer exists, in records that never
    // pinned anything. Cheap to clear, invisible if forgotten.
    clearPinnedFiles();

    const system = scrubPaths(await buildSystemPrompt(workspace, "executor"), workspace);

    const messages: TrainingMessage[] = [{ role: "user", content: scenario.prompt }];
    const toolsUsed: string[] = [];

    let lastTaskId: string | null = null;

    for (const [i, step] of scenario.steps.entries()) {
      const callId = `call_${scenario.id}_${i}`;
      const args = resolveArgs(step.args, lastTaskId);

      const toolCall: ToolCallMessage = {
        id: callId,
        type: "function",
        function: {
          name: step.tool,
          // JSON string, matching the wire format and what the chat template
          // interpolates. An object here renders as [object Object].
          arguments: JSON.stringify(args),
        },
      };

      messages.push({
        role: "assistant",
        ...(step.say ? { content: step.say } : {}),
        tool_calls: [toolCall],
      });

      // THE REAL CALL. Everything downstream depends on this being the tool's
      // actual output rather than a plausible-looking string.
      const content = await executeStep(scenario, step, workspace, args);
      messages.push({ role: "tool", tool_call_id: callId, name: step.tool, content });
      toolsUsed.push(step.tool);

      // Capture a spawned task's id so a later kill/logs step can use the
      // real one.
      if (step.tool === "runBackground") {
        try {
          const parsed = JSON.parse(content);
          if (typeof parsed?.taskId === "string") lastTaskId = parsed.taskId;
        } catch {
          // Handled by the step's own success assertion.
        }
      }
    }

    if (scenario.finalText) {
      messages.push({ role: "assistant", content: scenario.finalText });
    } else if (scenario.steps.length === 0) {
      throw new ScenarioError(scenario.id, "a scenario with no steps must set finalText");
    }

    // The last word must be the assistant's: the model is being taught to
    // finish a turn, and a record ending on a tool result teaches it to stop
    // mid-loop with the user still waiting.
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant") {
      throw new ScenarioError(scenario.id, "record must end with an assistant message");
    }

    return {
      meta: {
        id: scenario.id,
        scenario: scenario.id,
        band: scenario.band,
        tools: toolsUsed,
        turns: messages.length,
      },
      system,
      tools: buildToolSchemas(),
      messages,
    };
  } finally {
    // Kill anything runBackground spawned. A scenario is expected to stop
    // what it starts, but "expected to" is not a guarantee: a mid-scenario
    // throw skips the kill step, and one leaked idle process per failure
    // across a thousand scenarios would exhaust a machine that already runs
    // close to its memory limit.
    for (const task of listServices()) {
      try {
        stopService(task.name);
      } catch {
        // Already gone, or never ours. Either way nothing to do.
      }
    }

    process.chdir(originalCwd);
    if (projectFingerprint() !== before) {
      // Loud on purpose. A tool wrote into the repo instead of the workspace,
      // and continuing would mean generating data while corrupting source.
      throw new ScenarioError(
        scenario.id,
        "PROJECT MODIFIED during generation — a tool resolved a path outside the workspace",
      );
    }
    removeWorkspace(workspace);
  }
}

/** Builds every record, reporting scenario failures together rather than one per run. */
export async function generateAll(
  scenarios: Scenario[],
): Promise<{ records: TrainingRecord[]; errors: string[] }> {
  const records: TrainingRecord[] = [];
  const errors: string[] = [];

  for (const scenario of scenarios) {
    try {
      records.push(await generateRecord(scenario));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { records, errors };
}
