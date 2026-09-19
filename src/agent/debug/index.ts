// src/agent/debug/index.ts
//
// Barrel export for the debug/ module.
//
// TurnLogger is gone. It was a class of eighteen methods whose bodies were all
// `// Silenced` — every agent event paid a method call to reach a comment. Its
// job is now done properly by RunJournal, which records the same events plus
// the file diffs they caused.

export { SessionLogger, ACTIVE_SESSION_LOG_FILENAME, ACTIVE_SESSION_LOG_PATH } from "./session-logger.js";
export {
  RunJournal,
  disabledJournal,
  setActiveJournal,
  getActiveJournal,
} from "./run-journal.js";
export type {
  JournalEvent,
  RunTotals,
  ToolCallRecord,
  UsageRecord,
  RunJournalOptions,
} from "./run-journal.js";
export { buildFileDiff, formatDiffStat } from "./file-diff.js";
export type { FileDiff, FileChangeKind } from "./file-diff.js";
