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
AMAP_KEY=your_amap_key
```

说明：
- `ADMIN_*` 只影响管理员主对话主模型，普通用户继续走默认 `AI_*`
- `ADMIN_API_BASE_URL` / `ADMIN_AI_MODEL` / `ADMIN_API_KEY` 留空时，分别回退到 `API_BASE_URL` / `AI_MODEL` / `API_KEY`
- 当前 Web 设置页不会展示或编辑这些字段，需要手工维护 `.env`

2026-05-30 +08:00：外部子 agent 执行链路已退役，Linux 部署不再支持把工具任务统一转发到外部子进程。工具、记忆、planner 和主回复继续由 Mizuki 本项目运行时处理。

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

## 8. 工具执行链
外部子 agent 桥接已退役。线上工具请求仍按 `core/routeExecution.js` 和 `api/runtimeV2` 的本地工具、MCP、记忆与 planner 链路执行。

## 9. Web 面板访问
- 默认仅本机访问：`WEB_BIND_HOST=127.0.0.1`
- 若需公网访问，建议 Nginx 反代 + HTTPS，并设置强 `WEB_TOKEN`
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

4) 工具请求没有执行
- 检查路由是否进入工具执行计划。
- 检查本地工具/MCP 配置、权限策略和运行时诊断。

5) systemd 启动失败
- 查看 `journalctl -u mizukibot -n 200 --no-pager`

