// src/config/zizou-md.test.ts
//
// ZIZOU.md holds BOTH agent settings and free-text conventions. These tests
// pin the boundary between them: prose in the conventions section must never
// be parsed as configuration.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loadProjectSettings } from "./zizou-md.js";

const workspace = mkdtempSync(join(tmpdir(), "zizou-md-test-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function withFile(content: string) {
  writeFileSync(join(workspace, "ZIZOU.md"), content, "utf-8");
  return loadProjectSettings(workspace);
}

test("reads provider, effort and model from the Agent section", () => {
  const settings = withFile(`# ZIZOU.md

## Agent

provider: anthropic
effort: max
model: claude-opus-4-5
`);

  expect(settings).toEqual({
    provider: "anthropic",
    effort: "max",
    model: "claude-opus-4-5",
  });
});

test("ignores key: value lines outside the Agent section", () => {
  // The whole point of scoping to a section: conventions are prose, and prose
  // contains colons. Parsing the file as a whole would read "provider: we use
  // Stripe" as a provider setting.
  const settings = withFile(`# ZIZOU.md

## Agent

effort: fast

## Conventions

provider: we use Stripe for billing
model: the domain model lives in src/models
- Note: never commit secrets
`);

  expect(settings).toEqual({ effort: "fast" });
});

test("a missing file yields no settings rather than throwing", () => {
  const empty = mkdtempSync(join(tmpdir(), "zizou-md-none-"));
  expect(loadProjectSettings(empty)).toEqual({});
  rmSync(empty, { recursive: true, force: true });
});

test("a file with no Agent section yields no settings", () => {
  const settings = withFile(`# ZIZOU.md

## Conventions

- Use bun, not npm
`);
  expect(settings).toEqual({});
});

test("absent keys fall through instead of being defaulted", () => {
  // A file that only sets effort must leave provider alone, so the Conf
  // store's value still applies.
  const settings = withFile(`## Agent
effort: balanced
`);
  expect(settings.effort).toBe("balanced");
  expect(settings.provider).toBeUndefined();
  expect(settings.model).toBeUndefined();
});

test("strips inline comments, quotes and stray whitespace", () => {
  const settings = withFile(`## Agent

provider:  "anthropic"    # the good one
effort:    max
model:     \`claude-opus-4-5\`
`);

  expect(settings).toEqual({
    provider: "anthropic",
    effort: "max",
    model: "claude-opus-4-5",
  });
});

test("an unrecognised effort value is ignored, not guessed at", () => {
  const settings = withFile(`## Agent
effort: turbo
provider: groq
`);
  expect(settings.effort).toBeUndefined();
  expect(settings.provider).toBe("groq");
});

test("accepts the documented aliases for effort", () => {
  expect(withFile("## Agent\neffort: high\n").effort).toBe("max");
  expect(withFile("## Agent\neffort: default\n").effort).toBe("balanced");
  expect(withFile("## Agent\neffort: F\n").effort).toBe("fast");
});

test("commented-out settings are not applied", () => {
  const settings = withFile(`## Agent

provider: groq
# effort: max
`);
  expect(settings.provider).toBe("groq");
  expect(settings.effort).toBeUndefined();
});
