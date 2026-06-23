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
- **运维诊断**：重启、健康检查、请求 trace、token 预算、NapCat 状态、记忆质量、运行热点一应俱全。

## 并发与后台线程

更新 2026-06-23 09:42 +08:00：主 bot 仍保持 OneBot 单入口单实例；本地 CPU/同步文件型后台重活通过受控 `worker_threads` 池处理，默认 `BOT_WORKER_THREADS_MAX=2`。后台学习 worker 默认并发提升到 `POST_REPLY_WORKER_CONCURRENCY=2`，资源压力态会按 `POST_REPLY_WORKER_PRESSURE_MAX_CONCURRENCY=1` 回落；embedding backfill 与图片视觉摘要默认并发为 2。验收结果：7 个定向并发/线程池测试均通过；`npm run diag:runtime -- --json` 返回 warning，但主进程 `processCount=1` 且 post-reply 队列 `queued=0/processing=0`；`npm run diag:main-reply-lag -- --json --no-provider-diagnostic --window=24h` 仍判定瓶颈为 `main_model`，hotspots 已输出 `workerThreads.enabled=true/maxWorkers=2/active=0/queued=0`。小目标完成：默认受控多线程与后台并发扩容已落地。

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

Docker 部署说明见 [`deploy/docker/README.md`](deploy/docker/README.md)。

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
- [`scripts/README.md`](scripts/README.md) — 脚本说明
- [`deploy/README.md`](deploy/README.md) — 部署说明

---

更新时间：2026-06-23 12:38 +08:00
维护记录：2026-06-23 08:00 +08:00，本地 persona 与 admin prompt 已从 Git 跟踪中移除，并通过 `.gitignore` 保持本地私有。
维护记录：2026-06-23 09:00 +08:00，已重写 `master` 历史，`prompts/persona/` 和 `prompts/admin.txt` 不再出现在本地 Git 历史或对象列表中。
维护记录：2026-06-23 08:58 +08:00，已为 npm 发布增加白名单、dry-run 验收和敏感内容扫描记录，真实发布等待 npm 登录。
维护记录：2026-06-23 09:17 +08:00，已新增面向初学者的部署指南，覆盖 `.env`、私有 prompt、NapCat、启动和排障。
维护记录：2026-06-23 12:38 +08:00，已为 npm 发布增加 `prepublishOnly` 硬门禁，登录后可执行 `npm publish --access public`。
