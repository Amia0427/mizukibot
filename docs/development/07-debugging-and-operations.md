# 排障与运行维护

更新：2026-07-31 +08:00

排障目标不是尽快让进程重新变绿，而是用可关联证据定位故障发生在哪一段：入站、路由、Runtime、模型/工具、回复发送、持久化或后台 worker。重启可以恢复服务，但不能证明根因已修复。

## 1. 标准取证顺序

1. 记录发生时间、会话类型、用户/群的脱敏标识和 request ID。
2. 先查进程、readiness 和队列，确认故障是全局还是单请求。
3. 沿 request ID 检查入站、route、模型调用、工具、发送和 post-reply 证据。
4. 用只读诊断缩小模块，再在临时 `DATA_DIR` 或测试输入中复现。
5. 只有状态确实损坏或修复已部署时才执行重启、清理、迁移或回滚。
6. 修复后同时验证症状消失、回归测试通过、健康状态稳定，保留命令与时间窗。

日志和诊断输出可能包含用户内容。分享前只保留必要片段，脱敏 token、cookie、API URL 查询参数、QQ 标识、prompt 原文和工具参数。

## 2. 第一层：进程和健康

先执行只读状态检查：

```bash
npm run diag:runtime -- --text
npm run diag:runtime-hotspots -- --text --since 30m
npm run diag:runtime-exceptions -- --text --since 30m
```

`diag:runtime` 汇总主进程、post-reply worker、后台任务、LangGraph checkpoint、队列和锁信号。`diag:runtime-hotspots` 查看 RSS/heap、event loop、timer 与高频模块；`diag:runtime-exceptions` 聚合模型 fallback、记忆 rerank 和运行异常。

Web 探针：

```bash
curl -i http://127.0.0.1:3005/live
curl -i http://127.0.0.1:3005/ready
curl -i http://127.0.0.1:3005/healthz
```

- `/live` 只表示进程仍处于 live 状态；
- `/ready` 表示入口已准备接收请求；
- `/healthz` 当前与 readiness 等价；
- 503 是状态证据，不要通过修改探针固定返回 200。

平台状态命令：

```bash
restart-bot.cmd status
npm run win:daemon:status
npm run linux:status
systemctl status mizukibot --no-pager
systemctl status mizukibot-postreply-worker --no-pager
```

## 3. 按症状定位

### 3.1 QQ 消息没有进入

```bash
npm run diag:napcat-health -- --text
npm run smoke:napcat-ingress
node scripts/run-tests.js tests/napcatHttpReverseServer.test.js tests/napcatWsIngressSmoke.test.js
```

检查顺序：NapCat 是否在线、WebSocket 是否重连、HTTP reverse 是否绑定正确、鉴权是否失败、事件是否被判无效或重复、异步 ingress 队列是否饱和。不要先改 router；没有 ingress 证据时，路由根本没有收到消息。

HTTP reverse 的 401/403/429 分别优先检查签名/token、来源/时间窗与速率限制。空对象 POST 不是有效健康探针。

### 3.2 消息进入但走错路由

有 request ID 时：

```bash
npm run diag:route-decision -- --request-id req_xxx --since 2h --limit 1
npm run diag:request-trace-preflight -- --request-id req_xxx
```

只有文本时先离线预测：

```bash
npm run diag:route-decision -- --text "复现消息" --user-id test_user --chat-type private
```

查看 local rule、fast/direct 退出条件、权限、图片/引用上下文、allowed tools、planner 来源和最终 Runtime 节点。离线预测不读取当时全部会话状态，因此与已记录 request trace 冲突时，以真实 trace 为准。

### 3.3 路由正确但模型没有回复

```bash
npm run diag:main-reply -- --cache-stats
npm run diag:fallback
npm run diag:provider-request -- --provider gemini_native
npm run diag:main-model-retry-duplicates -- --since 2h
```

按顺序确认：实际 provider/model、请求开始/结束、HTTP 状态、首 token/总超时、fallback 熔断、重试是否重复、响应解析和终止原因。不要把 API key、完整 headers 或完整请求体贴到工单；`diagnose-provider-request.js` 的目的就是输出脱敏后的最终请求形状。

出现截断时：

```bash
npm run diag:main-reply-truncation -- --limit 20
npm run diag:main-reply-token-budget -- --limit 20 --json
```

区分上游 `MAX_TOKENS`、传输断流、缺少 terminal event 和本地发送失败，再决定改预算、协议还是发送链路。

### 3.4 Prompt、角色或上下文异常

```bash
npm run diag:main-reply-prompt-assembly -- --request-id req_xxx
npm run diag:live-state-dynamic -- --request-id req_xxx
npm run diag:short-term-context
npm run check:prompts
```

检查 stable/dynamic/assistant-only blocks、persona/worldbook 命中、planner 提供来源、daily journal、short-term continuity、裁剪前后长度和 block 顺序。不要直接输出真实完整 prompt；需要共享时只保留 block ID、来源、长度、hash 和脱敏摘要。

如果普通用户出现管理员规则，立即检查 admin 上下文与 `ADMIN_USER_IDS` 识别链，并运行 `tests/adminStableSystemPrompt.test.js`、`tests/normalUserDefaultPromptSendSurfaces.test.js` 和 prompt security 测试。不要修改私有 `prompts/admin.txt` 来掩盖路由污染。

### 3.5 工具没有执行或执行错

```bash
npm run diag:route-decision -- --request-id req_xxx --limit 1
npm run diag:runtime-exceptions -- --text --since 2h
npm run check:agent:static
node scripts/run-tests.js tests/toolContractsValidation.test.js tests/toolExecutionValidation.test.js
```

依次确认 route plan 是否允许工具、schema 名与 executor 名是否一致、companion/tool policy 是否过滤、动态 MCP registry 是否发现、参数校验是否拒绝，以及 executor 是否返回可识别失败。不要直接调用 `api/toolExecutors/index.js` 中的内部函数来证明线上可用，应通过 `api/toolRegistry.js` 公共入口复现实际过滤和惰性加载。

### 3.6 记忆没召回、串用户或写入污染

```bash
npm run diag:memory -- diagnose --read-only --limit 10
npm run diag:memory-rag-explain -- --user-id test_user --query "复现问题" --top-k 8
npm run diag:continuity
node scripts/check-sqlite-integrity.js
```

先区分“没有候选”“候选被 namespace/生命周期过滤”“排序未入选”“超预算裁剪”和“最终 prompt 未注入”。串用户属于高优先级隔离故障，立即保存脱敏证据并停止任何批量清理。

`diag:memory` 的 `diagnose`、`recall`、`audit`、`profile-journal-db` 等模式默认优先只读；`--clean`、`--apply-clean`、迁移、backfill、rollback 和 import 会改变数据，不属于排障第一步。

SQLite integrity 通过只说明数据库结构可读，不证明语义数据正确。Memory V3 的向量索引属于派生状态，先确认事件和结构化事实，再考虑重建索引。

### 3.7 回复已生成但 QQ 未发送

```bash
npm run diag:main-reply -- --limit 10
npm run diag:napcat-health -- --text
node scripts/run-tests.js tests/qqActionService.test.js tests/napcatActionRetry.test.js tests/outboundMessageDiagnostics.test.js
```

检查回复 guard、富文本/图片 payload、NapCat action 连接状态、重试是否发生在可确认未送达的错误上，以及最终发送 telemetry。不要无条件重试有副作用的发送操作，否则可能重复发消息。

### 3.8 Post-reply 队列积压

```bash
npm run diag:runtime -- --text
node scripts/inspect-post-reply-jobs.js
node scripts/check-post-reply-worker-ready.js
node scripts/run-tests.js tests/postReplyWorkerRuntime.test.js tests/postReplyWorkerDrain.test.js
```

观察 queued/processing/failed、最老任务年龄、lease、错误分类和 worker PID/心跳。worker 缺失与 worker 空闲不同：没有到期任务时 idle 是正常状态。

不要手工把 processing 文件移动回 queued。使用现有 inspect、requeue、rollback、repair 命令前先阅读对应脚本的参数与幂等规则，并保存队列快照。

### 3.9 频繁退出或重启

```bash
npm run diag:main-bot-restarts -- --text --tail-lines 20 --max-archive-logs 3 --max-daemon-events 20
npm run verify:main-bot-stability-window
npm run diag:runtime-exceptions -- --text --since 6h
```

区分预期关闭、短命启动、单实例锁冲突、daemon 重拉、资源压力回收和真实崩溃。陈旧 PID/lock 只是线索；在确认对应进程不存在前，不要删除锁文件。

### 3.10 Web 面板 401、403 或打不开

```bash
node scripts/run-tests.js tests/webHealthRoute.test.js tests/webAuthSecurity.test.js tests/webSessionSecurity.test.js
npm run diag:security
```

- 连接拒绝：检查 bind host、port、进程和 readiness；
- 401：检查是否通过 `/login` 建立短期 HttpOnly session；管理 API 不接受 Bearer、query token 或 `x-web-token`；
- 403：写请求必须有严格同源 Origin/Referer；
- 429：登录失败次数达到窗口上限；
- 反代后循环登录或 origin 不符：检查受控 proxy headers 和 `WEB_TRUST_PROXY_HOPS`。

不要临时关闭鉴权或同源检查来确认路由是否存在。可通过注入式 route 测试直接验证 handler。

## 4. 运行数据和证据所有权

所有默认运行证据位于 `config.DATA_DIR`，具体路径可能被环境变量覆盖。常见证据包括 request trace、model calls、NapCat health、后台任务、LangGraph checkpoint、post-reply queue、进程锁和 restart observation。

读取原则：

- 优先使用 `scripts/diagnose-*.js`，它们知道当前文件格式、时间窗和脱敏规则；
- 大型 NDJSON 只读尾部或指定 request ID，不整文件复制；
- 同时记录诊断读取的时间窗和样本数量；
- 主进程与 worker 可能写同类日志，必须保留 runtime role；
- 不根据单条日志推断全链路成功，使用 request ID 串联阶段。

写入、清理和归档的所有者由对应 store/worker 决定。不要用编辑器直接改运行 JSON、SQLite 或队列文件。

## 5. 生产安全边界

### 5.1 先只读，再变更

以下动作会改变生产状态，执行前需要明确目标、备份/快照和回滚方案：

- memory migrate、backfill、import、clean、governance apply/rollback；
- post-reply requeue、repair、cancel、archive、clear；
- 删除 PID/lock、SQLite WAL/SHM、向量索引或运行数据；
- 修改 `.env`、私有 prompt、tool/MCP 配置；
- restart/stop、Docker volume 删除、systemd 重装。

诊断中看到“stale”不等于可以直接删除。先确认进程存活、锁 owner、时间阈值和内建恢复逻辑。

### 5.2 Web 管理面

`web/server/index.js` 默认绑定 loopback。无 `WEB_TOKEN` 时只允许本机只读/同源操作；绑定非 loopback 时启动要求强 token。生产外部访问应通过 HTTPS 反向代理，Node 端口仍限制在 loopback 或受控网络。

只在确知代理跳数时设置 `WEB_TRUST_PROXY_HOPS`，并由代理覆盖 Host、`X-Forwarded-Proto` 和 `X-Forwarded-For`，不要信任客户端传入的 forwarded headers。健康端点保持最小公开信息。

### 5.3 NapCat HTTP reverse

生产必须设置 reverse secret。优先使用时间戳、nonce 和 HMAC/SHA-256 签名，服务端校验时间窗并拒绝 nonce 重放；legacy Bearer 只用于受控 loopback 兼容，所有调用方支持签名后应关闭兼容模式。端口不直接暴露公网。

### 5.4 Docker 与系统服务

`Dockerfile` 以非 root `node` 用户运行。`docker-compose.yml` 使用只读根文件系统、drop all capabilities、`no-new-privileges`、资源限制、tmpfs 和显式数据卷；3002/3005 默认只发布到宿主 loopback。不要为排障改成 root、可写根文件系统或 `0.0.0.0` 公网端口后长期保留。

```bash
docker compose ps
docker compose logs -f mizukibot
docker compose logs -f post-reply-worker
docker compose config
```

删除 volume 的 `docker compose down -v` 会删除持久化数据，不是普通重启命令。

### 5.5 安全重启

Windows 先执行：

```bash
restart-bot.cmd status
restart-bot.cmd restart confirm
```

未带 `confirm` 的 restart 只报告确认要求。脚本会校验 PID 对应命令、写 expected-shutdown 证据、等待主进程和 worker 健康；不要用任务管理器批量结束所有 Node 进程。

Linux：

```bash
npm run linux:status
npm run linux:restart
npm run linux:logs
```

systemd 部署以 `systemctl`/`journalctl` 为准，不混用手动 nohup PID 管理。重启后至少验证 `/ready`、worker readiness、原始症状和稳定时间窗；只看到新 PID 不算验收。

### 5.6 优雅关闭

主进程收到信号后会停止 ingress、Web/reverse server、主动任务、scheduler、worker supervisor、模型 transport，随后 flush hot stores 和关闭 SQLite。post-reply worker 会先 drain 再 flush/close。强制结束进程可能留下 lease、WAL、未刷盘 hot store 或误判崩溃，只有优雅关闭超时且证据已保存时才升级为强制终止。

## 6. 修复后的验收

修复完成至少回答：

1. 哪条证据证明根因，而不只是症状？
2. 哪个最小测试在修复前失败、修复后通过？
3. 相邻边界测试和质量门禁是否通过？
4. 生产是否重新出现同一个 request/queue/health 信号？
5. 是否观察了足够的稳定窗口？
6. 哪些数据、进程和配置没有改动？

建议记录：

```text
时间窗：开始/结束，时区
影响：会话类型、请求数量、脱敏标识
证据：request ID、诊断命令、关键状态码
根因：所属模块和失效前提
动作：代码/配置/运行状态分别改了什么
验收：聚焦测试、门禁、readiness、稳定窗口
未验证：剩余风险和后续观察点
```

同一处理思路连续三次没有推进时，不再重复重启或清理；回到系统边界重新确认是入口、所有权、数据格式还是问题定义错误。
