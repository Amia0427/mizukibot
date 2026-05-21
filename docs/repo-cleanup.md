# Repo Cleanup Notes

更新 2026-05-21 22:52 +08:00：本次只清理低风险历史垃圾，包括 `bak_codex` 备份、`artifacts/memory-recall-eval/*.tmp` 和旧排障日志。

未处理项：`api/skills.js`、`core/tgBot.js`、`core/routeContract.js`、`api/nanobotExecutor.js`、`api/legacy/agentGraphV1Runtime.js` 和 `src/features/*` 需要按功能开关、外部调用兼容和测试覆盖单独确认。

禁止直接手删项：`data/lancedb/**`、`data/memory-v3/**`、`api/legacy/aiHost.js`、`core/*.chunk.js` 和 `api/runtimeV2/context/*.chunk.js`。
