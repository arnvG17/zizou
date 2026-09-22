// evals/sft/scenarios/create-in-place.ts
//
// BAND: create-in-place — new files, put where they belong.
//
// This band exists because of a failure the repo documents as real and
// repeated. From build-system-prompt.ts, explaining why FILE_PLACEMENT_RULES
// is in the prompt at all:
//
//   "asked for an app, the agent writes chess.html, poker.tsx and
//    notesapp.html into the workspace root, next to package.json — sometimes
//    alongside the chess-app/ directory that already existed."
//
// Two behaviours are taught here, and they are the two the prompt asks for:
//
//   1. LOOK BEFORE WRITING. Every record globs or lists first, so the
//      destination comes from an observed layout rather than a guess.
//   2. EDIT, DON'T RECREATE. When something already does the job, the right
//      answer is to edit it — "a near-duplicate under a new name is almost
//      always wrong, and leaves two files that disagree."
//
// Every fixture is a populated repo. Generating these against an empty
// workspace would train the exact behaviour the rules exist to prevent,
// because writing at the root is correct when there is nothing else there.

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

export function createInPlaceScenarios(): Scenario[] {
  const out: Scenario[] = [];

  // ── New service beside the existing ones ───────────────────────────────
  for (let i = 0; i < 40; i++) {
    const existing = pick(SERVICE_NAMES, i);
    const fresh = pick(SERVICE_NAMES, i + 9);
    if (existing === fresh) continue;
    const newPath = `src/services/${fresh}.ts`;
    out.push({
      id: `create-service-${i}`,
      band: "create-in-place",
      prompt: `Add a ${fresh} service.`,
      fixture: { ...baseProject(), [`src/services/${existing}.ts`]: serviceFile(existing) },
      steps: [
        { tool: "listDir", args: { path: "src" } },
        { tool: "listDir", args: { path: "src/services" } },
        { tool: "writeFile", args: { path: newPath, contents: serviceFile(fresh) } },
      ],
      finalText: `Created ${newPath}, matching the shape of ${existing}.ts — options interface, defaults constant, and a run function that returns { success, value } rather than throwing.`,
    });
  }

  // ── New component in src/ui, not at the root ───────────────────────────
  for (let i = 0; i < 35; i++) {
    const existing = pick(COMPONENT_NAMES, i);
    const fresh = pick(COMPONENT_NAMES, i + 4);
    if (existing === fresh) continue;
    const newPath = `src/ui/${fresh}.tsx`;
    out.push({
      id: `create-component-${i}`,
      band: "create-in-place",
      prompt: `I need a ${fresh} component.`,
      fixture: { ...baseProject(), [`src/ui/${existing}.tsx`]: inkComponent(existing) },
      steps: [
        { tool: "glob", args: { pattern: "src/ui/*.tsx" } },
        { tool: "writeFile", args: { path: newPath, contents: inkComponent(fresh) } },
      ],
      finalText: `Added ${newPath}, beside the other Ink components.`,
    });
  }

  // ── New hook in src/hooks ──────────────────────────────────────────────
  for (let i = 0; i < 25; i++) {
    const existing = pick(HOOK_NAMES, i);
    const fresh = pick(HOOK_NAMES, i + 3);
    if (existing === fresh) continue;
    const newPath = `src/hooks/${fresh}.ts`;
    out.push({
      id: `create-hook-${i}`,
      band: "create-in-place",
      prompt: `Write a ${fresh} hook.`,
      fixture: { ...baseProject(), [`src/hooks/${existing}.ts`]: hookFile(existing) },
      steps: [
        { tool: "glob", args: { pattern: "src/hooks/*.ts" } },
        { tool: "writeFile", args: { path: newPath, contents: hookFile(fresh) } },
      ],
      finalText: `Added ${newPath} alongside ${existing}.ts.`,
    });
  }

  // ── EDIT, DON'T RECREATE ───────────────────────────────────────────────
  //
  // The request sounds like "make a new thing", and a file that already does
  // it exists under a name the request does not use. The correct answer is to
  // search, find it, and edit — not to write a near-duplicate.
  for (let i = 0; i < 40; i++) {
    const name = pick(SERVICE_NAMES, i + 2);
    const path = `src/services/${name}.ts`;
    out.push({
      id: `create-edit-not-recreate-${i}`,
      band: "create-in-place",
      prompt: `We need something that ${name}s input with a configurable timeout — can you set that up?`,
      fixture: { ...baseProject(), [path]: serviceFile(name) },
      steps: [
        { tool: "glob", args: { pattern: `**/${name}*.ts` } },
        { tool: "readFile", args: { path } },
        {
          tool: "editFile",
          args: {
            path,
            old_string: "  retries: number;",
            new_string: "  retries: number;\n  /** Fail the run if it exceeds timeoutMs. */\n  enforceTimeout: boolean;",
          },
        },
        {
          tool: "editFile",
          args: {
            path,
            old_string: "  retries: 3,",
            new_string: "  retries: 3,\n  enforceTimeout: true,",
          },
        },
      ],
      finalText: `${path} already does this, so I extended it rather than adding a second module — it now has an enforceTimeout option, on by default.`,
    });
  }

  // ── Genuinely nothing exists — say so, then create ─────────────────────
  //
  // The counterweight. The prompt says: "If you searched and there is
  // genuinely nothing, say so in one line and then create the file." Without
  // these, the band teaches a model that never creates anything.
  for (let i = 0; i < 20; i++) {
    const fresh = pick(SERVICE_NAMES, i + 11);
    const newPath = `src/services/${fresh}.ts`;
    out.push({
      id: `create-nothing-exists-${i}`,
      band: "create-in-place",
      prompt: `Is there a ${fresh} module? If not, add one.`,
      fixture: baseProject(),
      steps: [
        { tool: "glob", args: { pattern: `**/${fresh}*.ts` } },
        { tool: "listDir", args: { path: "src" } },
        {
          tool: "writeFile",
          args: { path: newPath, contents: serviceFile(fresh) },
          say: `No ${fresh} module exists — creating one under src/services.`,
        },
      ],
      finalText: `There wasn't one, so I created ${newPath}.`,
    });
  }

  return out;
}
