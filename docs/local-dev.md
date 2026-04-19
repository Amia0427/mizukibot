# Local Dev Notes

这些目录主要是本机开发/代理运行时依赖，不属于项目主代码结构：

## Local Tooling Dirs

- `.claude/`：本机 Claude 相关配置
- `.openclaw/`：本机 OpenClaw 工作区
- `.skills_bin/`：本机技能工具可执行文件
- `.skills_pydeps/`：本机技能依赖缓存
- `.venv_skills/`：本机技能 Python 虚拟环境

## Handling Rules

- 这些目录默认按“本机环境”看待，不作为业务代码目录整理
- 除非明确做环境迁移或工具链重构，否则不要随意改路径
- 如果只是整理仓库观感，优先整理根目录杂项、`artifacts/`、`ops/`、`docs/`

## Deploy Notes

- `deploy/` 已按用途拆成：
  - `deploy/linux/`
  - `deploy/windows/`
  - `deploy/network/`
  - `deploy/runtime/`
- 入口索引见 `deploy/README.md`
