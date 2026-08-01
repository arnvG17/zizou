// src/tui/file-index.ts
//
// LAYER: tui/
//
// Cached, debounced file tree listing for @ file search.
// Maintains a flat list of project files respecting .gitignore patterns.

import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

const CWD = process.cwd();

// Directories to skip (same as repo-map.ts)
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".zizou",
  "zizou-exports",
]);

// File extensions to include
const CODE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs|html|css|json|md|py|sh|yaml|yml|rs|go|c|cpp|h|txt)$/i;

/**
 * Cached file index with metadata.
 */
interface FileIndex {
  files: string[]; // Relative paths from project root
  lastUpdated: number;
}

let fileIndex: FileIndex = {
  files: [],
  lastUpdated: 0,
};

const CACHE_TTL = 5000; // 5 seconds cache TTL

/**
 * Scans the project directory and builds a flat list of files.
 * Skips directories in SKIP_DIRS and filters by file extension.
 */
function scanProjectFiles(rootDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // Permission errors etc — skip rather than crash
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (CODE_FILE_PATTERN.test(entry)) {
        const relPath = relative(rootDir, fullPath).replace(/\\/g, '/');
        files.push(relPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

/**
 * Gets the current file index, refreshing if cache is stale.
 * 
 * @param forceRefresh - Force a refresh regardless of cache TTL
 * @returns Array of relative file paths
 */
export function getFileIndex(forceRefresh = false): string[] {
  const now = Date.now();
  
  if (!forceRefresh && fileIndex.files.length > 0 && (now - fileIndex.lastUpdated) < CACHE_TTL) {
    return fileIndex.files;
  }

  // Refresh the index
  fileIndex.files = scanProjectFiles(CWD);
  fileIndex.lastUpdated = now;
  
  return fileIndex.files;
}

/**
 * Clears the file index cache.
 * Useful when the project structure changes significantly.
 */
export function clearFileIndex(): void {
  fileIndex = {
    files: [],
    lastUpdated: 0,
  };
}