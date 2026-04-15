# Linux Deployment Guide (MizukiBot)

本文档用于在 Linux 服务器上快速部署并启动项目。

## 1. 环境要求
- Ubuntu/Debian/CentOS 等 Linux 发行版
- Node.js >= 18
- npm
- 已可访问你的 `API_BASE_URL`
- NapCat OneBot WebSocket 已部署并可连接

## 2. 上传与安装
在服务器项目目录执行：

```bash
npm run linux:install
```

该命令会做：
- 检查 node/npm
- 安装依赖
- 自动创建 `.env`（若不存在）
- 创建日志目录 `logs/`
- 赋予 Linux 脚本执行权限

## 3. 配置 `.env`
至少确认以下字段：

```env
API_KEY=your_api_key
API_BASE_URL=https://www.su8.codes/codex/v1/chat/completions
AI_MODEL=gpt-5.4
ADMIN_USER_IDS=1960901788
ADMIN_API_BASE_URL=
ADMIN_AI_MODEL=
ADMIN_API_KEY=

NAPCAT_WS_URL=ws://127.0.0.1:3001
TIMEZONE=Asia/Shanghai

WEB_PORT=3005
WEB_BIND_HOST=127.0.0.1
WEB_TOKEN=your_strong_token

PROXY_URL=
AMAP_KEY=e9fda05366ed433e82dbdef2f20ccf43
```

说明：
- `ADMIN_*` 只影响管理员主对话主模型，普通用户继续走默认 `AI_*`
- `ADMIN_API_BASE_URL` / `ADMIN_AI_MODEL` / `ADMIN_API_KEY` 留空时，分别回退到 `API_BASE_URL` / `AI_MODEL` / `API_KEY`
- 当前 Web 设置页不会展示或编辑这些字段，需要手工维护 `.env`

如果你现在的执行链是“工具任务统一交给子 agent”，还要额外确认这组字段：

```env
SUBAGENT_ENABLED=true
SUBAGENT_BACKEND=openclaw
SUBAGENT_NAME=openclaw
SUBAGENT_REVIEW_ENABLED=true

OPENCLAW_COMMAND=/path/to/node_or_openclaw
OPENCLAW_BASE_ARGS=["/path/to/openclaw.mjs"]
OPENCLAW_WORKDIR=/root/.openclaw/workspace
OPENCLAW_AGENT_ID=main
OPENCLAW_TIMEOUT_MS=180000
OPENCLAW_JSON_OUTPUT=true
```

说明：
- 工具型请求会统一转发给子 agent 执行。
- Mizuki 本地不再执行这类工具调用，只负责审核子 agent 结果并发回当前 QQ 通路。
- 普通聊天仍然由 Mizuki 本地直接处理。

## 4. 启动前检查
```bash
npm run linux:check
```

## 5. 启动 / 停止 / 查看

```bash
npm run linux:start
npm run linux:status
npm run linux:logs
npm run linux:stop
npm run linux:restart
```

## 6. 作为系统服务（推荐）

安装 systemd 服务：

```bash
sudo npm run linux:systemd
```

常用命令：

```bash
systemctl status mizukibot --no-pager
journalctl -u mizukibot -f
systemctl restart mizukibot
systemctl stop mizukibot
```

## 7. NapCat 对接
本项目不自带 Linux NapCat 可执行包，你需要单独部署 Linux 版 NapCat。

确保 NapCat OneBot WebSocket 地址与 `.env` 中一致：
- `NAPCAT_WS_URL=ws://<napcat_host>:<port>`

## 8. 子 Agent 执行链
推荐线上配置：

```env
SUBAGENT_ENABLED=true
SUBAGENT_BACKEND=openclaw
SUBAGENT_REVIEW_ENABLED=true
```

这样线上行为会变成：
- 工具任务：Mizuki 路由到子 agent
- 子 agent：执行搜索、总结、资料查询等工具型任务
- Mizuki：审核和润色子 agent 输出
- QQ：把审核后的最终回复发回当前聊天

如果你关闭 `SUBAGENT_REVIEW_ENABLED`，子 agent 原始输出会直接返回给用户。

## 9. Web 面板访问
- 默认仅本机访问：`WEB_BIND_HOST=127.0.0.1`
- 当前更安全的默认管理方案不是直接公网开放，而是 `WireGuard + SSH 跳板`
  - 见 `deploy/WINDOWS_PUBLIC_INBOUND_SAFE.md`
  - 服务器脚本：`npm run linux:wireguard:setup`
  - Windows 管理脚本：`npm run win:mgmt:setup`
- 若需公网访问，建议 Nginx 反代 + HTTPS
- 已启用最小鉴权（`WEB_TOKEN`）
  - 支持 `Authorization: Bearer <token>`
  - 支持 `x-web-token: <token>`
  - 页面也支持 `?token=...` 方式登录

## 10. 常见问题
1) 启动失败 `.env not found`
- 运行 `npm run linux:install` 自动生成。

2) 连接 NapCat 失败
- 检查 `NAPCAT_WS_URL`、端口、防火墙。

3) API 调用超时
- 检查服务器网络，必要时设置 `PROXY_URL`。

4) 工具请求没有走子 agent
- 检查 `SUBAGENT_ENABLED=true`
- 检查 `SUBAGENT_BACKEND` 是否与你实际部署的子 agent 一致
- 如果是 OpenClaw，检查 `OPENCLAW_COMMAND`、`OPENCLAW_BASE_ARGS`、`OPENCLAW_WORKDIR`

5) systemd 启动失败
- 查看 `journalctl -u mizukibot -n 200 --no-pager`

