# Prompt Runtime Refactor Implementation Plan

> **For agentic workers:** Execute with focused tests before each implementation step.

**Goal:** Route main-reply prompt selection through a validated registry, a resolved plan, and a compiler while preserving current prompt output and cache lanes.

**Architecture:** `promptManifest.js` validates module declarations, `promptPlan.js` selects modules for one request snapshot, and `promptCompiler.js` renders and trims the resolved plan. `promptLoader.js` owns an immutable, versioned static-text snapshot and only replaces it after a successful explicit reload.

**Tech Stack:** Node.js 20, CommonJS, built-in test runner.

---

## Chunk 1: Runtime contracts

- [x] Add failing registry, selection, ordering, and budget tests.
- [x] Implement strict module validation and `resolvePromptPlan(context)`.
- [x] Refactor the compiler around `compilePromptPlan(plan, context)`.
- [x] Preserve the main-reply snapshot fields needed by cache and diagnostics.

## Chunk 2: Controlled loading

- [x] Add failing immutable snapshot, reload fallback, and concurrent-version tests.
- [x] Add `prompts/main-reply/manifest.json` and static assets without changing wording.
- [x] Replace per-request Few-shot file checks with snapshot reads.
- [x] Reuse the request snapshot for stable persona text and cache identity.

## Chunk 3: Main-reply migration and diagnostics

- [x] Migrate base, dynamic, and prepare assembly to resolver plus compiler.
- [x] Add prompt version, module reasons, order, budget, and trim data to observations and preview.
- [x] Add an authenticated reload route under the existing web session middleware.
- [x] Verify stable prefix and provider cache-marker placement.

## Chunk 4: Verification and delivery

- [x] Run focused tests and `node scripts/run-tests.js`.
- [x] Record dated architecture and verification results in docs and README.
- [x] Commit runtime/tests, then commit documentation only; do not push.

## Verification Record (2026-08-17)

- Runtime path: `promptManifest.js` -> `resolvePromptPlan(context)` -> `compilePromptPlan(plan, context)`; the main-reply request captures one immutable `promptLoader` snapshot.
- Explicit reload: `POST /api/prompt-runtime/reload` is registered after the existing web session and same-origin middleware. Failed reloads retain the old snapshot and return the diagnostic error.
- Focused verification: `node --test tests/promptPlan.test.js tests/promptLoader.test.js tests/mainReplyPromptAssemblyDiagnostics.test.js tests/adminStableSystemPrompt.test.js tests/conversationContextClaudeCacheMarkers.test.js tests/fewShotPromptsCache.test.js tests/promptRuntimeReloadRoute.test.js`.
- Full verification: `node scripts/run-tests.js` passed all tracked tests on 2026-08-19 with Node 24.14.1. No prompt wording, `prompts/admin.txt`, cache marker position, database, file watcher, or remote push was changed.

## Verification Record (2026-08-20)

- Prompt governance now treats `prompts/main-reply/manifest.json` and every asset it references as registered prompt resources, so the repository prompt check covers the new loader snapshot without changing the existing allowlist counts.
- Focused regression: `node --test tests/agentPrompts.test.js tests/checkPromptsIntegration.test.js tests/promptCheckGovernance.test.js` passed.
- Full verification: `node scripts/run-tests.js` exited 0 with Node 24.14.1. The fix only changes prompt asset reference discovery and its governance test; runtime prompt wording and reload behavior are unchanged.
