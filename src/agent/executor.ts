import { streamText, type ModelMessage, type LanguageModel } from "ai";
import { type PlanItem } from "./run-turn.js";
import { TurnLogger } from "./debug/index.js";

export async function* callExecutor(
  item: PlanItem,
  fileContent: string | null,
  model: LanguageModel,
  toolDef: any,
  log: TurnLogger
): AsyncGenerator<any, void> {
  // We want to force the model to call the specific tool.
  // We provide only this tool to the LLM.
  const tools = {
    [item.action]: toolDef
  };

  const systemPrompt = `You are the EXECUTOR. Your only job is to execute a specific plan item using the provided tool.
You MUST call the tool '${item.action}' to accomplish the following specification:

Plan Item ID: ${item.id}
Action: ${item.action}
Target: ${item.target}
Specification:
${item.spec}

${fileContent !== null ? `Current content of ${item.target}:\n\n${fileContent}\n\n` : ""}

DO NOT output conversational text. Call the tool immediately.`;

  const result = streamText({
    model,
    system: systemPrompt,
    tools,
    toolChoice: "required",
    messages: [
      { role: "user", content: "Execute the plan item." }
    ],
  });

  for await (const part of result.fullStream) {
    // We yield the events so the Orchestrator can handle them and emit AgentEvents
    yield part;
  }
}
