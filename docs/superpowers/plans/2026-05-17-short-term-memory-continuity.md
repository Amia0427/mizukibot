# Short-Term Memory Continuity Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase short-term memory carried conversation length and continuity without changing long-term memory semantics.

**Architecture:** Keep the current layered flow: raw `chatHistory`, structured `shortTermMemory`, restart `shortTermBridge`, first-turn `session_context_summaries`, and Memory V3 `session_checkpoint`. Replace hard-coded small windows with config-backed limits and add regression coverage.

**Tech Stack:** Node.js CommonJS, built-in `assert`, existing runtime V2 memory utilities.

---

## Chunk 1: Window Configuration

### Task 1: Add Short-Term Window Knobs

**Files:**
- Modify: `config.js`
- Modify: `utils/shortTermMemory.js`
- Modify: `utils/shortTermBridgeMemory.js`
- Modify: `api/runtimeV2/nodes/persist.js`
- Test: `tests/shortTermMemoryWindowConfig.test.js`

- [ ] Add config defaults for structured recent turns, scene recent turns, compression chunk size, and checkpoint recent messages.
- [ ] Use those config values where small windows are currently hard-coded.
- [ ] Add regression tests proving a larger configured window is honored.
- [ ] Run the targeted short-term memory tests.

## Chunk 2: Aggressive Continuity Injection

### Task 2: Add Explicit Short-Term Continuity Prompt Block

**Files:**
- Modify: `config.js`
- Modify: `api/runtimeV2/context/base-dynamic-prompt.chunk.js`
- Modify: `utils/mainReplyPromptBlocks.js`
- Test: `tests/shortTermMemoryWindowConfig.test.js`

- [ ] Add larger default windows for recent raw history and restart bridge payloads.
- [ ] Serialize short-term summary, restart summaries, and recent raw turns into a first-class dynamic prompt block.
- [ ] Include the block by default when it has content.
- [ ] Extend regression tests to assert the block is selected and contains recent turns.
