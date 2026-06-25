# Docker Beginner Deployment Guide

更新 2026-06-26 02:30 +08:00：这份文档给第一次用 Docker 部署 MizukiBot 的人看，只覆盖现有 `Dockerfile` 和 `docker-compose.yml` 的最小启动路径。

## 先知道范围

- Docker 只运行 MizukiBot 主进程和 post-reply worker。
- NapCat 不在这个 Compose 里，需要你单独运行。
- `.env`、私有 prompt、运行数据和日志不会打进镜像。
- 容器里的运行数据默认放在 Docker volume：`mizukibot-data` 和 `mizukibot-logs`。

## 第一步：安装 Docker

Windows 推荐安装 Docker Desktop，并打开 WSL 2 后端。Linux 服务器安装 Docker Engine 和 Compose 插件后，检查：

```bash
docker version
docker compose version
```

如果你在国内网络环境，拉镜像很慢时先配置 Docker 镜像加速器；npm 依赖安装默认已走 `registry.npmmirror.com`，也可以在构建时覆盖：

```bash
docker compose build --build-arg NPM_CONFIG_REGISTRY=https://registry.npmmirror.com mizukibot
```

## 第二步：准备项目

```bash
git clone https://github.com/Amia0427/mizukibot.git
cd mizukibot
```

如果你不是从公开仓库拉代码，而是复制项目目录，也要确认没有把本机 `.env`、`data/`、`artifacts/` 一起发给别人。

## 第三步：创建 `.env`

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

先填最小配置：

```env
API_BASE_URL=https://你的模型服务地址/v1/chat/completions
API_PROVIDER=openai
API_KEY=你的模型Key
AI_MODEL=你的模型名

NAPCAT_HTTP_API_BASE_URL=http://host.docker.internal:3000
NAPCAT_HTTP_ACTION_SECRET=你自己设置的NapCat鉴权密钥
NAPCAT_HTTP_REVERSE_PORT=3002
NAPCAT_HTTP_REVERSE_BIND_HOST=0.0.0.0

BOT_QQ=你的机器人QQ号
ADMIN_USER_IDS=你的QQ号

WEB_PORT=3005
WEB_BIND_HOST=0.0.0.0
WEB_TOKEN=换成一个长一点的随机字符串

DATA_DIR=/app/data
TIMEZONE=Asia/Shanghai
```

不要提交 `.env`。它已经被 `.gitignore` 和 `.dockerignore` 忽略。

Linux 上如果 NapCat 跑在宿主机，`host.docker.internal` 可能不可用。先用宿主机网关地址替换 `NAPCAT_HTTP_API_BASE_URL`，例如 `http://172.17.0.1:3000`；不同机器网关可能不同。

## 第四步：准备私有 prompt

Compose 会把这两个路径只读挂进容器：

```text
prompts/admin.txt
prompts/persona/
```

至少准备这些文件：

```text
prompts/admin.txt
prompts/persona/01_identity.txt
prompts/persona/02_style.txt
prompts/persona/03_boundaries.txt
prompts/persona/04_behavior.txt
prompts/persona/05_examples.index.json
prompts/persona/05_voice_samples.txt
prompts/persona/06_state_modulation.txt
prompts/persona/09_liveness_authentic.txt
```

最小可用的 `prompts/persona/05_examples.index.json`：

```json
{
  "version": 1,
  "max_examples": 0,
  "examples": []
}
```

私有 prompt 不进 Git，也不进镜像。详细说明见 `deploy/private-prompts.md`。

## 第五步：构建并启动

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
```

正常时能看到 `mizukibot` 和 `mizukibot-post-reply-worker` 都是 running 或 Up。

查看日志：

```bash
docker compose logs -f mizukibot
docker compose logs -f post-reply-worker
```

## 第六步：基础自检

先确认 Compose 配置能解析：

```bash
docker compose config
```

再检查容器里的入口文件语法：

```bash
docker compose run --rm --entrypoint node mizukibot --check index.js
docker compose run --rm --entrypoint node mizukibot --check core/napcatHttpReverseServer.js
docker compose run --rm --entrypoint node mizukibot --check scripts/post-reply-worker.js
```

检查 Web 面板安全状态：

```bash
curl -H "Authorization: Bearer 你的WEB_TOKEN" http://127.0.0.1:3005/api/security-status
```

检查 NapCat HTTP reverse 入口是否能收到空事件探针：

```bash
curl -i -X POST http://127.0.0.1:3002/ -H "Content-Type: application/json" -d "{}"
```

返回 `204` 说明入口活着。真正收发 QQ 消息还要 NapCat 侧配置正确。

## 第七步：配置 NapCat

NapCat 需要单独安装并登录 QQ。把 OneBot HTTP reverse 的 `postUrls` 指向 MizukiBot：

```text
http://宿主机IP:3002/
```

如果 NapCat 和 Docker 在同一台电脑上，Windows/macOS 通常可以用：

```text
http://127.0.0.1:3002/
```

Linux 服务器上更稳的是写服务器内网 IP 或宿主机实际 IP。

NapCat 的 action secret 要和 `.env` 里的 `NAPCAT_HTTP_ACTION_SECRET` 一致。

## 常见问题

### 拉不下基础镜像

先配置 Docker 国内镜像源，或换能访问 Docker Hub 的网络；然后重试：

```bash
docker compose build --no-cache mizukibot
```

### npm 安装慢

默认 Dockerfile 已用 `registry.npmmirror.com`。需要换源时：

```bash
docker compose build --build-arg NPM_CONFIG_REGISTRY=https://registry.npmmirror.com mizukibot
```

### 端口被占用

默认端口是 `3002` 和 `3005`。如果宿主机已有程序占用，在 `.env` 改：

```env
NAPCAT_HTTP_REVERSE_PORT=3012
WEB_PORT=3015
```

然后重启：

```bash
docker compose up -d
```

### 缺少私有 prompt

日志里出现 `Missing persona prompt files` 时，回到第四步补齐 `prompts/persona/` 文件。

### Web 面板 401

确认请求带了正确 token：

```bash
curl -H "Authorization: Bearer 你的WEB_TOKEN" http://127.0.0.1:3005/api/security-status
```

### 不小心想清空数据

普通停止不会删数据：

```bash
docker compose down
```

只有确定要清空 Docker volume 时才执行：

```bash
docker compose down -v
```

## 隐私边界

这些文件或目录不应该进入 Git，也不会被当前 Docker 镜像复制进去：

```text
.env
.env.*
.mcp.json
secrets/
prompts/admin.txt
prompts/persona/
data/
artifacts/
logs/
*.key
*.pem
*.p12
*.pfx
*.ovpn
```

公开模板 `.env.example` 和 `.env.skills.example` 会保留在仓库和镜像里，用来告诉部署者该填哪些变量。
