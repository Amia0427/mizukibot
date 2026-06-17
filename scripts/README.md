# Scripts Index

## Daily Use

- `run-tests.js`：测试入口；更新 2026-05-24 02:16 +08:00，逐测试文件子进程隔离执行，避免全局 stub/env/模块缓存和后台异步任务跨测试污染
- `pre-release-smoke.js`：发布前最小冒烟入口；更新 2026-06-17 20:04 +08:00，支持 `npm run smoke:pre-release -- --root D:\mizuki_release`，串联 expected-shutdown 未确认重启保护、主模型 fallback 重启恢复、普通群纯文本短 debounce 与群/入站并发回归
- `check-agent.js`：LangGraph / agent 自检
- `check-prompts.js`：prompt 资源检查
- `console.js`：本地控制台入口
- `lint.js`：轻量检查入口

## Runtime

- `post-reply-worker.js`：post-reply worker 入口
- `run-bot-daemon.ps1`：Windows 守护启动脚本；更新 2026-06-17 09:18 +08:00，expected-shutdown marker 必须未过期、未 consumed 且 PID 严格匹配，命中后写回 `consumedAt/consumedBy*` 并在日志/观测里保留 marker source/request/message/group；更新 2026-06-15 23:28 +08:00，stale lock 时追加 `data/bot-main-exit-observations.jsonl`，并用 `bot-main-runtime-state.json` 的同 pid heartbeat lifetime 判断短命退出窗口，避免 daemon 检查晚到导致误归类；更新 2026-06-12 13:36 +08:00，主 bot 重拉前归档旧 runtime stdout/stderr，并对 15 分钟内连续 2 次硬退出做 15 分钟退避；更新 2026-06-11 18:59 +08:00，daemon 本轮成功拉起主 bot 且外置 post-reply worker 启用时会补启 worker，补启前仍扫描现有 PID/进程避免重复；更新 2026-06-11 13:35 +08:00，主 bot 启动后轮询等待 `.mizukibot.lock` 接管，默认 `BOT_DAEMON_LOCK_WAIT_MS=30000`，避免固定 2 秒窗口误报启动失败
- `..\restart-bot.cmd` / `restart-bot.ps1`：Windows 手动/远程重启入口；更新 2026-06-18 00:56 +08:00，`.cmd` 只做参数转发，`restart-bot.ps1` 直接隐藏启动 `node index.js` 和 `scripts/post-reply-worker.js`，等待真实健康并写 `data\restart-bot.log`，避免计划任务异步触发和嵌套 PowerShell 等待卡住；停进程前只接受仍匹配 main/worker 命令行的 pid 文件，避免 stale pid 复用误杀；更新 2026-06-17 13:28 +08:00，`restart confirm` 成功后会在当前控制台自动打印最终 status，避免真实重启成功但静默看起来失败；更新 2026-06-17 13:18 +08:00，未确认 `restart` 会提示精确确认命令，status 输出拆分真实 `Bot Node Processes` 与 `Other Related Node Processes (diagnostic only)`，避免残留测试 Node 进程被误读为业务进程；更新 2026-06-17 09:18 +08:00，只有 `restart confirm`、`/restart confirm` 经远程链路或 `MIZUKI_RESTART_CONFIRM=1/confirm` 才会停启主 bot；未确认的 `restart` 只输出确认要求，不写 expected-shutdown marker，也不打开守护日志窗口；marker 会记录 `source/requestId/messageId/groupId/command` 便于审计；更新 2026-06-17 01:05 +08:00，无参数默认只读 status；写 `data/bot-main-expected-shutdown.json` 前会确认目标 PID 是存活的 `node index.js`，避免 stale lock 被误标为 expected shutdown
- `restart-bot-periodic.ps1`：Windows 定时重启脚本；更新 2026-06-10 23:51 +08:00，计划任务默认每天 04:00 运行；更新 2026-06-08 13:36 +08:00，直接解析 `node.exe` 启动 `index.js`，避免计划任务 `Start-Process npm` 命中 shim 报 `%1 不是有效的 Win32 应用程序`
- `restart-windows-daemon.ps1`：Windows 守护重启
- `status-windows-daemon.ps1`：Windows 守护状态
- `mizukibot.sh`：Linux 启停/日志

## Diagnose

- `diagnose-continuity-state.js`
- `diagnose-local-knowledge.js`
- `diagnose-main-model-fallback.js`
- `diagnose-main-model-web-search.js`：更新 2026-05-23 23:20 +08:00，探测主回复/管理员主回复实际链路及 provider-native 参数是否具备内置联网搜索能力
- `diagnose-provider-request.js`：更新 2026-05-26 18:35 +08:00，输出指定 provider 在 `http_client_direct/main_reply/admin_reply/vision_reply/qzone_image_generation` 下最终 headers、cache、鉴权来源、剔除字段和异常信号；可用 `npm run diag:provider-request -- --provider gemini_native`
- `verify-admin-cache-read.js`：更新 2026-06-17 20:09 +08:00，最小管理员缓存读写对照验收；对同一管理员连续发两次真实主模型请求，记录脱敏请求体差异、缓存读写 usage、model-call 和 request-trace 关键日志，区分上游不支持/请求体不符合缓存条件/本地读取链路漏吃结果；可用 `npm run verify:admin-cache-read -- --output artifacts/tmp/admin-cache-read.json`
- `diagnose-main-reply.js`：统一主回复诊断，输出 route/model/fallback、memory freshness、群聊回复守卫、direct/tool/background 分支；更新 2026-06-06 12:44 +08:00：`--truncation` 汇总最近主回复截断候选，区分 `MAX_TOKENS`、上游断流、无 terminal event 和本地发送层失败
- `diagnose-main-reply-prompt-assembly.js`：更新 2026-06-14 15:10 +08:00，只读回答“本次请求的 system prompt 最终怎么拼出来”，支持 `--request-id req_xxx` 和 `--text "..."`；输出 stable/dynamic/assistant-only blocks、persona modules、SQL worldbook 命中、planner provided/source、runtime 本地补入、来源文件/策略，以及 `buildDynamicPromptImpl` 子阶段耗时 `promptAssemblyStageTimings`（`collectPromptInputs`、`renderPromptLayers.*`、persona/worldbook、`profile_journal_db`、`daily_journal`、`short_term_continuity`）。验收：`node tests/mainReplyPromptAssemblyDiagnostics.test.js`、`node tests/memoryRecallObservability.test.js`、`npm run diag:main-reply-prompt-assembly -- --text "服饰专门学校和N25两个都不放弃" --worldbook-semantic-limit=0`、`node -e "require('./api/runtimeV2/context/service')"`。
- `diagnose-live-state-dynamic.js`：更新 2026-06-14 10:04 +08:00，只读回答某次请求里的 `live_state_dynamic` 如何生成并注入；支持 `--request-id req_xxx` 和 `--text "..."`，输出命中、关系边界/当前活动/最近摘要/反 AI 规则来源、裁剪前后长度、最终 token 估算和 prompt block 顺序位置。验收：`node tests/mainReplyPromptAssemblyDiagnostics.test.js`、`npm run diag:live-state-dynamic -- --text "服饰专门学校和N25两个都不放弃" --worldbook-semantic-limit=0`。
- `diagnose-request-trace-preflight.js`：更新 2026-06-09 09:22 +08:00，按 requestId 拆分 `request-trace.ndjson` 的入站等待、planner、prepare、route、routeDoneToUpstream、pre-model 事件（thinking emoji / ask_ai_dispatch）和主模型耗时；可用 `npm run diag:request-trace-preflight -- --request-id req_290ea2184adf174b`
- `diagnose-route-decision.js`：更新 2026-06-14 09:58 +08:00，只读解释某次请求为什么走 `normal_fast_reply`、普通 `direct_reply`、planner/tool route 或降级直回；支持 `--request-id req_xxx` 和 `--text "..."`，输出 route、fast reply 命中/未命中条件、工具/图片/权限/连续性退出原因、最终 runtime 节点和耗时摘要。验收：`node tests/routeDecisionDiagnostics.test.js`、`npm run diag:route-decision -- --text "今晚吃什么好" --user-id normal_1 --fast-reply-enabled=true`、`npm run diag:route-decision -- --request-id req_197c52fc1a63585d --limit 1`。
- `diagnose-main-reply-token-budget.js`：更新 2026-06-08 21:05 +08:00，聚合最近主回复输入 token、分布区间和最大消息索引；默认扫尾部 5000 行避开 embedding 噪声，可用 `npm run diag:main-reply-token-budget -- --limit 20 --json`
- `diagnose-chat-default-memory-leak.js`：更新 2026-06-13 15:25 +08:00，只读交叉扫描 `model-calls.ndjson`、`request-trace.ndjson` 和 `memory-recall-observability.ndjson`，输出普通 `chat/default` 主回复里无明确召回证据却注入 `retrieved_memory_lite/daily_journal/memory_recall_policy` 的 request id、命中证据和汇总；实际验收 `npm run diag:chat-default-memory-leak -- --limit 5 --since 24h` 得到 `candidateChatDefaultRequests=90`、`violationRequests=30`
- `diagnose-memory-ops.js`：记忆诊断入口，支持 `diagnose/backfill/recall/audit`；更新 2026-05-19 21:45 +08:00：`audit` 会运行抽样记忆质量审查，只报告不改库
- 更新 2026-05-23 11:25 +08:00：`diagnose-memory-ops.js recall --gate` 会把 lifecycle leakage、category mismatch、recent recall miss 纳入门禁指标。
- `diagnose-persona-memory-state.js`
- `diagnose-persona-modules.js`
- `diagnose-napcat-health.js`：更新 2026-06-12 20:16 +08:00，只读汇总 `napcat-health-state.json` / `napcat-health-events.ndjson`，输出 NapCat 是否离线、离线持续时长、最近 thinking-emoji / continuous-message expand 降级动作和恢复时间；可用 `npm run diag:napcat-health -- --text`
- `diagnose-runtime-exceptions.js`：更新 2026-06-08 13:32 +08:00，最小运行时异常汇总入口；聚合 `model-calls.ndjson`、memory recall observability 和 runtime 日志里的 `main-model-fallback:admin_shared` / `memoryReranker` 超时回退信号
- `diagnose-gemini-recent-style-signals.js`：更新 2026-06-13 15:27 +08:00，只读汇总 `data/gemini-recent-style-signals.json` 的最近 Gemini 起手、尾音、固定短语命中次数和最近命中时间，并标出 `gemini_recent_style_guard` 会纳入的信号；验收当前缺失数据文件时输出 `missing records=0 recent=0 guard=no`
- `diagnose-runtime-hotspots.js`：运行时资源热点诊断，汇总 RSS/heap/event loop delay、timer/interval、post-reply worker 和高频模块
- `diagnose-runtime-status.js`：运行时状态诊断，汇总主进程、post-reply worker、后台任务和锁
- `diagnose-main-bot-restarts.js`：更新 2026-06-15 23:28 +08:00，读取 `bot-main-exit-observations.jsonl` / daemon stale-lock evidence，能把 counted hard exit 和 silent stale-lock 从 `ok` 升为 `warning`；验收命令 `node scripts/diagnose-main-bot-restarts.js --text --tail-lines=20 --max-archive-logs=3 --max-daemon-events=20`
- `analyze-foreground-concurrency.js`

## Setup / Install

- `install-linux.sh`
- `bootstrap-debian12.sh`
- `check-linux.sh`
- `setup-systemd.sh`
- `setup-wireguard-jump-host.sh`
- `install-windows-daemon.ps1`
- `install-periodic-restart.ps1`
- `uninstall-windows-daemon.ps1`
- `setup-windows-management-plane.ps1`
- `install-skill-deps.ps1`

## Migration / Maintenance

- `migrate-memory-v3.js`
- `import-memory-file.js`：导入 `.md/.txt` 到 Memory V3；更新 2026-05-23 11:04 +08:00：Markdown 按标题切块，写入前走版本化 update，重复导入不扩大 active chunk 数
- 更新 2026-05-23 11:20 +08:00：Memory V3 维护脚本诊断时可结合 `tests/memoryV3GenericConflictResolution.test.js`、`tests/memoryV3RecentRecallFastPath.test.js` 验证冲突 loser 隐藏和近期召回快路径。
- `check-native-migration.js`
- `backup-prompt-persona-modules.js`
- `pack-linux-migration.sh`

## Local Integration

- `local-command-bridge.js`：更新 2026-06-03 07:53 +08:00，`LOCAL_COMMAND_BRIDGE_TOKEN` 缺失时仅保留 `/health`，`/run` 和 MCP 入口阻断；token 从 `.env`/进程环境读取
- `local-command-bridge.ps1`：更新 2026-06-03 07:53 +08:00，兼容旧 PowerShell 桥的 `.env` token 加载和执行入口鉴权
- `configure-napcat-onebot.js`
- 更新 2026-05-30 +08:00：OpenClaw / Claude CLI / HAPI 外部子 agent 激活链路已移除；相关本地启动脚本等待删除确认后移出仓库。

## Small Utility

- `load-env.js`
- `set-env.js`
- `set-apikey.js`
- `one-click-start.ps1`
- `toggle-ipv4-exit-gateway.ps1`
- `toggle-ipv4-via-98.142.241.73.ps1`
- `windows-daemon-common.ps1`

约定：

- 正式可执行脚本暂时仍保留在 `scripts/` 根层，避免破坏现有命令和文档路径
- 备份脚本、临时模板、一次性产物优先放 `artifacts/` 或 `docs/templates/`
- 更新 2026-05-21 22:52 +08:00：已移除旧 `run-bot-daemon.ps1.bak-*`；后续不要把脚本备份直接提交到 `scripts/` 根层。
