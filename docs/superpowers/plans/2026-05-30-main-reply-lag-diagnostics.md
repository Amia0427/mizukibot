# Main Reply Lag Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one diagnostic entry for main-reply stalls that reports planner latency, main model latency, send latency, post-reply worker RSS pressure, and the most likely bottleneck.

**Architecture:** Reuse existing runtime status, hotspots, low-resource, and provider request diagnostics. Add a small aggregation utility plus CLI script; only add minimal perf-event field parsing and docs updates.

**Tech Stack:** Node.js CommonJS scripts, existing perf/resource JSONL diagnostics, npm test runner.

---

## Chunk 1: Diagnostic Aggregator

**Files:**
- Create: `utils/mainReplyLagDiagnostics.js`
- Create: `scripts/diagnose-main-reply-lag.js`
- Modify: `package.json`
- Test: `tests/mainReplyLagDiagnostics.test.js`

- [ ] Implement parser for recent perf events with aliases for planner, main-model, and send durations.
- [ ] Combine `buildRuntimeStatusDiagnostic`, `buildRuntimeHotspotsDiagnostic`, `buildLowResourceHealthReport`, and optional provider request diagnostics.
- [ ] Output a compact text summary by default and JSON under `--json`.
- [ ] Pick bottleneck by largest latency/pressure signal with deterministic tie order.
- [ ] Add `diag:main-reply-lag` npm script.

## Chunk 2: Minimal Instrumentation

**Files:**
- Modify: `src/model/http/post-retry.chunk.js` or existing model request telemetry caller only if current perf logs cannot expose main-model duration.
- Modify: `core/messageHandler.runtime-05.chunk.js` only if final send duration alias is missing.

- [ ] Prefer existing `durationMs` on `reply_send_*` and `planner_done`.
- [ ] If model request events lack a stable alias, add `mainModelDurationMs`/`module: main_model` to the existing model-call perf event without changing request behavior.

## Chunk 3: Docs And Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/runtime-latency-diagnosis.md`

- [ ] Add timestamped docs note for `npm run diag:main-reply-lag`.
- [ ] Run focused diagnostics tests.
- [ ] Run package test command if focused tests pass.
- [ ] Commit only files touched by this task, preserving existing dirty files.
