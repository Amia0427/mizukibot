# 陪伴事项闭环实施计划

> **For agentic workers:** This plan is tracked in the current task and will be updated with the verified result.

**Goal:** 为私聊用户提供可查看、可完成、可延期的待跟进事项，并将事项作为主动私聊模型的上下文。

**Architecture:** 新增独立的 `companion-followups` 本地存储与服务，事项按用户隔离；通过一个混合读写工具暴露自然语言工具调用，读操作直接执行，写操作沿用现有工具授权。主动私聊只读取事项上下文，不新增另一套发送调度器。

**Tech Stack:** Node.js CommonJS、`createJsonHotStore`、现有工具 schema/executor/policy、现有私聊主动消息引擎。

---

## Chunk 1: 事项领域

- [x] 新增事项状态存储、归一化和服务动作。
- [x] 支持 `add`、`list`、`complete`、`snooze`、`abandon`、`delete`。
- [x] 事项只允许访问当前私聊用户的数据。

## Chunk 2: 工具与主动上下文

- [x] 注册 `companion_followup` schema、executor 和工具策略。
- [x] 将事项加入 companion 工具预设。
- [x] 将未完成事项注入主动私聊上下文和模型指导。

## Chunk 3: 验收

- [x] 补充存储、服务、策略和主动上下文定向测试。
- [x] 运行定向测试、lint、typecheck 和差异检查。
- [x] 更新 README 与开发文档，记录带时间戳的验收结果。
- [ ] 提交当前分支并复核提交内容。
