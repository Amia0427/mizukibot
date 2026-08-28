# 高并发对话可靠性第一阶段 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保证同一会话的新消息不会取消已经开始处理的旧消息回复，并让入口与业务并发队列具备可验收的运行统计。

**Architecture:** 保留不同会话并行、同一 `sessionKey` 串行的现有并发边界，删除基于 freshness 版本跳过旧回复的发送路径。入口、入站和前台控制器继续使用内存等待队列，但补充累计入队、峰值队列、累计完成和最长等待时间，作为后续持久化队列与容量压测的基线。

**Tech Stack:** Node.js 20、CommonJS、现有消息处理器与自定义 Node 测试运行器。

---

## Chunk 1: 同会话消息不取消回复

### Task 1: 固定同会话按序回复行为

**Files:**
- Modify: `tests/messageHandlerPrivateFreshness.test.js`
- Modify: `core/messageHandler.runtime.js`
- Modify: `core/messageHandler.runtime.chunk.js`
- Modify: `core/messageHandler.runtime-03.chunk.js`
- Modify: `core/messageHandler.runtime-05.chunk.js`
- Modify: `core/messageHandler.runtime-06.chunk.js`
- Modify: `config/index.js`
- Modify: `.env.example`

- [x] **Step 1: 将旧 freshness 测试改为两条消息都回复**

第一条消息模拟慢模型请求，第二条同用户消息在第一条运行期间进入；最终必须按第一条、第二条的顺序发送两次私聊回复。

- [x] **Step 2: 运行测试并确认旧实现失败**

运行：`node scripts/run-tests.js tests/messageHandlerPrivateFreshness.test.js`。

- [x] **Step 3: 删除回复发送前的 stale 丢弃路径**

连续消息预处理仍负责短时间消息聚合；消息一旦进入正式处理链路，新消息不得取消它的普通、快速或流式回复。

- [x] **Step 4: 运行测试并确认通过**

运行同 Step 2 命令，预期两条回复均发送且同一会话不并行。

## Chunk 2: 并发队列可观测性

### Task 2: 增加入口与业务队列统计

**Files:**
- Modify: `core/messageIngressDispatcher.js`
- Modify: `core/inboundConcurrency.js`
- Modify: `core/foregroundConcurrency.js`
- Modify: `tests/messageIngressDispatcher.test.js`
- Modify: `tests/concurrencyBackpressure.test.js`

- [x] **Step 1: 增加失败断言**

断言快照包含累计接受、累计入队、累计启动、累计完成、峰值等待队列和最长等待时间。

- [x] **Step 2: 实现最小计数器**

计数只在现有入队、获取、完成和释放边界更新，不新增定时器、额外持久化或复杂采样器。

- [x] **Step 3: 运行入口与并发专项测试**

运行：`node scripts/run-tests.js tests/messageIngressDispatcher.test.js tests/concurrencyBackpressure.test.js tests/inboundConcurrency.test.js tests/foregroundConcurrency.test.js`。

## Chunk 3: 文档、验收与提交

### Task 3: 完整验收

**Files:**
- Modify: `README.md`
- Modify: `docs/message-ingress-async.md`
- Modify: `docs/maintenance-log.md`

- [x] **Step 1: 运行消息并发回归**

运行入口 smoke、私聊 freshness、私聊突发、群聊并发、前台并发和控制器测试。

- [x] **Step 2: 运行静态检查**

运行：`npm run lint`、`npm run typecheck`、`git diff --check`。

- [x] **Step 3: 重启并检查健康状态**

按项目现有本地进程方式重启，确认 `/live` 与 `/ready` 返回 200，并记录实际运行配置。

- [x] **Step 4: 更新文档并提交**

## 验收记录 2026-08-28

- 代码与测试验收已完成：同会话两条消息均发送，回复顺序为第一条、第二条；入口、入站和前台控制器的统计字段均按实际生命周期更新。
- 静态验收已完成：入口 smoke、消息并发回归、lint、typecheck 和 git diff --check 通过。
- 全量回归边界：`npm test` 退出码为 1，失败仅为既有 `agentPrompts.test.js` 和私有 `prompts/ADULT.txt` manifest/allowlist 检查；高并发相关用例均通过。
- 健康验收：2026-08-28 17:31 +08:00 执行 `restart-bot.cmd restart confirm` 成功，主 bot 与 post-reply worker 均为 Running；`/live`、`/ready` 均返回 HTTP 200 和 `{"ok":true}`。

以 `2026-08-28` 时间戳记录验收结果，只暂存本轮文件，保留并行工作区改动，不推送远端。
