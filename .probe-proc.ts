import { generateRecord } from "./evals/sft/generate.js";
import type { Scenario } from "./evals/sft/types.js";

const s: Scenario = {
  id: "p-server", band: "shell-process", prompt: "start the dev server and confirm it serves",
  fixture: { "README.md": "# x\n" },
  steps: [
    { tool: "service", args: { action: "start", name: "web",
        command: `node -e "require('http').createServer((q,s)=>s.end('hello from the dev server')).listen(process.env.PORT)"`,
        autoPort: true } },
    { tool: "checkUrl", args: { url: "{{serviceUrl}}", service: "web" } },
    { tool: "service", args: { action: "stop", name: "web" } },
  ],
  finalText: "The server is up and serving.",
};
try {
  const r = await generateRecord(s);
  console.log("=== OK ===");
  for (const m of r.messages) {
    if (m.role === "tool") console.log(` ${m.name}:`, m.content.slice(0, 230));
    if (m.role === "assistant" && m.tool_calls) console.log(` CALL ${m.tool_calls[0]!.function.name}:`, m.tool_calls[0]!.function.arguments.slice(0, 160));
  }
} catch (e: any) { console.log("=== FAILED ===\n", String(e.message).slice(0, 500)); }
