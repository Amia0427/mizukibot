# MizukiBot Linux 服务器完整部署手册

这份文档用于把当前项目部署到 Linux 服务器并稳定运行。

适用系统：
- Ubuntu 20.04/22.04/24.04
- Debian 11/12
- 其他支持 `bash + systemd` 的 Linux

---

## 0. 你将得到什么

项目内已提供 Linux 脚本：
- `scripts/install-linux.sh`：安装依赖与初始化
- `scripts/check-linux.sh`：部署前检查
- `scripts/mizukibot.sh`：手动启动/停止/日志查看
- `scripts/setup-systemd.sh`：安装为 systemd 服务（开机自启）

对应 npm 命令：
- `npm run linux:install`
- `npm run linux:check`
- `npm run linux:start`
- `npm run linux:stop`
- `npm run linux:restart`
- `npm run linux:status`
- `npm run linux:logs`
- `npm run linux:systemd`

---

## 1. 服务器准备

### 1.1 安装 Node.js 18+

建议 Node.js 20 LTS（或更高）。

Ubuntu/Debian 示例：

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

---

## 2. 上传并解压项目

把压缩包上传到服务器，例如：

```bash
scp mizukibot-linux-package.zip user@your-server:/opt/
```

服务器上解压：

```bash
cd /opt
sudo apt install -y unzip
unzip mizukibot-linux-package.zip
cd mizukibot-linux-package
```

---

## 3. 初始化安装

```bash
npm run linux:install
```

这个步骤会：
- 安装 npm 依赖
- 若缺失则自动创建 `.env`
- 创建 `logs/`
- 赋予 Linux 脚本执行权限

---

## 4. 配置 `.env`（必须）

编辑 `.env`：

```bash
nano .env
```

最少需要确认：

```env
API_KEY=你的key
API_BASE_URL=https://www.su8.codes/codex/v1/chat/completions
AI_MODEL=gpt-5.4
ADMIN_USER_IDS=1960901788
ADMIN_API_BASE_URL=
ADMIN_AI_MODEL=
ADMIN_API_KEY=
MEMORY_MODEL=gpt-5.1-codex-mini
IMAGE_MODEL=[官方]gemini-3.1-flash-image-preview

NAPCAT_WS_URL=ws://127.0.0.1:3001
TIMEZONE=Asia/Shanghai

WEB_PORT=3005
WEB_BIND_HOST=127.0.0.1
WEB_TOKEN=请设置强口令
```

可选：

```env
PROXY_URL=
AMAP_KEY=your_amap_key
```

`ADMIN_*` 仅影响管理员主对话主模型；留空时分别回退到默认 `API_BASE_URL` / `AI_MODEL` / `API_KEY`。当前 Web 设置页不会展示或编辑这些字段，需要手工维护 `.env`。

---

## 5. 启动前检查（推荐）

```bash
npm run linux:check
```

它会检查：
- Node/npm 是否可用
- `.env` 是否存在、`API_KEY` 是否为空
- 关键 JS 文件语法是否正确
- agent 静态自检

---

## 6. 启动与运维（手动模式）

启动：

```bash
npm run linux:start
```

状态：

```bash
npm run linux:status
```

日志：

```bash
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

---

## 7. 安装为 systemd 服务（生产推荐）

```bash
sudo npm run linux:systemd
```

查看状态：

```bash
systemctl status mizukibot --no-pager
```

实时日志：

```bash
journalctl -u mizukibot -f
```

重启服务：

```bash
sudo systemctl restart mizukibot
```

停止服务：

```bash
sudo systemctl stop mizukibot
```

开机自启检查：

```bash
systemctl is-enabled mizukibot
```

---

## 8. NapCat / OneBot 对接说明

本项目不会自动安装 Linux NapCat，本项目只负责连接 OneBot WS：

```env
NAPCAT_WS_URL=ws://<napcat_host>:<port>
```

你需要先在 Linux 侧部署 NapCat 并确保 OneBot WS 可访问。

排障建议：
- 本机测试端口是否通：`nc -vz 127.0.0.1 3001`
- 跨机网络：检查防火墙、安全组、反向代理

---

## 9. Web 面板安全建议

当前面板已实现最小鉴权：
- `WEB_TOKEN` 配置后支持：
  - `Authorization: Bearer <token>`
  - `x-web-token: <token>`
  - 页面 URL `?token=...`

生产建议：
- `WEB_BIND_HOST=127.0.0.1`
- 用 Nginx 反代并启用 HTTPS
- 仅开放 Nginx 端口，不直接暴露 Node 端口

---

## 10. 常见故障排查

### Q1: `API_KEY is empty`
- 检查 `.env` 是否在项目根目录
- 检查是否有不可见空格/引号

### Q2: `NapCat ws error` / 连不上 OneBot
- 检查 `NAPCAT_WS_URL`
- 检查 NapCat 是否启动
- 检查端口和防火墙

### Q3: 启动成功但很快退出
- 先看 `logs/mizukibot.log`
- 再看 `journalctl -u mizukibot -n 200 --no-pager`

### Q4: 面板 401
- 未携带 token 或 token 错误
- 可用 `?token=你的WEB_TOKEN` 先登录

### Q5: 服务器网络慢导致 API 超时
- 检查出网
- 必要时设置 `PROXY_URL`

---

## 11. 升级流程（建议）

1. 停服务：

```bash
npm run linux:stop
```

2. 替换代码（保留 `.env`）

3. 安装依赖并检查：

```bash
npm run linux:install
npm run linux:check
```

4. 启动：

```bash
npm run linux:start
```
