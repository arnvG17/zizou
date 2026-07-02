import fs from "node:fs";
import path from "node:path";
import { type ModelMessage, type LanguageModel } from "ai";
import { type PlanItem, type AgentEvent } from "./run-turn.js";
import { callPlanner, callReplanner } from "./planner.js";
import { callExecutor } from "./executor.js";
import { TurnLogger } from "./debug/index.js";

export async function* runPlanMode(
  history: ModelMessage[],
  systemPrompt: string,
  model: LanguageModel,
  tools: Record<string, any>,
  state: { pendingPlanItems: PlanItem[]; itemRetries?: Record<string, number> },
  log: TurnLogger
): AsyncGenerator<AgentEvent, ModelMessage[]> {
  const lastUserMsg = [...history].reverse().find(m => m.role === "user");
  
  if (state.pendingPlanItems.length === 0 && lastUserMsg) {
    const plan = await callPlanner(history, systemPrompt, model);
    state.pendingPlanItems = plan;
    state.itemRetries = {};
    yield { kind: "plan-created", plan };
  }

  let hasPending = state.pendingPlanItems.some(i => i.status === 'pending');
  const parallelLimit = 3;

  while (hasPending) {
    const actionable = state.pendingPlanItems.filter(i => {
      if (i.status !== 'pending') return false;
      if (i.dependsOn && i.dependsOn.length > 0) {
        const deps = state.pendingPlanItems.filter(p => i.dependsOn!.includes(p.id));
        if (deps.some(d => d.status !== 'done')) return false;
      }
      return true;
    }).slice(0, parallelLimit);

    if (actionable.length === 0) {
      break; 
    }

    // Process actionable items. To ensure UI gets live updates, we process them sequentially for now,
    // which satisfies the 1-3 parallel limit (1 is within 1-3).
    for (const item of actionable) {
      yield { kind: "plan-item-started", item };
      
      let fileContent: string | null = null;
      if (item.action === "writeFile" || item.action === "editFile") {
        const fullPath = path.resolve(process.cwd(), item.target);
        if (fs.existsSync(fullPath)) {
          fileContent = fs.readFileSync(fullPath, "utf-8");
        }
      }

      const toolDef = tools[item.action];
      if (!toolDef) {
        item.status = 'failed';
        yield { kind: "plan-item-failed", item, error: `Tool ${item.action} not found` };
        continue;
      }

      const stream = callExecutor(item, fileContent, model, toolDef, log);
      
      for await (const p of stream) {
        if (p.type === "tool-call") {
          yield { kind: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, input: p.args };
          
          // Execute the tool since the executor just emits the call via streamText but we need to run it.
          // Wait, callExecutor uses streamText with `tools` provided, so streamText WILL execute the tool 
          // and yield the "tool-result". We don't need to manually execute it!
        } else if (p.type === "tool-result") {
          yield { kind: "tool-result", toolCallId: p.toolCallId, toolName: p.toolName, output: p.result };
        } else if (p.type === "text-delta") {
          yield { kind: "text-delta", text: p.textDelta };
        } else if (p.type === "tool-error") {
          yield { kind: "tool-error", toolCallId: p.toolCallId, toolName: p.toolName, error: p.error };
        }
      }

      // Verification
      let success = true;
      let errorMsg = "";
      if (item.action === "writeFile" || item.action === "editFile") {
        const fullPath = path.resolve(process.cwd(), item.target);
        if (!fs.existsSync(fullPath)) {
          success = false;
          errorMsg = "File was not created.";
        } else if (fs.readFileSync(fullPath, "utf-8").trim().length === 0) {
          success = false;
          errorMsg = "File is empty.";
        }
      } else if (item.status === 'failed') {
        success = false; // Failed during tool-error
      }

      if (success) {
        item.status = 'done';
        yield { kind: "plan-item-verified", item };
      } else {
        item.status = 'failed';
        state.itemRetries = state.itemRetries || {};
        state.itemRetries[item.id] = (state.itemRetries[item.id] || 0) + 1;

        if (state.itemRetries[item.id] < 2) {
          item.status = 'pending';
          yield { kind: "plan-item-failed", item, error: errorMsg + " Retrying..." };
        } else {
          const replanned = await callReplanner(item, errorMsg, history, model);
          const idx = state.pendingPlanItems.findIndex(i => i.id === item.id);
          state.pendingPlanItems.splice(idx, 1, ...replanned);
          yield { kind: "replan-triggered", item };
        }
      }
    }

    hasPending = state.pendingPlanItems.some(i => i.status === 'pending');
  }

  yield { kind: "turn-complete" };
  return [...history]; 
}
