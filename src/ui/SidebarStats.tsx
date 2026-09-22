// src/ui/SidebarStats.tsx
//
// LAYER: ui
// Allowed imports: telemetry/, config/, ink, react.
//
// The two panels the chat sidebar renders: what this session has spent, and
// how the model in use scored on the golden tasks.
//
// These are separated from Chat.tsx because they are the only parts of the
// sidebar with their own data sources — a live subscription to the usage
// ledger, and a file read of the newest eval report. Everything else in that
// column is already-computed props.
//
// A NOTE ON WHAT THESE PANELS REFUSE TO DO: neither invents a number. If a
// model has no known rate the cost reads "unknown", not a defaulted guess; if
// the suite has never run the eval panel says so rather than showing 0%. A
// sidebar exists to raise the user's confidence, and a confident wrong figure
// does the opposite the first time they check it against a real bill.

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import {
  cellForModel,
  costIsComplete,
  formatCost,
  formatSessionCost,
  getSessionUsage,
  isStale,
  modelIsPriced,
  onUsageChange,
  readLatestEvalReport,
  USAGE_ROLES,
  type EvalSnapshot,
  type SessionUsage,
  type UsageRole,
} from "../telemetry/index.js";

// ─── Shared styling ──────────────────────────────────────────────────────────

const HEADING = "#E6E6E6";
const MUTED = "gray";
const DIM = "#4A5568";
const WARN = "#D9A441";
const GOOD = "#5FB87A";
const BAD = "#D96C6C";

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <Text color={HEADING} bold>
      {children}
    </Text>
  );
}

/** Compact token counts: 1240 -> 1.2k, 1240000 -> 1.24M. */
function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** A label/value row that stays aligned in a 30-column box. */
function Row({
  label,
  value,
  color = MUTED,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text color={MUTED}>{label}</Text>
      <Text color={color}>{value}</Text>
    </Box>
  );
}

// ─── Token / cost panel ──────────────────────────────────────────────────────

/** Display order. Matches the order a turn actually runs them in. */
const ROLE_LABELS: Record<UsageRole, string> = {
  router: "route",
  planner: "plan",
  executor: "build",
  verifier: "verify",
  chat: "chat",
};

export function TokenStatsPanel({
  contextLimit,
  modelId,
  provider,
}: {
  contextLimit: number;
  modelId: string;
  provider: string;
}) {
  // Live subscription rather than a per-turn recomputation: the planner and
  // verifier calls land between turns, and a figure that only moves when the
  // user presses enter would hide exactly the spend this panel was added for.
  const [usage, setUsage] = useState<SessionUsage>(() => getSessionUsage());

  useEffect(() => onUsageChange(setUsage), []);

  const pctUsed = contextLimit > 0
    ? Math.min(100, (usage.totalTokens / contextLimit) * 100)
    : 0;

  const contextColor = pctUsed > 90 ? BAD : pctUsed > 70 ? WARN : MUTED;
  const priced = modelIsPriced(modelId, provider);
  const complete = costIsComplete(usage);

  // Only roles that actually ran. Showing five rows of zeroes in a 30-column
  // column buries the one number that moved.
  const activeRoles = USAGE_ROLES.filter((r) => usage.byRole[r].calls > 0);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Heading>Tokens</Heading>

      <Row label="in" value={tokens(usage.totalInputTokens)} />
      <Row label="out" value={tokens(usage.totalOutputTokens)} />
      {usage.totalCachedInputTokens > 0 && (
        // Cached input bills at roughly a tenth of fresh input, so this is the
        // difference between a cheap long session and an expensive one.
        <Row label="cached" value={tokens(usage.totalCachedInputTokens)} color={GOOD} />
      )}
      {usage.totalReasoningTokens > 0 && (
        <Row label="reasoning" value={tokens(usage.totalReasoningTokens)} />
      )}
      <Row
        label="context"
        value={`${pctUsed.toFixed(0)}% of ${tokens(contextLimit)}`}
        color={contextColor}
      />

      <Box marginTop={1} flexDirection="column">
        <Row
          label="cost"
          value={formatSessionCost(usage)}
          color={complete ? MUTED : WARN}
        />
        <Row label="calls" value={String(usage.totalCalls)} />
      </Box>

      {!priced && usage.totalCalls > 0 && (
        <Text color={WARN} wrap="truncate">
          no rate for this model
        </Text>
      )}
      {priced && !complete && (
        <Text color={WARN} wrap="truncate">
          {usage.unpricedCalls} call{usage.unpricedCalls === 1 ? "" : "s"} unpriced
        </Text>
      )}

      {/* Per-role breakdown. This is the part that was missing entirely: before
          the usage ledger, only `build` was counted and the other three roles
          spent tokens invisibly. */}
      {activeRoles.length > 1 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={DIM}>by stage</Text>
          {activeRoles.map((role) => {
            const r = usage.byRole[role];
            const total = r.inputTokens + r.outputTokens;
            return (
              <Box key={role} flexDirection="row" justifyContent="space-between">
                <Text color={DIM}>
                  {ROLE_LABELS[role]} ×{r.calls}
                </Text>
                <Text color={DIM}>{tokens(total)}</Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

// ─── Eval panel ──────────────────────────────────────────────────────────────

export function EvalStatsPanel({
  projectRoot,
  modelId,
  currentSha,
}: {
  projectRoot: string;
  modelId: string;
  currentSha?: string;
}) {
  const [snapshot, setSnapshot] = useState<EvalSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Read once on mount, off the render path. The file is small, but a
  // synchronous read in a render would block the whole Ink frame.
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => readLatestEvalReport(projectRoot))
      .then((s) => {
        if (alive) {
          setSnapshot(s);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [projectRoot]);

  if (!loaded) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Heading>Evals</Heading>
        <Text color={DIM} dimColor>
          loading…
        </Text>
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Heading>Evals</Heading>
        <Text color={DIM}>never run</Text>
        <Text color={DIM} wrap="truncate">
          bun run eval
        </Text>
      </Box>
    );
  }

  const mine = cellForModel(snapshot, modelId);
  const stale = currentSha ? isStale(snapshot, currentSha) : false;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Heading>Evals</Heading>

      {mine ? (
        <>
          {/* The headline: how the model the user is ACTUALLY running scored. */}
          <Row
            label="pass"
            value={`${(mine.passRate * 100).toFixed(0)}% (${mine.tasksPassed}/${mine.tasksTotal})`}
            color={mine.passRate === 1 ? GOOD : mine.passRate >= 0.7 ? WARN : BAD}
          />
          <Row label="tools/task" value={mine.avgToolCalls.toFixed(1)} />
          <Row label="$/task" value={formatCost(mine.avgCostUsd)} />
          {mine.fallbackParses > 0 && (
            // The sharpest signal that a model is struggling with the tool
            // protocol, and invisible in a pass rate.
            <Row label="fallbacks" value={String(mine.fallbackParses)} color={WARN} />
          )}
        </>
      ) : (
        <>
          <Text color={DIM} wrap="truncate">
            {modelId} not benchmarked
          </Text>
          {snapshot.cells.length > 0 && (
            <Text color={DIM} wrap="truncate">
              have: {snapshot.cells.map((c) => c.modelId).join(", ")}
            </Text>
          )}
        </>
      )}

      {snapshot.failingTaskIds.length > 0 && (
        <Text color={BAD} wrap="truncate">
          failing: {snapshot.failingTaskIds.join(", ")}
        </Text>
      )}

      {!snapshot.integrityOk && (
        // The suite writes this when the project directory changed during a
        // run. It means a tool resolved a path wrongly, which makes every
        // other number in the report suspect.
        <Text color={BAD}>integrity violation</Text>
      )}

      <Text color={DIM} wrap="truncate">
        {snapshot.gitSha}
        {stale ? " (stale)" : ""}
        {snapshot.ageDays > 0 ? ` · ${snapshot.ageDays}d ago` : " · today"}
      </Text>
    </Box>
  );
}
