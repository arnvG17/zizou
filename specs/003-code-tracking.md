# ADD_GIT_SCOPED_REVERT.md

## Scope Guardrails
- Do NOT touch: `src/config/**`, `src/provider/**`.
- ALL git operations stay isolated inside `git.ts` — no other module (orchestrator, session registry, CLI) runs raw git commands. They call exposed functions only.
- Depends on `ADD_NAMED_SESSIONS.md` (sessions must exist) and the orchestrator's `verifier.ts` (`ADD_ORCHESTRATOR_WITH_ROLE_AWARE_CONTEXT.md`) being in place — a "step" here means an orchestrator-verified step, not an arbitrary tool call. Do not build this against tool-call granularity.
- Inspect existing `git.ts` first (workspace snapshot / full-revert capability already exists) — extend it, don't replace it wholesale.

## Problem Statement
Current revert is workspace-wide and un-scoped — it can't tell whose changes it's undoing. Need revert scoped to a single session: reverting session A must never touch session B's work or upstream `main`. This also has to fail safely — refuse rather than guess when asked to revert to a point that isn't actually in this session's own history.

## Required Changes

### 1. Session = branch
On `createSession` (from the sessions doc), `git.ts` creates a branch `zizou/<session-name>` off the current HEAD and records the starting commit SHA.
```ts
// git.ts
export function createSessionBranch(sessionName: string): { branch: string; startCommit: string };
```
`snapshots.json` (new, per session, alongside `state.json`):
```ts
export interface SessionSnapshots {
  startCommit: string;
  commits: Array<{
    sha: string;
    stepIndex: number;
    description: string;
    timestamp: string;
  }>;
}
```

### 2. Commit per verified step
After `verifier.ts` confirms a step (`VerificationResult.verified === true`), the orchestrator calls into `git.ts` to commit — one commit per verified step, not per tool call, not batched per plan.
```ts
// git.ts
export function createSessionCommit(
  sessionId: string,
  stepIndex: number,
  description: string
): { sha: string };
```
Commit message format: `[<sessionId>] step <stepIndex>: <description>`. Append the result to `snapshots.json`.
- If a step fails verification, no commit is made — the orchestrator's existing escalation/retry logic handles that, this doc doesn't change it.

### 3. Revert commands
```
zizou revert                        # revert the last commit on the active session's branch
zizou revert --to <stepIndex|sha>   # reset the active branch to that point
```
```ts
// git.ts
export function revertSession(sessionId: string, target?: string | number): void;
export function listSessionCommits(sessionId: string): SessionSnapshots["commits"];
```
- `revertSession` must look up the target inside *this session's own* `commits` list. If the target SHA/stepIndex isn't found there — refuse. Do not fall back to a raw `git reset` against arbitrary refs; this is the guard against reverting into another session's history or into upstream `main`.
- Before executing: show the commit list/diff that will be discarded and gate on confirmation, reusing the existing plan-confirmation-required Y/n pattern — don't build a second confirmation UI for this.

### 4. Session delete behavior
Extend `deleteSession` (from the sessions doc): archiving `state.json` does not delete the git branch. Leave `zizou/<session-name>` intact for manual cleanup (`git branch -d` by hand) — automatic branch deletion is out of scope here since it's destructive and harder to reverse than archiving a JSON file.

## Acceptance Criteria
- Each session has its own branch; commits from one session's steps never appear on another session's branch.
- `zizou revert` only ever affects the active session's branch.
- `zizou revert --to <x>` refuses cleanly (no partial state change) if `<x>` isn't in the active session's own commit list.
- Revert always shows what will be discarded and requires confirmation before acting.
- No file outside `git.ts` issues a raw git command.

## Suggested Test
1. Create two sessions, run a few verified steps in each → confirm each branch's commit list only contains that session's own step commits.
2. `zizou revert` on session A → confirm only session A's branch changes, session B's branch and `main` are untouched.
3. `zizou revert --to <sha-from-other-session>` → confirm it's refused with a clear error, no state change.
4. `zizou revert --to <stepIndex>` on a valid earlier step → confirm the branch resets to exactly that point and later commits are gone from the branch (but still visible in `snapshots.json` history/reflog if you choose to keep that trail — decide and note in the PR).