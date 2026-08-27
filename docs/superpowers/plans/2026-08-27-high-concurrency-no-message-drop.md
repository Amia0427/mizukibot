# 高并发消息不丢弃 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在多用户同时对话时保持消息最终进入回复链路，不因入口队列满、业务队列满或等待超时而丢弃用户消息。

**Architecture:** 保留入口与业务处理的有限 active 并发，等待中的消息使用内存队列继续排队；移除正常运行期基于队列长度和等待时间的拒绝路径。不同会话继续并行，同一会话继续串行，以兼顾吞吐量和上下文顺序。

**Tech Stack:** Node.js 20、CommonJS、现有 `messageIngressDispatcher`、`inboundConcurrency`、消息处理器和 Node 自定义测试运行器。

---

## Chunk 1: 入口与业务并发语义

### Task 1: 先固定入口高并发不丢消息行为

**Files:**
- Modify: `tests/messageIngressDispatcher.test.js`
- Modify: `tests/concurrencyBackpressure.test.js`

- [x] **Step 1: 将原有“队列满即丢弃”断言改为“队列继续等待”断言**

覆盖入口 active 槽为 1、显式传入旧队列上限、连续投递超过旧上限时，所有任务都应最终执行完成，`dropped` 保持为 0。

- [x] **Step 2: 将入站/前台控制器的队列满与超时场景改为长队列最终释放**

使用超过原配置上限的不同会话，先占满 active 槽，再释放锁，断言每一个 `acquire` 都成功；同会话仍按序获得锁。

- [x] **Step 3: 运行定向测试并确认当前实现失败**

运行：

```text
node scripts/run-tests.js tests/messageIngressDispatcher.test.js tests/concurrencyBackpressure.test.js
```

预期：修改后的测试在旧实现上因 `MESSAGE_INGRESS_QUEUE_FULL`、队列满或超时而失败。

### Task 2: 移除正常运行期的丢弃路径

**Files:**
- Modify: `core/messageIngressDispatcher.js`
- Modify: `core/inboundConcurrency.js`
- Modify: `core/foregroundConcurrency.js`

- [x] **Step 1: 让入口 dispatcher 忽略运行期队列容量参数并持续入队**

保留 `maxActive` 限制和 `stop({ drain: false })` 的生命周期清理语义；`enqueue` 和 `dispatch` 不再因等待队列长度返回 false 或拒绝用户消息。

- [x] **Step 2: 让 inbound/foreground controller 忽略运行期队列长度和等待超时**

保留 lane、global、per-session 限制以及公平调度；所有等待请求都留在队列直到获得 slot，释放时继续 drain。

- [x] **Step 3: 运行 Chunk 1 定向测试并确认通过**

运行同 Task 1 命令，预期全部通过，且 active 并发上限仍生效。

## Chunk 2: 默认配置与文档

### Task 3: 提升默认多用户吞吐并关闭配置层丢弃开关

**Files:**
- Modify: `config/index.js`
- Modify: `config/envRuntime.js`
- Modify: `.env.example`
- Modify: local `.env`（不提交密钥内容）
- Modify: `index.js`
- Modify: `core/messageHandler.runtime.js`

- [x] **Step 1: 将入口、入站和私聊等待队列默认设为不限制长度、不限制等待时间**

统一使用 `0` 表示不限制；入口仍以 `maxActive` 控制并发，业务 controller 仍以 global/lane/per-session 控制并发。

- [x] **Step 2: 将私聊默认 global/general 并发提升为 16**

保留 `PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT=1`，避免同一用户上下文交错；默认配置、示例配置和当前本地运行配置保持一致。

- [x] **Step 3: 删除调用方对“队列满返回 false”的业务依赖**

入口投递成功语义保持稳定，避免配置层仍把 dispatcher 的容量参数当成丢弃开关。

### Task 4: 更新开发文档和验收记录

**Files:**
- Modify: `docs/message-ingress-async.md`
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`

- [x] **Step 1: 记录新的并发边界**

说明 active 并发、等待队列、同会话串行和停机 drain 的区别，明确正常运行期不因队列满或超时丢弃消息。

- [x] **Step 2: 记录本次验收命令和实际结果**

追加带 `2026-08-27` 时间戳的维护记录；不修改 `prompts/admin.txt` 或其他无关并行改动。

## Chunk 3: 完整验收与提交

### Task 5: 回归、静态检查和提交

**Files:**
- Verify: `core/messageIngressDispatcher.js`
- Verify: `core/inboundConcurrency.js`
- Verify: `core/foregroundConcurrency.js`
- Verify: `config/index.js`
- Verify: `config/envRuntime.js`
- Verify: `tests/messageIngressDispatcher.test.js`
- Verify: `tests/concurrencyBackpressure.test.js`

- [x] **Step 1: 运行消息入口与并发专项测试**

```text
npm run smoke:napcat-ingress
node scripts/run-tests.js tests/messageHandlerInboundConcurrency.test.js tests/messageHandlerPrivateConcurrencySource.test.js tests/messageHandlerPrivateFreshness.test.js tests/messageHandlerGroupConcurrency.test.js tests/messageHandlerForegroundConcurrency.test.js
```

- [x] **Step 2: 运行静态门禁**

```text
npm run lint
npm run typecheck
git diff --check
```

- [x] **Step 3: 检查变更边界并确认未触碰禁改文件**

检查 `git status`、`git diff --stat` 和 `git diff --name-only`，确认只包含本次并发修复、文档/README、测试和必要本地配置；保留用户已有 `.belt/notices/survey-q-use_case`、`.codex/config.toml`、`prompts/guanxi/07.txt` 改动。

- [x] **Step 4: 提交当前分支，不推送远端**

提交信息：`fix: prevent message loss under concurrent chats`。
