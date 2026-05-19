# Profile Memory Governance Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve user profile memory cleanup, write quality, recall ranking, and prompt injection without rewriting the memory subsystem.

**Architecture:** Add a small lifecycle policy module for profile memory nodes, then call it from materialization, recall filtering/scoring, vector visibility, and profile prompt rendering. Keep event history immutable; derived projections mark stale/suspect/superseded nodes so old facts stop influencing recall and prompt injection.

**Tech Stack:** Node.js CommonJS, existing Memory V3 projections, existing test runner.

---

Updated: 2026-05-19 21:25 +08:00

## Chunk 1: Lifecycle And Quality Policy

### Task 1: Add lifecycle policy module

**Files:**
- Create: `utils/memory-v3/profileLifecycle.js`
- Test: `tests/memoryV3ProfileLifecycle.test.js`

- [x] **Step 1: Add field TTL and quality helpers**

Implement profile field categories, TTL resolution, freshness scoring, stale/suspect detection, and lifecycle status derivation.

- [x] **Step 2: Add conservative config defaults**

Read optional profile governance env vars inside the lifecycle module, with conservative defaults, so this change does not collide with concurrent config work.

- [x] **Step 3: Add focused tests**

Cover stale candidate downgrade, explicit memory survival, generic write rejection, and prompt surface formatting.

## Chunk 2: Projection And Recall Integration

### Task 2: Materialize lifecycle into nodes and profiles

**Files:**
- Modify: `utils/memory-v3/materializer.js`
- Modify: `utils/memory-v3/materializerNodes.js`
- Modify: `utils/memory-v3/recallFilter.js`
- Test: `tests/memoryV3ProfileLifecycle.test.js`

- [x] **Step 1: Carry lifecycle metadata from events**

Preserve payload `expiresAt`, `lifecycleStatus`, `profileQuality`, and correction metadata on nodes.

- [x] **Step 2: Decorate profile nodes during materialization**

Mark stale/suspect nodes before projection; include suppressed reasons in profile trace.

- [x] **Step 3: Treat stale/suspect/superseded as not recallable**

Update shared recall filtering so query, embeddings, and docs skip hidden lifecycle states.

### Task 3: Improve recall ranking

**Files:**
- Modify: `utils/memory-v3/queryRanking.js`
- Modify: `utils/lancedbMemoryStore/rows.js`
- Test: `tests/memoryV3ProfileLifecycle.test.js`

- [x] **Step 1: Exclude hidden lifecycle states during ranking**

Filter stale, suspect, and superseded profile memories before conflict resolution; extend identity facet matching to stable profile goal/boundary/hobby/personality fields.

- [x] **Step 2: Avoid stale vector rows**

Keep vector SQL and row predicate consistent with lifecycle statuses.

## Chunk 3: Prompt Surface And Docs

### Task 4: Improve profile prompt injection text

**Files:**
- Modify: `utils/memoryProfileSurface/surface.js`
- Test: `tests/memoryContextProfileInjection.test.js`

- [x] **Step 1: Render action-oriented profile sections**

Prefer "stable facts", "reply preferences", "use cautiously", and "do not infer" over raw profile dumps.

- [x] **Step 2: Preserve existing budget and trace behavior**

Keep `buildStableProfileText` return shape unchanged.

### Task 5: Update docs and verify

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-05-19-profile-memory-governance.md`

- [x] **Step 1: Document the new governance behavior**

Add a brief timestamped README note and mark this plan complete.

- [x] **Step 2: Run focused tests**

Run:

```bash
node tests/memoryV3ProfileLifecycle.test.js
node tests/memoryV3MaterializerProfile.test.js
node tests/memoryV3Query.test.js
node tests/memoryContextProfileInjection.test.js
node tests/memoryProfileSurface.test.js
node tests/memoryExtractionProfileClassification.test.js
```

- [x] **Step 3: Commit**

Stage only files changed for this implementation and commit on the current branch.
