# Repo Cleanup Notes

更新 2026-05-21 22:52 +08:00：本次只清理低风险历史垃圾，包括 `bak_codex` 备份、`artifacts/memory-recall-eval/*.tmp` 和旧排障日志。

更新 2026-05-21 23:13 +08:00：继续移除无运行入口的历史快照、旧 recall eval 输出、`core/routeContract.js` 和 `api/nanobotExecutor.js` 兼容 shim；保留 `cases.jsonl` 与 `memos-cases.jsonl` 作为评估入口。

更新 2026-05-21 23:28 +08:00：大文件拆分状态已校正；部分旧入口在拆分后又承载新功能，不能按“已拆完”处理。

拆分回流待处理项：`config.js`、`web/server.js`、`core/continuousMessagePreprocessor.js`、`core/router.js`、`utils/memoryCli.js`、`api/createAgentExecutor.js`。回流前先查这些文件自 2026-05-19 以来的提交，确认新增功能迁移到子模块后再继续瘦身 facade。

更新 2026-05-22 08:38 +08:00：回流同步执行计划已落到 `docs/superpowers/plans/2026-05-22-large-file-backflow-sync.md`；后续拆分必须先按该计划审计旧入口新增提交，再迁移、验证、更新时间戳状态。

更新 2026-05-22 08:58 +08:00：复核后确认回流计划不是只有六个文件；六个是必须迁移清单，另需审计 `api/mcpRuntime.js`、`utils/dailyJournal.js`、`utils/memory-v3/query.js`、`utils/personaMemoryState.js`、`utils/shortTermMemory.js` 是否已在同日拆分提交中同步完成。

未处理项：`api/skills.js`、`core/tgBot.js`、`api/legacy/agentGraphV1Runtime.js` 和 `src/features/*` 需要按功能开关、外部调用兼容和测试覆盖单独确认。

禁止直接手删项：`data/lancedb/**`、`data/memory-v3/**`、`api/legacy/aiHost.js`、`core/*.chunk.js` 和 `api/runtimeV2/context/*.chunk.js`。
