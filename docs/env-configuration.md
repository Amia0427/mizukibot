# Env Configuration

更新时间：2026-05-30 19:40 +08:00

## 维护约定

- `.env` 不提交到仓库，真实密钥只留本地。
- 中文注释放在变量上一行，不使用行尾注释；当前 fallback 解析器只跳过整行 `#`，不会剥离 `KEY=value # 注释`。
- 同功能变量放在同一分区，新增变量优先追加到对应分区，避免混入无关配置。
- 目前 `.env` 有 305 个变量，303 个唯一变量；重复项仅保留 `MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE` 和 `MEMORY_EMBEDDING_BACKFILL_MAX_PER_RUN` 两组历史调优项。
- 当前 fallback 解析器遇到同名变量会保留首个非空环境值；重复项已在本地 `.env` 注释中标明实际生效顺序。
- 2026-05-30 19:40 +08:00：新增普通用户快速回复配置 `NORMAL_FAST_REPLY_ENABLED`、`NORMAL_FAST_REPLY_RECENT_TURNS`、`NORMAL_FAST_REPLY_CONTEXT_MAX_CHARS`、`NORMAL_FAST_REPLY_SUMMARY_MAX_CHARS`、`NORMAL_FAST_REPLY_MAX_TOKENS`；只影响非管理员简单纯文本 direct_chat。
- 2026-05-29 17:43 +08:00：`HTTP_USER_AGENT`、`MAIN_REPLY_USER_AGENT`、`MODEL_HTTP_USER_AGENT` 默认统一为 `codex-cli/0.121.0 (external, cli)`；配置值不包含 `codex` 时会回落到该默认值。

## 当前分区

- 基础运行 / QQ / Web 面板
- 主模型 / 流式 / 通用生成参数
- 模型路由 / Planner / 降级 / 全局工具
- 普通用户快速回复
- 管理员模型 / 群总结 / 管理员降级
- Humanizer / 拒答代理 / 感知开关
- Native Skills 本地路径
- Minecraft 工具链
- 子代理 / OpenClaw / HAPI
- 被动群感知 / 跟随者日志
- 低资源 / 后台 Worker / 并发控制
- LangGraph / 短期上下文 / 会话摘要
- 长期记忆 / RAG / LanceDB / MemOS
- 视觉理解 / 画图 / 空间分享

## 校验命令

```bash
node -e "const config=require('./config'); console.log(config.AI_MODEL, config.GROUP_SUMMARY_MODEL, config.LOW_RESOURCE_MODE)"
```

该命令只验证配置模块可加载，不会输出密钥。
