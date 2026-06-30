// src/agent/debug/turn-logger.ts
//
// LAYER: agent/debug
//
// All verbose debug logging for the agent loop lives here.
// This keeps the main agent loop in run-turn.ts clean and readable
// while preserving full diagnostic output in zizou-debug.log.
//
// The TurnLogger is instantiated once per turn. It:
//   1. Writes a structured pre-turn snapshot (system prompt, history, tools, SDK params)
//   2. Appends live stream events as they fire
//   3. Records fallback-parser activity and final usage stats

import { writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelMessage, LanguageModel } from "ai";

// ─── Formatting helpers ──────────────────────────────────────────────────────

const HR = (label: string) =>
  `\n${"═".repeat(70)}\n  ${label}\n${"═".repeat(70)}`;

const SUB = (label: string) =>
  `\n${"─".repeat(60)}\n  ${label}\n${"─".repeat(60)}`;

// ─── Static tool-schema metadata ─────────────────────────────────────────────
//
// Manually described because the Vercel AI SDK doesn't expose a public API
// to serialise tool schemas at runtime. These descriptions are only used for
// the debug log — they have zero effect on what the LLM actually sees.

const TOOL_SCHEMAS = [
  {
    name: "readFile",
    description: "Read the full contents of a file from disk.",
    parameters: { path: "string — absolute or relative file path" },
    returnShape: "{ success: true, contents: string } | { success: false, error: string }",
    howPassed: "LLM emits a structured tool-call JSON block. SDK intercepts it, calls execute(), and feeds { success, contents } back as a tool-result message before the next LLM token.",
  },
  {
    name: "writeFile",
    description: "Create a new file or fully overwrite an existing one.",
    parameters: { path: "string — target file path", contents: "string — full file content" },
    returnShape: "{ success: true, message: string } | { success: false, error: string }",
    howPassed: "Same tool-call / tool-result cycle. Path is resolved to absolute via path.resolve(cwd, inputPath) inside execute().",
  },
  {
    name: "editFile",
    description: "Replace exactly one unique occurrence of old_string with new_string.",
    parameters: { path: "string", old_string: "string — must be unique in file", new_string: "string — replacement" },
    returnShape: "{ success: true, message } | { success: false, error }",
    howPassed: "Same cycle. execute() reads file, counts occurrences, errors if 0 or >1.",
  },
  {
    name: "glob",
    description: "Find files by filename pattern (e.g. '*.ts') recursively from cwd.",
    parameters: { pattern: "string — simple glob like '*.ts'" },
    returnShape: "{ success: true, files: string[] } — capped at 50 results",
    howPassed: "Pure in-process function using readdirSync. No subprocess. Skips node_modules/.git/dist.",
  },
  {
    name: "grep",
    description: "Search file contents by text pattern.",
    parameters: { query: "string" },
    returnShape: "{ success: true, matches: Array<{file,line,content}> }",
    howPassed: "Walks filesystem with readdirSync, reads each file, does string indexOf search.",
  },
  {
    name: "listDir",
    description: "List immediate children of a directory.",
    parameters: { path: "string? — defaults to cwd root" },
    returnShape: "{ success: true, directory: string, entries: Array<{name, type: 'file'|'dir'}> }",
    howPassed: "Uses readdirSync + statSync on the resolved absolute path.",
  },
  {
    name: "openFile",
    description: "Open a file in the OS default application (HTML → browser).",
    parameters: { path: "string" },
    returnShape: "{ success: true, message } | { success: false, error }",
    howPassed: "Spawns platform open command (start/open/xdg-open) detached so it doesn't block the agent loop.",
  },
  {
    name: "runBash",
    description: "Execute a shell command after explicit user approval.",
    parameters: { command: "string — the shell command" },
    returnShape: "{ success: true, output: string } | { success: false, error }",
    howPassed: "ConfirmFn suspends the agent loop (via Promise) until user presses y/n in the TUI. If approved, uses child_process.exec with 15s timeout + 1MB buffer.",
  },
  {
    name: "runBackground",
    description: "Execute a shell command in the background (non-blocking).",
    parameters: { command: "string — the shell command" },
    returnShape: "{ success: true, taskId: string, pid?: number } | { success: false, error: string }",
    howPassed: "Uses child_process.spawn to run command in the background, registers it in the task registry.",
  },
  {
    name: "manageTasks",
    description: "Manage background tasks spawned in the session.",
    parameters: { action: "'list' | 'kill' | 'logs'", taskId: "string" },
    returnShape: "{ success: true, ... } | { success: false, error: string }",
    howPassed: "Queries active background task list, logs buffer, or terminates a task.",
  },
  {
    name: "managePorts",
    description: "Find or terminate processes listening on a port.",
    parameters: { action: "'find' | 'kill'", port: "number" },
    returnShape: "{ success: true, ... } | { success: false, error: string }",
    howPassed: "Invokes platform commands (netstat, taskkill, lsof, kill) to find or stop processes on local ports.",
  },
  {
    name: "fileOperations",
    description: "Perform filesystem operations natively (delete, copy, move, create directories).",
    parameters: { action: "'delete' | 'createDirectory' | 'copy' | 'move'", source: "string", destination: "string" },
    returnShape: "{ success: true, message: string } | { success: false, error: string }",
    howPassed: "Uses Node fs methods directly to modify directories and files.",
  },
];

// ─── TurnLogger class ────────────────────────────────────────────────────────

export class TurnLogger {
  private logPath: string;

  constructor() {
    this.logPath = resolve(process.cwd(), "zizou-debug.log");
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private append(text: string): void {
    try {
      appendFileSync(this.logPath, text + "\n", "utf-8");
    } catch {
      /* best-effort — never crash the agent loop */
    }
  }

  // ── Pre-turn snapshot ────────────────────────────────────────────────────
  //
  // Writes the full pre-turn context to disk: system prompt, conversation
  // history, tool schemas, and SDK call parameters. The file is overwritten
  // at the start of each new user turn so it always reflects the most
  // recent interaction only.

  writePreTurn(opts: {
    model: LanguageModel;
    history: ModelMessage[];
    systemPrompt?: string;
    maxSteps: number;
  }): void {
    const { model, history, systemPrompt, maxSteps } = opts;

    try {
      const lines: string[] = [
        HR(`ZIZOU VERBOSE DEBUG LOG  ·  ${new Date().toISOString()}`),
        `  cwd              : ${process.cwd()}`,
        `  model (provider) : ${(model as any)?.modelId ?? (model as any)?.model ?? "unknown"}`,
        `  history messages : ${history.length}`,
        `  maxSteps         : ${maxSteps}`,
        `  system prompt    : ${(systemPrompt?.length ?? 0).toLocaleString()} chars / ${(systemPrompt ?? "").split("\n").length} lines`,
        "",

        // 1 — SYSTEM PROMPT
        SUB("1 · SYSTEM PROMPT (full text)"),
        systemPrompt ?? "(none — no system prompt was provided)",
        "",

        // 2 — SYSTEM PROMPT SECTION BREAKDOWN
        SUB("2 · SYSTEM PROMPT SECTION BREAKDOWN"),
        ...this.breakdownSystemPrompt(systemPrompt),
        "",

        // 3 — CONVERSATION HISTORY
        SUB(`3 · CONVERSATION HISTORY (${history.length} messages)`),
        ...this.formatHistory(history),

        // 4 — TOOLS PASSED TO LLM
        SUB(`4 · TOOLS PASSED TO LLM (${TOOL_SCHEMAS.length} total)`),
        "  Each tool is serialised into JSON Schema by the Vercel AI SDK and sent",
        "  alongside the messages in the API request body under the 'tools' key.",
        "  The LLM sees the name, description, and parameter schema — NOT the execute().",
        "  It can then request a tool call by name and the SDK dispatches it locally.",
        "",
        ...TOOL_SCHEMAS.flatMap((t, i) => [
          `  [tool ${i + 1}] ${t.name}`,
          `           description : ${t.description}`,
          `           parameters  : ${JSON.stringify(t.parameters)}`,
          `           returnShape : ${t.returnShape}`,
          `           how it runs : ${t.howPassed}`,
          "",
        ]),

        // 5 — SDK CALL PARAMETERS
        SUB("5 · SDK CALL PARAMETERS"),
        "  streamText() is called with:",
        `    model       : resolved LanguageModel object (provider-specific)`,
        `    system      : the system prompt above`,
        `    messages    : the ${history.length} history messages above`,
        `    tools       : the ${TOOL_SCHEMAS.length} tool definitions above`,
        `    stopWhen    : stepCountIs(${maxSteps})  ← safety cap on tool-call rounds`,
        "",
        "  The fullStream async iterator is consumed to get events in real time.",
        "  Each tool-call event from the LLM causes the SDK to call execute()",
        "  synchronously, then inject a tool-result message before re-prompting.",
        "",

        // 6 — LIVE STREAM header (events appended below as they fire)
        SUB("6 · LIVE STREAM EVENTS (appended as each event fires)"),
        `  Turn started at: ${new Date().toISOString()}`,
        "",
      ];

      writeFileSync(this.logPath, lines.join("\n"), "utf-8");
    } catch {
      /* best-effort */
    }
  }

  // ── Live stream events ───────────────────────────────────────────────────

  logStepStart(stepIndex: number): void {
    const ts = new Date().toISOString();
    this.append(`  [${ts}]  STEP-START     step=${stepIndex}`);
    this.append(`             The SDK is starting a new internal round trip.`);
    this.append(`             All tool-calls below belong to step ${stepIndex} until STEP-FINISH.`);
    this.append("");
  }

  logStepFinish(stepIndex: number, finishReason: string, usage: unknown): void {
    const ts = new Date().toISOString();
    this.append(`  [${ts}]  STEP-FINISH    step=${stepIndex}  finishReason="${finishReason}"`);
    this.append(`             stepUsage=${JSON.stringify(usage ?? {})}`);
    this.append("");
  }

  logTextDelta(text: string): void {
    const ts = new Date().toISOString();
    this.append(`  [${ts}]  TEXT-DELTA     chars=${text.length}  fragment="${text.replace(/\n/g, "\\n").slice(0, 80)}"`);
  }

  logToolCall(toolName: string, toolCallId: string, input: unknown): void {
    const ts = new Date().toISOString();
    const inputJson = JSON.stringify(input ?? {}, null, 2);
    this.append(`  [${ts}]  TOOL-CALL      ► ${toolName}  (id=${toolCallId})`);
    this.append(`             The LLM output a tool-call token for "${toolName}".`);
    this.append(`             The SDK intercepts this and will call execute() locally.`);
    this.append(`             INPUT ARGUMENTS:`);
    inputJson.split("\n").forEach(l => this.append("               " + l));
    this.append("");
  }

  logToolResult(toolName: string, toolCallId: string, output: unknown): void {
    const ts = new Date().toISOString();
    const resultJson = JSON.stringify(output, null, 2);
    const preview = resultJson.length > 600 ? resultJson.slice(0, 600) + "\n  … (truncated)" : resultJson;
    this.append(`  [${ts}]  TOOL-RESULT    ◄ ${toolName}  (id=${toolCallId})`);
    this.append(`             execute() finished. Result injected as a tool-result message`);
    this.append(`             in the conversation before the LLM continues generating.`);
    this.append(`             RESULT OUTPUT:`);
    preview.split("\n").forEach(l => this.append("               " + l));
    this.append("");
  }

  logToolError(toolName: string, toolCallId: string, error: unknown): void {
    const ts = new Date().toISOString();
    this.append(`  [${ts}]  TOOL-ERROR     ✗ ${toolName}  (id=${toolCallId})`);
    this.append(`             execute() THREW an exception (not a controlled error return).`);
    this.append(`             ERROR: ${String(error)}`);
    this.append("");
  }

  logFinish(finishReason: string, usage: unknown): void {
    const ts = new Date().toISOString();
    this.append(`  [${ts}]  FINISH         finishReason="${finishReason}"`);
    this.append(`             usage=${JSON.stringify(usage ?? {})}`);
    this.append(`             The LLM has stopped generating for this turn.`);
    this.append("");
  }

  // ── Fallback parser events ───────────────────────────────────────────────

  logFallbackIntercept(toolName: string): void {
    this.append(`  [FALLBACK PARSER] Intercepted raw JSON tool call for "${toolName}"`);
  }

  logFallbackExecTime(ms: number): void {
    this.append(`  [FALLBACK PARSER] Tool execution took ${ms}ms`);
  }

  logFallbackExecError(error: string): void {
    this.append(`  [FALLBACK PARSER] Tool execution THREW: ${error}`);
  }

  logFallbackRecurse(maxSteps: number): void {
    this.append(`  [FALLBACK PARSER] Recursively calling runTurn with maxSteps=${maxSteps}`);
  }

  logFallbackCombinedUsage(inputTokens: number, outputTokens: number): void {
    this.append(`  [FALLBACK PARSER] COMBINED USAGE: inputTokens=${inputTokens}  outputTokens=${outputTokens}`);
  }

  // ── Turn end ─────────────────────────────────────────────────────────────

  logTurnEnd(): void {
    this.append(`  Turn ended at: ${new Date().toISOString()}`);
    this.append("");
  }

  logFinalUsage(inputTokens: number, outputTokens: number): void {
    this.append(`  FINAL USAGE: inputTokens=${inputTokens}  outputTokens=${outputTokens}  total=${inputTokens + outputTokens}`);
  }

  // ── Private formatting methods ───────────────────────────────────────────

  private breakdownSystemPrompt(prompt?: string): string[] {
    if (!prompt) return ["  (no system prompt)"];

    const sections: string[] = [];
    if (prompt.includes("You are Zizou"))
      sections.push("  ✓ BASE_INSTRUCTIONS  — Agent identity, file-editing rules, tool usage rules");
    if (prompt.includes("SESSION CONTEXT")) {
      const cwdMatch = prompt.match(/Workspace root \(cwd\): (.+)/);
      sections.push(`  ✓ SESSION_CONTEXT    — Live workspace root: ${cwdMatch?.[1] ?? "unknown"}`);
    }
    if (prompt.includes("TOOL GUIDE"))
      sections.push("  ✓ TOOL GUIDE         — Per-tool documentation embedded in prompt");
    if (prompt.includes("REPO MAP")) {
      const mapStart = prompt.indexOf("--- REPO MAP ---");
      const mapEnd = prompt.indexOf("--- END REPO MAP ---");
      const mapLen = mapEnd > mapStart ? mapEnd - mapStart : 0;
      sections.push(`  ✓ REPO MAP           — ${mapLen.toLocaleString()} chars of extracted symbols from the codebase`);
    }
    return sections.length ? sections : ["  (no recognisable sections found)"];
  }

  private formatHistory(history: ModelMessage[]): string[] {
    if (history.length === 0) return ["  (empty — this is the first turn)"];

    return history.flatMap((msg, i) => {
      const role = msg.role.toUpperCase().padEnd(12);
      const idx = `[msg ${String(i).padStart(2, "0")}]`;

      if (typeof msg.content === "string") {
        return [
          `${idx} ROLE: ${role}  TYPE: plain-text string`,
          `       CHARS: ${msg.content.length}`,
          `       CONTENT:`,
          ...msg.content.split("\n").map(l => "         " + l),
          "",
        ];
      }

      if (Array.isArray(msg.content)) {
        return [
          `${idx} ROLE: ${role}  TYPE: content-part array  (${msg.content.length} parts)`,
          ...msg.content.flatMap((part: any, pi: number) => {
            const partLines = [`       [part ${pi}] type="${part.type}"`];
            if (part.type === "text")
              partLines.push(`               text (${part.text?.length ?? 0} chars): ${part.text?.slice(0, 200) ?? ""}${(part.text?.length ?? 0) > 200 ? "…" : ""}`);
            if (part.type === "tool-call")
              partLines.push(
                `               toolCallId="${part.toolCallId}"  toolName="${part.toolName}"`,
                `               input=${JSON.stringify(part.input ?? {}, null, 2).replace(/\n/g, "\n               ")}`,
              );
            if (part.type === "tool-result")
              partLines.push(
                `               toolCallId="${part.toolCallId}"  isError=${part.isError ?? false}`,
                `               result=${JSON.stringify(part.result ?? part.output, null, 2).slice(0, 400)}`,
              );
            return partLines;
          }),
          "",
        ];
      }

      return [`${idx} ROLE: ${role}  (unknown content shape)`, `       ${JSON.stringify(msg).slice(0, 300)}`, ""];
    });
  }
}
