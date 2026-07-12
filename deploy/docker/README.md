# Docker Deployment Guide (MizukiBot)

更新 2026-06-23 00:00 +08:00：新增 Docker/Compose 部署入口。验收：目标单测、Node 语法检查、Compose YAML 解析和 Dockerfile 文本检查通过；当前本机缺少 Docker CLI，镜像构建需在安装 Docker 的环境复跑。

更新 2026-06-25 13:00 +08:00：`amia/dev` 的 Docker 构建改为显式复制运行白名单，并通过 `.dockerignore` 排除 `.env`、密钥文件、运行数据、本地 MCP 配置和私有 prompt。`prompts/persona/` 与 `prompts/admin.txt` 只在 Compose 运行时只读挂载，不进入镜像。

更新 2026-07-12 14:15 +08:00：运行镜像改用内置 `node` 非 root 用户，`/app` 可创建实例锁且数据/日志目录归该用户所有；Compose 的 3002、3005 端口均只发布到宿主 loopback。当前环境 Docker daemon 与 Compose 插件均不可用，已完成 Dockerfile 安全断言和 YAML 解析，真实镜像 UID/卷写入探针需在 daemon 可用后执行。

## 适用范围

Docker 部署只运行 MizukiBot 主进程和 post-reply worker，不包含 NapCat。NapCat 需要单独运行，并把 OneBot HTTP reverse `postUrls` 指向宿主机的 `http://<host>:3002/`。

## 准备环境

复制并编辑环境文件：

```bash
cp .env.example .env
```

至少确认：

```env
API_KEY=your_api_key
API_BASE_URL=https://example.com/v1/chat/completions
AI_MODEL=your_model

NAPCAT_HTTP_API_BASE_URL=http://host.docker.internal:3000
NAPCAT_HTTP_ACTION_SECRET=your_secret
NAPCAT_HTTP_REVERSE_PORT=3002
NAPCAT_HTTP_REVERSE_BIND_HOST=0.0.0.0
NAPCAT_HTTP_REVERSE_SECRET=your_long_random_reverse_secret

WEB_PORT=3005
WEB_BIND_HOST=0.0.0.0
WEB_TOKEN=your_strong_token
DATA_DIR=/app/data
```

容器启动前还需要在宿主机准备本地私有 prompt：

```text
prompts/admin.txt
prompts/persona/
```

这些文件会被 Compose 只读挂载到容器内，不会打进镜像。详细清单见 [`../private-prompts.md`](../private-prompts.md)。

Linux 上如果 NapCat 跑在宿主机，`host.docker.internal` 可能不可用。可把 `NAPCAT_HTTP_API_BASE_URL` 改成宿主机网关地址，或在 compose 中增加 `extra_hosts`。

## 启动

```bash
docker compose up -d --build
```

查看状态和日志：

```bash
docker compose ps
docker compose logs -f mizukibot
docker compose logs -f post-reply-worker
```

停止：

```bash
docker compose down
```

保留数据时不要删除 volume。确实需要清空运行数据时再执行：

```bash
docker compose down -v
```

## 验证

```bash
docker compose config
docker compose run --rm --entrypoint node mizukibot --check index.js
docker compose run --rm --entrypoint node mizukibot --check core/napcatHttpReverseServer.js
docker compose run --rm --entrypoint node mizukibot --check utils/postReplyWorkerSupervisor.js
docker compose run --rm --entrypoint sh mizukibot -c 'id -u && touch /app/data/.write-probe && rm /app/data/.write-probe'
```

主服务提供无需令牌且只返回 `{ "ok": true }` 的 `/healthz` 容器探针；post-reply worker 使用 `service_healthy` 门控，主服务未通过健康检查前不会启动。

Web 面板默认访问：

```text
http://127.0.0.1:3005/login
```

在登录页输入 `WEB_TOKEN` 后使用短期 `HttpOnly` 会话；Bearer、`x-web-token` 和 query token 不再用于管理 API。（更新：2026-07-12 20:10 +08:00）

NapCat HTTP reverse 默认入口：

```text
http://127.0.0.1:3002/
```

原生 NapCat HTTP client 可在宿主 loopback 上使用 `NAPCAT_HTTP_REVERSE_SECRET` token 的兼容模式。跨主机代理或自定义客户端应使用 HMAC 签名请求；签名字符串为 `timestamp.nonce.rawBody`，请求头为 `X-NapCat-Timestamp`、`X-NapCat-Nonce` 和 `X-NapCat-Signature: sha256=<hex>`。签名模式会校验时间窗并拒绝 nonce 重放，静态 Bearer / `X-NapCat-Token` 仅为兼容模式，不提供防重放能力。

Linux/WSL 签名探针：

```bash
body='{"post_type":"meta_event","meta_event_type":"heartbeat","status":{}}'
timestamp=$(date +%s%3N)
nonce=$(openssl rand -hex 16)
signature=$(printf '%s.%s.%s' "$timestamp" "$nonce" "$body" | openssl dgst -sha256 -hmac "$NAPCAT_HTTP_REVERSE_SECRET" -hex | awk '{print $2}')
curl -i http://127.0.0.1:3002/ \
  -H 'Content-Type: application/json' \
  -H "X-NapCat-Timestamp: $timestamp" \
  -H "X-NapCat-Nonce: $nonce" \
  -H "X-NapCat-Signature: sha256=$signature" \
  --data "$body"
```

期望返回 `204`。匿名空对象 POST、错误签名、过期时间戳或重复 nonce 都不是有效健康探针。Compose 只把该端口发布到宿主机 loopback；所有调用方支持签名后，应设置 `NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER=false`。

更新 2026-07-12 16:51 +08:00：NapCat reverse 验证说明已从 Bearer-only/空对象探针更新为 HMAC 签名和显式兼容模式；本轮仅更新文档，未声称容器运行态已重新验收。
