# Embedding Protocol Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `BAAI/bge-m3` Embeddings 请求被共享 HTTP 层错误转换为 Chat Completions 请求，恢复 `/v1/embeddings` 的真实上游调用。

**Architecture:** Embedding 客户端在请求体中声明内部协议标记 `__preferredProtocol: 'embeddings'`。共享请求准备层在识别该协议后保留原始 `input` 请求体和 Embeddings URL，仅继续执行通用内部字段清理；Chat/Responses 请求仍沿用现有归一化逻辑。

**Tech Stack:** Node.js、Axios、Node `assert` 测试、现有 `prepareRequest`/`postWithRetry` HTTP 抽象。

---

## Chunk 1: Embeddings 协议边界

### Task 1: Add regression coverage

**Files:**
- Modify: `tests/providerRequestNormalization.test.js`
- Modify: `tests/memoryEmbeddingClient.test.js`

- [x] **Step 1: Add a `prepareRequest` assertion for an Embeddings request**

  Use an explicit `__preferredProtocol: 'embeddings'` with an `/v1/embeddings` URL and assert that the prepared body keeps `input`, has no `messages`, and keeps the endpoint unchanged.

- [x] **Step 2: Extend the Embedding client mock assertion**

  Assert that `embedTexts()` passes `__preferredProtocol: 'embeddings'` to the shared HTTP client while retaining the existing timeout and TLS flags.

- [x] **Step 3: Run the focused tests and confirm the new assertions fail before implementation**

  Run:

  ```text
  node scripts/run-tests.js tests/providerRequestNormalization.test.js tests/memoryEmbeddingClient.test.js
  ```

  Expected: the new Embeddings assertions fail because the current shared layer converts `input` to `messages` and the client does not declare a protocol.

### Task 2: Implement the protocol branch

**Files:**
- Modify: `src/model/http/prepare.chunk.js`
- Modify: `utils/memoryEmbeddingClient.js`

- [x] **Step 1: Detect the explicit Embeddings protocol before stripping internal fields**

  Add a small local predicate for `body.__preferredProtocol === 'embeddings'`.

- [x] **Step 2: Preserve Embeddings request URL and body**

  In the OpenAI-compatible branch, skip Chat Completions URL/body normalization for Embeddings requests. Continue stripping internal fields so the provider only receives `model` and `input`.

- [x] **Step 3: Mark Embedding client requests with the protocol**

  Add `__preferredProtocol: 'embeddings'` beside the existing internal timeout/TLS/trace fields.

- [x] **Step 4: Run the focused tests and confirm they pass**

  Run the same focused command and expect both tests to pass.

## Chunk 2: Documentation and verification

### Task 3: Document the boundary and verify the repository

**Files:**
- Modify: `README.md`
- Modify: `docs/env-configuration.md`
- Modify: `docs/maintenance-log.md`

- [x] **Step 1: Add a short operational note**

  Record that `MEMORY_EMBEDDING_API_BASE_URL` must remain an Embeddings endpoint and that the shared HTTP layer now preserves the Embeddings protocol.

- [x] **Step 2: Run targeted and repository checks**

  Run the focused tests, `npm run lint`, `npm run typecheck`, and `git diff --check`.

- [x] **Step 3: Perform a live smoke check when the configured key is available**

  Send one request through the project client and verify HTTP 200, `data.length >= 1`, and vector dimension 1024. Do not write the API key to logs or documentation.

- [x] **Step 4: Commit only the files belonging to this fix**

  Preserve all unrelated pre-existing worktree changes and do not push to the remote repository.
