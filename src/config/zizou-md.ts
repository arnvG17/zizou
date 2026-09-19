// src/config/zizou-md.ts
//
// LAYER: config/
//
// Reads per-project settings from ZIZOU.md in the workspace root.
//
// ZIZOU.md is ONE file serving two purposes, because asking a user to keep two
// project files is one file too many:
//
//   - Settings: a `## Agent` section of `key: value` lines, read here.
//   - Conventions: everything else, read by context/load-project-conventions.ts
//     and injected into the agent's system prompt.
//
// It replaces model_config.md, which was a third config store alongside two
// Conf stores and re-parsed on every single config access.
//
// WHY A PROJECT FILE AND NOT JUST GLOBAL SETTINGS: a Rust repo and a React
// repo want different defaults, and a team wants to share them. ZIZOU.md is
// committed; API keys stay in the Conf store and are never written here.
//
// Precedence: ZIZOU.md > Conf store > built-in default. A key absent from the
// file falls through rather than overriding with a default, so a file that
// only sets `effort` leaves the provider alone.
//
// DEPENDENCY DIRECTION: imports from config/ only.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseEffort, type Effort } from "./effort.js";

export interface ProjectSettings {
  provider?: string;
  effort?: Effort;
  /** An explicit model pin, overriding whatever effort would choose. */
  model?: string;
}

/** Where the project's ZIZOU.md lives. */
export function getZizouMdPath(projectRoot: string = process.cwd()): string {
  return join(projectRoot, "ZIZOU.md");
}

/**
 * Reads the `## Agent` section of ZIZOU.md.
 *
 * Returns an empty object when the file is missing, has no Agent section, or
 * cannot be read. Project settings are a convenience; a malformed file must
 * never stop the agent from running.
 */
export function loadProjectSettings(projectRoot: string = process.cwd()): ProjectSettings {
  const path = getZizouMdPath(projectRoot);
  if (!existsSync(path)) return {};

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return {};
  }

  // Take only the Agent section: everything from a heading whose text starts
  // with "Agent" up to the next heading of the same or higher level. Parsing
  // the whole file would pick up `key: value` lines out of prose conventions.
  const section = extractAgentSection(content);
  if (!section) return {};

  const settings: ProjectSettings = {};
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    // Skip blanks, comments, list markers and anything that isn't key: value.
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-") || trimmed.startsWith(">")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
    if (!match) continue;

    const key = match[1].toLowerCase();
    // Strip inline comments and surrounding quotes/backticks.
    const value = match[2].split("#")[0].trim().replace(/^["'`]|["'`]$/g, "");
    if (!value) continue;

    if (key === "provider") {
      settings.provider = value.toLowerCase();
    } else if (key === "effort") {
      const effort = parseEffort(value);
      if (effort) settings.effort = effort;
    } else if (key === "model") {
      settings.model = value;
    }
  }

  return settings;
}

/** Returns the body of the `## Agent` section, or null if there isn't one. */
function extractAgentSection(content: string): string | null {
  const lines = content.split("\n");

  let startIndex = -1;
  let headingLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!heading) continue;

    if (startIndex === -1) {
      if (/^agent\b/i.test(heading[2].trim())) {
        startIndex = i + 1;
        headingLevel = heading[1].length;
      }
      continue;
    }

    // Inside the section: a heading at the same or higher level ends it.
    if (heading[1].length <= headingLevel) {
      return lines.slice(startIndex, i).join("\n");
    }
  }

  return startIndex === -1 ? null : lines.slice(startIndex).join("\n");
}

/** The template written by `/init`, shown in docs and error messages. */
export const ZIZOU_MD_TEMPLATE = `# ZIZOU.md

Project settings and conventions for the Zizou agent.
Committed to the repo, so the whole team shares them.

## Agent

provider: anthropic
effort:   balanced

# effort:   fast | balanced | max
#   fast     small model, minimal context - quick edits and questions
#   balanced mid model, normal context - the default
#   max      strongest model, full context - hard or wide-reaching work
#
# model:   pin an exact model, overriding what effort would pick
#          e.g. model: claude-sonnet-4-5

## Layout

Where things go. The agent treats these as binding when choosing a
destination for a new file, overriding its own guess.

- Example: apps go in apps/<name>/
- Example: React components go in src/components/
- Example: nothing new at the repo root

## Conventions

Everything below this point is injected into the agent's context.
Describe how this project is built and what the agent should avoid.

- Example: use bun, not npm
- Example: no default exports
`;
