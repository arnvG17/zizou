# ADD_NAMED_SESSIONS.md

## Scope Guardrails
- Do NOT touch: `src/config/**`, `src/provider/**`.
- Locate the existing session I/O module (owns reading/writing `~/.zizou/sessions/<project-hash>/state.json`) before writing anything — inspect first, extend to match this spec rather than rewriting from scratch.
- `context-assembler.ts` gets a minimal, additive change only (resolve active session before reading state) — do not touch its context-building logic otherwise.
- No changes to `src/agent/**` orchestrator/clarifier/planner/executor logic — this task is session plumbing only.

## Problem Statement
Sessions today are keyed 1:1 to `<project-hash>` — there's exactly one working session per project. Need named, switchable sessions per project (e.g. one for "login feature," one for "auth feature"), each with its own state (working memory, plan, TODO, context cache, artifacts) and its own conversation history, without losing or corrupting the others.

## Required Changes

### 1. Registry file — `~/.zizou/sessions/<project-hash>/registry.json`
```ts
export interface SessionMeta {
  id: string;          // uuid or slug
  name: string;         // user-facing, e.g. "login-feature"
  createdAt: string;
  lastActiveAt: string;
  baseBranch: string;   // branch/commit it forked from (used by git-revert doc)
}

export interface Registry {
  activeSessionId: string | null;
  sessions: SessionMeta[];
}
```
Directory layout becomes:
```
~/.zizou/sessions/<project-hash>/
  registry.json
  <session-id>/
    state.json        // existing shape, unchanged
    snapshots.json     // introduced in ADD_GIT_SCOPED_REVERT.md, not this doc
```

### 2. Session CRUD — new module, e.g. `src/session/registry.ts`
```ts
export function createSession(name: string): SessionMeta;
export function listSessions(): SessionMeta[];
export function switchSession(name: string): void; // sets activeSessionId
export function deleteSession(name: string): void;
export function getActiveSession(): SessionMeta | null;
```
- `createSession`: generates id, writes empty `state.json`, records current git HEAD as `baseBranch`, adds to registry, sets as active.
- `switchSession`: **must check working-tree cleanliness first** (`git status --porcelain`). If dirty, block and tell the user to commit or discard changes before switching — do not silently carry uncommitted changes into another session's context. (This becomes richer once branch-per-session lands in the git-revert doc; for now, a plain dirty-check is sufficient.)
- `deleteSession`: refuse if the session is currently active; archive `state.json` (move to a `.deleted/` subfolder, don't hard-delete) rather than removing outright.

### 3. CLI commands
```
zizou session new <name>
zizou session list
zizou session switch <name>
zizou session delete <name>
```
`session list` output: name, last active timestamp, and a one-line status (open plan present? clean/dirty working tree?).

### 4. context-assembler.ts — minimal wiring
Before reading `state.json`, resolve `activeSessionId` from `registry.json` and read from `<session-id>/state.json` instead of the old flat path. This is the only change to this file — no changes to how context is built from the state once loaded.

## Acceptance Criteria
- Multiple named sessions can exist under one project hash simultaneously, each with independent `state.json`.
- `zizou session switch <name>` changes which session's state the next turn reads/writes, and refuses if the working tree is dirty.
- Deleting a session does not delete its underlying files outright (archived, not destroyed).
- Existing single-session projects continue to work unchanged after migration (registry auto-created on first run if missing, with the existing session as the sole entry).

## Suggested Test
1. `zizou session new login-feature` → `zizou session new auth-feature` → `zizou session list` shows both, correct active pointer.
2. Make an uncommitted change → `zizou session switch auth-feature` → command refuses with a clear message.
3. Commit or discard → switch succeeds → confirm `state.json` read/written is the `auth-feature` one, not `login-feature`'s.
4. `zizou session delete login-feature` while it's not active → confirm files move to archive, not deleted; registry no longer lists it as active-selectable.