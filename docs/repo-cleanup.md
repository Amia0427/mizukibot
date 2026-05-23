# Repo Cleanup Notes

更新 2026-05-23 09:02 +08:00：README 已明确历史维护记录统一写入 `docs/repo-cleanup.md`，README 只保留入口级更新时间戳。

更新 2026-05-22 21:18 +08:00：根 README 已从历史流水账重构为入口文档，保留快速启动、常用命令、关键配置、修改入口和排障顺序；详细维护记录继续收敛在 `docs/`。

更新 2026-05-21 22:52 +08:00：本次只清理低风险历史垃圾，包括 `bak_codex` 备份、`artifacts/memory-recall-eval/*.tmp` 和旧排障日志。

更新 2026-05-21 23:13 +08:00：继续移除无运行入口的历史快照、旧 recall eval 输出、`core/routeContract.js` 和 `api/nanobotExecutor.js` 兼容 shim；保留 `cases.jsonl` 与 `memos-cases.jsonl` 作为评估入口。

更新 2026-05-21 23:28 +08:00：大文件拆分状态已校正；部分旧入口在拆分后又承载新功能，不能按“已拆完”处理。

拆分回流待处理项：`config.js`、`web/server.js`、`core/continuousMessagePreprocessor.js`、`core/router.js`、`utils/memoryCli.js`、`api/createAgentExecutor.js`。回流前先查这些文件自 2026-05-19 以来的提交，确认新增功能迁移到子模块后再继续瘦身 facade。

更新 2026-05-22 08:38 +08:00：回流同步执行计划已落到 `docs/superpowers/plans/2026-05-22-large-file-backflow-sync.md`；后续拆分必须先按该计划审计旧入口新增提交，再迁移、验证、更新时间戳状态。

更新 2026-05-22 08:58 +08:00：复核后确认回流计划不是只有六个文件；六个是必须迁移清单，另需审计 `api/mcpRuntime.js`、`utils/dailyJournal.js`、`utils/memory-v3/query.js`、`utils/personaMemoryState.js`、`utils/shortTermMemory.js` 是否已在同日拆分提交中同步完成。

更新 2026-05-22 16:19 +08:00：`config.js` 回流同步已完成，相关配置拆入 `config/plannerRuntime.js`、`config/memosRuntime.js`、`config/postReplyRuntime.js`、`config/mainReplyContextRuntime.js` 和 `config/imageMemoryRuntime.js`。剩余必须迁移：`web/server.js`、`core/continuousMessagePreprocessor.js`、`core/router.js`、`utils/memoryCli.js`、`api/createAgentExecutor.js`；`api/mcpRuntime.js` 需从审计项升级为迁移或明确保留说明。

更新 2026-05-22 16:24 +08:00：`web/server.js` 回流同步已推进，`/api/main-reply-context-preview` 和对应 Admin UI/刷新脚本已拆入 `web/mainReplyContextPreviewRoute.js`、`web/mainReplyContextPreviewAdmin.js`。剩余必须迁移：`core/continuousMessagePreprocessor.js`、`core/router.js`、`utils/memoryCli.js`、`api/createAgentExecutor.js`；`api/mcpRuntime.js` 仍需处理审计结论。

更新 2026-05-22 16:26 +08:00：`core/continuousMessagePreprocessor.js` 回流同步已推进，图片视觉摘要入队 helper 已拆入 `core/continuousMessage/imageVisualSummary.js`。剩余必须迁移：`core/router.js`、`utils/memoryCli.js`、`api/createAgentExecutor.js`；`api/mcpRuntime.js` 仍需处理审计结论。

更新 2026-05-22 16:29 +08:00：`core/router.js` 与 `utils/memoryCli.js` 回流同步已推进，notebook allowlist 拆入 `core/router/memoryTools.js`，图片记忆搜索 normalize/merge 拆入 `utils/memoryCli/imageRecall.js`。剩余必须迁移：`api/createAgentExecutor.js`；`api/mcpRuntime.js` 仍需处理审计结论。

更新 2026-05-22 16:33 +08:00：`api/createAgentExecutor.js` 回流同步已推进，失败回复映射拆入 `api/createAgent/failureReply.js`；`api/mcpRuntime.js` 审计结论已处理，spawn config 拆入 `api/mcp/config.js`，单服务器 discovery 拆入 `api/mcp/discovery.js`。下一步执行最终关键词复核、审计项复核和烟测。

更新 2026-05-22 16:35 +08:00：大文件回流同步计划已完成最终复核；本计划剩余未同步旧入口：无。审计项结论：`api/mcpRuntime.js` 已迁移；`utils/dailyJournal.js`、`utils/memory-v3/query.js`、`utils/personaMemoryState.js`、`utils/shortTermMemory.js` 当前仅保留拆分模块 wiring/组合逻辑，暂无需新增回流任务。

更新 2026-05-22 17:08 +08:00：扩展复查发现的 `utils/memoryWritePipeline.js` 回流项已处理，memory quality gate 拆入 `utils/memoryWritePipeline/qualityGate.js`；旧入口仅保留写入流程编排、批处理 guard 和兼容导出。

未处理项：`api/skills.js`、`core/tgBot.js`、`api/legacy/agentGraphV1Runtime.js` 和 `src/features/*` 需要按功能开关、外部调用兼容和测试覆盖单独确认。

禁止直接手删项：`data/lancedb/**`、`data/memory-v3/**`、`api/legacy/aiHost.js`、`core/*.chunk.js` 和 `api/runtimeV2/context/*.chunk.js`。
