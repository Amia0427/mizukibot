# Streaming Segment Order Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保证同一流的分段状态按增量顺序推进，并保证同一 QQ 群中的一条流式回复不会被其他回复插入。

**Architecture:** 在 dispatcher 内增加操作队列，串行执行所有 `onDelta`、`finish` 和 `abort` 状态变更；复用现有按群发送队列，为流式回复持有从首段到收尾的群发送租约。不同群仍可并行，普通非流式群回复继续使用原队列。

**Tech Stack:** Node.js 20、CommonJS、项目自带测试运行器

---

## Chunk 1: 回归测试与发送边界

### Task 1: 固定乱序复现

**Files:**
- Modify: `tests/messageReplyRuntimeFreshness.test.js`
- Modify: `tests/systemGroupReplyQueue.test.js`

- [x] **Step 1: 增加未等待增量回调测试**

连续触发多个不等待返回值的 `onDelta`，断言最终发送段数不超过 `AI_STREAM_MAX_SEGMENTS`，段号按 1、2、3 递增。

- [x] **Step 2: 增加同群双流测试**

让流 A 首段发送后进入段间等待，同时启动流 B；断言最终顺序为 A1、A2、B，而不是 A1、B、A2。

- [x] **Step 3: 运行测试确认旧实现失败**

运行：`node scripts/run-tests.js tests/messageReplyRuntimeFreshness.test.js tests/systemGroupReplyQueue.test.js`

## Chunk 2: 最小修复

### Task 2: 串行化流内状态并复用群发送队列

**Files:**
- Modify: `core/systemGroupReply.js`
- Modify: `src/message/streaming/index.js`
- Modify: `core/messageReplyRuntime.js`
- Modify: `core/messageRouteFlow/index.js`
- Modify: `core/messageDispatchCoordinator.js`

- [x] **Step 1: 为现有群发送队列增加流级租约**

租约在首段真正准备发送时进入按群队列，在 `finish` 或 `abort` 后释放；不新增定时器或持久化状态。

- [x] **Step 2: 增加 dispatcher 操作队列**

`onDelta` 调用立即按调用顺序入队，状态读取、切段、发送和 `sentSegments` 更新在同一串行链上完成。

- [x] **Step 3: 补齐异常收尾**

模型调用未完成流式收尾或抛错时调用 dispatcher `abort`，确保群发送租约释放且后续回复不会永久等待。

- [x] **Step 4: 运行定向测试**

运行：`node scripts/run-tests.js tests/messageReplyRuntimeFreshness.test.js tests/systemGroupReplyQueue.test.js tests/messageRouteFlowGroupStreaming.test.js tests/messageDispatchCoordinator.test.js`

## Chunk 3: 验收、文档与提交

### Task 3: 完成验证和记录

**Files:**
- Modify: `docs/maintenance-log.md`
- Modify: `README.md`

- [x] **Step 1: 运行静态检查**

运行：`npm run lint`、`npm run typecheck`、`git diff --check`。

- [x] **Step 2: 更新验收记录**

以 `2026-08-31` 时间戳记录根因、定向测试和静态检查结果；README 仅追加独立条目，不覆盖并行代理现有改动。

- [x] **Step 3: 仅暂存本轮文件并提交**

提交前核对 staged diff，确保不包含主模型池、Codex 配置、提示词或其他代理文件；不推送远端。

## 验收记录

- 根因：上游流式回调同步触发 `onDelta` 却不等待 Promise，dispatcher 的切段状态并发读取；同时每个 dispatcher 只维护自己的发送队列，导致同群并发流互相插入。
- 修复：dispatcher 增加操作队列串行化 `onDelta`、`finish`、`abort`；群流式回复通过现有群发送队列持有从首段到收尾的发送租约，不同群保持并行；模型异常和未完成流式收尾统一释放租约。
- 验收（2026-08-31）：`node scripts/run-tests.js tests/messageReplyRuntimeFreshness.test.js tests/systemGroupReplyQueue.test.js tests/messageRouteFlowGroupStreaming.test.js tests/messageDispatchCoordinator.test.js tests/messageHandlerGroupConcurrency.test.js tests/messageHandlerInboundConcurrency.test.js` 退出码 0，全部测试通过；`npm run lint`、`npm run typecheck`、`git diff --check` 退出码 0。
- 小目标已完成：实现提交 `e55de53a`。
