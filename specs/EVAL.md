# EVAL.md — superseded

This document described the first eval harness: a `GoldenTask` with a single
`expectedCheck(workspaceDir)`, and tasks named `build-single-file-fix`,
`plan-mode-deliberate-failure`, `ambiguous-prompt-clarifier` and
`plan-mode-nested-directory-structure`.

**None of those exist any more.** The contract, the checks and the task names all
changed when the harness was rewritten, and a document that confidently
describes deleted code is worse than no document — it sends you looking for
files that are not there.

Current spec: **[011-evals-and-telemetry.md](./011-evals-and-telemetry.md)**
User-facing guide: **[evals/README.md](../evals/README.md)**

Two things from the original are worth carrying forward, because they are the
reasons the harness exists at all and neither has changed:

> Before this, testing Zizou meant typing something like "make a todo app,"
> watching what happened, and deciding if it looked okay. That doesn't catch
> anything reliably — every real bug found so far (tool calls silently failing,
> plans running off the rails after a failure, files landing in the wrong place)
> was only found by manually reading a debug log after the fact.

And the rule that still outranks everything else:

> No LLM ever judges whether a test passed. It's always a hard, mechanical
> check: a file exists or it doesn't, a command exits cleanly or it doesn't, a
> pattern is found in a file or it isn't.
