// src/agent/executor.ts
//
// LAYER: agent/
//
// Step-scoped execution wrapper — takes a single PlanStep and executes it
// by driving the existing runTurn() agent loop with a scoped context.
//
// PURPOSE:
//   The executor is the module that actually DOES things: reads files,
//   writes code, runs commands. It receives one PlanStep at a time from
//   the orchestrator, builds a focused context for just that step, calls
//   runTurn(), and collects the results (which files were touched, which
//   tool calls were made) into a StepResult for the verifier to check.
//
// KEY DESIGN DECISIONS:
//   1. STEP-SCOPED CONTEXT: Each step gets a fresh, minimal context.
//      The system prompt includes only the step's description and target
//      files, not the full plan. This keeps the context window focused
//      and prevents the model from "wandering" into other steps.
//   2. TOOL CALL TRACKING: As the runTurn() stream emits tool-call and
//      tool-result events, the executor captures them to build the
//      claimedFiles list (from writeFile/editFile calls) and the full
//      toolCallsMade log. The verifier uses these.
//   3. BOTH MODES: The executor is used in both build mode (single step
//      from raw prompt) and plan mode (one step at a time from the plan).
//
// CONTEXT:
//   Calls buildSystemPrompt({ role: "executor" }) — repo map follows
//   existing budget scaling (excluded under "light" budget). The executor
//   works from explicit targetFiles, so it doesn't need the full repo
//   overview when running lean.
//
// DEPENDENCY DIRECTION: imports from agent/run-turn.ts, agent/types.ts,
// context/. Must NOT import from ui/, config/, or provider/.

import { type LanguageModel, type ModelMessage } from "ai";
import { buildSystemPrompt, type AgentRole } from "../context/build-system-prompt.js";
import { runTurn, extractRawToolCall, type AgentEvent } from "./run-turn.js";
import type { ConfirmFn } from "../tools/types.js";
import type { PlanStep, StepResult, ToolCall, ProjectContext } from "./types.js";
import { SessionLogger } from "./debug/index.js";
import { captureFileState } from "../checkpoint/patcher.js";
import {
  readFile,
  createWriteFileTool,
  createEditFileTool,
  glob,
  grep,
  listDir,
  openFile,
  addFileToContext,
  createRunBashTool,
  createRunBackgroundTool,
  manageTasks,
  managePorts,
  createFileOperationsTool,
} from "../tools/index.js";

// ─── Step Prompt Builder ─────────────────────────────────────────────────────
//
// Constructs the user message for the executor. This is NOT the system
// prompt — it's the "user" message that tells the model what specific
// step to execute. The system prompt comes from buildSystemPrompt().

/**
 * Builds a focused user message for a single step execution.
 * Includes the step description and target files so the model knows
 * exactly what to do without needing the full plan context.
 */
function buildStepPrompt(step: PlanStep): string {
  let prompt = `Execute the following task:\n\n${step.description}`;

  if (step.targetFiles.length > 0) {
    prompt += `\n\nTarget files to create or modify:\n`;
    for (const file of step.targetFiles) {
      prompt += `  - ${file}\n`;
    }
    prompt += `\nFocus ONLY on the files listed above. Do not modify other files.`;
  }

  return prompt;
}

// ─── File Extraction from Tool Calls ─────────────────────────────────────────
//
// Extracts the list of files the executor claims to have modified from
// the tool call stream. We look at writeFile and editFile calls specifically,
// since those are the tools that modify the filesystem.

/**
 * Checks if a tool call is a file-modifying operation and extracts the
 * target file path if so.
 */
function extractFileFromToolCall(toolName: string, input: unknown): string | null {
  // writeFile and editFile both take a "path" or "filePath" parameter
  // that tells us which file was modified.
  if (toolName === "writeFile" || toolName === "editFile") {
    if (typeof input === "object" && input !== null) {
      const obj = input as Record<string, unknown>;
      // The AI SDK tool definitions use "path" for both writeFile and editFile
      const filePath = obj.path ?? obj.filePath ?? obj.file;
      if (typeof filePath === "string") return filePath;
    }
  }
  return null;
}

// ─── Main Execute Function ───────────────────────────────────────────────────

/**
 * Executes a single PlanStep and returns a StepResult.
 *
 * This is the core execution function used in both modes:
 *   - Build mode: orchestrator synthesizes a single step, calls this once.
 *   - Plan mode: orchestrator calls this for each step in dependency order.
 *
 * The function drives runTurn() with a step-scoped context and captures
 * the tool call stream to build the StepResult.
 *
 * @param step - The plan step to execute.
 * @param context - Ambient project info (root, prompt, budget).
 * @param model - The resolved LLM to use for execution.
 * @param onConfirm - Callback for user confirmation of shell commands.
 * @param onEvent - Optional callback to forward agent events to the UI.
 *                  The orchestrator uses this to stream events to Chat.tsx.
 * @returns StepResult with claimed files and tool call log.
 */
export async function executeStep(
  step: PlanStep,
  context: ProjectContext,
  model: LanguageModel,
  onConfirm: ConfirmFn,
  onEvent?: (event: AgentEvent) => void,
): Promise<StepResult> {
  // Build a system prompt with the executor role — repo map follows
  // existing budget scaling (excluded under "light").
  const systemPrompt = await buildSystemPrompt(
    context.projectRoot,
    "executor" as AgentRole,
    step.targetFiles,
  );

  // Build the step-specific user message
  const stepPrompt = buildStepPrompt(step);

  SessionLogger.logExecutorStepStart(step, context.budget);
  SessionLogger.logExecutorStepLLM(systemPrompt, stepPrompt);

  // Initialize the conversation history with just the step prompt.
  // Each step gets a fresh conversation — no carryover from previous
  // steps. This prevents context pollution and keeps the model focused.
  const history: ModelMessage[] = [
    { role: "user", content: stepPrompt },
  ];

  // Tracking collections for building the StepResult
  const claimedFiles = new Set<string>();
  const toolCallsMade: ToolCall[] = [];
  const agentEvents: AgentEvent[] = [];
  const oldFileStates = new Map<string, string | null>();
  let fullResponseText = "";

  // ── Conversation history tracking for subsequent rounds ─────────────────────
  const loggedHistory: ModelMessage[] = [
    { role: "user", content: stepPrompt }
  ];
  let roundIndex = 1;
  let currentAssistantParts: any[] = [];
  let currentToolParts: any[] = [];

  // Track in-progress tool calls so we can pair call → result
  const pendingToolCalls = new Map<string, { toolName: string; input: unknown }>();

  // ── Drive the runTurn loop ─────────────────────────────────────────────
  //
  // runTurn is an async generator that yields AgentEvents. We consume
  // every event, forward it to the UI (if onEvent is provided), and
  // capture tool calls for the StepResult.
  const turn = runTurn({
    history,
    model,
    onConfirm,
    systemPrompt,
    maxSteps: 15,
  });

  let result = await turn.next();
  while (!result.done) {
    const event = result.value;

    // Forward the event to the UI so the user sees real-time progress
    if (onEvent) {
      onEvent(event);
    }

    // ── Round Transition Detection ───────────────────────────────────
    // If we receive a new text chunk or tool-call but we have already
    // executed tools in the previous round, we are transitioning to a
    // new LLM request.
    if ((event.kind === "text-delta" || event.kind === "tool-call") && currentToolParts.length > 0) {
      loggedHistory.push({ role: "assistant", content: [...currentAssistantParts] });
      loggedHistory.push({ role: "tool", content: [...currentToolParts] });
      currentAssistantParts = [];
      currentToolParts = [];
      roundIndex++;
      SessionLogger.logLLMRoundStart(roundIndex, systemPrompt, loggedHistory);
    }

    // ── Log high-level events to session log (silencing text-deltas) ──
    if (event.kind === "text-delta") {
      fullResponseText += event.text;

      // Accumulate text part for history tracking
      let textPart = currentAssistantParts.find(p => p.type === "text");
      if (!textPart) {
        textPart = { type: "text", text: "" };
        currentAssistantParts.unshift(textPart); // Keep text at the beginning
      }
      textPart.text += event.text;
    } else if (event.kind === "tool-call") {
      const argsStr = JSON.stringify(event.input, null, 2);
      SessionLogger.logExecutorStreamEvent(
        `\n  [TOOL CALL INITIATED]\n` +
        `    Tool Name: ${event.toolName}\n` +
        `    ID       : ${event.toolCallId}\n` +
        `    How Sent : Sent via native JSON tool-calling protocol (function calling) in LLM API payload\n` +
        `    Arguments:\n` +
        argsStr.split("\n").map(l => `      ${l}`).join("\n") + "\n"
      );

      // Accumulate tool-call part for history tracking
      currentAssistantParts.push({
        type: "tool-call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.input
      });
    } else if (event.kind === "tool-result") {
      const outputStr = JSON.stringify(event.output, null, 2);
      const outputPreview = outputStr.length > 2000 ? outputStr.slice(0, 2000) + "\n      ... (truncated)" : outputStr;
      SessionLogger.logExecutorStreamEvent(
        `\n  [TOOL CALL COMPLETED]\n` +
        `    Tool Name: ${event.toolName}\n` +
        `    ID       : ${event.toolCallId}\n` +
        `    Result   :\n` +
        outputPreview.split("\n").map(l => `      ${l}`).join("\n") + "\n"
      );

      // Accumulate tool-result part for history tracking
      currentToolParts.push({
        type: "tool-result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.output,
        isError: false
      });
    } else if (event.kind === "tool-error") {
      SessionLogger.logExecutorStreamEvent(
        `\n  [TOOL CALL ERROR]\n` +
        `    Tool Name: ${event.toolName}\n` +
        `    ID       : ${event.toolCallId}\n` +
        `    Error    : ${String(event.error)}\n`
      );

      // Accumulate tool-error part as tool-result for history tracking
      currentToolParts.push({
        type: "tool-result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: { error: String(event.error) },
        isError: true
      });
    } else if (event.kind === "finish") {
      SessionLogger.logExecutorStreamEvent(`\n  [LLM FINISHED GENERATION] usage=${JSON.stringify(event.usage ?? {})}\n`);
    }

    // ── Capture tool calls ───────────────────────────────────────────
    if (event.kind === "tool-call") {
      // Record the pending tool call so we can pair it with its result
      pendingToolCalls.set(event.toolCallId, {
        toolName: event.toolName,
        input: event.input,
      });

      // Check if this is a file-modifying tool call and track the file
      const filePath = extractFileFromToolCall(event.toolName, event.input);
      if (filePath) {
        claimedFiles.add(filePath);
        if (!oldFileStates.has(filePath)) {
          oldFileStates.set(filePath, captureFileState(filePath));
        }
      }
    }

    // ── Capture tool results ─────────────────────────────────────────
    if (event.kind === "tool-result") {
      const pending = pendingToolCalls.get(event.toolCallId);
      if (pending) {
        toolCallsMade.push({
          toolName: pending.toolName,
          toolCallId: event.toolCallId,
          input: pending.input,
          output: event.output,
        });
        pendingToolCalls.delete(event.toolCallId);
      }
    }

    // ── Capture tool errors (still record the call, with error output)
    if (event.kind === "tool-error") {
      const pending = pendingToolCalls.get(event.toolCallId);
      if (pending) {
        toolCallsMade.push({
          toolName: pending.toolName,
          toolCallId: event.toolCallId,
          input: pending.input,
          output: { error: String(event.error) },
        });
        pendingToolCalls.delete(event.toolCallId);
      }
    }

    // ── Capture all agent events for usage tracking ───────────────────
    agentEvents.push(event);

    result = await turn.next();
  }

  // ── Fallback: pseudo-call parser for malformed tool calls ──────────────
  //
  // If runTurn() yielded zero native tool calls but the model emitted text
  // containing a <function/...> pseudo-tag or raw JSON tool-call block,
  // we parse it, execute the tool, and record it. This only fires when
  // there were ZERO native calls — never alongside or after a successful one.

  if (toolCallsMade.length === 0 && fullResponseText.trim().length > 0) {
    const fallback = extractRawToolCall(fullResponseText);
    if (fallback) {
      // Build a local tool map for lookup (mirrors the one in runTurn)
      const fallbackTools: Record<string, any> = {
        readFile,
        writeFile: createWriteFileTool(onConfirm),
        editFile: createEditFileTool(onConfirm),
        glob,
        grep,
        listDir,
        openFile,
        addFileToContext,
        runBash: createRunBashTool(onConfirm),
        runBackground: createRunBackgroundTool(onConfirm),
        manageTasks,
        managePorts,
        fileOperations: createFileOperationsTool(onConfirm),
      };

      const tool = fallbackTools[fallback.name];
      if (tool) {
        const toolCallId = `fallback_${Math.random().toString(36).slice(2, 9)}`;

        // Emit tool-call event to the UI
        if (onEvent) {
          onEvent({ kind: "tool-call", toolCallId, toolName: fallback.name, input: fallback.arguments });
        }

        // Log initiation with FALLBACK marker
        const argsStr = JSON.stringify(fallback.arguments, null, 2);
        SessionLogger.logExecutorStreamEvent(
          `\n  [FALLBACK PSEUDO-CALL PARSED — not a native tool call]\n` +
          `    Tool Name: ${fallback.name}\n` +
          `    ID       : ${toolCallId}\n` +
          `    How Sent : Parsed from raw text via fallback pseudo-call parser\n` +
          `    Arguments:\n` +
          argsStr.split("\n").map(l => `      ${l}`).join("\n") + "\n"
        );

        // Record into claimedFiles and capture pre-execution state before executing
        const filePath = extractFileFromToolCall(fallback.name, fallback.arguments);
        if (filePath) {
          claimedFiles.add(filePath);
          if (!oldFileStates.has(filePath)) {
            oldFileStates.set(filePath, captureFileState(filePath));
          }
        }

        let output: any;
        let success = true;
        try {
          output = await tool.execute(fallback.arguments, { toolCallId, messages: history });

          // Emit tool-result event
          if (onEvent) {
            onEvent({ kind: "tool-result", toolCallId, toolName: fallback.name, output });
          }
        } catch (e) {
          success = false;
          output = { error: String(e) };

          // Emit tool-error event
          if (onEvent) {
            onEvent({ kind: "tool-error", toolCallId, toolName: fallback.name, error: e });
          }
        }

        // Log the full fallback interception via SessionLogger
        SessionLogger.logFallbackToolCall(
          fallback.name,
          fallback.arguments,
          output,
          fullResponseText.slice(0, 500),
          success,
        );

        toolCallsMade.push({
          toolName: fallback.name,
          toolCallId,
          input: fallback.arguments,
          output,
        });

        agentEvents.push(
          { kind: "tool-call", toolCallId, toolName: fallback.name, input: fallback.arguments },
          success
            ? { kind: "tool-result", toolCallId, toolName: fallback.name, output }
            : { kind: "tool-error", toolCallId, toolName: fallback.name, error: output },
        );
      }
    }
  }

  const finalResult = {
    stepIndex: step.index,
    claimedFiles: Array.from(claimedFiles),
    toolCallsMade,
    agentEvents,
    oldFileStates,
  };

  SessionLogger.logExecutorStepEnd({
    ...finalResult,
    fullResponseText,
  });

  // Return the StepResult for the verifier to check
  return finalResult;
}
