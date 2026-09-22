// evals/sft/scenarios/multi-file.ts
//
// BAND: multi-file — one change, several files, finish all of them.
//
// The failure this targets is stopping early. A small model that edits the
// first of four call sites and then writes a confident summary has produced
// something worse than nothing: the code no longer compiles, and the message
// says it is done.
//
// So every record here follows the same arc — grep to find every site, then
// one edit per site, then a summary that names the count. The grep result in
// the record is real, so the number of edits that follow always matches the
// number of matches the model just saw. That correspondence is the signal.

import type { Scenario } from "../types.js";
import { baseProject, serviceFile, pick, SERVICE_NAMES } from "../fixtures.js";

/** A consumer that imports and calls a service — one call site per file. */
function consumerFile(dir: string, name: string, serviceName: string): string {
  const Cap = serviceName[0]!.toUpperCase() + serviceName.slice(1);
  return `// src/${dir}/${name}.ts

import { run${Cap}, DEFAULT_${serviceName.toUpperCase()}_OPTIONS } from "../services/${serviceName}.js";

export async function ${name}(input: string) {
  const result = await run${Cap}(input, DEFAULT_${serviceName.toUpperCase()}_OPTIONS);
  if (!result.success) {
    throw new Error(result.error ?? "${name} failed");
  }
  return result.value;
}
`;
}

export function multiFileScenarios(): Scenario[] {
  const out: Scenario[] = [];

  // ── Rename an exported function across its call sites ──────────────────
  for (let i = 0; i < 40; i++) {
    const service = pick(SERVICE_NAMES, i);
    const Cap = service[0]!.toUpperCase() + service.slice(1);
    const oldName = `run${Cap}`;
    const newName = `execute${Cap}`;

    const servicePath = `src/services/${service}.ts`;
    const consumers = ["handlers/process", "handlers/batch", "cli/command"];

    const fixture: Record<string, string> = {
      ...baseProject(),
      [servicePath]: serviceFile(service),
    };
    for (const c of consumers) {
      const [dir, base] = c.split("/") as [string, string];
      fixture[`src/${dir}/${base}.ts`] = consumerFile(dir, base, service);
    }

    const steps = [
      { tool: "grep", args: { pattern: oldName, fileGlob: "*.ts" } },
      { tool: "readFile", args: { path: servicePath } },
      {
        tool: "editFile",
        args: {
          path: servicePath,
          old_string: `export async function ${oldName}(`,
          new_string: `export async function ${newName}(`,
        },
      },
    ];

    // One edit per call site. Two edits per consumer file: the import and the
    // call. Both are needed for the rename to actually compile, and a model
    // that does only the import has produced a broken repo that looks done.
    for (const c of consumers) {
      const [dir, base] = c.split("/") as [string, string];
      const path = `src/${dir}/${base}.ts`;
      steps.push({ tool: "readFile", args: { path } });
      steps.push({
        tool: "editFile",
        args: {
          path,
          old_string: `import { ${oldName}, DEFAULT_`,
          new_string: `import { ${newName}, DEFAULT_`,
        },
      });
      steps.push({
        tool: "editFile",
        args: {
          path,
          old_string: `await ${oldName}(input,`,
          new_string: `await ${newName}(input,`,
        },
      });
    }

    out.push({
      id: `multi-rename-${i}`,
      band: "multi-file",
      prompt: `Rename ${oldName} to ${newName} everywhere.`,
      fixture,
      steps,
      finalText: `Renamed ${oldName} to ${newName} in 4 files: the declaration in ${servicePath}, and the import and call site in each of the three consumers.`,
    });
  }

  // ── Change a shared constant everywhere it is referenced ───────────────
  for (let i = 0; i < 30; i++) {
    const service = pick(SERVICE_NAMES, i + 5);
    const servicePath = `src/services/${service}.ts`;
    const consumers = ["handlers/ingest", "cli/run"];

    const fixture: Record<string, string> = {
      ...baseProject(),
      [servicePath]: serviceFile(service),
    };
    for (const c of consumers) {
      const [dir, base] = c.split("/") as [string, string];
      fixture[`src/${dir}/${base}.ts`] = consumerFile(dir, base, service);
    }

    const steps: any[] = [
      { tool: "grep", args: { pattern: "DEFAULT_", fileGlob: "*.ts" } },
    ];
    for (const c of consumers) {
      const [dir, base] = c.split("/") as [string, string];
      const path = `src/${dir}/${base}.ts`;
      steps.push({ tool: "readFile", args: { path } });
      steps.push({
        tool: "editFile",
        args: {
          path,
          old_string: `  if (!result.success) {`,
          new_string: `  if (!result.success) {\n    console.error("[${base}]", result.error);`,
        },
      });
    }

    out.push({
      id: `multi-logging-${i}`,
      band: "multi-file",
      prompt: `Log the error before throwing in every handler that calls ${service}.`,
      fixture,
      steps,
      finalText: `Added error logging before the throw in both call sites.`,
    });
  }

  return out;
}
