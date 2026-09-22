// src/agent/verification-plan.ts
//
// LAYER: agent/
//
// Deciding what "did it work" means for a change that did not declare it.
//
// THE HOLE THIS FILLS: a plan step can carry a `check` and the verifier runs
// it. Build mode has no planner, so its synthesised step has no check at all
// (see orchestrator.ts, runBuildMode) — which meant runDeclaredCheck was a
// no-op on the route that runs most often. A TypeScript change could edit
// three files, report success, and never once be compiled.
//
// The system prompt asked the model to verify its own work. That is the right
// instruction and the wrong enforcement: a model that forgets produces exactly
// the same green tick as one that checked, and the two are indistinguishable
// afterwards.
//
// WHAT THIS IS NOT: a test-runner, a build system, or a guess. It reads the
// scripts the project actually declares and picks one. No script, no
// dependencies installed, or nothing relevant changed — it returns null and
// verification stays exactly as it was. Inventing `tsc --noEmit` for a project
// that never asked for it would be the same guessing this replaces.
//
// DEPENDENCY DIRECTION: imports from context/project-runtime.ts only.

import { extname } from "node:path";
import {
  detectProjectRuntime,
  scriptCommand,
  type ProjectRuntime,
} from "../context/project-runtime.js";
import type { VerificationKind } from "./task-state.js";

/**
 * The escape hatch, read from the environment.
 *
 * An env var rather than a ZIZOU.md setting because the case it serves is
 * situational — "this project's test suite takes four minutes and I am
 * iterating" — not a property of the project that belongs in a file everyone
 * on the team shares.
 */
export function autoVerifyEnabled(): boolean {
  const flag = process.env.ZIZOU_NO_AUTO_VERIFY;
  return !(flag === "1" || flag === "true");
}

export interface VerificationCommand {
  /** The full command line, spelled for this project's package manager. */
  command: string;
  kind: VerificationKind;
  /** The package.json script it resolves to, for the "already ran" check. */
  script: string;
}

/**
 * Which script names count as which kind of check.
 *
 * Ordered by preference within each kind, and matched exactly rather than by
 * substring: a project with `test` and `test:watch` must get `test`, and
 * `test:watch` must never be chosen at all — it does not exit.
 */
const SCRIPT_CANDIDATES: Record<VerificationKind, string[]> = {
  typecheck: ["typecheck", "type-check", "tsc", "check-types"],
  test: ["test", "tests"],
  build: ["build", "compile"],
  lint: ["lint", "eslint"],
};

/**
 * Which kinds are worth running for a change to a file of this type.
 *
 * Ordered strongest-evidence-first. A typecheck that passes proves more about
 * a .ts change than a lint that passes, and costs less than a full build.
 *
 * Extensions absent from this table get no derived verification. That is
 * deliberate for .html/.css/.md/.json: the verifier already does a structural
 * check on those (validateFileSyntax), and running a project's whole test
 * suite because a README changed is a tax with no evidence behind it.
 */
const KINDS_BY_EXTENSION: Record<string, VerificationKind[]> = {
  ".ts": ["typecheck", "test", "build"],
  ".tsx": ["typecheck", "test", "build"],
  ".mts": ["typecheck", "test", "build"],
  ".cts": ["typecheck", "test", "build"],
  ".js": ["test", "lint", "build"],
  ".jsx": ["test", "lint", "build"],
  ".mjs": ["test", "lint", "build"],
  ".cjs": ["test", "lint", "build"],
  ".vue": ["typecheck", "test", "build"],
  ".svelte": ["typecheck", "test", "build"],
};

/**
 * Picks a verification command for a set of changed files, or null.
 *
 * Null is the common and correct answer for: a project with no package.json,
 * one whose dependencies are not installed (nothing would run anyway), a
 * change that touched no code, and a project that declares no check script.
 * Eval workspaces are almost all of these, so the harness stays fast there.
 */
export function deriveVerification(
  changedFiles: string[],
  projectRoot: string,
  runtime: ProjectRuntime | null = detectProjectRuntime(projectRoot),
): VerificationCommand | null {
  if (!runtime || !runtime.dependenciesInstalled) return null;

  const wanted = rankKinds(changedFiles);
  if (wanted.length === 0) return null;

  for (const kind of wanted) {
    const script = SCRIPT_CANDIDATES[kind].find((name) =>
      Object.prototype.hasOwnProperty.call(runtime.scripts, name),
    );
    if (script) {
      return { command: scriptCommand(runtime, script), kind, script };
    }
  }

  return null;
}

/**
 * The kinds worth running for this change, best first and de-duplicated.
 *
 * A change spanning .ts and .js files should prefer the typecheck the .ts
 * files earned while still accepting a test run if no typecheck exists, so
 * the per-file lists are merged in order rather than intersected.
 */
function rankKinds(changedFiles: string[]): VerificationKind[] {
  const ranked: VerificationKind[] = [];

  for (const file of changedFiles) {
    for (const kind of KINDS_BY_EXTENSION[extname(file).toLowerCase()] ?? []) {
      if (!ranked.includes(kind)) ranked.push(kind);
    }
  }

  return ranked;
}

/**
 * True when this step already ran the derived check itself.
 *
 * Re-running a project's test suite because the plan happened to mention it
 * doubles the cost of every step for no new information — the same reasoning
 * runDeclaredCheck applies, and matching on the SCRIPT name rather than the
 * full command line means `bun run typecheck` and `npm run typecheck` both
 * count as having run it.
 */
export function alreadyRan(check: VerificationCommand, commands: string[]): boolean {
  return commands.some((cmd) => {
    const c = cmd.toLowerCase();
    return c.includes(check.script.toLowerCase()) || c.includes(check.command.toLowerCase());
  });
}
