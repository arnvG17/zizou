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
  createReadFileTool,
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
 * Extracts file paths recently referenced in conversation history from tool calls.
 * Looks at readFile, openFile, editFile, and writeFile calls to determine which
 * files the user has been working with. This resolves deictic references like
 * "that file", "edit it", "the file I just opened", etc.
 */
function extractRecentFileReferences(history?: ModelMessage[]): string[] {
  if (!history || history.length === 0) return [];

  const files = new Set<string>();
  for (const msg of history) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const anyPart = part as any;
      if (anyPart.type === "tool-call") {
        const toolName = anyPart.toolName;
        if (
          toolName === "readFile" ||
          toolName === "openFile" ||
          toolName === "editFile" ||
          toolName === "writeFile"
        ) {
          const path =
            anyPart.args?.path ??
            anyPart.args?.filePath ??
            anyPart.args?.file ??
            anyPart.input?.path ??
            anyPart.input?.filePath;
          if (typeof path === "string") {
            files.add(path);
          }
        }
      }
    }
  }
  return Array.from(files);
}

/**
 * Builds a focused user message for a single step execution.
 * Includes the step description and target files so the model knows
 * exactly what to do without needing the full plan context.
 *
 * When conversationHistory is provided (build mode), extracts recently
 * referenced files so deictic references ("that file", "edit it") resolve
 * correctly even though the executor gets a fresh prompt.
 */
function buildStepPrompt(step: PlanStep, conversationHistory?: ModelMessage[]): string {
  let prompt = `Task: ${step.description}\n\nCall a tool to begin immediately. Do not ask clarifying questions.`;

  if (step.targetFiles.length > 0) {
    prompt += `\n\nTarget files to create or modify:\n`;
    for (const file of step.targetFiles) {
      prompt += `  - ${file}\n`;
    }
    prompt += `\nFocus ONLY on the files listed above. Do not modify other files.`;
  }

  // In build mode, if the step has no explicit targetFiles but prior tool calls
  // referenced files, include them as context so "that file" / "it" resolves.
  if (step.targetFiles.length === 0 && conversationHistory) {
    const recentFiles = extractRecentFileReferences(conversationHistory);
    if (recentFiles.length > 0) {
      prompt += `\n\nRecently referenced files from this conversation:\n`;
      for (const file of recentFiles) {
        prompt += `  - ${file}\n`;
      }
      prompt += `\nIf the task refers to "that file", "it", or "the file", it likely means one of the files listed above.`;
    }
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
  provider?: string,
  conversationHistory?: ModelMessage[],
): Promise<StepResult> {
  // Build a system prompt with the executor role — repo map follows
  // existing budget scaling (excluded under "light").
  const systemPrompt = await buildSystemPrompt(
    context.projectRoot,
    "executor" as AgentRole,
    step.targetFiles,
  );


  // Build the step-specific user message, passing conversation history
  // so it can resolve deictic references ("that file", "it") from prior turns.
  const stepPrompt = buildStepPrompt(step, conversationHistory);

  SessionLogger.logExecutorStepStart(step, context.budget);
  SessionLogger.logExecutorStepLLM(systemPrompt, stepPrompt);

  // Initialize the conversation history. If conversationHistory is provided (e.g. build mode),
  // we inherit it and swap the last user message with the enriched stepPrompt.
  // Otherwise, start fresh (plan mode isolation).
  let history: ModelMessage[];
  if (conversationHistory && conversationHistory.length > 0) {
    history = [...conversationHistory];
    const lastMsg = history[history.length - 1];
    if (lastMsg && lastMsg.role === "user") {
      history[history.length - 1] = { ...lastMsg, content: stepPrompt };
    } else {
      history.push({ role: "user", content: stepPrompt });
    }
  } else {
    history = [
      { role: "user", content: stepPrompt },
    ];
  }

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
    provider,
    onConfirm,
    systemPrompt,
    maxSteps: 15,
    temperature: context.temperature,
    maxOutputTokens: context.maxOutputTokens,
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
    // Build a local tool map for lookup (mirrors the one in runTurn)
    const fallbackTools: Record<string, any> = {
      readFile: createReadFileTool(onConfirm),
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

    if (fallback && fallbackTools[fallback.name]) {
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
    } else {
      // Model replied with text only — no tool call, no parseable pseudo-call.
      // This is a legitimate response: a question, clarification, or explanation.
      // Ensure the text is in agentEvents so the UI renders it and the user
      // can reply. Without this, the text was silently swallowed.
      if (!agentEvents.some((e) => e.kind === "text-delta")) {
        agentEvents.push({ kind: "text-delta", text: fullResponseText });
      }
      SessionLogger.logExecutorStreamEvent(
        `\n  [LLM TEXT-ONLY RESPONSE — no tool call made]\n` +
        `    Text: ${fullResponseText.slice(0, 300)}${fullResponseText.length > 300 ? " ... (truncated)" : ""}\n`
      );
    }
  }

  const updatedHistory = cleanHistoryForNextTurn(result.value || []);

  const finalResult = {
    stepIndex: step.index,
    claimedFiles: Array.from(claimedFiles),
    toolCallsMade,
    agentEvents,
    oldFileStates,
    conversationHistory: updatedHistory,
  };

  SessionLogger.logExecutorStepEnd({
    ...finalResult,
    fullResponseText,
  });

  // Return the StepResult for the verifier to check
  return finalResult;
}

/**
 * Cleans the conversation history for subsequent turns by stripping large payloads
 * (like full file contents from readFile or search matches from grep) and leaving only
 * the tool names, file paths referenced, and whether they succeeded/failed.
 */
function cleanHistoryForNextTurn(messages: ModelMessage[]): ModelMessage[] {
  const filePaths = new Map<string, string>();

  // First pass: extract file paths from tool calls
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        const anyPart = part as any;
        if (anyPart.type === "tool-call") {
          const path = anyPart.args?.path || anyPart.args?.filePath || anyPart.args?.file;
          if (typeof path === "string") {
            filePaths.set(anyPart.toolCallId, path);
          }
        }
      }
    }
  }

  // Second pass: clean up content
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) {
      return msg;
    }

    const cleanedContent = msg.content.map((part: any) => {
      if (part.type === "tool-call") {
        // Keep all file-writing/editing arguments intact (including contents)
        // so the model has the code in history.
        return part;
      }

      if (part.type === "tool-result") {
        const toolName = part.toolName;
        const res = part.result;
        let cleanedResult: any = { success: true };

        if (res && typeof res === "object") {
          cleanedResult.success = res.success !== false;
          if (res.error) {
            cleanedResult.error = String(res.error);
          }

          const file = filePaths.get(part.toolCallId) || "unknown";

          if (toolName === "readFile") {
            cleanedResult.file = file;
            cleanedResult.success = res.success !== false;
            // Preserve the code contents so the LLM doesn't need to re-read
            cleanedResult.contents = res.contents; 
            cleanedResult.message = res.success ? "Successfully read file" : "Failed to read file";
          } else if (toolName === "writeFile") {
            cleanedResult.file = file;
            cleanedResult.message = res.success ? "Successfully wrote file" : "Failed to write file";
          } else if (toolName === "editFile") {
            cleanedResult.file = file;
            cleanedResult.message = res.success ? "Successfully edited file" : "Failed to edit file";
          } else if (toolName === "glob") {
            cleanedResult.matches = Array.isArray(res.files) ? res.files : [];
          } else if (toolName === "grep") {
            cleanedResult.matches = Array.isArray(res.matches) 
              ? res.matches.map((m: string) => m.split(":")[0]).filter((v: string, idx: number, self: string[]) => self.indexOf(v) === idx) 
              : [];
          } else if (toolName === "runBash" || toolName === "runBackground") {
            cleanedResult.message = res.success ? "Command completed successfully" : "Command failed";
            if (res.taskId) cleanedResult.taskId = res.taskId;
          } else {
            cleanedResult.message = res.message || (res.success ? "Success" : "Failed");
          }
        } else {
          cleanedResult = { success: !part.isError, message: String(res) };
        }

        return {
          ...part,
          result: cleanedResult,
        };
      }

      return part;
    });

    return {
      ...msg,
      content: cleanedContent,
    };
  }) as ModelMessage[];
}

