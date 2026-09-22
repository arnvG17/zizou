// src/context/project-runtime.ts
//
// LAYER: context/
//
// One answer to "what can actually be run in this project".
//
// WHY THIS IS ITS OWN MODULE: build-system-prompt.ts already read package.json
// to tell the model the real package manager and the real script names, for
// the reason recorded there — a guess like `npm run dev` is wrong in a pnpm
// repo, wrong where the script is called `start`, and worst when it is right
// often enough that the failure looks like something else.
//
// The verifier now needs exactly the same facts, to derive a check from the
// scripts that exist rather than one it hoped for. Two readers re-implementing
// the same detection is how they drift: the prompt would say `bun run test`
// while the verifier shelled out to npm. So the detection moved here and both
// call it.
//
// The prompt wants prose and the verifier wants data, so this returns the data
// and renders the prose separately.
//
// DEPENDENCY DIRECTION: node stdlib only. Imported by context/ and agent/.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface ProjectRuntime {
  packageManager: PackageManager;
  /** Script names mapped to their command lines, straight from package.json. */
  scripts: Record<string, string>;
  /** False when node_modules is absent — nothing can be run until an install. */
  dependenciesInstalled: boolean;
}

/**
 * Reads the project's package.json and lockfile.
 *
 * Returns null when there is no package.json, or when it is malformed — a
 * project's broken manifest is that project's problem, not a reason to fail
 * prompt construction or skip verification entirely.
 */
export function detectProjectRuntime(projectRoot: string): ProjectRuntime | null {
  const pkgPath = resolve(projectRoot, "package.json");
  if (!existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };

    return {
      packageManager: detectPackageManager(projectRoot, pkg.packageManager),
      scripts: isScriptMap(pkg.scripts) ? pkg.scripts : {},
      dependenciesInstalled: existsSync(resolve(projectRoot, "node_modules")),
    };
  } catch {
    return null;
  }
}

/**
 * The `packageManager` field wins when present — it is the project stating its
 * own answer. Otherwise the lockfile on disk decides, which is evidence rather
 * than convention.
 */
function detectPackageManager(projectRoot: string, declared?: string): PackageManager {
  if (declared) {
    const name = declared.split("@")[0];
    if (name === "bun" || name === "pnpm" || name === "yarn" || name === "npm") return name;
  }

  const has = (file: string) => existsSync(resolve(projectRoot, file));
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  return "npm";
}

/** A `scripts` field that is not an object is not a script map. */
function isScriptMap(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The command that runs one of this project's scripts.
 *
 * Every supported manager spells this `<manager> run <script>`, but going
 * through one function means a manager that does not stays a one-line change
 * here rather than a discrepancy between the prompt and the verifier.
 */
export function scriptCommand(runtime: ProjectRuntime, script: string): string {
  return `${runtime.packageManager} run ${script}`;
}

/** The prose form injected into the system prompt's session context. */
export function renderProjectRuntime(runtime: ProjectRuntime): string {
  const scripts = Object.keys(runtime.scripts);

  const lines = [`Package manager: ${runtime.packageManager}`];
  lines.push(
    scripts.length
      ? `Available scripts: ${scripts.join(", ")}`
      : "No scripts defined in package.json.",
  );
  lines.push(
    runtime.dependenciesInstalled
      ? "Dependencies are installed (node_modules exists)."
      : "Dependencies are NOT installed — install before running anything.",
  );

  return `\n${lines.join("\n")}`;
}
