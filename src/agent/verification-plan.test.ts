// src/agent/verification-plan.test.ts
//
// Whether "it worked" gets checked, and with what.
//
// The rule being protected: verification is derived from what the project
// ACTUALLY declares and what actually changed. The two ways to get this wrong
// are opposite and both bad — inventing a command the project never asked for,
// and running nothing at all because the step forgot to say what success meant.

import { test, expect } from "bun:test";
import { alreadyRan, deriveVerification, autoVerifyEnabled } from "./verification-plan.js";
import type { ProjectRuntime } from "../context/project-runtime.js";

function runtime(scripts: Record<string, string>, installed = true): ProjectRuntime {
  return { packageManager: "bun", scripts, dependenciesInstalled: installed };
}

// ─── Choosing a check ────────────────────────────────────────────────────────

test("a TypeScript change prefers the project's typecheck", () => {
  const check = deriveVerification(
    ["src/app.ts"],
    "/p",
    runtime({ typecheck: "tsc --noEmit", test: "bun test", build: "bun run build.ts" }),
  );

  // Strongest evidence for the least time: a typecheck proves more about a
  // .ts change than a lint, and costs less than a full build.
  expect(check?.kind).toBe("typecheck");
  // Spelled for the project's own package manager, not a guessed `npm run`.
  expect(check?.command).toBe("bun run typecheck");
});

test("the next-best check is used when the preferred one does not exist", () => {
  const check = deriveVerification(["src/app.ts"], "/p", runtime({ test: "bun test" }));
  expect(check?.kind).toBe("test");
});

test("a project that declares no check script gets none invented for it", () => {
  // Falling back to a hardcoded `tsc --noEmit` would be exactly the guessing
  // this replaces — and would fail loudly in a project that never wanted it.
  expect(deriveVerification(["src/app.ts"], "/p", runtime({ start: "node ." }))).toBeNull();
});

test("nothing is derived before dependencies are installed", () => {
  // The command could not succeed, so running it would produce a hard finding
  // about the install rather than about the change.
  expect(
    deriveVerification(["src/app.ts"], "/p", runtime({ typecheck: "tsc --noEmit" }, false)),
  ).toBeNull();
});

test("a project with no package.json gets nothing", () => {
  expect(deriveVerification(["src/app.ts"], "/p", null)).toBeNull();
});

// ─── Proportionality ─────────────────────────────────────────────────────────

test("documentation and markup changes trigger no check", () => {
  // A README edit must not run the test suite. A check that fires on
  // everything is a tax, and a tax gets switched off.
  const scripts = runtime({ typecheck: "tsc --noEmit", test: "bun test" });

  expect(deriveVerification(["README.md"], "/p", scripts)).toBeNull();
  expect(deriveVerification(["styles.css"], "/p", scripts)).toBeNull();
  expect(deriveVerification(["index.html"], "/p", scripts)).toBeNull();
  // JSON is already structurally validated by the verifier's syntax check.
  expect(deriveVerification(["data.json"], "/p", scripts)).toBeNull();
});

test("a change with nothing to check returns nothing even in a full project", () => {
  expect(deriveVerification([], "/p", runtime({ typecheck: "tsc --noEmit" }))).toBeNull();
});

test("a mixed change takes the strongest check any of its files earned", () => {
  // Merged in preference order rather than intersected: a .ts file in the set
  // earns a typecheck even though the .js files alone would not.
  const check = deriveVerification(
    ["src/app.ts", "scripts/tool.js", "README.md"],
    "/p",
    runtime({ typecheck: "tsc --noEmit", test: "bun test" }),
  );

  expect(check?.kind).toBe("typecheck");
});

test("a watch script is never chosen, because it does not exit", () => {
  // Matching is on exact script names for this reason: a substring match on
  // "test" would happily pick "test:watch" and block until the timeout.
  const check = deriveVerification(
    ["src/app.js"],
    "/p",
    runtime({ "test:watch": "bun test --watch" }),
  );

  expect(check).toBeNull();
});

// ─── Not running it twice ────────────────────────────────────────────────────

test("a check the step already ran is not run again", () => {
  const check = deriveVerification(["src/app.ts"], "/p", runtime({ typecheck: "tsc --noEmit" }))!;

  // Matched on the script name, so the model running it through a different
  // package manager still counts. Re-running would double the cost of every
  // step for no new information.
  expect(alreadyRan(check, ["bun run typecheck"])).toBe(true);
  expect(alreadyRan(check, ["npm run typecheck"])).toBe(true);
  expect(alreadyRan(check, ["git status"])).toBe(false);
  expect(alreadyRan(check, [])).toBe(false);
});

// ─── The escape hatch ────────────────────────────────────────────────────────

test("auto-verification is on unless explicitly switched off", () => {
  const original = process.env.ZIZOU_NO_AUTO_VERIFY;
  try {
    delete process.env.ZIZOU_NO_AUTO_VERIFY;
    expect(autoVerifyEnabled()).toBe(true);

    process.env.ZIZOU_NO_AUTO_VERIFY = "1";
    expect(autoVerifyEnabled()).toBe(false);

    process.env.ZIZOU_NO_AUTO_VERIFY = "true";
    expect(autoVerifyEnabled()).toBe(false);

    // Anything else is not an opt-out. Silently disabling verification
    // because of a stray value is the failure this guards against.
    process.env.ZIZOU_NO_AUTO_VERIFY = "0";
    expect(autoVerifyEnabled()).toBe(true);
  } finally {
    if (original === undefined) delete process.env.ZIZOU_NO_AUTO_VERIFY;
    else process.env.ZIZOU_NO_AUTO_VERIFY = original;
  }
});
