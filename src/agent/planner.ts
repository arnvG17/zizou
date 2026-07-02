import { generateObject, type ModelMessage, type LanguageModel } from "ai";
import { z } from "zod";
import { type PlanItem } from "./run-turn.js";

const planItemSchema = z.object({
  id: z.string().describe("Unique identifier for this plan item"),
  action: z.enum([
    "readFile", "writeFile", "editFile", "glob", "grep", 
    "listDir", "openFile", "addFileToContext", "runBash", 
    "runBackground", "manageTasks", "managePorts", "fileOperations"
  ]).describe("The specific tool action to execute"),
  target: z.string().describe("The primary target (file path, glob pattern, or command string)"),
  spec: z.string().describe("Natural-language specification of what this step should do. Must be detailed enough for an executor to implement independently."),
  dependsOn: z.array(z.string()).optional().describe("Array of parent item IDs that must complete before this item can start"),
});

export async function callPlanner(
  history: ModelMessage[],
  systemPrompt: string,
  model: LanguageModel
): Promise<PlanItem[]> {
  const enhancedSystemPrompt = systemPrompt + "\n\n" + 
    "You are the PLANNER. Your task is to analyze the user request and output a structured execution plan. " +
    "You do not execute tools yourself. You break the task into independent, actionable items for the EXECUTOR. " +
    "For file modifications, prefer multiple small edits over full rewrites. Ensure 'dependsOn' is set correctly for sequential dependencies.";

  const result = await generateObject({
    model,
    system: enhancedSystemPrompt,
    messages: history,
    schema: z.object({
      plan: z.array(planItemSchema).describe("The sequence of plan items to execute")
    }),
  });

  return result.object.plan.map(item => ({
    ...item,
    status: 'pending' as const
  }));
}

export async function callReplanner(
  item: PlanItem,
  failureContext: string,
  history: ModelMessage[],
  model: LanguageModel
): Promise<PlanItem[]> {
  const replanPrompt = `The executor failed to complete a plan item twice. \n\n` +
    `Item ID: ${item.id}\nAction: ${item.action}\nTarget: ${item.target}\nSpec: ${item.spec}\n\n` +
    `Failure context: ${failureContext}\n\n` +
    `Please provide a revised plan item, or split it into smaller steps if necessary. Return the new plan items to replace the failed one.`;

  const result = await generateObject({
    model,
    system: "You are the RE-PLANNER. Your job is to fix a failing plan item by returning revised items.",
    messages: [
      ...history,
      { role: "user", content: replanPrompt }
    ],
    schema: z.object({
      plan: z.array(planItemSchema)
    }),
  });

  return result.object.plan.map(item => ({
    ...item,
    status: 'pending' as const
  }));
}
