 # ADD_ORCHESTRATOR_WITH_ROLE_AWARE_CONTEXT.md

## Scope Guardrails
- Do NOT touch: `src/config/**`, `src/provider/**` (unresolved duplicate-config issue — off limits regardless of what this task seems to need).
- Create/modify files under `src/agent/**`, the CLI entry point, and `context-assembler.ts` only.
- If `src/agent/clarifier.ts`, `planner.ts`, `executor.ts`, `orchestrator.ts`, or `context-assembler.ts` already exist: **inspect first**. Extend/refactor to match this spec rather than blind-overwriting — do not assume any are empty or missing.
- Respect existing dependency direction: `ui → agent → tools/provider → config`. Nothing in `src/agent/**` should import from `ui` or reach into `config`/`provider` directly.

## Problem Statement
Two related gaps, being fixed together because they touch the same integration point:

1. No confirmed, working orchestration loop exists (clarifier → planner → executor → verifier), and no deterministic way to distinguish a one-file fix from a full feature plan. The naive fix — an upfront LLM call to classify the request — is rejected: it adds latency/cost to every request and just relocates the ambiguity instead of resolving it. Instead: explicit user-selected mode, with deterministic (non-LLM) escalation when a "simple" request turns out not to be simple mid-execution.
2. Context budget (Light/Default/Max) currently applies as one blanket setting, and Light excludes the repo map from the system prompt regardless of who's asking for context. That's fine for the executor (works from an explicit target file, doesn't need a repo overview) but wrong for planner/clarifier — take the repo map away from planning and you get exactly the write-before-scaffold ordering bug already diagnosed once. Fix: repo map inclusion is gated by **which agent role is requesting context**, not by budget level alone.

Building these together because every module in (1) is a consumer of (2) — `context-assembler.ts` needs a `role` argument, and that argument has to come from somewhere: the clarifier, planner, and executor being built here.

## Required Changes

### 1. Mode type & routing — `src/agent/mode.ts`
```ts
export type Mode = "build" | "plan";

export interface ModeContext {
  mode: Mode;
  reason: "user-flag" | "escalated";
}

export function resolveMode(args: { planFlag: boolean }): ModeContext {
  return { mode: args.planFlag ? "plan" : "build", reason: "user-flag" };
}
```
CLI wiring: default invocation (`zizou "<prompt>"`) = build mode. `zizou plan "<prompt>"` or `--plan` flag = plan mode. No LLM call involved — pure flag check.

### 2. Context-assembler — role-aware repo map (`context-assembler.ts`)
This is the shared plumbing every role below calls into. Update the signature to take a `role`, and gate repo-map inclusion by role first, budget second:
```ts
export type AgentRole = "clarifier" | "planner" | "executor";

export interface AssembleContextArgs {
  role: AgentRole;
  budget: "light" | "default" | "max";
  // ...existing args, unchanged
}

function shouldIncludeRepoMap(args: AssembleContextArgs): boolean {
  if (args.role === "clarifier" || args.role === "planner") return true; // always, regardless of budget
  return args.budget !== "light"; // executor: existing budget-scaled behavior, unchanged
}
```
No other change to how context is built once the repo-map decision is made — this is additive, not a rewrite of context-assembler's existing logic.

### 3. Verifier — `src/agent/verifier.ts` (new, pulled out of orchestrator)
Filesystem verification lives in its own module. Orchestrator calls it; never trust the model's own report of what it changed.
```ts
export interface StepResult {
  stepIndex: number;
  claimedFiles: string[];
  toolCallsMade: ToolCall[];
}

export interface VerificationResult {
  verified: boolean;
  mismatches: string[]; // claimed-changed-but-unchanged, or changed-but-not-claimed
}

export async function verifyStep(
  step: PlanStep,
  result: StepResult,
  cwd: string
): Promise<VerificationResult> {
  // Compare actual filesystem state (mtime/hash) against result.claimedFiles.
  // Do not rely on result.toolCallsMade alone as evidence of what changed.
}
```

### 4. Clarifier — `src/agent/clarifier.ts` (plan mode only)
Pre-planning agent. Asks clarifying questions before any plan is generated. Never invoked in build mode. Calls `assembleContext({ role: "clarifier", ... })` — repo map is always included per (2) above.
```ts
export interface ClarifyingQuestion {
  question: string;
  required: boolean;
}

export async function clarify(
  userPrompt: string,
  projectContext: ProjectContext
): Promise<ClarifyingQuestion[]>;
```

### 5. Planner — `src/agent/planner.ts` (plan mode only)
No tool access. Outputs a structured JSON plan array only. Calls `assembleContext({ role: "planner", ... })` — repo map always included.
```ts
export interface PlanStep {
  index: number;
  description: string;
  targetFiles: string[];
  dependsOn: number[]; // step indices — enforce this to prevent the write-before-scaffold ordering bug
}

export async function plan(
  userPrompt: string,
  clarifications: Record<string, string>,
  context: ProjectContext
): Promise<PlanStep[]>;
```

### 6. Executor — `src/agent/executor.ts` (both modes)
Receives one scoped `PlanStep` at a time. `tool_choice` required. Fresh, minimal context per call. Calls `assembleContext({ role: "executor", budget, ... })` — repo map follows existing Light/Default/Max scaling, unchanged.
```ts
export async function executeStep(
  step: PlanStep,
  context: ProjectContext
): Promise<StepResult>;
```
In build mode, the orchestrator synthesizes a single `PlanStep` directly from the raw user prompt (no clarifier, no planner call) and passes it straight to `executeStep`.

### 7. Orchestrator — `src/agent/orchestrator.ts` (the harness)
Owns plan state. Drives the loop differently per mode:

- **Plan mode:** clarifier → planner → plan-confirmation-required gate (full plan displayed, Y/n) → for each step in dependency order: executeStep → verifyStep → record. Reuse the existing plan-confirmation-required gate as-is.
- **Build mode:** synthesize single step → executeStep → verifyStep → check escalation.

Escalation logic (build mode only — deterministic, not LLM-judged):
```ts
interface EscalationTrigger {
  reason: "verification-failed" | "touched-too-many-files" | "step-implies-dependency";
}

const FILE_THRESHOLD = 3; // tune based on observed behavior

function shouldEscalate(
  result: StepResult,
  verification: VerificationResult
): EscalationTrigger | null {
  if (!verification.verified) return { reason: "verification-failed" };
  if (result.claimedFiles.length > FILE_THRESHOLD) return { reason: "touched-too-many-files" };
  return null;
}
```
On escalation: orchestrator stops immediately, does **not** auto-switch modes or silently continue, and surfaces a prompt: *"This touched more than expected — switch to plan mode? [y/n]"*. If yes, re-enter as plan mode from scratch with the original prompt (clarifier runs fresh — do not reuse partial build-mode state).

## Acceptance Criteria
- `zizou "<simple prompt>"` executes via build mode: exactly one `executeStep` + one `verifyStep` call; clarifier and planner never invoked.
- `zizou plan "<feature prompt>"` runs clarifier → planner → full plan display → Y/n gate → per-step execute+verify loop, in `dependsOn` order.
- A build-mode step touching more than `FILE_THRESHOLD` files, or failing verification, triggers the escalation prompt — never silently continues, never silently switches modes.
- Running plan mode under `--context light` still includes the repo map for clarifier and planner calls; running build mode under `--context light` still excludes it for executor, matching prior behavior.
- No file reads/writes anything in `src/config/` or `src/provider/`.
- `verifyStep` is the single place filesystem-vs-claim comparison happens; orchestrator only calls it.

## Suggested Test
1. Build mode, trivial fix (1 file) → single step executes, verifies clean, no escalation.
2. Build mode, prompt requiring 5 files → executor attempts it → verifier confirms 5 files changed → escalation triggers → user prompted, not auto-switched.
3. Plan mode, multi-file feature prompt, run with `--context light` → inspect the assembled system prompt sent to clarifier/planner → confirm repo map is present despite Light budget → plan executes in dependency order, each step verified independently.
4. Build mode under `--context light` → confirm executor's system prompt still excludes the repo map, unchanged from before.
5. Regression: existing session `state.json` fields (plan, TODO, artifacts) still populate correctly through the new orchestrator path.