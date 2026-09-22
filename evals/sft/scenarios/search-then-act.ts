// evals/sft/scenarios/search-then-act.ts
//
// BAND: search-then-act — the user names a thing, not a path.
//
// This band exists because of a specific instruction in the real system
// prompt that a model cannot follow without examples:
//
//   "Never reference a file path you have not seen in a glob, grep or
//    listDir result."
//
// A model that has only seen read-then-edit records will happily invent
// src/services/cache.ts because the request mentioned "cache". Here the
// request never contains a path, so the only way to produce one is to search
// — and the search results in the record are real, produced by running the
// real grep and glob against the fixture.
//
// Tool choice is taught by contrast rather than by rule: grep for "where is
// this string", glob for "what files match this name", listDir for "what is
// in this folder". Each appears as the right answer to its own question.

import type { Scenario } from "../types.js";
import {
  baseProject,
  serviceFile,
  inkComponent,
  pick,
  SERVICE_NAMES,
  COMPONENT_NAMES,
} from "../fixtures.js";

export function searchThenActScenarios(): Scenario[] {
  const out: Scenario[] = [];

  // ── grep for a distinctive string, then edit what it found ─────────────
  for (let i = 0; i < 45; i++) {
    const name = pick(SERVICE_NAMES, i);
    const path = `src/services/${name}.ts`;
    const newTimeout = [12000, 20000, 45000, 1000][i % 4]!;
    out.push({
      id: `search-grep-edit-${i}`,
      band: "search-then-act",
      prompt: `Something sets a 5000ms timeout for ${name} and it's too short — make it ${newTimeout}.`,
      fixture: { ...baseProject(), [path]: serviceFile(name) },
      steps: [
        { tool: "grep", args: { pattern: "timeoutMs: 5000", fileGlob: "*.ts" } },
        { tool: "readFile", args: { path } },
        {
          tool: "editFile",
          args: {
            path,
            old_string: "  timeoutMs: 5000,",
            new_string: `  timeoutMs: ${newTimeout},`,
          },
        },
      ],
      finalText: `Found it in ${path} and raised the timeout to ${newTimeout}ms.`,
    });
  }

  // ── glob by filename when the user names the file, not the path ────────
  for (let i = 0; i < 40; i++) {
    const name = pick(COMPONENT_NAMES, i);
    const path = `src/ui/${name}.tsx`;
    out.push({
      id: `search-glob-edit-${i}`,
      band: "search-then-act",
      prompt: `The ${name} component should render its label in bold too.`,
      fixture: { ...baseProject(), [path]: inkComponent(name) },
      steps: [
        { tool: "glob", args: { pattern: `**/${name}.tsx` } },
        { tool: "readFile", args: { path } },
        {
          tool: "editFile",
          args: {
            path,
            old_string: `<Text dimColor={dim}>{label}</Text>`,
            new_string: `<Text bold dimColor={dim}>{label}</Text>`,
          },
        },
      ],
      finalText: `${name} now renders the label in bold.`,
    });
  }

  // ── listDir to learn the layout before answering ───────────────────────
  //
  // Deliberately ends in prose, not an edit. "What's in here" is a question,
  // and a model that edits something after being asked to look is worse than
  // one that does nothing.
  for (let i = 0; i < 25; i++) {
    const a = pick(SERVICE_NAMES, i);
    const b = pick(SERVICE_NAMES, i + 5);
    out.push({
      id: `search-listdir-${i}`,
      band: "search-then-act",
      prompt: `What's in the services folder?`,
      fixture: {
        ...baseProject(),
        [`src/services/${a}.ts`]: serviceFile(a),
        [`src/services/${b}.ts`]: serviceFile(b),
      },
      steps: [{ tool: "listDir", args: { path: "src/services" } }],
      finalText: `src/services contains two modules: ${a}.ts and ${b}.ts. Both export an options interface, a defaults constant, and a run function that returns { success, value } rather than throwing.`,
    });
  }

  // ── grep to find every usage before deciding ───────────────────────────
  for (let i = 0; i < 30; i++) {
    const name = pick(SERVICE_NAMES, i + 2);
    const Cap = name[0]!.toUpperCase() + name.slice(1);
    const path = `src/services/${name}.ts`;
    out.push({
      id: `search-usages-${i}`,
      band: "search-then-act",
      prompt: `Where is DEFAULT_${name.toUpperCase()}_OPTIONS used?`,
      fixture: { ...baseProject(), [path]: serviceFile(name) },
      steps: [
        { tool: "grep", args: { pattern: `DEFAULT_${name.toUpperCase()}_OPTIONS` } },
      ],
      finalText: `DEFAULT_${name.toUpperCase()}_OPTIONS is used in two places, both in ${path}: the declaration itself, and as the default value of run${Cap}'s options parameter. Nothing outside that file references it.`,
    });
  }

  return out;
}
