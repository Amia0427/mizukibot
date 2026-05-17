# Memory Vector Profile Optimization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep user profile injection minimal and stable while moving most recall quality to V3/vector memory with embedding, rerank, and stricter write gates.

**Architecture:** Do not migrate or delete existing memory data. Tighten extraction/write classification, prevent transient evidence from materializing into profile projections, and shrink prompt-facing profile text so detailed facts are recalled through V3/vector evidence.

**Tech Stack:** Node.js CommonJS, local JSON/V3 memory projections, optional embedding/rerank/LanceDB.

---

## Chunk 1: Conservative Writes And Thin Profile Surface

### Task 1: Add Tunable Defaults

**Files:**
- Modify: `config.js`

- [x] Add profile surface mode and default it to `basic`.
- [x] Add legacy profile write policy and default it to `explicit_only`.
- [x] Add summary/impression support gate and default it to require supporting profile evidence.
- [x] Add extraction-class projection guard and default it on.

### Task 2: Thin Profile Prompt Text

**Files:**
- Modify: `utils/memoryProfileSurface.js`
- Modify: `utils/memoryContext.js`
- Test: `tests/memoryProfileSurface.test.js`
- Test: `tests/memoryContextProfileInjection.test.js`

- [x] Keep `[LongTermProfile]` to relation, identity, boundaries, and optionally goals by default.
- [x] Keep likes/dislikes/hobbies/personality out of default profile prompt; those remain searchable via V3/vector memory.
- [x] Do not inject persona summary/impression into the separate `[Summary]`/`[Impression]` blocks by default.
- [x] Preserve explicit profile-query behavior behind the existing weak/profile-query path.

### Task 3: Harden Extraction Writes

**Files:**
- Modify: `api/memoryExtraction.js`
- Modify: `utils/memory-v3/materializer.js`
- Test: `tests/memoryExtractionProfileClassification.test.js`
- Test: `tests/memoryExtractionProfileV3Bridge.test.js`
- Test: `tests/memoryV3MaterializerProfile.test.js`

- [x] Default extractor profile-like writes to candidate unless explicit.
- [x] Stop normal extractor writes from updating legacy profile arrays except policy-approved identity/goal basics.
- [x] Gate summary/impression support so single-turn low-evidence summaries do not update personaCore.
- [x] Prevent `episodic_observation` and `journal_only` nodes from entering strict/weak profile projections.

### Task 4: Verify

**Commands:**
- `node tests\memoryProfileSurface.test.js`
- `node tests\memoryContextProfileInjection.test.js`
- `node tests\memoryExtractionProfileClassification.test.js`
- `node tests\memoryExtractionProfileV3Bridge.test.js`
- `node tests\memoryV3MaterializerProfile.test.js`
- `node tests\memoryWritePipeline.test.js`
- `node tests\memoryV3Query.test.js`
