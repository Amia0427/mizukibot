# 开发环境与首次启动

> 源码核验时间：2026-07-31（Asia/Shanghai）。命令以仓库根目录为当前目录。

本文只解决一件事：让新开发者在不污染真实数据、不误用示例密钥的前提下，完成依赖安装、配置检查、离线 smoke 和本地进程启动。

## 1. 环境要求

| 项目 | 要求 | 依据 |
| --- | --- | --- |
| Node.js | 必须是 20.x | `.nvmrc` 为 `20`，`package.json` 的 `engines.node` 为 `>=20 <21` |
| npm | 使用 Node.js 20 自带版本即可 | 仓库提交了 `package-lock.json` |
| NapCat / OneBot 11 | 只有做真实 QQ 收发联调时需要 | 主进程同时支持 HTTP 反向事件入口和 HTTP action 出站 |
| 模型服务 | 只有做真实模型调用时需要 | 可使用 OpenAI-compatible、Anthropic-compatible 或受支持的 provider gateway |

先验证 Node.js，不要用 21、22 或 24 代替：

```bash
node --version
npm run check:node
```

通过时会输出类似：

```text
[node-version] Node.js v20.x.x matches 20.x policy
```

## 2. 安装依赖

首次检出仓库、CI 或希望严格复现锁文件时使用：

```bash
npm ci
```

只有在以下情况使用 `npm install`：

- 当前工作区还没有可用的 lockfile；
- 你正在有意增加、删除或升级依赖，并准备审查 `package.json` 与 `package-lock.json` 的变化。

```bash
npm install
```

不要为了“修一下本地环境”随手运行 `npm install <package>`。依赖变化属于代码变化，必须有明确用途并进入同一次评审。

## 3. 安全创建 `.env`

配置加载入口是 `config/envRuntime.js`。进程优先保留已经存在的环境变量，再从仓库根目录 `.env` 补齐空缺；也可以通过 `MIZUKIBOT_ENV_FILE` 指向另一个配置文件。

仅当 `.env` 不存在时复制示例，避免覆盖本机已有密钥：

Linux、macOS 或 Git Bash：

```bash
[ -e .env ] || cp .env.example .env
```

Windows `cmd.exe`：

```bat
if not exist .env copy .env.example .env
```

必须理解两个安全事实：

1. `.env.example` 中的 `placeholder`、`changeme` 只是占位符，不是可用配置。
2. `config.validateRequiredConfig()` 当前只硬校验 `API_KEY` 非空，因此 `API_KEY=placeholder` 也会通过配置检查；通过检查不等于模型或 NapCat 可用。

`.env`、`.env.local` 等本地配置已被 `.gitignore` 忽略。不要用 `git add -f` 强行提交。

## 4. 最小配置

### 4.1 只做静态检查和离线测试

离线测试不应依赖真实服务。最小可设置一个非生产测试值：

```dotenv
API_KEY=local-test-only
PRIVATE_PROACTIVE_ENABLED=false
PROACTIVE_GROUP_OUTBOUND_ENABLED=false
POST_REPLY_WORKER_ENABLED=false
POST_REPLY_WORKER_INLINE=false
```

测试用例和 smoke 脚本会在需要时把 `DATA_DIR` 重定向到临时目录。不要把生产 `.env` 或生产 `data/` 复制进开发工作区。

### 4.2 启动主进程并真实调用模型

至少替换以下值：

```dotenv
API_BASE_URL=https://your-model-endpoint.example/v1
API_KEY=replace-with-real-secret
AI_MODEL=replace-with-supported-model

PRIVATE_PROACTIVE_ENABLED=false
PROACTIVE_GROUP_OUTBOUND_ENABLED=false
POST_REPLY_WORKER_ENABLED=false
POST_REPLY_WORKER_INLINE=false

WEB_BIND_HOST=127.0.0.1
WEB_PORT=3005
WEB_TOKEN=replace-with-a-long-random-value
REQUEST_TRACE_HASH_SECRET=replace-with-a-stable-random-value
```

`API_PROVIDER` 可以留空让运行时按 endpoint 和模型自动判断。只有自动判断不正确时再显式配置，且要同时验证 provider 协议和 URL。

开发环境默认关闭主动私聊、主动群消息和 post-reply worker，是为了避免本地启动后向真实用户发消息或消费共享队列。需要验证这些能力时再逐项开启。

### 4.3 做真实 QQ 收发联调

在上一节基础上补齐：

```dotenv
BOT_QQ=replace-with-bot-qq
NAPCAT_HTTP_API_BASE_URL=http://127.0.0.1:3000
NAPCAT_HTTP_ACTION_SECRET=replace-with-action-secret
NAPCAT_HTTP_REVERSE_PORT=3002
NAPCAT_HTTP_REVERSE_BIND_HOST=127.0.0.1
NAPCAT_HTTP_REVERSE_SECRET=replace-with-reverse-secret
```

NapCat 的 OneBot 11 HTTP 反向 `postUrls` 应指向：

```text
http://127.0.0.1:3002/
```

NapCat 使用的反向请求 secret 必须与 `NAPCAT_HTTP_REVERSE_SECRET` 一致。机器人发送 action 时使用 `NAPCAT_HTTP_API_BASE_URL` 和 `NAPCAT_HTTP_ACTION_SECRET`；这是另一条方向相反的链路，不要把两个 secret 当成同一个配置项。

如果模型端点或 NapCat 不在本机，先阅读对应的网络与安全配置，不要为了联通而直接把 bind host 改成 `0.0.0.0`。`WEB_BIND_HOST` 非 loopback 时，Web 服务会强制要求 `WEB_TOKEN`。

## 5. 配置自检

`console` 脚本不是交互式 REPL，而是一个轻量诊断入口。先执行：

```bash
npm run console
```

等价的显式命令是：

```bash
npm run console -- check
```

它会输出 Node.js 版本、关键路径、NapCat 地址、Web 端口，并对密钥做掩码显示。该命令只检查配置形状，不会证明模型 endpoint 能返回结果，也不会证明 NapCat 已登录。

查看命令帮助：

```bash
npm run console -- --help
```

记忆检索诊断的入口示例：

```bash
npm run console -- rag <userId> "<query>"
```

这个命令可能读取本地记忆数据。不要拿生产用户 ID 和生产 `DATA_DIR` 做无关开发试验。

## 6. 首次 smoke

按从快到慢的顺序执行：

```bash
npm run check:node
npm run console -- check
npm run check:prompts
npm run smoke:napcat-ingress
```

这组命令验证：

- Node.js 主版本与仓库策略一致；
- `.env` 可以被加载，必需配置和并发参数合法；
- prompt manifest、prompt 资产和运行时引用一致；
- NapCat WebSocket/HTTP 入口、异步 ingress dispatcher 和入口接线的回归测试通过。

它们不需要向真实 QQ 用户发消息。首次修改核心运行时前，再执行完整静态检查：

```bash
npm run lint
npm run typecheck
npm test
```

发布前 smoke 更重，并包含 Windows 重启脚本、模型 fallback、连续消息和并发回归：

```bash
npm run smoke:pre-release
```

不要把 `smoke:pre-release` 当成每次改一行文档都必须运行的命令；验证范围应与改动风险一致。

## 7. 启动主进程

```bash
npm start
```

实际入口是根目录 `index.js`。启动时依次完成：

1. 设置运行角色 `MIZUKIBOT_RUNTIME_ROLE=main`；
2. 加载并校验配置；
3. 获取 `.mizukibot.lock` 单实例锁；
4. 启动 Web 服务和 NapCat HTTP 反向入口；
5. 初始化表情包、调度、主动行为、资源采样等已启用运行时；
6. 两个监听服务就绪后把 readiness 标记为 ready。

本地健康检查：

```bash
curl http://127.0.0.1:3005/live
curl http://127.0.0.1:3005/ready
curl http://127.0.0.1:3005/healthz
```

预期是 HTTP 200 和 `{"ok":true}`。`/live` 表示进程存活；`/ready` 与 `/healthz` 表示启动流程已经完成。Web 管理页默认是 `http://127.0.0.1:3005/`。

使用 `Ctrl+C` 结束开发进程，让主进程执行 drain、停止 worker/runtime、刷写 hot store、关闭 SQLite 和释放单实例锁。不要把结束 Node 进程作为常规停机方式。

## 8. 启动 post-reply worker

post-reply worker 消费 `POST_REPLY_QUEUE_DIR`（默认 `data/post_reply_jobs/`）中的回复后任务，处理记忆提取、向量维护等非前台工作。开发时只能选择一种模式。

### 独立进程模式

`.env`：

```dotenv
POST_REPLY_WORKER_ENABLED=true
POST_REPLY_WORKER_INLINE=false
```

终端 A：

```bash
npm start
```

终端 B：

```bash
npm run start:post-reply-worker
```

worker 入口是 `scripts/post-reply-worker.js`，会设置运行角色 `post_reply_worker`，并通过 `.mizukibot-postreply-worker.lock` 和 `.mizukibot-postreply-worker.pid` 阻止重复实例。readiness 状态默认写入 `data/runtime/post-reply-worker/worker-state.json`。

### 主进程内联模式

`.env`：

```dotenv
POST_REPLY_WORKER_ENABLED=true
POST_REPLY_WORKER_INLINE=true
```

只启动主进程：

```bash
npm start
```

此时不要再运行 `npm run start:post-reply-worker`，否则两个消费者会共享同一队列，增加调试噪声和状态竞争风险。

## 9. 常见首次启动问题

| 现象 | 先检查什么 |
| --- | --- |
| `Node.js 20.x required` | 当前终端是否真的切换到 Node 20，而不是只安装了 Node 20 |
| `Missing required env vars: API_KEY` | `.env` 是否在仓库根目录，或 `MIZUKIBOT_ENV_FILE` 是否指向正确文件 |
| 配置检查通过但模型请求失败 | 是否仍在使用 `placeholder`；`API_BASE_URL`、模型名和 provider 协议是否匹配 |
| 主进程提示已有实例 | 查明 `.mizukibot.lock` 对应进程是否仍存活；不要直接删除正在使用的锁文件 |
| `/live` 可用但 `/ready` 返回 503 | 查看主进程启动日志，确认 Web 和 HTTP reverse 两个监听器都已就绪 |
| 能收到事件但发不出回复 | 检查 NapCat action 地址与 action secret，而不只是 reverse secret |
| 收不到事件 | 检查 NapCat `postUrls`、反向端口、bind host 和 reverse secret |
| worker 启动后立即退出 | 已有 worker 持有单实例锁，或守护进程已经启动了 worker |

## 10. 禁止提交的数据

以下内容即使看起来“有助于复现”，也不能直接提交：

- `.env*` 中的真实配置；仓库只允许 `.env.example` 和 `.env.skills.example`；
- `secrets/`、`*.key`、`*.pem`、`*.p12`、`*.pfx`、`*.ovpn`；
- `data/` 中的对话、记忆、SQLite、队列、checkpoint、模型调用轨迹、request trace、缓存和导出；
- `tmp/`、`logs/`、`*.log`、`*.pid`、`*.lock`；
- `node_modules/` 和本机工具缓存；
- `artifacts/` 下的本地评估、备份和诊断输出，除非它是经过脱敏、被正式文档引用且明确允许提交的验收资产；
- `prompts/admin.txt`、`prompts/persona/` 等被忽略的私有 prompt 资产；
- 包含真实用户 ID、群号、消息原文、Cookie、token、API key 或服务端地址的截图和日志片段。

提交前至少执行：

```bash
git status --short
npm run check:secrets:all
```

`.gitignore` 只是最后一道保护，不是提交敏感数据的许可判断。诊断输出需要进入评审时，先生成最小、脱敏的复现样本，再明确说明数据来源和保留理由。
