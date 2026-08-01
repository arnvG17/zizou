# Feature Batch: Undo/Redo, @ File Search, Image Drop, Export, Diff Preview, Model-Tier Indicator, ZIZOU.md, Cost Readout

## How to use this doc
Eight independent components. Implement and verify each one in order — don't start the next until the current one's acceptance criteria pass. Each component lists its own files and tests so a partial implementation is still a working, shippable state.

## Global Scope Guardrails
- Do NOT touch `src/config/` or `src/provider/`.
- Do NOT touch planner, clarifier, verifier, or executor step-execution logic itself — these features wrap around the existing pipeline via checkpoints, TUI, and context injection, not by changing how steps run.
- Do NOT implement Plan/Build mode in this doc — that's tracked separately.
- Do NOT implement `/share` (hosted link) — only local `/export` is in scope here.
- Every new file follows house rules: one concept per file, no barrel exports, comments only on non-obvious logic.

---

## Component 1 — Undo / Redo

### File Structure
```
src/checkpoints/
  step-snapshot.ts     — capture/restore per-step file diffs
  undo-redo-stack.ts    — stack management, persisted to .zizou/
```

### Problem
Zizou has no way to revert a step's file changes short of manual git usage. Need `/undo` and `/redo` at the step granularity, backed by the existing `.zizou/` project-root-relative checkpoint storage.

### Required Changes

**[NEW] `src/checkpoints/step-snapshot.ts`**
```typescript
interface StepSnapshot {
  stepId: string;
  timestamp: string;
  fileDiffs: Array<{ path: string; before: string | null; after: string | null }>;
  // before === null means the file was created by this step
  // after === null means the file was deleted by this step
}

export function captureBeforeState(paths: string[]): Map<string, string | null> {
  // read current content (or null if file doesn't exist) for each path, BEFORE the step executes
}

export function buildSnapshot(stepId: string, before: Map<string, string | null>, touchedPaths: string[]): StepSnapshot {
  // diff before vs after (read current disk state) for each touched path
}
```

**[NEW] `src/checkpoints/undo-redo-stack.ts`**
```typescript
import Conf from "conf";

const store = new Conf<{ undoStack: StepSnapshot[]; redoStack: StepSnapshot[] }>({
  projectName: "zizou",
  cwd: ".zizou",
  defaults: { undoStack: [], redoStack: [] },
});

export function pushSnapshot(snap: StepSnapshot): void {
  store.set("undoStack", [...store.get("undoStack"), snap]);
  store.set("redoStack", []); // any new action clears redo history
}

export function undo(): StepSnapshot | null {
  const stack = store.get("undoStack");
  const last = stack.at(-1);
  if (!last) return null;
  store.set("undoStack", stack.slice(0, -1));
  store.set("redoStack", [...store.get("redoStack"), last]);
  applySnapshotReverse(last); // write `before` values back to disk
  return last;
}

export function redo(): StepSnapshot | null {
  const stack = store.get("redoStack");
  const last = stack.at(-1);
  if (!last) return null;
  store.set("redoStack", stack.slice(0, -1));
  store.set("undoStack", [...store.get("undoStack"), last]);
  applySnapshotForward(last); // write `after` values back to disk
  return last;
}
```

Wire `pushSnapshot` into the orchestrator immediately after a step's filesystem verification succeeds (per your existing "orchestrator owns filesystem verification" pattern — this is the correct place, not the executor).

### Acceptance Criteria
- [ ] `/undo` after a step reverts exactly the files that step touched, nothing else.
- [ ] `/undo` on a step that created a file deletes that file; `/undo` on a step that deleted a file restores it.
- [ ] `/redo` after `/undo` reapplies the exact same change.
- [ ] Any new step execution after an `/undo` clears the redo stack.
- [ ] Multiple sequential `/undo` calls walk back multiple steps correctly.

### Suggested Tests
- Unit: snapshot/restore round-trip on create, edit, and delete cases.
- Integration: execute 3 steps, `/undo` twice, `/redo` once, verify disk state matches step 2's post-state.

---

## Component 2 — @ Fuzzy File Search

### File Structure
```
src/tui/file-search-overlay.tsx
src/tui/file-index.ts   — cached, debounced file tree listing
```

### Required Changes

**[NEW] `src/tui/file-index.ts`** — maintains a cached flat list of project files (respecting `.gitignore`), refreshed on a debounce (e.g. via `chokidar` watch, or re-scanned on prompt-submit if you want to avoid a new dependency).

**[NEW] `src/tui/file-search-overlay.tsx`** — Ink component: detects `@` typed in the main input, opens an overlay listing fuzzy matches (use `fuzzysort` — lightweight, no native deps) against the file index, arrow keys to navigate, Enter to insert the resolved relative path into the input at the `@` position.

### Acceptance Criteria
- [ ] Typing `@` opens the overlay; typing further characters filters live.
- [ ] Selecting a result inserts the file's relative path, closes the overlay, returns focus to the main input.
- [ ] Overlay respects `.gitignore` — doesn't surface `node_modules`, `.git`, etc.
- [ ] Works correctly with multiple `@` references in a single prompt.

### Suggested Tests
- Manual: type `@` in a project with 500+ files, confirm no noticeable input lag (index must be pre-built, not scanned per keystroke).
- Manual: reference two different files in one prompt, confirm both resolve correctly.

---

## Component 3 — Image Paste/Drop Support

### File Structure
```
src/tui/image-input-handler.ts
```

### Required Changes

**[NEW] `src/tui/image-input-handler.ts`** — most terminals emit a file path string (not raw binary) on drag-and-drop or paste. Detect a pasted/typed string matching an image path pattern (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`) that resolves to an existing file, read it, base64-encode, and attach as an `image` content block on the next message sent via the AI SDK, alongside the text prompt.

```typescript
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

export async function tryExtractImageAttachment(inputText: string): Promise<{ mediaType: string; data: string } | null> {
  const candidate = inputText.trim().replace(/^['"]|['"]$/g, "");
  if (!IMAGE_EXT.test(candidate)) return null;
  if (!(await fileExists(candidate))) return null;
  const buffer = await readFile(candidate);
  return { mediaType: mimeTypeFor(candidate), data: buffer.toString("base64") };
}
```

### Acceptance Criteria
- [ ] Dropping/pasting an image path into the prompt attaches it as an image content block, not literal text, in the outgoing message.
- [ ] Non-image paths are left untouched as normal text input.
- [ ] Model can correctly reference the attached image in its response (confirm via a design-reference test prompt).

### Suggested Tests
- Manual: paste a screenshot path, ask "what does this show", confirm the model describes the actual image content.

---

## Component 4 — /export (Local Transcript Export)

### File Structure
```
src/commands/export-transcript.ts
```

### Required Changes

**[NEW] `src/commands/export-transcript.ts`** — serializes the current conversation (messages, tool calls, and step outcomes) to a readable markdown file under `./zizou-exports/<timestamp>.md`. No network calls, no auth — purely local.

### Acceptance Criteria
- [ ] `/export` produces a markdown file with the full conversation, formatted readably (headers per turn, code blocks for tool calls/results).
- [ ] File is written to a predictable, gitignorable location.
- [ ] Command works mid-session without disrupting the active conversation.

### Suggested Tests
- Manual: run `/export` after a multi-step session, confirm the output is coherent and complete.

---

## Component 5 — Per-File Diff Preview Before Apply

### File Structure
```
src/tui/diff-preview.tsx
```

### Required Changes

**[NEW] `src/tui/diff-preview.tsx`** — before a `writeFile`/`editFile` call is committed to disk (Build mode), render a compact diff (use a lightweight diffing lib, e.g. `diff` npm package, unified format) in the TUI with an accept/reject prompt, similar in shape to the permission prompt already implemented for `runCommand`. Reject skips the write and marks the step failed with a clear "user rejected file change" reason, which the orchestrator treats like any other step failure.

### Acceptance Criteria
- [ ] Every file write/edit shows a diff and requires accept before landing on disk.
- [ ] Reject leaves the file completely unchanged and fails the step cleanly.
- [ ] Diff rendering is readable for both small edits and full-file creates.

### Suggested Tests
- Manual: reject a proposed edit, confirm file on disk is byte-identical to before.
- Manual: accept a proposed edit, confirm it matches what was previewed exactly.

---

## Component 6 — Model-Tier Indicator

### File Structure
```
src/tui/status-bar.tsx   (extend existing status bar if one exists, else create)
```

### Required Changes
Tag each step's result with which model handled it (`hosted` vs `local-executor`, based on your existing planner/executor routing), and render a small `[hosted]`/`[local]` tag next to each step in the TUI output stream.

### Acceptance Criteria
- [ ] Every executed step visibly shows which model tier handled it.
- [ ] Tag is accurate against actual routing (verify against your executor's model-selection logic, not inferred).

### Suggested Tests
- Manual: run a session with the fine-tuned local executor active, confirm tags match actual routing decisions in logs.

---

## Component 7 — ZIZOU.md Project Conventions File

### File Structure
```
src/context/load-project-conventions.ts
```

### Required Changes

**[NEW] `src/context/load-project-conventions.ts`** — on session start, look for a `ZIZOU.md` file at the project root. If present, read it and inject its content into planner context (and optionally executor context for the relevant step) as a distinct, clearly-labeled section — e.g. "Project conventions (from ZIZOU.md):". This is the project self-declaring the same kind of scope guardrails / path conventions you currently write manually into each Antigravity doc.

```typescript
export async function loadProjectConventions(projectRoot: string): Promise<string | null> {
  const path = join(projectRoot, "ZIZOU.md");
  if (!(await fileExists(path))) return null;
  return readFile(path, "utf-8");
}
```

Inject this alongside the existing file-tree/package.json context you already pass to the planner for multi-file features.

### Acceptance Criteria
- [ ] `ZIZOU.md` content, when present, appears in planner context verbatim, clearly delimited.
- [ ] Absence of `ZIZOU.md` is a silent no-op — no error, no missing-file warning shown to the user.
- [ ] Planner output respects conventions stated in the file (e.g. "never touch src/legacy/") in a manual test.

### Suggested Tests
- Manual: add a `ZIZOU.md` with an explicit "don't touch X" rule, give a task that would otherwise touch X, confirm planner avoids it.

---

## Component 8 — Token/Cost Readout

### File Structure
```
src/tui/cost-tracker.ts
```

### Required Changes

**[NEW] `src/tui/cost-tracker.ts`** — accumulate input/output token counts already available from the AI SDK's usage metadata per call, multiply by the current provider/model's known per-token rate (maintain a small static rate table, since you're BYOK across providers), and render a running session total in the status bar.

```typescript
interface UsageEntry { model: string; inputTokens: number; outputTokens: number; }

const RATE_TABLE: Record<string, { input: number; output: number }> = {
  // per-1M-token rates, USD — keep this table updated manually as pricing changes
};

export function estimateCost(entries: UsageEntry[]): number {
  return entries.reduce((total, e) => {
    const rate = RATE_TABLE[e.model];
    if (!rate) return total; // unknown model — skip rather than guess
    return total + (e.inputTokens / 1_000_000) * rate.input + (e.outputTokens / 1_000_000) * rate.output;
  }, 0);
}
```

### Acceptance Criteria
- [ ] Running cost total updates after every model call and is visible in the status bar.
- [ ] Unknown models (not in rate table) don't crash the readout — they're excluded from the total with a visible "unpriced" indicator rather than silently wrong numbers.
- [ ] Rate table is easy to update as a single flat config, not scattered through code.

### Suggested Tests
- Manual: run a session, cross-check accumulated cost against the provider's own dashboard/billing for rough accuracy.

---

## Cross-Component Notes
- Components 1 and 5 (undo/redo, diff preview) touch adjacent territory — implement 1 first, since 5's "reject" path is just a no-op if 1 doesn't exist yet, but 1 doesn't depend on 5 at all.
- Component 7 (ZIZOU.md) should land before you rely on it in future Antigravity docs — once it exists, your future docs can say "add a rule to ZIZOU.md" instead of repeating scope guardrails by hand each time.
- None of these components require changes to the fine-tuned local executor's training data or grammar — they're all harness/TUI layer.