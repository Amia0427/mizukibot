# Private Message Restart Recovery Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover private messages whose reply was interrupted by a bot restart or which arrived while the HTTP reverse ingress was offline.

**Architecture:** Persist every accepted private inbound message before the HTTP 204 acknowledgement and mark it complete only after the normal message pipeline finishes. On startup, replay unfinished records and query NapCat recent contacts for the latest unanswered private message received during the downtime window; inspect friend history before replaying uncertain records to avoid duplicate replies.

**Tech Stack:** Node.js CommonJS, Express, NapCat OneBot HTTP actions, JSON hot store, existing test runner.

---

### Task 1: Durable Recovery State

**Files:**
- Create: `utils/privateMessageRecoveryStore.js`
- Test: `tests/privateMessageRecoveryStore.test.js`

- [x] Persist a private inbound message synchronously before acknowledgement.
- [x] Keep failed or interrupted messages pending across store recreation.
- [x] Remove completed messages from pending state and retain a bounded deduplication record.
- [x] Run the focused store test.

### Task 2: Startup Recovery Runtime

**Files:**
- Create: `core/privateMessageRecoveryRuntime.js`
- Test: `tests/privateMessageRecoveryRuntime.test.js`

- [x] Reconcile pending messages with `get_friend_msg_history`.
- [x] Replay unfinished messages without a later textual bot reply.
- [x] Query `get_recent_contact` and replay the latest unanswered private message from the downtime window.
- [x] Advance the recovery cursor only after a successful scan.
- [x] Run the focused runtime test.

### Task 3: Ingress Integration

**Files:**
- Modify: `core/napcatHttpReverseServer.js`
- Modify: `core/messageIngressDispatcher.js`
- Modify: `index.js`
- Modify: `config/index.js`
- Modify: `.env.example`
- Test: `tests/napcatHttpReverseServer.test.js`
- Test: `tests/messageIngressDispatcher.test.js`
- Test: `tests/messageIngressAsyncEntrypointSource.test.js`

- [x] Add a pre-acknowledgement acceptance hook to the HTTP reverse server.
- [x] Mark recovery records complete only after the normal handler resolves.
- [x] Wire startup recovery after runtime readiness.
- [x] Run the NapCat ingress smoke suite.

### Task 4: Documentation And Acceptance

**Files:**
- Modify: `README.md`
- Create: `docs/private-message-restart-recovery.md`

- [x] Document scope, configuration, state file, and operational limits with a `2026-08-25` timestamp.
- [x] Run syntax, focused tests, ingress smoke tests, and lint for touched files.
- [x] Record the actual acceptance commands and results.
- [x] Commit only the files changed for this goal (`2057898e`).
