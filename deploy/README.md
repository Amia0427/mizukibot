# Deploy Index

## Linux

- `deploy/linux/LINUX_DEPLOY_FULL.md`
- `deploy/linux/README_LINUX.md`
- `deploy/docker/README.md`
- `deploy/linux/subagent.env.linux.example`（2026-05-30 +08:00 起仅保留退役占位说明）

## Windows

- Windows 本地运行见根目录 `restart-bot.cmd` 和 `scripts/README.md`

## Runtime

- 本项目不保留无关网络隧道运行配置或管理脚本。

更新 2026-06-22 18:45 +08:00：已删除本项目内无关网络隧道配置、脚本和部署文档入口，并清理对应历史路径。验收：当前树和历史路径扫描均不再命中该类专属文件。

更新 2026-06-23 00:00 +08:00：新增 Dockerfile、Compose 和 Docker 部署文档，支持主 bot 与 post-reply worker 容器化运行。验收：目标单测、Node 语法检查、Compose YAML 解析和 Dockerfile 文本检查通过；当前本机缺少 Docker CLI，镜像构建需在安装 Docker 的环境复跑。
