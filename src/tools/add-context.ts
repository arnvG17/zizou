import { tool } from "ai";
import { z } from "zod";
import { addPinnedFile } from "../context/build-system-prompt.js";

export const addFileToContext = tool({
  description: "Pin a file's contents permanently to the system prompt. Use this if you know you will need to frequently reference a file's contents across many turns in this session. The file will be loaded into the system prompt immediately for the next turn.",
  parameters: z.object({
    path: z.string().describe("The path to the file to add to context. Can be relative to cwd or absolute."),
  }),
  execute: async ({ path }) => {
    try {
      const absolutePath = addPinnedFile(process.cwd(), path);
      return {
        success: true,
        message: `Successfully pinned ${absolutePath} to context. It will be available in the system prompt starting from the next turn.`,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message,
      };
    }
  },
});
