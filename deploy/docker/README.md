# Docker Deployment Guide (MizukiBot)

更新 2026-06-23 00:00 +08:00：新增 Docker/Compose 部署入口。验收：目标单测、Node 语法检查、Compose YAML 解析和 Dockerfile 文本检查通过；当前本机缺少 Docker CLI，镜像构建需在安装 Docker 的环境复跑。

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

WEB_PORT=3005
WEB_BIND_HOST=0.0.0.0
WEB_TOKEN=your_strong_token
DATA_DIR=/app/data
```

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
docker compose run --rm --entrypoint node mizukibot -c index.js
docker compose run --rm --entrypoint node mizukibot -c core/napcatHttpReverseServer.js
docker compose run --rm --entrypoint node mizukibot -c utils/postReplyWorkerSupervisor.js
```

Web 面板默认访问：

```text
http://127.0.0.1:3005/?token=<WEB_TOKEN>
```

NapCat HTTP reverse 默认入口：

```text
http://127.0.0.1:3002/
```
