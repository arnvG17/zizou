// src/context/load-project-conventions.ts
//
// LAYER: context/
//
// Loads ZIZOU.md project conventions file if present.
// Injects project-specific conventions into planner context.

import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Loads the ZIZOU.md file from the project root if it exists.
 * 
 * @param projectRoot - Absolute path to the project root
 * @returns The content of ZIZOU.md as a string, or null if the file doesn't exist
 */
export async function loadProjectConventions(projectRoot: string): Promise<string | null> {
  const path = join(projectRoot, "ZIZOU.md");
  
  if (!existsSync(path)) {
    return null;
  }
  
  try {
    const content = readFileSync(path, "utf-8");
    return content;
  } catch (error) {
    // If we can't read the file, just return null rather than failing
    console.warn(`Failed to read ZIZOU.md: ${error instanceof Error ? error.message : "Unknown error"}`);
    return null;
  }
}