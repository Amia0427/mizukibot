# Developer Source Guide Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为首次接触 MizukiBot 的开发者建立一套可按任务阅读、可按命令验收、与真实源码边界一致的多文档开发指南。

**Architecture:** 在 `docs/development/` 建立稳定入口，按“先运行、再理解主链路、最后扩展与排障”拆分独立文档；文档引用当前 CommonJS 入口、兼容 facade、测试运行器和诊断命令，不复制 `.env.example` 或源码中的易漂移清单。README 只增加带时间戳的入口与本次验收记录，避免继续扩大其职责。

**Tech Stack:** Node.js 20、CommonJS、LangGraph、Express、WebSocket/OneBot、SQLite、LanceDB、Markdown

---

## Chunk 1: Source map and document skeleton

### Task 1: Verify repository boundaries

**Files:**
- Read: `package.json`
- Read: `index.js`
- Read: `config/index.js`
- Read: `api/agentGraph.js`
- Read: `api/agentGraphV2.js`
- Read: `api/runtimeV2/host/index.js`
- Read: `core/messageHandler.runtime.js`
- Read: `scripts/run-tests.js`
- Read: `scripts/lint.js`

- [x] **Step 1: Inventory tracked source and test files**

Run: `rg --files api config core src utils web scripts tests prompts`

Expected: command succeeds and exposes all paths used by the guide.

- [x] **Step 2: Trace the runtime entry**

Run: `rg -n "startMainProcess|createMessageHandler|askAIByGraph|createGraphRuntime" index.js api core src`

Expected: the trace starts at `index.js`, enters the message handler, then `api/agentGraph` and Runtime V2 host.

- [x] **Step 3: Confirm verification commands**

Run: `node scripts/run-tests.js tests/runTestsRunner.test.js`

Expected: the focused test-runner regression passes without starting the full suite.

### Task 2: Create the documentation hub

**Files:**
- Create: `docs/development/README.md`
- Create: `docs/development/01-getting-started.md`
- Create: `docs/development/02-architecture-map.md`

- [x] **Step 1: Write the navigation hub**

Document the intended audience, recommended reading routes, document ownership, freshness date, and links to all seven topic guides.

- [x] **Step 2: Write the local setup guide**

Document Node 20, dependency install, minimal safe configuration workflow, startup modes, first smoke checks, and files that must not be committed.

- [x] **Step 3: Write the architecture map**

Document process boundaries, top-level directories, dependency direction, compatibility facades, runtime data ownership, and the recommended location for new code.

## Chunk 2: Runtime and extension guides

### Task 3: Explain the Agent execution paths

**Files:**
- Create: `docs/development/03-message-and-agent-runtime.md`
- Create: `docs/development/04-memory-and-prompts.md`

- [x] **Step 1: Document the inbound-to-outbound message sequence**

Trace NapCat WebSocket/HTTP reverse ingress, async dispatch, route selection, Runtime V2 graph, model/tool loop, reply guard, persistence, and post-reply queue.

- [x] **Step 2: Document lifecycle and concurrency boundaries**

Explain startup, readiness, reconnect, per-session serialization, worker boundaries, graceful shutdown, and why direct invocation of internal chunks is unsupported.

- [x] **Step 3: Document state and prompt composition**

Separate short-term state, journal/profile, Memory V3/vector recall, prompt manifest, runtime prompt blocks, write pipelines, and data inspection points.

### Task 4: Explain safe feature development

**Files:**
- Create: `docs/development/05-feature-development.md`
- Create: `docs/development/06-testing-and-quality.md`

- [x] **Step 1: Provide task-oriented change recipes**

Cover adding a local route, model capability/tool, background feature, Web endpoint, configuration key, prompt module, memory behavior, and diagnostic command.

- [x] **Step 2: Define project-specific design constraints**

Document CommonJS export shape, dependency injection at composition roots, data-store ownership, lazy loading on hot paths, source/facade compatibility, and secret handling.

- [x] **Step 3: Explain the test system**

Document test naming/discovery, targeted and full-suite commands, serial tests, lint/typecheck/prompt/secret gates, test isolation, and evidence requirements.

## Chunk 3: Operations, integration, and acceptance

### Task 5: Add the debugging and operations guide

**Files:**
- Create: `docs/development/07-debugging-and-operations.md`
- Create: `tests/developerDocumentation.test.js`

- [x] **Step 1: Build a symptom-to-evidence workflow**

Map ingress, routing, model calls, tool execution, memory, reply delivery, worker backlog, Web health, and shutdown symptoms to existing diagnostics and data files.

- [x] **Step 2: Define production-safe investigation boundaries**

Explain redaction, read-only diagnosis, local-first reproduction, process-role separation, and when a restart is or is not evidence of a fix.

- [x] **Step 3: Add a documentation integrity regression**

Create a Node `assert` test that scans `docs/development/*.md`, resolves every local Markdown link, verifies exact repository paths in prose and commands, and checks every referenced `npm run` script. Ignore URLs, anchors, environment keys, paths containing wildcards/placeholders, and explicitly private prompt paths.

Run: `node tests/developerDocumentation.test.js`

Expected: PASS with the number of checked documents, local links, and repository paths.

### Task 6: Link and verify the guide

**Files:**
- Modify: `README.md`
- Modify: `docs/development/README.md`

- [ ] **Step 1: Prepare the post-commit README entry**

After the primary documentation commit exists, add one stable developer-guide link under the existing documentation entry and a concise acceptance record using the real completion time and commit id.

- [x] **Step 2: Verify Markdown links and referenced paths**

Run: `node tests/developerDocumentation.test.js`

Expected: all local Markdown links, exact repository paths, and `npm run` scripts resolve; URLs, anchors, environment keys, wildcards, placeholders, and private prompt paths are excluded by the checked-in test.

- [x] **Step 3: Run repository quality gates**

Run: `npm run lint`

Expected: PASS.

Run: `npm run check:agent:static`

Expected: PASS.

Run: `npm run check:prompts`

Expected: PASS.

Run: `git diff --check`

Expected: no output.

- [x] **Step 4: Review commit scope**

Task-start baseline: `AGENT.md` and `docs/superpowers/plans/2026-07-30-prompt-injection-hardening.md` were untracked; `README.md` had no working-tree change.

Run: `git status --short`

Expected: the two baseline files remain untracked; only this plan, `docs/development/`, and `tests/developerDocumentation.test.js` belong to the primary documentation commit. Preserve every later concurrent change.

Run: `git diff -- docs/superpowers/plans/2026-07-30-developer-source-guide.md`

Expected: tracked-file changes belong to this task. Review untracked `docs/development/` and `tests/developerDocumentation.test.js` directly because ordinary `git diff` does not display them.

Run after staging: `git diff --cached --check && git diff --cached --stat && git diff --cached --name-only`

Run: `git diff --cached -- docs/development tests/developerDocumentation.test.js docs/superpowers/plans/2026-07-30-developer-source-guide.md`

Expected: the complete staged content contains only this documentation set, its integrity test, and the plan; every unrelated file remains unstaged.

- [ ] **Step 5: Commit**

```bash
git add docs/development tests/developerDocumentation.test.js docs/superpowers/plans/2026-07-30-developer-source-guide.md
git commit -m "docs: add developer source guide"
```

- [ ] **Step 6: Record completion after the primary commit**

Append the real completion timestamp, primary commit id, executed commands, results, and `小目标已完成` to `docs/development/README.md`; add the developer-guide link and the same concise acceptance summary to `README.md`.

- [ ] **Step 7: Commit the completion record**

Stage the exact README and developer-hub hunks only, inspect their complete cached diff, and commit them with `docs: record developer guide acceptance`.
