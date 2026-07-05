// src/checkpoint/patcher.ts
//
// LAYER: checkpoint/
//
// File state capture and restoration utilities.
// Handles reading file content and restoring files to previous states.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import type { FilePatch } from "./types.js";

const CWD = process.cwd();

/**
 * Captures the current state of a file.
 * Returns the file content as a string, or null if the file doesn't exist.
 */
export function captureFileState(filePath: string): string | null {
  const absPath = resolve(CWD, filePath);
  try {
    return readFileSync(absPath, "utf-8");
  } catch {
    // File doesn't exist
    return null;
  }
}

/**
 * Restores a file to a specific state.
 * If content is null, deletes the file.
 * If content is a string, writes it to the file.
 */
export function restoreFileState(filePath: string, content: string | null): void {
  const absPath = resolve(CWD, filePath);
  
  if (content === null) {
    // Delete the file if it exists
    if (existsSync(absPath)) {
      unlinkSync(absPath);
    }
  } else {
    // Write the content to the file
    writeFileSync(absPath, content, "utf-8");
  }
}

/**
 * Creates a FilePatch for a single file change.
 * Captures the old state before the change and the new state after.
 */
export function createFilePatch(
  filePath: string,
  oldContent: string | null,
  newContent: string | null
): FilePatch {
  let operation: "create" | "modify" | "delete";
  
  if (oldContent === null && newContent !== null) {
    operation = "create";
  } else if (oldContent !== null && newContent === null) {
    operation = "delete";
  } else {
    operation = "modify";
  }
  
  return {
    filePath,
    operation,
    oldContent,
    newContent,
  };
}

/**
 * Applies a FilePatch to restore the file to its old state.
 * This is used when reverting a checkpoint.
 */
export function revertFilePatch(patch: FilePatch): void {
  restoreFileState(patch.filePath, patch.oldContent);
}

/**
 * Applies a FilePatch to move the file to its new state.
 * This is used when restoring a checkpoint.
 */
export function applyFilePatch(patch: FilePatch): void {
  restoreFileState(patch.filePath, patch.newContent);
}
