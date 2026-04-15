# Continuity Online Smoke Template

## Goal

Validate that the main conversation agent carries forward the immediate prior thread state more reliably in both:

1. direct reply
2. tool-plan final synthesis

## Preconditions

- `CONTINUITY_STATE_PROMPT_ENABLED=true`
- `CONTINUITY_AUTO_PROBE_ENABLED=true`
- `MEMORY_CLI_ENABLED=true`
- `MEMORY_CLI_CHAT_ENABLED=true`
- runtime deployed with only this round's changed files

## Smoke 1: direct reply continuity

Send in the same session:

1. `我们刚定的执行计划是什么，先用一句话说`
2. `继续，不要重讲背景`

Expected:

- second reply should continue the prior plan instead of re-explaining from zero
- logs/events should include:
  - `continuity_state_built`
  - either `continuity_probe_skipped` or `continuity_probe_result`

## Smoke 2: weak-local-context auto probe

Use a session that has weak short-term state but has retrievable recent memory.

Send:

1. `你还记得我们上次做到哪了吗`

Expected:

- reply should reference recent continuity rather than generic amnesia
- if local continuity evidence is weak, events should show:
  - `continuity_probe_triggered`
  - `continuity_probe_result`

## Smoke 3: tool-plan final synthesis continuity

Send a request that enters tool-plan mode after a prior planning exchange:

1. `按我们刚才定的思路继续，把检查步骤列出来`

Expected:

- final synthesized answer should preserve prior thread intent and constraints
- continuity should affect the final answer even when the reply comes from plan synthesis, not only direct reply

## Verify

- inspect event log for the current thread
- confirm no extra write-path memory command was executed automatically
- confirm no automatic `mem open` happened
- confirm service logs do not show route regressions or repeated tool loops
