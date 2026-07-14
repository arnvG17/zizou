// src/checkpoint/storage.ts
//
// LAYER: checkpoint/
//
// Checkpoint persistence - loads and saves checkpoint history to disk.
// All tracking is done via local file I/O only — no git commands used.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { CheckpointHistory, Checkpoint } from "./types.js";

const CWD = process.cwd();

/**
 * Gets a stable hash for the current working directory.
 * Uses a djb2-style hash of the directory path — no git dependency.
 */
function getProjectHash(): string {
  let hash = 0;
  const str = CWD.toLowerCase();
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Gets the checkpoint history file path for the current project.
 */
export function getCheckpointHistoryPath(): string {
  const homedir = process.env.HOME || process.env.USERPROFILE || "";
  const projectHash = getProjectHash();
  const checkpointsDir = join(homedir, ".zizou", "checkpoints", projectHash);
  return join(checkpointsDir, "history.json");
}

/**
 * Loads checkpoint history from disk.
 * Returns an empty history if the file doesn't exist.
 */
export function loadCheckpointHistory(): CheckpointHistory {
  const historyPath = getCheckpointHistoryPath();
  if (!existsSync(historyPath)) {
    return {
      branches: [],
      checkpoints: new Map(),
      activeBranchId: "",
    };
  }

  try {
    const data = readFileSync(historyPath, "utf-8");
    const parsed = JSON.parse(data);
    
    // Convert checkpoints array back to Map
    const checkpointsMap = new Map<string, Checkpoint>();
    if (parsed.checkpoints && Array.isArray(parsed.checkpoints)) {
      for (const checkpoint of parsed.checkpoints) {
        checkpointsMap.set(checkpoint.id, checkpoint);
      }
    }
    
    return {
      branches: parsed.branches || [],
      checkpoints: checkpointsMap,
      activeBranchId: parsed.activeBranchId || "",
    };
  } catch (error) {
    console.error("Failed to load checkpoint history:", error);
    return {
      branches: [],
      checkpoints: new Map(),
      activeBranchId: "",
    };
  }
}

/**
 * Saves checkpoint history to disk.
 */
export function saveCheckpointHistory(history: CheckpointHistory): void {
  const historyPath = getCheckpointHistoryPath();
  const dir = join(historyPath, "..");
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  // Convert Map to array for JSON serialization
  const serialized = {
    branches: history.branches,
    checkpoints: Array.from(history.checkpoints.values()),
    activeBranchId: history.activeBranchId,
  };
  
  writeFileSync(historyPath, JSON.stringify(serialized, null, 2), "utf-8");
}
