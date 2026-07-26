/**
 * permissions.ts — Session-level permission cache and manager.
 *
 * Remembers user permissions granted during an active session for:
 * - Specific file paths (reads, writes, edits, deletes, moves)
 * - Specific task/bash commands
 *
 * Once a file or command/task permission is approved by the user in a session,
 * subsequent requests targeting that file or command in the same session are
 * automatically approved without prompting again.
 */

import { resolve } from "node:path";

export interface PermissionTarget {
  type: "file" | "command" | "task" | "unknown";
  target: string;
}

export class SessionPermissionManager {
  private allowedFiles = new Set<string>();
  private allowedCommands = new Set<string>();
  private allowedTasks = new Set<string>();

  /**
   * Reset all session permissions (e.g. on session switch or new session).
   */
  public reset(): void {
    this.allowedFiles.clear();
    this.allowedCommands.clear();
    this.allowedTasks.clear();
  }

  /**
   * Parse a confirmation description string into a type and normalized target path or command.
   */
  public parseQuery(description: string): PermissionTarget {
    const desc = description.trim();

    // 1. File operations:
    // "Read file: <path>"
    // "Edit file: <path>"
    // "Overwrite existing file: <path>"
    // "Create new file: <path>"
    // "Delete file/directory: <path>"
    const fileMatch = desc.match(/(?:Read file|Edit file|Overwrite existing file|Create new file|Delete file\/directory):\s*(.+)/i);
    if (fileMatch) {
      const rawPath = fileMatch[1].trim();
      const absPath = resolve(process.cwd(), rawPath).replace(/\\/g, "/");
      return { type: "file", target: absPath };
    }

    const moveMatch = desc.match(/Move\s+(.+)\s+to\s+(.+)/i);
    if (moveMatch) {
      const rawPath = moveMatch[1].trim();
      const absPath = resolve(process.cwd(), rawPath).replace(/\\/g, "/");
      return { type: "file", target: absPath };
    }

    // Direct path match fallback if description is just a filepath or file: <path>
    const simpleFileMatch = desc.match(/^(?:file:\s*)?([A-Za-z]:[\\\/].+|\/?.+\.[a-zA-Z0-9]+)$/);
    if (simpleFileMatch) {
      const absPath = resolve(process.cwd(), simpleFileMatch[1].trim()).replace(/\\/g, "/");
      return { type: "file", target: absPath };
    }

    // 2. Shell / bash commands:
    // "The agent wants to run the following command:\n  <cmd>\nAllow?"
    // "The agent wants to run the following background command:\n  <cmd>\nAllow?"
    const bashMatch = desc.match(/(?:command|background command):\s*\n?\s*(.+?)(?:\n\s*Allow\?|$)/is);
    if (bashMatch) {
      return { type: "command", target: bashMatch[1].trim() };
    }

    // 3. Fallback: treat whole description as a general task/action
    return { type: "task", target: desc };
  }

  /**
   * Returns true if permission for this target has already been granted in the session.
   */
  public isPermitted(description: string): boolean {
    const { type, target } = this.parseQuery(description);
    if (!target) return false;

    const normTarget = target.toLowerCase();

    if (type === "file") {
      for (const allowed of this.allowedFiles) {
        if (allowed.toLowerCase() === normTarget) {
          return true;
        }
      }
      return false;
    } else if (type === "command") {
      for (const allowed of this.allowedCommands) {
        if (allowed.toLowerCase() === normTarget) {
          return true;
        }
      }
      return false;
    } else {
      for (const allowed of this.allowedTasks) {
        if (allowed.toLowerCase() === normTarget) {
          return true;
        }
      }
      return false;
    }
  }

  /**
   * Grant permission for a target in the active session.
   */
  public grantPermission(description: string): void {
    const { type, target } = this.parseQuery(description);
    if (!target) return;

    if (type === "file") {
      this.allowedFiles.add(target);
    } else if (type === "command") {
      this.allowedCommands.add(target);
    } else {
      this.allowedTasks.add(target);
    }
  }

  /**
   * List summary of current active session permissions.
   */
  public getSummary(): { files: string[]; commands: string[]; tasks: string[] } {
    return {
      files: Array.from(this.allowedFiles),
      commands: Array.from(this.allowedCommands),
      tasks: Array.from(this.allowedTasks),
    };
  }
}

// Global singleton instance for session permission tracking
export const sessionPermissions = new SessionPermissionManager();
