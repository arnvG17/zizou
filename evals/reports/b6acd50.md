# Zizou eval report

- commit: `b6acd50`
- version: 1.3.2
- started: 2026-09-22T20:26:21.407Z
- tasks: 15

## Model comparison

| model | effort | pass | tasks | tools/run | tokens/run | $/run | $/pass | fallback | tool fails |
|---|---|---|---|---|---|---|---|---|---|
| `gpt-5-mini` | balanced | 53% | 8/15 | 15.5 | 0 | unknown | unknown | 0 | 10 |

`$/run` reads `unknown` when the model has no entry in the rate table (`src/tui/cost-tracker.ts`). It is not defaulted to a guessed rate.

## Per-task results

### openai / `gpt-5-mini` / balanced

| task | pass rate | failures |
|---|---|---|
| `build-create-file` | 100% | — |
| `build-fix-off-by-one` | 100% | — |
| `plan-dependency-ordering` | 0% | assertion: exists: utils.ts: not found at C:\Users\Arnv\ZIZOUv1\evals\.artifacts\openai-balanced--plan-dependency-ordering--run1-17 |
| `plan-ambiguous-assumptions` | 0% | budget: tool calls 107 > budget 25 |
| `build-edit-missing-file` | 100% | — |
| `auto-route-chat` | 0% | assertion: routed to chat: routed to build (mode=build reason=Auto → build: router unavailable: The model `gpt-4o-mini` does not ex |
| `auto-route-ask` | 0% | assertion: routed to ask: routed to build (mode=build reason=Auto → build: router unavailable: The model `gpt-4o-mini` does not exi |
| `auto-route-build` | 100% | — |
| `auto-route-plan` | 0% | assertion: routed to plan: routed to build (mode=build reason=Auto → build: router unavailable: The model `gpt-4o-mini` does not ex |
| `auto-route-plan-underspecified` | 0% | assertion: routed to plan: routed to build (mode=build reason=Auto → build: router unavailable: The model `gpt-4o-mini` does not ex |
| `auto-route-build-specified` | 100% | — |
| `build-file-placement` | 100% | — |
| `build-edit-not-recreate` | 100% | — |
| `build-long-conversation` | 100% | — |
| `build-run-and-verify-server` | 0% | budget: tool calls 28 > budget 25 |
