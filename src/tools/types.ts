/**
 * types.ts — Shared type definitions for the tools layer.
 *
 * Layer: tools
 * Allowed imports: none (or standard library types)
 * NOT allowed to import from: agent/, ui/, provider/, or config/
 *
 * This file contains types that need to be shared across multiple tool definitions.
 */

/**
 * ConfirmFn is a swappable callback injected into tools that require user confirmation
 * before proceeding (e.g., executing shell commands). In a simple CLI, this might use
 * Node's readline, whereas in a TUI, it might pop up a confirmation modal.
 */
export type ConfirmFn = (description: string) => Promise<boolean>;
