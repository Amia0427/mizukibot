# Workspace Layout

根目录只保留运行入口、包管理文件、主配置和运行时锁文件。

## Core Runtime

- `api/`
- `core/`
- `utils/`
- `web/`
- `scripts/`
- `tests/`
- `prompts/`
- `deploy/`
- `docs/`

## Runtime State

- `data/`：运行时数据、日志、检查点、队列

## Local Artifacts

- `artifacts/tmp/`：本地临时快照、一次性导出、测试残留
- `artifacts/logs/`：根目录遗留调试日志
- `artifacts/backups/`：本地迁移备份、旧脚本备份、一次性归档目录

## Windows Ops

- `ops/windows/`：Windows 运维相关配置、导出 XML、安装包、快捷脚本

## Templates

- `docs/templates/`：诊断或线上 smoke 用的模板文件

约定：

- 新的临时文件不要再直接落到根目录
- 运维资产优先放到 `ops/windows/`
- 一次性分析产物优先放到 `artifacts/tmp/`
- 本机工具目录说明见 `docs/local-dev.md`
- 脚本索引见 `scripts/README.md`
- 部署目录索引见 `deploy/README.md`
