// src/commands/export-transcript.ts
//
// LAYER: commands/
//
// Serializes the current conversation to a readable markdown file.
// No network calls, no auth — purely local export.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { ModelMessage } from "ai";

/**
 * Exports the current conversation to a markdown file.
 * 
 * @param conversation - The conversation history to export
 * @param outputDir - Directory to write the export file (default: ./zizou-exports/)
 * @returns The path to the exported file
 */
export function exportTranscript(
  conversation: ModelMessage[],
  outputDir: string = "./zizou-exports"
): string {
  // Create output directory if it doesn't exist
  const absOutputDir = join(process.cwd(), outputDir);
  try {
    mkdirSync(absOutputDir, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to create export directory: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  // Generate timestamp for filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const filename = `transcript-${timestamp}.md`;
  const filepath = join(absOutputDir, filename);

  // Build markdown content
  let markdown = `# Zizou Transcript\n\n`;
  markdown += `Exported: ${new Date().toLocaleString()}\n`;
  markdown += `Total messages: ${conversation.length}\n\n`;
  markdown += `---\n\n`;

  for (let i = 0; i < conversation.length; i++) {
    const msg = conversation[i];
    const role = msg.role === "user" ? "User" : "Assistant";
    
    markdown += `## ${role} (${i + 1}/${conversation.length})\n\n`;
    
    if (typeof msg.content === "string") {
      markdown += `${msg.content}\n\n`;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") {
          markdown += `${part.text}\n\n`;
        } else if (part.type === "tool-call") {
          const anyPart = part as any;
          markdown += `**Tool Call:** ${anyPart.toolName}\n\n`;
          markdown += `\`\`\`json\n${JSON.stringify(anyPart.args, null, 2)}\n\`\`\`\n\n`;
        } else if (part.type === "tool-result") {
          const anyPart = part as any;
          markdown += `**Tool Result:** ${anyPart.toolName}\n\n`;
          if (anyPart.error) {
            markdown += `Error: ${anyPart.error}\n\n`;
          } else {
            const result = typeof anyPart.result === "string" 
              ? anyPart.result 
              : JSON.stringify(anyPart.result, null, 2);
            markdown += `\`\`\`\n${result}\n\`\`\`\n\n`;
          }
        } else if (part.type === "image") {
          const anyPart = part as any;
          markdown += `[Image: ${anyPart.mediaType}]\n\n`;
        }
      }
    }
    
    markdown += `---\n\n`;
  }

  // Write to file
  try {
    writeFileSync(filepath, markdown, "utf-8");
  } catch (error) {
    throw new Error(`Failed to write export file: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  return filepath;
}