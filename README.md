# MizukiBot

> 面向 QQ 的角色 Agent —— 在真实群聊/私聊里稳定运转，而不只是个问答 bot。

MizukiBot 基于 Node.js、LangGraph 和 NapCat，把"晓山瑞希"角色扮演、消息路由、分层记忆、工具调用、后台学习和运行诊断拼成一套可长期跑的本地机器人。一条消息进来，它先判断该不该回、怎么回（直接聊 / 调工具 / 后台处理 / 拒绝），回复后再把有价值的信息沉淀进记忆。

## 它能做什么

- **QQ 接入**：通过 NapCat / OneBot 收发私聊、群聊、图片、引用、转发、戳一戳等事件。
- **路由分流**：按 `ignore` / `refuse` / `admin` / `direct_chat` 等路线分发，不是每条消息都砸给大模型。
- **角色一致性**：prompt manifest、persona worldbook、运行时协议和回复清洗共同维持瑞希的语气和边界。
- **分层记忆**：短期上下文、会话摘要、用户画像、Memory V3、LanceDB 向量召回、本地知识库协同。
- **工具调用**：本地命令、诊断、知识检索、图片处理、日程、自定义 skill。
- **后台学习**：post-reply worker 在回复后异步抽取记忆、维护画像、写日记，不卡主回复。
- **群聊回复拦截**：群聊主回复发送前会用本地高风险敏感词库快照做出口检查，命中后替换为固定提示，不影响私聊和系统群发任务。
- **运维诊断**：重启、健康检查、请求 trace、token 预算、NapCat 状态、记忆质量、运行热点一应俱全。

## 并发与后台线程

更新 2026-06-23 09:42 +08:00：主 bot 仍保持 OneBot 单入口单实例；本地 CPU/同步文件型后台重活通过受控 `worker_threads` 池处理，默认 `BOT_WORKER_THREADS_MAX=2`。后台学习 worker 默认并发提升到 `POST_REPLY_WORKER_CONCURRENCY=2`，资源压力态会按 `POST_REPLY_WORKER_PRESSURE_MAX_CONCURRENCY=1` 回落；embedding backfill 与图片视觉摘要默认并发为 2。验收结果：7 个定向并发/线程池测试均通过；`npm run diag:runtime -- --json` 返回 warning，但主进程 `processCount=1` 且 post-reply 队列 `queued=0/processing=0`；`npm run diag:main-reply-lag -- --json --no-provider-diagnostic --window=24h` 仍判定瓶颈为 `main_model`，hotspots 已输出 `workerThreads.enabled=true/maxWorkers=2/active=0/queued=0`。小目标完成：默认受控多线程与后台并发扩容已落地。

更新 2026-06-24 01:31 +08:00：主回复和图片总结上下文收到 HTTP 408 时不再自动重试；这类网关超时可能只是上游生成慢，服务端仍会完成，自动重试会造成重复主模型调用。普通网络错误、5xx、409/425/429 和非主回复 408 的既有重试策略保持不变。验收结果：新增 408 重试策略回归通过，相关 HTTP client 与图片总结定向测试通过；`git diff --check` 通过。小目标完成：管理员主模型慢成功 408 不再被本地重试放大。

更新 2026-06-24 09:40 +08:00：新增最小诊断入口 `npm run diag:main-model-retry-duplicates -- --around "2026-06-24T00:47:59+08:00" --window 5m --admin-only`，可直接交叉扫描 `data/request-trace.ndjson` 和 `data/model-calls.ndjson`，识别同一 requestId 因 HTTP 408 且 retryable 后继续发起主模型调用的疑似重复样本。验收结果：新增回归 `node scripts/run-tests.js mainModelRetryDuplicateDiagnostics.test.js` 通过；本地现场样本命中 `req_a82a87717e2f479f`，显示 attempt 1/2 为 408、attempt 3 成功。小目标完成：408 重试重复主模型调用排查闭环已落地。

更新 2026-06-24 10:21 +08:00：`memoryReranker` 召回退化闭环复查今天 `data/bot-runtime.err.log` 的 `800ms/1200ms` 超时样本；`data/model-calls.ndjson` 中 6/23-6/24 共 71 条 `memory_rerank` 底层调用全部成功，p95/p99 为 `732/996ms`，只 2 条超过 800ms、无超过 1200ms，瓶颈判定为本地 800ms 预算贴近尾延迟而非调用链阻塞或无门禁重复触发。现运行配置来源的 rerank timeout 会受 `MEMORY_RERANK_TIMEOUT_FLOOR_MS=1500` 下限保护，显式测试/特殊调用的短 timeout 仍原样生效。验收结果：`node tests\memoryReranker.test.js` 覆盖默认预算下限和显式超时分支。小目标完成：热路径不再因 800ms 尾延迟误伤频繁回退到 base recall。

更新 2026-06-24 10:25 +08:00：图片视觉摘要长期记忆链路补齐 400 诊断。HTTP 失败进入 cooldown 时会在 `image_memory_index` 的 `visualSummaryState` 留下脱敏 `errorDiagnostic/requestDiagnostic`，用于区分请求体、模型参数或上游约束；目标测试和语法检查通过。

更新 2026-06-24 10:28 +08:00：被动群感知决策模型空正文不再混记为 `invalid-json`，会记录为 `empty-output` 并输出 `finishReason/hasReasoning` 诊断；本地决策模型从 `opencode.ai + mimo-v2.5-free` 切回已验证可返回 JSON 的 `。验收结果：最小 JSON 探针返回可解析 `should_reply=false`；决策空正文回归、强 cue 兜底回归和语法检查通过。小目标完成：群  的 `group-awareness decision model returned non-json output` 已定位为模型选择导致的空正文，而非提示词或响应解析。

更新 2026-06-24 18:01 +08:00：新增 `npm run diag:memory-rag-explain -- --user-id <id> --query "<text>"` 最小本地诊断入口，复用现有 Memory V3 / diagnosis 链路，直接输出一次主回复记忆召回的候选来源、journal segment 命中、long-term/profile 命中、rank fusion / rerank、journal-vs-long-term 去重和最终保留结果。验收结果：`node tests/memoryV3RagExplainDiagnostic.test.js`、`node tests/memoryV3RagExplainDedupStage.test.js` 通过。小目标完成：真实 `userId + query` 的 RAG explain 闭环已可本地直接跑通。

更新 2026-06-25 13:45 +08:00：`npm test` 挂住根因已定位为测试子进程继承本机 `.env` 后误开 CycleTLS/Memory CLI rerank，导致本地型单测断言结束后残留 `::1:9119` Socket；另有股票高级测试真实访问外网导致 TCP 等待。验收结果：原 33 个超时文件按小分片全部通过，新增 runner 默认环境回归和股票测试网络 stub 回归通过；未跑全量。

更新 2026-06-25 13:36 +08:00：主回复最终组装层不再把已进入 canonical segments 的 retrieved memory / daily journal / short-term continuity 再作为 dynamic system blocks 注入，recent history 也会剔除与当前 user turn 完全相同的副本。验收结果：`node tests/conversationContextClaudeCacheMarkers.test.js`、`node tests/runtimeStreamingCoordinator.test.js`、`node -e "require('./tests/runtimeV2MainReplyMemoryOrder.test.js')().catch((error)=>{ console.error(error); process.exit(1); })"` 通过。小目标完成：主回复慢样本里的重复上下文拼装点已收口。

更新 2026-06-25 23:19 +08:00：`scripts/console.js` 新增 `rag` / `memory-rag-explain` 子命令，复用既有 `diag:memory-rag-explain` 实现，可用 `npm run console -- rag <userId> "<query>"` 更快按真实用户和问题跑 Memory RAG explain。验收结果：`node scripts/run-tests.js consoleMemoryRagExplainEntry.test.js`、`node scripts/run-tests.js memoryV3RagExplainDiagnostic.test.js memoryV3RagExplainDedupStage.test.js`、`node --check scripts/console.js`、`node --check tests/consoleMemoryRagExplainEntry.test.js`、`git diff --check` 通过；隔离空数据目录 smoke 在关闭 embedding/rerank 后也可输出 `memory_v3_rag_explain_diagnostic_v1`。小目标完成：真实 `userId + query` 的本地 explain 入口已收口到 console 快捷命令。

## 技术栈

| 层 | 选型 |
| --- | --- |
| Runtime | Node.js 20+、CommonJS、LangGraph |
| 模型适配 | Anthropic Messages、OpenAI 兼容、Gemini 风格 provider |
| QQ 接入 | NapCat、OneBot WebSocket / HTTP action |
| 存储 | JSONL、SQLite、LanceDB、本地分片文件 |
| Web | Express 本地管理入口 |
| 测试与诊断 | 自研 `scripts/run-tests.js`、prompt 检查、运行态诊断脚本 |

## 主链路

```text
NapCat / OneBot
  → core/messageHandler.js
  → core/messageIngress.js
  → core/router/index.js
  → core/routeExecution.js
  → core/messageRouteFlow/index.js
  → api/runtimeV2/host/index.js
  → Runtime V2 nodes / tools / memory
  → QQ 回复发送
  → post-reply worker / memory / diagnostics
```

## 快速开始

### 环境要求

- Node.js `>= 20`
- npm
- NapCat / OneBot
- 可用的模型 API Key

### 安装

```bash
npm install
```

### 最小 `.env`

```env
API_KEY=你的模型 API Key
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_WS_TOKEN=
DATA_DIR=./data
```

### 启动

```bash
npm start                 # 主 bot
npm run console           # 交互控制台
npm run start:post-reply-worker   # 单独跑后台学习 worker
```

## 常用命令

```bash
# 测试与检查
npm test
npm run lint
npm run check:prompts

# 诊断
npm run diag:napcat-health -- --text
npm run diag:main-reply
npm run diag:memory -- audit --limit 5
npm run console -- rag <userId> "<query>"
```

### Windows 本地运维

```bash
restart-bot.cmd status
restart-bot.cmd restart confirm
npm run win:daemon:status
```

### Linux 运维

```bash
npm run linux:install
npm run linux:start
npm run linux:status
npm run linux:logs
```

### Docker 运维

```bash
docker compose up -d --build
docker compose logs -f mizukibot
docker compose logs -f post-reply-worker
```

Docker 部署说明见 [`deploy/docker/README.md`](deploy/docker/README.md)；第一次用容器部署先看 [`deploy/docker-beginner-guide.md`](deploy/docker-beginner-guide.md)。

更新 2026-06-25 13:00 +08:00：`amia/dev` 的 Docker 构建只复制运行白名单；真实 `.env`、运行数据、密钥文件、本地 MCP 配置和私有 prompt 不进入镜像，私有 prompt 由 Compose 运行时只读挂载。

更新 2026-06-26 01:52 +08:00：本地 WSL/Docker 链路已用国内镜像源完成真实 smoke：DaoCloud 拉取基础镜像，Dockerfile 依赖安装默认走 `registry.npmmirror.com`，临时端口 `49105/49106` 下 `docker-compose build`、`docker-compose up -d`、Web security status 200、NapCat reverse 204 和容器内 Node 语法检查均通过。

更新 2026-06-26 02:30 +08:00：复查 Git、忽略规则和 `mizukibot:local` 镜像，未发现真实 `.env`、密钥文件、本地 MCP 配置、私有 prompt 或运行数据进入仓库/镜像；新增初学者容器化部署文档。

### NPM 发布

发布包使用 `package.json` 的 `files` 白名单，不包含真实 `.env`、运行数据、测试、MCP 本地配置、本地私有 prompt 或本地 `skills/` 目录。发布前检查见 [`docs/npm-publish.md`](docs/npm-publish.md)。

更新 2026-06-23 12:38 +08:00：`npm publish` 会先执行 `prepublishOnly` / `npm run publish:check`，登录后真实发布命令为 `npm publish --access public`。

## 目录结构

```text
api/        模型调用、工具注册、Runtime V2、Agent 能力
core/       QQ 消息入口、路由、调度、被动感知和主动任务
utils/      记忆、prompt、诊断、存储和工具策略
config/     环境变量解析和运行时配置
prompts/    人格、系统提示词、worldbook 和 prompt manifest
scripts/    启动、测试、诊断、部署和维护脚本
tests/      单元测试和回归测试
web/        本地管理 Web 服务
docs/       架构说明、维护记录和排障文档
data/       本地运行数据，默认不提交
```

## 项目演进

这个项目从一个 QQ 角色聊天机器人，一步步长成能长期运行的 Agent Runtime。早期先打通 NapCat 接入、主回复链路和基础 prompt，随后补上路由、工具、记忆、主动任务和后台学习，形成"消息进入 → 路由判断 → Runtime 执行 → 回复发送 → 持久化/学习"的闭环。

一路下来的主要工程动作：

- **Runtime V2**：把准备上下文、路由、planner、工具 dispatch、回复草稿、润色、校验、持久化拆成可测试节点，压低单文件主流程复杂度。
- **记忆重构**：从全量 JSON 常驻内存改成磁盘优先、按用户/群组分片召回，减轻启动和回复路径的内存压力。
- **延迟治理**：定位连续消息聚合、入站锁、流式生成和 QQ 发送阶段的耗时，给普通群文本、图片、引用分别设等待策略。
- **安全与角色边界**：普通用户、管理员、被动群感知、fast reply 各自接入安全 prompt、回复标记和 emoji 反馈，不让安全规则只卡在单一路径。
- **清理历史隐私**：从 Git 历史移除本地截图、运行数据、评估样本、备份包和代理本地配置，`.gitignore` 阻止再次入库。
- **Anthropic prompt cache**：统一最终请求里的缓存断点、TTL 和网关 header，避免动态历史消息破坏缓存命中。
- **Windows 运行加固**：修双击重启、远程重启、旧进程清理、worker 残留、锁文件和成功反馈，让本地长期跑更可控。
- **复杂度治理**：拆大文件、补诊断脚本、沉淀维护日志，README 也从维护流水账收回到项目入口该有的样子。

## 文档入口

- [`docs/maintenance-log.md`](docs/maintenance-log.md) — 近期维护记录和验收结果
- [`docs/repository-structure.md`](docs/repository-structure.md) — 目录边界和清理规则
- [`docs/main-reply-context.md`](docs/main-reply-context.md) — 主回复上下文设计
- [`docs/post-reply-worker.md`](docs/post-reply-worker.md) — 回复后学习 worker 说明
- [`docs/project-development-history.md`](docs/project-development-history.md) — 基于 Git 历史整理的开发过程
- [`docs/npm-publish.md`](docs/npm-publish.md) — npm 发布边界和检查命令
- [`deploy/beginner-guide.md`](deploy/beginner-guide.md) — 面向初学者的部署指南
- [`deploy/docker-beginner-guide.md`](deploy/docker-beginner-guide.md) — 面向初学者的容器化部署指南
- [`scripts/README.md`](scripts/README.md) — 脚本说明
- [`deploy/README.md`](deploy/README.md) — 部署说明

---

更新时间：2026-06-26 01:52 +08:00
维护记录：2026-06-26 01:52 +08:00，Docker/Compose 链路已在 WSL 本地真实跑通：已处理历史 `wg0` 全流量路由、Docker bridge DNS 和官方源访问慢的问题；`docker-compose build --progress plain mizukibot` 成功生成 `mizukibot:local`，临时 `.env` 端口 `49105/49106` 下两个服务启动为 Up，`/api/security-status` 返回 200 且 `ok=true`，NapCat HTTP reverse 空 JSON POST 返回 204，容器内 `node --check` 三项通过，最后已 `docker-compose down` 清理。
维护记录：2026-06-25 23:45 +08:00，Docker/Compose 链路已做本地复核：`docker-compose config` 在 WSL 临时最小 `.env` 下通过，白名单文件集和私有 prompt 只读挂载检查通过，主进程按 Dockerfile 等价文件集可启动并通过 Web/NapCat reverse 基础探针；真实镜像构建被 `node:20-bookworm-slim` 从 Docker Hub 拉取元数据超时阻塞，且本机默认 3002/3005 正被当前宿主 bot 占用。小目标完成状态：已定位当前最可能启动断点和环境缺口，真实 `docker compose up -d --build` 需在镜像源可达且端口空闲环境复跑。
维护记录：2026-06-25 23:19 +08:00，`scripts/console.js` 已接入 `rag` / `memory-rag-explain` 快捷子命令，委托既有 `diag:memory-rag-explain`，可用 `npm run console -- rag <userId> "<query>"` 直接对真实用户问题跑 Memory RAG explain；最小入口回归、既有 RAG explain 回归、语法检查、隔离空数据目录 smoke 和 diff 检查均通过。小目标已完成：本地真实 `userId + query` explain 入口更顺手。
维护记录：2026-06-25 13:45 +08:00，已定位并修复 `npm test` 挂住的测试环境外部传输泄漏：runner 子进程默认关闭 CycleTLS 和 Memory CLI rerank，股票高级单测改为 stub 外网行情源；原超时集合小分片验收通过，未跑全量。
维护记录：2026-06-24 18:01 +08:00，已新增 `diag:memory-rag-explain` 最小本地诊断脚本，复用现有 Memory V3 / diagnosis 链路，直接按真实 `userId + query` 输出候选来源、journal segment 命中、long-term/profile 命中、rerank、journal-vs-long-term 去重和最终保留结果；并补齐两条最小回归覆盖真实链路与去重诊断。小目标已完成：主回复记忆召回 explain/diagnostic 已可本地直接验收。
维护记录：2026-06-24 15:53 +08:00，已定位 `tests/memoryV3PreferenceFacet.test.js` 和 `tests/memoryV3Query.test.js` 直接运行卡住的根因是默认 `MEMORY_RERANK_ENABLED=true` 会让本地型 Memory V3 测试误走 CycleTLS rerank 传输并留下 `::1:9119` 句柄；现仅对这两个测试关闭 rerank/embedding/LanceDB/CycleTLS 路径并新增非 stdio 句柄断言，直接运行可自然退出。小目标已完成：这两个 Memory V3 定向测试不再依赖 `process.exit(0)` 包装收尾。
维护记录：2026-06-24 12:08 +08:00，Memory V3 查询阶段新增 journal-vs-long-term 语义去重，重复候选只在本次召回结果中折叠并保留 duplicateEvidence 诊断。
维护记录：2026-06-24 12:01 +08:00，日记 segment 已按 session/topic 聚类后分别摘要和向量化，避免同一向量文档混入无关主题。
维护记录：2026-06-24 11:32 +08:00，日记 segment 默认批量从 10 条降到 6 条，降低混合话题摘要带来的无关召回风险。
维护记录：2026-06-23 23:36 +08:00，已收窄 QQ 群聊敏感词默认分类，并放行一批日常高频误伤词。
维护记录：2026-06-23 08:00 +08:00，本地 persona 与 admin prompt 已从 Git 跟踪中移除，并通过 `.gitignore` 保持本地私有。
维护记录：2026-06-23 09:00 +08:00，已重写 `master` 历史，`prompts/persona/` 和 `prompts/admin.txt` 不再出现在本地 Git 历史或对象列表中。
维护记录：2026-06-23 08:58 +08:00，已为 npm 发布增加白名单、dry-run 验收和敏感内容扫描记录，真实发布等待 npm 登录。
维护记录：2026-06-23 09:17 +08:00，已新增面向初学者的部署指南，覆盖 `.env`、私有 prompt、NapCat、启动和排障。
维护记录：2026-06-23 12:38 +08:00，已为 npm 发布增加 `prepublishOnly` 硬门禁，登录后可执行 `npm publish --access public`。
