// src/agent/debug/index.ts
//
// Barrel export for the debug/ module.
//
// Both predecessors are gone.
//
// TurnLogger was a class of eighteen methods whose bodies were all
// `// Silenced` — every agent event paid a method call to reach a comment.
//
// SessionLogger worked, but wrote a log nobody could read. It dumped the full
// system prompt on every step (~3.7k tokens of tool schemas), re-logged each
// tool call from the event stream WITHOUT the diff it caused, and wrote the
// whole message history a second time at the end. A ten-step plan produced a
// file where the same boilerplate appeared eleven times and the three lines
// explaining the failure were buried in it. It also wrote to a fixed
// `zizou-debug.log` at the repo root, which the user then had to gitignore.
//
// RunJournal records the same events plus the file diffs they caused, keeps
// verbatim prompts behind a flag, and writes per-run files under .zizou/.
export {
  RunJournal,
  disabledJournal,
  setActiveJournal,
  getActiveJournal,
} from "./run-journal.js";
export type {
  JournalEvent,
  JournalPayload,
  JournalPhase,
  RunTotals,
  ToolCallRecord,
  UsageRecord,
  RunJournalOptions,
} from "./run-journal.js";
export { buildFileDiff, formatDiffStat } from "./file-diff.js";
export type { FileDiff, FileChangeKind } from "./file-diff.js";
