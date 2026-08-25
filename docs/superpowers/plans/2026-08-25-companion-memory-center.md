# 用户可控记忆中心实施计划

> **For agentic workers:** This plan is tracked in the current task and will be updated with the verified result.

**Goal:** 让私聊用户能够查看、明确保存、更正和遗忘自己的长期记忆，并控制自动长期记忆写入。

**Architecture:** 新增 `companion-memory` 领域服务，读写只经过 Memory V3 事件与物化；`legacy_compat` 下同步归档同 ID 的旧镜像。用户级自动记忆偏好独立持久化，并在 post-reply 的隐式画像、每轮摘要和 enrich 自动学习入口统一生效，不影响显式保存、短期上下文或 Daily Journal。

**Tech Stack:** Node.js CommonJS、Memory V3、现有工具注册与授权策略、JSON hot store。

---

## Chunk 1: 领域能力

- [x] 增加用户级自动记忆偏好存储，默认开启。
- [x] 支持查看、明确保存、更正、遗忘当前用户的 Memory V3 记忆。
- [x] 在 `legacy_compat` 下同步归档旧镜像，避免被旧主读召回。

## Chunk 2: 工具与运行时

- [x] 注册私聊限定的 `companion_memory` 工具及动作级授权策略。
- [x] 自动记忆关闭时跳过隐式画像、每轮摘要和 enrich 自动学习。
- [x] 显式“请记住”与 Daily Journal 在自动记忆关闭时继续工作。

## Chunk 3: 验收

- [x] 覆盖用户隔离、动作授权、兼容模式、开关持久化和 post-reply 行为。
- [ ] 更新 README 与记忆开发文档，运行项目门禁并提交。
