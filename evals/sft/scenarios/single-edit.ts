// evals/sft/scenarios/single-edit.ts
//
// BAND: single-edit — read the file, then edit it with a verbatim old_string.
//
// This is the core loop and the largest band, because it is where the real
// system prompt makes its strongest demand:
//
//   "Before editFile: always readFile first to get exact whitespace.
//    Never guess."   — build-system-prompt.ts EXECUTOR_INSTRUCTIONS
//
// Every record here therefore reads before it edits. A model that has only
// ever seen read-then-edit does not have "guess the old_string" available as
// a behaviour, which is cheaper than teaching it to recover from the guess.
//
// The old_string values are taken from the fixture text rather than retyped,
// so they cannot drift from the file — and the generator runs the real
// editFile, so a non-unique one fails the build instead of reaching the model.

import type { Scenario } from "../types.js";
import {
  baseProject,
  serviceFile,
  inkComponent,
  hookFile,
  pick,
  SERVICE_NAMES,
  COMPONENT_NAMES,
  HOOK_NAMES,
} from "../fixtures.js";

export function singleEditScenarios(): Scenario[] {
  const out: Scenario[] = [];

  // ── Change a constant in a service module ──────────────────────────────
  //
  // The most common real edit: someone wants a number changed. The value is
  // embedded in a unique line so old_string does not need surrounding context.
  for (let i = 0; i < 40; i++) {
    const name = pick(SERVICE_NAMES, i);
    const path = `src/services/${name}.ts`;
    const oldTimeout = 5000;
    const newTimeout = [10000, 15000, 30000, 2000, 8000][i % 5]!;
    out.push({
      id: `single-edit-timeout-${i}`,
      band: "single-edit",
      prompt: `Change the ${name} service timeout to ${newTimeout}ms.`,
      fixture: { ...baseProject(), [path]: serviceFile(name, oldTimeout) },
      steps: [
        { tool: "readFile", args: { path } },
        {
          tool: "editFile",
          args: {
            path,
            old_string: `  timeoutMs: ${oldTimeout},`,
            new_string: `  timeoutMs: ${newTimeout},`,
          },
        },
      ],
      finalText: `Updated the ${name} timeout to ${newTimeout}ms.`,
    });
  }

  // ── Add a field to an interface ────────────────────────────────────────
  //
  // old_string spans two lines here on purpose: the closing brace alone
  // appears many times in the file, and the model needs examples of choosing
  // a window wide enough to be unique. The system prompt asks for exactly
  // this ("include enough surrounding lines to make it uniquely identifiable
  // BEFORE calling editFile").
  for (let i = 0; i < 35; i++) {
    const name = pick(SERVICE_NAMES, i + 3);
    const Cap = name[0]!.toUpperCase() + name.slice(1);
    const path = `src/services/${name}.ts`;
    const field = ["maxConcurrency", "dryRun", "labelPrefix", "abortOnError"][i % 4]!;
    const type = field === "maxConcurrency" ? "number" : field === "labelPrefix" ? "string" : "boolean";
    const value = type === "number" ? "4" : type === "string" ? '"zizou"' : "false";
    out.push({
      id: `single-edit-add-field-${i}`,
      band: "single-edit",
      prompt: `Add a ${field} option to the ${name} service, defaulting to ${value}.`,
      fixture: { ...baseProject(), [path]: serviceFile(name) },
      steps: [
        { tool: "readFile", args: { path } },
        {
          tool: "editFile",
          args: {
            path,
            old_string: `  verbose: boolean;\n}`,
            new_string: `  verbose: boolean;\n  ${field}: ${type};\n}`,
          },
        },
        {
          tool: "editFile",
          args: {
            path,
            old_string: `  verbose: false,\n};`,
            new_string: `  verbose: false,\n  ${field}: ${value},\n};`,
          },
        },
      ],
      finalText: `Added ${field} to ${Cap}Options with a default of ${value}.`,
    });
  }

  // ── Rename a prop in an Ink component ──────────────────────────────────
  for (let i = 0; i < 30; i++) {
    const name = pick(COMPONENT_NAMES, i);
    const path = `src/ui/${name}.tsx`;
    out.push({
      id: `single-edit-prop-${i}`,
      band: "single-edit",
      prompt: `In ${name}, make the dim prop default to true instead of false.`,
      fixture: { ...baseProject(), [path]: inkComponent(name) },
      steps: [
        { tool: "readFile", args: { path } },
        {
          tool: "editFile",
          args: {
            path,
            old_string: `dim = false`,
            new_string: `dim = true`,
          },
        },
      ],
      finalText: `${name} now defaults dim to true.`,
    });
  }

  // ── Change a hook's default delay ──────────────────────────────────────
  for (let i = 0; i < 25; i++) {
    const name = pick(HOOK_NAMES, i);
    const path = `src/hooks/${name}.ts`;
    const oldDelay = 300;
    const newDelay = [150, 500, 750, 1000][i % 4]!;
    out.push({
      id: `single-edit-hook-delay-${i}`,
      band: "single-edit",
      prompt: `Make ${name} default to a ${newDelay}ms delay.`,
      fixture: { ...baseProject(), [path]: hookFile(name, oldDelay) },
      steps: [
        { tool: "readFile", args: { path } },
        {
          tool: "editFile",
          args: {
            path,
            old_string: `delay = ${oldDelay}`,
            new_string: `delay = ${newDelay}`,
          },
        },
      ],
      finalText: `${name} now defaults to ${newDelay}ms.`,
    });
  }

  // ── Edit a file the user named by path ─────────────────────────────────
  //
  // No search step, because the user gave the path. A model that globs for a
  // file it was just handed wastes a turn, and on a local model a wasted turn
  // is a large fraction of the budget.
  for (let i = 0; i < 20; i++) {
    const name = pick(SERVICE_NAMES, i + 7);
    const path = `src/services/${name}.ts`;
    out.push({
      id: `single-edit-named-path-${i}`,
      band: "single-edit",
      prompt: `In ${path}, bump the retry count from 3 to 5.`,
      fixture: { ...baseProject(), [path]: serviceFile(name) },
      steps: [
        { tool: "readFile", args: { path } },
        {
          tool: "editFile",
          args: { path, old_string: `  retries: 3,`, new_string: `  retries: 5,` },
        },
      ],
      finalText: `Retries raised to 5 in ${path}.`,
    });
  }

  return out;
}
