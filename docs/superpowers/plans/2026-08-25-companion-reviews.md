# 陪伴回顾实施计划

> **For agentic workers:** This plan is tracked in the current task and will be updated with the verified result.

**Goal:** 让私聊用户按需查看今天、昨天或最近七天的相处记录和未完成事项。

**Architecture:** 新增只读的 `companion-review` 服务，复用 Daily Journal 的 SQLite 主读与历史文件回退，并组合现有待跟进事项。通过独立工具暴露查询，不新增定时任务或模型调用。

**Tech Stack:** Node.js CommonJS、Daily Journal、现有工具 schema/executor/policy。

---

## Chunk 1: 回顾领域

- [x] 支持 `today`、`yesterday`、`week` 三种时间范围。
- [x] 汇总当前用户的每日记录和未完成事项，明确返回空数据。
- [x] 覆盖 Profile Journal SQLite 与历史 Daily Journal 回退链路。

## Chunk 2: 只读工具

- [x] 注册 `companion_review` schema、executor 和只读工具策略。
- [x] 仅允许当前私聊用户访问，并加入 companion 工具预设。

## Chunk 3: 验收

- [x] 补充范围、用户隔离、空数据和工具注册测试。
- [x] 运行定向测试、lint、typecheck 和差异检查。
- [ ] 更新 README 和维护记录，提交并复核提交内容。
