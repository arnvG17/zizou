/**
 * dev-harness.ts — Manual test script for verifying the tool-call round-trip.
 *
 * ⚠️  THIS IS A DEV HARNESS, NOT PRODUCTION CODE. It exists solely to prove
 * that the tools work end-to-end against the APIs.
 *
 * Layer: (none — standalone script, not part of any layer)
 */

import { generateText, stepCountIs } from "ai";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getModel } from "./provider/index.js";
import { readFile, editFile, createRunBashTool, ConfirmFn } from "./tools/index.js";
import { ProviderName } from "./config/index.js";

const rl = readline.createInterface({ input, output });

const confirmInConsole: ConfirmFn = async (description: string) => {
  const answer = await rl.question(`\n⚠️  CONFIRMATION REQUIRED:\n${description}\n(y/N): `);
  return answer.trim().toLowerCase() === "y";
};

async function testProvider(providerName: ProviderName) {
  console.log(`\n=== Testing Provider: ${providerName.toUpperCase()} ===\n`);

  try {
    const result = await generateText({
      model: getModel(providerName),
      tools: {
        readFile,
        editFile,
        runBash: createRunBashTool(confirmInConsole),
      },
      stopWhen: stepCountIs(10),
      prompt:
        "Please do the following exactly:\n" +
        "1. Use runBash to create a file named 'demo.txt' with the contents 'This is a test file.'\n" +
        "2. Use readFile to read 'demo.txt' back.\n" +
        "3. Use editFile to modify 'demo.txt' by replacing the exact string 'This is a test file.' with 'This line was modified by Zizou.'\n" +
        "4. Tell me when you are done.",
    });

    console.log(`Total steps: ${result.steps.length}\n`);

    for (const step of result.steps) {
      console.log(`--- Step ${step.stepNumber} ---`);
      console.log(`  Finish reason: ${step.finishReason}`);

      if (step.toolCalls.length > 0) {
        console.log(`  Tool calls:`);
        for (const tc of step.toolCalls) {
          // Note: older ai SDK versions might use 'args' instead of 'input', checking both
          console.log(`    - ${tc.toolName}(${JSON.stringify((tc as any).args ?? (tc as any).input)})`);
        }
      }

      if (step.toolResults.length > 0) {
        console.log(`  Tool results:`);
        for (const tr of step.toolResults) {
          const outputStr = JSON.stringify((tr as any).result ?? (tr as any).output);
          const preview =
            outputStr.length > 200
              ? outputStr.slice(0, 200) + "…(truncated)"
              : outputStr;
          console.log(`    - ${tr.toolName}: ${preview}`);
        }
      }

      if (step.text) {
        console.log(
          `  Text: ${step.text.slice(0, 300)}${step.text.length > 300 ? "…" : ""}`
        );
      }
      console.log();
    }

    console.log(`=== Final response from ${providerName} ===`);
    console.log(result.text);
  } catch (err) {
    console.error(`❌ Provider ${providerName} failed:`, err);
  }
}

async function main() {
  console.log("=== Zizou Dev Harness: Multi-Provider Tool Round-Trip ===\n");
  
  // We'll just test Groq since it's the one known to be working without rate limit right now
  await testProvider("groq");

  rl.close();
}

main().catch((err) => {
  console.error("Dev harness failed:", err);
  process.exit(1);
});
