# Beginner Deployment Guide

更新 2026-06-23 09:17 +08:00：这是一份给第一次部署 MizukiBot 的开发者看的指南。目标是先把机器人跑起来，再逐步加后台 worker、Web 面板、Docker 或 systemd。

## 先知道这几个东西

- MizukiBot 是 Node.js 程序，主入口是 `npm start`。
- NapCat 是 QQ 接入程序，需要单独安装运行；MizukiBot 通过 OneBot HTTP 和 NapCat 通信。
- `.env` 是本地配置文件，里面放模型 key、NapCat 地址、Web token 等敏感信息，不能提交。
- `prompts/persona/` 和 `prompts/admin.txt` 是私有 prompt，仓库不会提供，需要自己创建。具体看 `deploy/private-prompts.md`。
- `data/`、`logs/` 是运行数据和日志，默认不提交。

## 推荐顺序

第一次部署建议按这个顺序来：

1. 在本机或服务器装好 Node.js 20+ 和 npm。
2. 拉代码，安装依赖。
3. 复制 `.env.example` 为 `.env`，填最少配置。
4. 创建私有 prompt 文件。
5. 先运行检查命令。
6. 启动 MizukiBot。
7. 再配置 NapCat 让 QQ 消息进来。

不要一开始就同时改 Docker、systemd、反代、worker 和所有可选功能。先让主 bot 正常启动，后面的问题会少很多。

## 第一步：安装基础环境

### Windows

安装：

- Node.js 20 或更高版本
- Git
- npm，通常会随 Node.js 一起安装

检查：

```powershell
node -v
npm -v
git --version
```

### Linux

Debian/Ubuntu 可以先装常用工具：

```bash
sudo apt-get update
sudo apt-get install -y git curl unzip python3
```

如果服务器还没有 Node.js，可以使用项目脚本：

```bash
bash scripts/bootstrap-debian12.sh
```

检查：

```bash
node -v
npm -v
git --version
```

Node.js 版本必须是 20 或更高。

## 第二步：获取代码并安装依赖

```bash
git clone https://github.com/Amia0427/mizukibot.git
cd mizukibot
npm install
```

如果是生产服务器，想按 lockfile 安装：

```bash
npm ci --omit=dev
```

## 第三步：创建 `.env`

复制模板：

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

Linux/macOS：

```bash
cp .env.example .env
```

至少先填这些：

```env
API_BASE_URL=https://你的模型服务地址/v1/chat/completions
API_PROVIDER=openai
API_KEY=你的模型Key
AI_MODEL=你的模型名

NAPCAT_HTTP_API_BASE_URL=http://127.0.0.1:3000
NAPCAT_HTTP_ACTION_SECRET=你自己设置的NapCat鉴权密钥
NAPCAT_HTTP_REVERSE_PORT=3002
NAPCAT_HTTP_REVERSE_BIND_HOST=127.0.0.1

BOT_QQ=你的机器人QQ号
ADMIN_USER_IDS=你的QQ号

WEB_PORT=3005
WEB_BIND_HOST=127.0.0.1
WEB_TOKEN=换成一个长一点的随机字符串

DATA_DIR=./data
TIMEZONE=Asia/Shanghai
```

说明：

- `API_BASE_URL`、`API_KEY`、`AI_MODEL` 决定机器人调用哪个模型。
- `NAPCAT_HTTP_API_BASE_URL` 是 MizukiBot 发消息给 NapCat 的地址。
- `NAPCAT_HTTP_REVERSE_PORT` 是 MizukiBot 接收 NapCat 事件的端口。
- `NAPCAT_HTTP_ACTION_SECRET` 要和 NapCat 侧配置一致。
- `WEB_TOKEN` 不要用 `123456` 这种弱口令。

## 第四步：创建私有 prompt

仓库不会带这两个路径：

```text
prompts/persona/
prompts/admin.txt
```

它们已经被 `.gitignore` 忽略。你需要自己创建，至少包含：

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

最小可用的 `05_examples.index.json`：

```json
{
  "version": 1,
  "max_examples": 0,
  "examples": []
}
```

如果你还不知道每个文件怎么写，先看：

```text
deploy/private-prompts.md
```

## 第五步：启动前检查

先检查 prompt：

```bash
npm run check:prompts
```

再做基础语法检查：

```bash
node -c index.js
node -c config/index.js
node -c core/napcatHttpReverseServer.js
```

Linux 服务器可以直接跑：

```bash
npm run linux:check
```

如果 `npm run check:prompts` 报 `Missing persona prompt files`，说明第四步的私有 prompt 文件缺了或是空文件。

## 第六步：启动 MizukiBot

### 最简单启动

```bash
npm start
```

看到程序持续运行，没有立即退出，说明主进程已经起来。

### Windows 常用启动

项目根目录可以用：

```powershell
.\restart-bot.cmd restart confirm
.\restart-bot.cmd status
```

查看日志时优先看：

```text
data/restart-bot.log
logs/
```

### Linux 后台启动

```bash
npm run linux:start
npm run linux:status
npm run linux:logs
```

停止：

```bash
npm run linux:stop
```

重启：

```bash
npm run linux:restart
```

## 第七步：配置 NapCat

NapCat 需要单独运行。MizukiBot 当前推荐 HTTP reverse 接入：

- MizukiBot 接收事件地址：`http://127.0.0.1:3002/`
- MizukiBot 调 NapCat action 地址：看你的 NapCat HTTP 服务地址，填到 `NAPCAT_HTTP_API_BASE_URL`
- 鉴权密钥：NapCat 和 `.env` 里的 `NAPCAT_HTTP_ACTION_SECRET` 保持一致

如果 NapCat 和 MizukiBot 在同一台机器：

```env
NAPCAT_HTTP_API_BASE_URL=http://127.0.0.1:3000
NAPCAT_HTTP_REVERSE_BIND_HOST=127.0.0.1
NAPCAT_HTTP_REVERSE_PORT=3002
```

如果 NapCat 在另一台机器，要把 `127.0.0.1` 改成能互相访问的内网 IP，并检查防火墙。

## 第八步：打开 Web 面板

默认地址：

```text
http://127.0.0.1:3005/?token=你的WEB_TOKEN
```

如果部署在服务器上，初学者不建议直接把 `WEB_BIND_HOST` 改成 `0.0.0.0` 暴露公网。更稳妥的做法是先用 SSH 隧道或 Nginx 反代加 HTTPS。

## Docker 部署

如果你熟悉 Docker，可以用：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f mizukibot
```

注意：

- Docker Compose 只运行 MizukiBot 和 post-reply worker。
- NapCat 仍然需要单独运行。
- Linux Docker 里访问宿主机 NapCat 时，`host.docker.internal` 可能不可用，需要改成宿主机网关地址。
- 私有 prompt 仍然要准备好；如果 Docker 镜像不包含这些文件，就要通过外部 `PROMPTS_DIR` 或 volume 提供。

更完整说明见：

```text
deploy/docker/README.md
```

## systemd 部署

Linux 服务器长期运行时，可以装 systemd 服务：

```bash
sudo npm run linux:systemd
```

常用命令：

```bash
systemctl status mizukibot --no-pager
journalctl -u mizukibot -f
systemctl restart mizukibot
```

如果你还没跑通 `npm start` 或 `npm run linux:start`，先不要上 systemd。

## 常见问题

### 启动时报 `.env not found`

你还没有创建 `.env`。执行：

```bash
cp .env.example .env
```

Windows 用：

```powershell
Copy-Item .env.example .env
```

### 报 `Missing persona prompt files`

缺少私有 prompt。按第四步创建 `prompts/persona/` 下的文件。

### QQ 没有消息进来

优先检查：

- NapCat 是否正在运行
- NapCat 的 HTTP reverse 地址是否指向 `http://127.0.0.1:3002/`
- `NAPCAT_HTTP_REVERSE_PORT` 是否和 NapCat 配置一致
- 防火墙是否放行端口

### 机器人发不出消息

优先检查：

- `NAPCAT_HTTP_API_BASE_URL` 是否能访问
- `NAPCAT_HTTP_ACTION_SECRET` 是否和 NapCat 一致
- NapCat HTTP action 服务是否开启
- `BOT_QQ` 是否填的是机器人 QQ

### 模型调用失败

优先检查：

- `API_BASE_URL` 是否是正确 endpoint
- `API_KEY` 是否有效
- `AI_MODEL` 是否存在
- 服务器是否能访问模型服务

可以跑：

```bash
npm run diag:provider-request
```

### Web 面板打不开

检查：

- 主进程是否还在运行
- `WEB_PORT` 是否被占用
- 地址是否带了 `?token=WEB_TOKEN`
- 服务器防火墙是否放行端口

## 最小验收清单

部署完成后至少确认：

```bash
npm run check:prompts
node -c index.js
npm run diag:napcat-health -- --text
```

然后确认：

- NapCat 能把消息推到 MizukiBot。
- MizukiBot 能通过 NapCat 发出回复。
- `logs/` 或 `data/restart-bot.log` 没有连续报错。
- Web 面板能用 `WEB_TOKEN` 打开。
