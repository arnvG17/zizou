// src/telemetry/index.ts
//
// LAYER: telemetry/
//
// Token accounting, pricing, and eval-report reading — the three things the
// sidebar needs in order to tell the user what their run actually cost and how
// the model they are using scored.
//
// Allowed imports: config/ only. Imported by agent/, ui/, and evals/.
// This layer must never import from agent/, ui/, tools/ or sdk/: it is a sink
// and a reader, so it cannot be allowed to influence what it measures.

export {
  getRate,
  costOf,
  formatCost,
  isLocalProvider,
  knownModelIds,
  type ModelRate,
  type CostableUsage,
} from "./pricing.js";

export {
  recordUsage,
  recordModelUsage,
  getSessionUsage,
  resetUsage,
  onUsageChange,
  formatSessionCost,
  costIsComplete,
  modelIsPriced,
  USAGE_ROLES,
  type UsageRole,
  type SessionUsage,
  type RoleTotals,
} from "./usage.js";

export {
  readLatestEvalReport,
  cellForModel,
  isStale,
  type EvalSnapshot,
  type EvalCellSummary,
} from "./eval-report.js";
