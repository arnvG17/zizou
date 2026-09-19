// src/agent/debug/session-logger.ts
//
// LAYER: agent/debug
//
// Centralized logger for recording the entire lifecycle of a single session
// execution. Generates timestamped logs (zizou-debug-YYYY-MM-DD_HH-mm-ss.log)
// so that each time the bun process recompiles or runs, a new clean file is created.
//
// Contains:
//   - Verbatim LLM inputs (system prompt, user prompt, chat history)
//   - Verbatim LLM outputs
//   - Orchestrator mode & role transitions (Planner, Executor, Verifier)
//   - Input and Output parameters for each tool call
//   - Verifier comparison data

import { writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelMessage } from "ai";

// ─── Session Initialization ──────────────────────────────────────────────────

const now = new Date();

export const ACTIVE_SESSION_LOG_FILENAME = "zizou-debug.log";
export const ACTIVE_SESSION_LOG_PATH = resolve(process.cwd(), ACTIVE_SESSION_LOG_FILENAME);

// Overwrite and clear the log file immediately upon new session/process start.
// This guarantees we only keep a single active session's trace in zizou-debug.log
// and do not append across process runs.
try {
  writeFileSync(
    ACTIVE_SESSION_LOG_PATH,
    `================================================================================\n` +
    `  ZIZOU SESSION DEBUG LOG\n` +
    `  Started: ${now.toISOString()}\n` +
    `================================================================================\n\n`,
    "utf-8"
  );
} catch (e) {
  // best-effort
}

// ─── Formatting Utilities ───────────────────────────────────────────────────

function divider(char: string = "─", length: number = 80): string {
  return char.repeat(length) + "\n";
}

function titleBlock(title: string): string {
  return (
    `\n` +
    divider("═") +
    `  ${title}\n` +
    divider("═")
  );
}

function subTitleBlock(title: string): string {
  return (
    `\n` +
    divider("─") +
    `  ${title}\n` +
    divider("─")
  );
}

// ─── SessionLogger implementation ───────────────────────────────────────────

export class SessionLogger {
  private static append(text: string): void {
    try {
      appendFileSync(ACTIVE_SESSION_LOG_PATH, text, "utf-8");
    } catch {
      // best-effort — never block execution
    }
  }

  /**
   * Log the initialization of a new session run.
   */
  static logSessionStart(prompt: string, mode: string, cwd: string): void {
    this.append(
      titleBlock("SESSION RUN INITIALIZED") +
      `  Time       : ${new Date().toISOString()}\n` +
      `  CWD        : ${cwd}\n` +
      `  Mode       : ${mode.toUpperCase()}\n` +
      `  User Prompt: "${prompt}"\n` +
      divider("─") + "\n"
    );
  }

  /**
   * Log the start of the Planning phase.
   */
  static logPlannerStart(prompt: string): void {
    this.append(
      titleBlock("ROLE: PLANNER (Plan Generation Phase)") +
      `  Starting structured plan generation.\n` +
      `  Prompt: "${prompt}"\n`
    );
  }

  /**
   * Log the verbatim prompt and response from the planner LLM call.
   */
  static logPlannerLLM(system: string, user: string, response: string): void {
    this.append(
      subTitleBlock("PLANNER LLM CALL (VERBATIM)") +
      `[SYSTEM PROMPT]\n` +
      `----------------------------------------\n` +
      `${system}\n` +
      `----------------------------------------\n\n` +
      `[USER MESSAGE]\n` +
      `----------------------------------------\n` +
      `${user}\n` +
      `----------------------------------------\n\n` +
      `[LLM RESPONSE]\n` +
      `----------------------------------------\n` +
      `${response}\n` +
      `----------------------------------------\n`
    );
  }

  /**
   * Log the output of the Planner phase.
   */
  static logPlannerEnd(steps: any[]): void {
    const stepText = steps.length > 0
      ? steps.map((s) => 
          `    [Step ${s.index + 1}] ${s.description}\n` +
          `             Targets  : ${JSON.stringify(s.targetFiles)}\n` +
          `             DependsOn: ${JSON.stringify(s.dependsOn)}`
        ).join("\n\n")
      : "    (no steps generated)";

    this.append(
      `\n  [Planner Output]\n` +
      `  Plan Steps:\n` +
      `${stepText}\n` +
      divider("─") + "\n"
    );
  }

  /**
   * Log the start of an Executor step.
   */
  static logExecutorStepStart(step: any, budget: string): void {
    this.append(
      titleBlock(`ROLE: EXECUTOR (Step ${step.index + 1} Execution)`) +
      `  Description : "${step.description}"\n` +
      `  Target Files: ${JSON.stringify(step.targetFiles)}\n` +
      `  Depends On  : ${JSON.stringify(step.dependsOn)}\n` +
      `  Budget Level: ${budget}\n`
    );
  }

  /**
   * Log the verbatim prompts used for executing a step.
   */
  static logExecutorStepLLM(system: string, user: string): void {
    this.append(
      subTitleBlock("EXECUTOR INITIAL LLM PROMPT (VERBATIM)") +
      `[SYSTEM PROMPT]\n` +
      `----------------------------------------\n` +
      `${system}\n` +
      `----------------------------------------\n\n` +
      `[USER MESSAGE (STEP)]\n` +
      `----------------------------------------\n` +
      `${user}\n` +
      `----------------------------------------\n`
    );
  }

  /**
   * Log the verbatim conversation exchanged with the LLM during a step —
   * assistant tool calls and the tool results fed back in.
   *
   * Called ONCE after the turn with the canonical ModelMessage[] that runTurn
   * returns (the AI SDK's own responseMessages). It used to be called per
   * round with a history the executor rebuilt by hand from the event stream;
   * that reconstruction was ~120 lines re-deriving what the SDK already gives
   * us, and it could drift from what was actually sent.
   */
  static logLLMConversation(system: string, history: ModelMessage[]): void {
    const historyText = history.map((msg, i) => {
      const role = msg.role.toUpperCase();
      if (typeof msg.content === "string") {
        return `  [Message ${i}] ROLE: ${role}\n${msg.content.split("\n").map(l => "    " + l).join("\n")}\n`;
      }
      if (Array.isArray(msg.content)) {
        const partsText = msg.content.map((part: any, pi: number) => {
          if (part.type === "text") {
            return `    Part ${pi} (text): ${part.text}`;
          }
          if (part.type === "tool-call") {
            return `    Part ${pi} (tool-call): ${part.toolName} (id=${part.toolCallId})\n    Args: ${JSON.stringify(part.args ?? part.input)}`;
          }
          if (part.type === "tool-result") {
            const resultStr = JSON.stringify(part.result ?? part.output, null, 2);
            const resultPreview = resultStr.length > 500 ? resultStr.slice(0, 500) + "\n    ... (truncated)" : resultStr;
            return `    Part ${pi} (tool-result): ${part.toolName} (id=${part.toolCallId})\n    Result:\n${resultPreview.split("\n").map(l => "      " + l).join("\n")}`;
          }
          return `    Part ${pi}: ${JSON.stringify(part)}`;
        }).join("\n");
        return `  [Message ${i}] ROLE: ${role}\n${partsText}\n`;
      }
      return `  [Message ${i}] ROLE: ${role}\n    ${JSON.stringify(msg.content)}\n`;
    }).join("\n" + "  " + "─".repeat(48) + "\n");

    this.append(
      subTitleBlock("LLM CONVERSATION (MESSAGES EXCHANGED)") +
      `[SYSTEM PROMPT]\n` +
      `----------------------------------------\n` +
      `${system}\n` +
      `----------------------------------------\n\n` +
      `[CONVERSATION HISTORY (MESSAGES SENT IN)]\n` +
      `----------------------------------------\n` +
      `${historyText}\n` +
      `----------------------------------------\n`
    );
  }

  /**
   * Log a live stream event (tool call, delta, result) during step execution.
   */
  static logExecutorStreamEvent(eventText: string): void {
    this.append(`  [STREAM] ${eventText}\n`);
  }

  /**
   * Log the final output of the Executor step.
   */
  static logExecutorStepEnd(result: any): void {
    const textPassage = result.fullResponseText?.trim() 
      ? result.fullResponseText.trim() 
      : "(No text response, only tool calls)";
    
    this.append(
      `\n  [LLM RESPONDED PASSAGE]\n` +
      `----------------------------------------\n` +
      `${textPassage}\n` +
      `----------------------------------------\n\n` +
      `  [Executor Output Summary]\n` +
      `  Claimed Files: ${JSON.stringify(result.claimedFiles)}\n` +
      `  Tool Calls   : ${result.toolCallsMade.map((t: any) => t.toolName).join(", ") || "(none)"}\n`
    );
  }

  /**
   * Log the start of the Verifier checks for a step.
   */
  static logVerifierStart(step: any, claimedFiles: string[]): void {
    this.append(
      titleBlock(`ROLE: VERIFIER (Step ${step.index + 1} Verification)`) +
      `  Verifying filesystem integrity vs claims.\n` +
      `  Expected Targets: ${JSON.stringify(step.targetFiles)}\n` +
      `  Executor Claims : ${JSON.stringify(claimedFiles)}\n`
    );
  }

  /**
   * Log the verification checks and results.
   */
  static logVerifierEnd(result: any): void {
    this.append(
      `\n  [Verifier Output]\n` +
      `  Verification Verified: ${result.verified ? "SUCCESS" : "FAILED"}\n` +
      `  Mismatches Found     : ${result.mismatches.length > 0 ? JSON.stringify(result.mismatches) : "(none)"}\n` +
      divider("─") + "\n"
    );
  }

  /**
   * Log an advisory scope hint in build mode.
   *
   * Was logEscalation. Nothing is "triggered" any more — the turn has already
   * finished successfully and this only records that it looked large.
   */
  /**
   * Log the router's decision, in auto mode only.
   *
   * This is the audit trail for "why did it do that?" — and equally for "is
   * auto mode actually costing me a call on every turn?". A pinned mode
   * produces no line here at all, which is the point.
   */
  static logRouteDecision(
    route: string,
    reason: string,
    confidence: number,
    source: string,
  ): void {
    this.append(
      `\n  [ROUTER] → ${route.toUpperCase()} (${source}, confidence ${confidence.toFixed(2)}) — ${reason}\n`
    );
  }

  static logScopeHint(reason: string): void {
    this.append(
      `\n  [SCOPE HINT] ${reason} — build step looked larger than one step.\n`
    );
  }

  /**
   * Log session run completion.
   */
  static logSessionComplete(): void {
    this.append(
      titleBlock("SESSION RUN COMPLETED") +
      `  Completed at: ${new Date().toISOString()}\n\n`
    );
  }

  /**
   * Log a fallback pseudo-call interception. This is visually distinct from
   * native tool calls so you can grep for "FALLBACK" or "PSEUDO-CALL" to
   * measure how often the parser fires vs native tool-calling.
   */
  static logFallbackToolCall(
    name: string,
    args: unknown,
    result: unknown,
    rawText: string,
    success: boolean,
  ): void {
    const argsStr = JSON.stringify(args, null, 2);
    const resultStr = JSON.stringify(result, null, 2);
    const resultPreview = resultStr.length > 2000 ? resultStr.slice(0, 2000) + "\n      ... (truncated)" : resultStr;
    const rawPreview = rawText.length > 500 ? rawText.slice(0, 500) + "... (truncated)" : rawText;

    this.append(
      `\n` +
      `══════════════════════════════════════════════════════════════════════════════════\n` +
      `  ⚠️  FALLBACK: USED PSEUDO-CALL PARSER (not a native tool call)\n` +
      `══════════════════════════════════════════════════════════════════════════════════\n` +
      `  Parsed Tool  : ${name}\n` +
      `  Raw Text     : ${rawPreview}\n` +
      `  Parsed Args  :\n` +
      argsStr.split("\n").map(l => `    ${l}`).join("\n") + "\n" +
      `  Execution OK : ${success}\n` +
      `  Result       :\n` +
      resultPreview.split("\n").map(l => `    ${l}`).join("\n") + "\n" +
      `──────────────────────────────────────────────────────────────────────────────────\n`
    );
  }
}
