## 清理记录 2026-06-08 13:22

### model-calls.ndjson
- 清除56条机械报错：Claude Opus 4-6的500错误 + BGE embedding/reranker超时
- 保留7445条有效记录
- 备份至 data/model-calls.ndjson.backup_*

### langgraph_v2_checkpoints
- 删除包含英文safety拒绝的checkpoint（已清空）
- 删除管理员失败的vision checkpoint 3个
- 保留85个正常checkpoint

### 原因
防止误报的机械故障污染上下文，历史拒绝记录不影响新prompt效果。

## 运行维护 2026-06-12 13:36

- 复查 `data/bot-daemon.log`：06:55、07:04、07:08 +08:00 三次都是主 bot 锁 PID 已死后被 daemon 重拉；锁均能快速接管，说明不是启动锁等待问题。
- 排除项：NapCat 对应时间窗只有普通群聊消息，没有 `/restart`；`data/bot-restart.log` 只有 04:00 计划重启；本次不重复处理 post-reply worker 空窗。
- 根因诊断缺口：旧 `bot-runtime.out.log` / `bot-runtime.err.log` 被下一次重拉前清空，导致短命主进程退出现场不可恢复。
- 最小加固：daemon 启动前归档旧 runtime 日志，主 bot 15 分钟内连续 2 次硬退出后退避 15 分钟，`index.js` 写入启动/fatal/expected-shutdown 诊断。
- 小目标已完成：主 bot 硬退出时不再短时间无证据连续重启。

## 运行维护 2026-06-12 12:55

- 按新网关配置切换 `PLAN_*` 与 `PASSIVE_AWARENESS_*`，目标 host 为 `catiecli.sukaka.top`，模型为 `gcli-gemini-3-flash-preview-nothinking`。
- 密钥仅写入本地 `.env`，文档不记录明文 key。
- 复跑模型自检：plan、embedding、rerank、memory、main_reply、admin_reply、passive_awareness_decision、passive_awareness_reply 全部 OK。
- 小目标已完成：原 plan / passive awareness decision 的 `http_403` 已通过配置切换消除。

## 运行维护 2026-06-12 12:42

- 定位模型自检批量 `http_421`：同一轮并发自检跨 `token.memoh.net`、`gcli.ggchan.dev`、`apiapipp.com` 时，CycleTLS/HTTP2 连接复用会触发网关 `421 Misdirected Request`。
- 最小修复：默认关闭 `MODEL_TLS_IMPERSONATION_CONNECTION_REUSE_ENABLED`，CycleTLS 明确返回 421 时自动回落 axios 重试一次。
- 复查 `token.memoh.net`：关闭 TLS 伪装和多组 JA3/HTTP2 指纹仍稳定 `403`，响应体为账号只允许匹配配置的 TLS router 客户端；该项按上游账号限制保留原状。
- 小目标已完成：模型自检不再被 421 批量打断，`token.memoh.net` 的 403 不纳入本次修复范围。

## 运行维护 2026-06-08 16:59

- 关闭 `MODEL_TOP_P_ENABLED`，让主回复与管理员主回复都不再发送 `top_p`。
- 真实请求验证结论：`https://apiapipp.com/v1/chat/completions` 上的 `claude-opus-4-6` 带 `top_p` 稳定返回泛化 `400 bad_response_status_code`；去掉 `top_p` 后恢复 200。

## 运行维护 2026-06-08 17:55

- 修复 `lookup/notebook-answer` 跨消息误续跑：`prepare` 只在当前 `requestId` 与 checkpoint 内 `requestId` 完全一致时才恢复未完成状态。
- 直接效果：上一条消息残留的 `memoryCliTurn.mustAnswer` 不再污染新消息，避免 `request.allowedTools` 被错误裁成仅 `get_context_stats`，从而把后续 `memory_cli` step 误打成 `Tool not allowed: memory_cli`。
- 新增回归测试：`tests/prepareNodeResumeGuard.test.js`，覆盖“同 session 新消息不应继承旧 checkpoint 的 memory_cli turn 状态”。

## 运行维护 2026-06-09 09:22

- 完成管理员私聊 `req_290ea2184adf174b` 前置延迟复查：`lookup/notebook-answer` 但 planner 为 `chat_only/allowTools=false`，未命中 `plain_private_chat`，且旧诊断误把 route 后 pre-model 空档合并到 prepare。
- 最小修复：notebook-answer 无 memory/tool/planning 依赖时跳过远程 planner，`prepare` 使用 `notebook_chat_only` 轻量路径；私聊禁工具 direct reply 跳过 QQ thinking emoji preflight。
- 新增/增强诊断入口：`npm run diag:request-trace-preflight -- --request-id <id>` 现在输出 `prepare`、`route`、`routeDoneToUpstream`、`thinkingEmoji`、`askAiDispatch`。

## 运行维护 2026-06-10 23:51

- Windows 定时重启计划改为每天 04:00 执行，取消每 6 小时重复触发。
- 小目标已完成：降低晚间管理员主模型流式回复被计划任务强杀的概率。

## 运行维护 2026-06-11 13:43

- 管理员私聊 `v2_streaming_reply` 首字等待补齐超时保护：新增 `ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS`，超时后 abort 当前上游流并直接返回明确兜底。
- 根因：已有 `NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS` 在 `userRole=admin` 时显式跳过，管理员私聊只能等通用流式首 chunk/请求超时，慢上游会继续悬挂到接近 60s。
- 小目标已完成：管理员私聊主回复链路超慢时不再转入 admin shared fallback 或非流式二次慢请求。

## 运行维护 2026-06-11 13:52

- 管理员私聊首字硬兜底默认等待窗口从 45s 调整为 150s：`ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS=150000`。

## 运行维护 2026-06-11 17:06

- 主回复模型 HTTP 传输启用浏览器 TLS/JA3 指纹伪装：`MODEL_TLS_IMPERSONATION_ENABLED=true`，默认 CycleTLS + Chrome-like JA3 + Chrome HTTP/2 fingerprint。
- 保留 `MODEL_TLS_IMPERSONATION_FALLBACK_ENABLED=true`，CycleTLS 传输级异常自动回落 axios；上游明确 4xx/5xx 仍按原错误处理。
- 小目标已完成：主回复模型请求不再只暴露 Node/OpenSSL 默认 TLS 指纹。

## 运行维护 2026-06-12 06:48

- 定位 `req_fbe5ff402ae28f6c` / `messageId=1011704550`：用户短追问“更早的呢”被归为 `chat/default` 普通私聊，`allowTools=false`，`memoryCliTurn.searchCount=0`，`memory-recall-observability.ndjson` 无该请求记录，主模型 `prompt_integrity.memory_marker_count=0`。
- 最小修复：`更早的呢`、`再之前呢`、`往前一点` 等短召回追问归类为 `recent_continuity`，触发 `lookup/notebook-answer` 记忆链路和完整动态记忆 prompt。
- 小目标已完成：短追问不会再绕过记忆召回。

## 运行维护 2026-06-12 07:10

- 深化修复短追问召回：不再只枚举“更早的呢”，新增上下文召回继承。当前消息为 `然后呢/还有呢/继续说` 等椭圆追问时，路由会读取 `contextSummary`、短期记忆 `activeTopic/carryOverUserTurn` 和 recent user turn，只有上一轮本身是回忆/日志/历史类问题才继承 `needsMemory`。
- 热路径补齐：`buildSubagentContextSummary` 追加 sanitized short-term active topic/carry-over；`messageHandler` 传入结构化 `continuitySignals`；AI router refine 不再清掉本地已经判定的 memory route。
- 回归覆盖：孤立“然后呢/还有呢”不触发 memory；承接“回忆一下我们相处最搞笑的一件趣事”会触发 notebook memory；`Previous user:` 标签本身不会因为英文 `previous` 误触发。
- 小目标已完成：短追问召回从关键词补丁改为上下文继承机制。

## 运行维护 2026-06-12 07:16

- 定位 `data/bot-runtime.err.log` 最新 `NapCat websocket is not connected`：thinking emoji pre-model 与 continuous-message reply expand 都在 NapCat 已断线时继续发 OneBot action，导致非关键链路持续刷失败。
- 最小修复：`napcatActionClient` 增加连接快照与 offline/retryable 错误语义；`setMessageEmojiLike` 离线快速返回 `napcat_offline`；reply/forward 展开离线标记 `degraded` 并跳过缓存负写入。
- 恢复逻辑：WebSocket `open` 显式 `handleConnect()`，message handler 将当前 action client 透传给连续消息预处理器，恢复后同一引用/转发可以重新调用 NapCat 展开。
- 小目标已完成：NapCat 断连时不再持续打坏 thinking emoji / continuous-message expand，恢复后自动回正。

## 运行维护 2026-06-12 07:32

- 长期记忆巡检入口默认只读化：`profile-journal-db` 不再默认执行 auto-clean / benchmark，显式 `--clean` / `--benchmark` 才触发对应动作。
- MemOS 远端层关闭时诊断直接返回 disabled 摘要，不再等待 MCP discovery；实测 `diag:memory memos` 7ms 返回 `discovery.skippedReason=memos_disabled`。
- 复查 LanceDB/SQLite/Memory V3 overlap：`unexpectedVectorRows=0`、`missingVectorRows=0`、`vectorOnlyRows=0`、`recommendedAction=none`。
- 小目标已完成：长期记忆维护诊断不再隐式改库，也不会因关闭的 MemOS 远端层卡住。

## 运行维护 2026-06-12 07:34

- 完成当前项目优秀架构提炼，输出到 `E:\qq-bot-0.1\doc\mizukibot0`。
- 新增总索引和 40 个可并行开发主题文档，覆盖 route contract、Runtime V2、tool policy、prompt manifest、记忆治理、post-reply worker、request trace、诊断命令、NapCat health、部署运维和 Rust 迁移。
- 小目标已完成：其他 agent/QQ 聊天机器人可按主题并行学习和迁移。
