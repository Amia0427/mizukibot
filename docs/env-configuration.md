# Env Configuration

更新时间：2026-05-31 19:43 +08:00

## 维护约定

- `.env` 不提交到仓库，真实密钥只留本地。
- 中文注释放在变量上一行，不使用行尾注释；当前 fallback 解析器只跳过整行 `#`，不会剥离 `KEY=value # 注释`。
- 同功能变量放在同一分区，新增变量优先追加到对应分区，避免混入无关配置。
- 目前 `.env` 有 313 个变量，311 个唯一变量；重复项仅保留 `MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE` 和 `MEMORY_EMBEDDING_BACKFILL_MAX_PER_RUN` 两组历史调优项。
- 当前 fallback 解析器遇到同名变量会保留首个非空环境值；重复项已在本地 `.env` 注释中标明实际生效顺序。
- 2026-05-31 19:43 +08:00：主回复和管理员主模型输出上限提高到 8192，`AI_MAX_TOKENS=8192`、`ADMIN_AI_MAX_TOKENS=8192`；为中等推理留出更充足输出预算，缓存和采样参数不变。
- 2026-05-31 18:28 +08:00：主回复和管理员主模型开启中等推理，`AI_REASONING_EFFORT=medium`、`ADMIN_AI_REASONING_EFFORT=medium`；采样参数和缓存配置保持不变。
- 2026-05-31 18:12 +08:00：主回复和管理员主模型进入自然灵动采样档，`AI_TEMPERATURE=1.05`、`AI_TOP_A=0.72`、`AI_REPETITION_PENALTY=1.08`、`ADMIN_AI_TEMPERATURE=1.05`；缓存配置不变，`AI_REASONING_EFFORT=off` 继续避免高推理闲聊。
- 2026-05-31 18:05 +08:00：新增记忆召回污染防护配置：`MEMORY_RECALL_FORCE_LOCAL_RAG=true`、`MEMORY_JOURNAL_UNSAFE_REPLY_FILTER=true`、`MEMORY_PROFILE_IDENTITY_NOISE_FILTER=true`、`MEMORY_PROFILE_CURRENT_USER_ANCHOR=true`；可用 `node scripts/audit-memory-pollution.js --user <id>` dry-run 审计，`--apply` 只写 quarantine 标记不删除原文。
- 2026-05-31 15:13 +08:00：主回复请求体保留缓存配置不变，仅收敛非缓存参数：`AI_REASONING_EFFORT=off`、`AI_MAX_TOKENS=3500`，并清空 `AI_TOP_A` / `AI_REPETITION_PENALTY`，避免主回复上游按高推理/扩展采样任务处理闲聊。
- 2026-05-31 07:03 +08:00：普通用户快速回复默认关闭；`NORMAL_FAST_REPLY_ENABLED=true` 才启用，留空或 `false` 均禁用并回到完整旧链路。
- 2026-05-30 +08:00：已移除 OpenClaw / Claude CLI / HAPI 外部子 agent 激活链路；`SUBAGENT_*`、`OPENCLAW_*` 和外部桥接专用 `HAPI_*` 不再作为支持配置项记录或读取。
- 2026-05-30 19:40 +08:00：新增普通用户快速回复配置 `NORMAL_FAST_REPLY_ENABLED`、`NORMAL_FAST_REPLY_RECENT_TURNS`、`NORMAL_FAST_REPLY_CONTEXT_MAX_CHARS`、`NORMAL_FAST_REPLY_SUMMARY_MAX_CHARS`、`NORMAL_FAST_REPLY_MAX_TOKENS`；只影响非管理员简单纯文本 direct_chat。
- 2026-05-31 00:47 +08:00：新增 `API_PROVIDER`、`ADMIN_API_PROVIDER`、`AI_FALLBACK_PROVIDER`、`ADMIN_AI_FALLBACK_PROVIDER`；空值按 URL 推断，`/messages` 走 Anthropic，`/chat/completions` 走 OpenAI-compatible。当前 superapi 管理员主模型 `/v1/messages` 已出现 `invalid_grant`、HTTP 429 和非流式配额异常，本地固定为 `ADMIN_API_PROVIDER=openai_compatible` 和 `ADMIN_API_BASE_URL=https://superapi.buzz/v1/chat/completions`。
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
- 内部 Router / Planner / Research 子代理
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
