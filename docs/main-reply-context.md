# Main Reply Context

更新时间：2026-05-25 11:06 +08:00

## 已调整

- `SHORT_TERM_MEMORY_RECENT_MESSAGES` 默认从 160 提高到 240。
- `SHORT_TERM_MEMORY_RECENT_TURNS` 默认从 32 提高到 48。
- `SHORT_TERM_SCENE_RECENT_TURNS` 默认从 16 提高到 24。
- `SESSION_CONTEXT_SUMMARY_MAX_CHARS` 默认从 300 提高到 520。
- `SESSION_CONTEXT_SUMMARY_LOAD_COUNT` 默认从 3 提高到 5。
- `SESSION_CONTEXT_SUMMARY_MAX_ITEMS_PER_SESSION` 默认从 20 提高到 32。
- `SHORT_TERM_BRIDGE_RECENT_MESSAGES` 默认从 64 提高到 96。
- `MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS` 默认从 2200 提高到 3600。
- `MEMORY_V3_SESSION_RECENT_MESSAGES` 默认从 64 提高到 96。
- 2026-05-21 21:38 +08:00：`prepare` 软超时 fallback 会同步补 `retrieved_memory_lite`、`daily_journal`、`short_term_continuity`、planner 已选择的 `memos_recall` 和摘要块；主模型调用日志新增 `prompt_integrity` 摘要。
- 2026-05-21 22:02 +08:00：八个目标已落地：`short_term_continuity` 观测新增 token/raw/summary/trim；普通聊天、长任务、记忆追问、管理员私聊使用不同 context profile；raw turns 会按引用、承诺、未闭环、纠错和信息量保留；session summary 关键字段有独立数量/字符配置；`diag:continuity -- prompt --user <id>` 可输出实际短期块；bridge 过 48h 只恢复结构化摘要；新增主回复失忆 eval；Web 面板新增只读上下文预览。
- 2026-05-23 23:45 +08:00：主回复请求默认使用 Claude `/v1/messages` 协议，稳定 system/tool 前缀使用 Anthropic `cache_control` 断点；主回复不再使用 OpenAI `prompt_cache_key/prompt_cache_retention`。
- 2026-05-24 08:35 +08:00：Anthropic 缓存断点适配官方 automatic prompt caching：可用时追加顶层 `cache_control`，显式断点总量按 `tools -> system -> messages` 保持在 4 个以内；如果兼容网关拒绝顶层 automatic，会先去掉顶层字段并保留稳定 system/tool 断点重试。
- 2026-05-24 17:23 +08:00：Anthropic 图片输入新增 `ANTHROPIC_INLINE_IMAGE_MAX_BASE64_CHARS`，默认 `120000`；cached 图片超过内联预算时不再转 base64，优先发送安全原始 URL，否则注入文本占位，避免图片路由把 base64 字符串计成 10 万级输入 token。
- 2026-05-24 22:22 +08:00：Anthropic 超大 cached 图片优先用 `sharp` 压缩为小 JPEG 内联，最大边长由 `ANTHROPIC_DOWNSAMPLED_IMAGE_MAX_EDGE` 控制，转后仍必须低于 `ANTHROPIC_INLINE_IMAGE_MAX_BASE64_CHARS`；QQ 临时图不再回退裸 URL，避免网关取不到图导致“看不清”。
- 2026-05-24 17:28 +08:00：角色活人感顶部总纲明确当前项目没有线下模式；主回复只按线上私聊、群聊和任务聊天组织口吻，禁止切成线下/小说叙事场景。
- 2026-05-24 17:35 +08:00：瑞希稳定系统提示词继续作为默认人格；主回复新增 `roleplay_runtime_context` critical 动态块，注入当前时间、场景、聊天模式、关系/近期摘要、用户最新消息、可见用户状态和本轮限制，并明确不读心、不替用户行动、普通聊天短消息、纯文本输出。
- 2026-05-24 19:56 +08:00：planner 决策模型切到 `PLAN_MODEL=gpt-5.4-nano`，用于路由后工具/计划决策；`PLANNER_MAX_MODEL_CALLS=1` 和 `PLANNER_REQUEST_TIMEOUT_MS=60000` 保持不变。
- 2026-05-24 20:08 +08:00：planner 决策模型改为 `PLAN_MODEL=gpt-5.4-mini`，同步当前可用的 router 模型配置。
- 2026-05-24 21:10 +08:00：主回复新增用户可见回复防漏闸门，拦截 `I'll search for ...`、`[Context for assistant only]`、`[ContinuityState]` 等内部上下文/工具叙事进入首条复用、工具 followup 和 persist；`web_search_20250305` 改为只在显式联网工具或诊断探针启用。
- 2026-05-24 21:36 +08:00：planner normalization 收尾：companion 模式会把天气类泛用 web 选择纠正为 `getWeather/skill_weather`，MemOS recall 已作为 prompt evidence 注入时不会再额外强制 `memory_cli`。
- 2026-05-24 23:06 +08:00：修复弱指代群聊被旧 `active_topic` 带偏的问题。`[ContinuityState]` 不再因为仅有 `active_topic` 就绕过 planner 强制进主回复；只有 `carry_over_user_turn`、open loop、承诺、用户约束或 continuity probe digest 这类明确未完成信号才会强制注入。planner 明确启用 `continuity_state` 时仍会正常注入。
- 2026-05-25 10:30 +08:00：`prompts/SYSTEM.txt` 作为 `root_system_prompt` 接入主回复稳定系统提示词。文件有内容时会排在 stable system blocks 第一位，并早于 security、persona、route prompt 和动态上下文；空文件保持跳过，不影响现有 persona。
- 2026-05-25 11:06 +08:00：主回复安全提示词已收窄：`SecurityContract` 只管防注入、防系统提示词/密钥/路由/记忆 schema/隐私泄露与防记忆污染；`safetyBoundary/refusal` 只在现实可执行伤害、违法滥用、泄密、攻击链、绕过等细节上收住，并要求避免模板化安全说教。`prompts/SYSTEM.txt` 保持用户已有内容不变。

## Root System Prompt

`prompts/SYSTEM.txt` 是 D:\waifu 最顶级主回复系统提示词入口。manifest 中的 `root_system_prompt` 使用 `priority=-1000`，运行时会导出到 `config.SYSTEM_PROMPT_BLOCKS` 并在主回复 `stableSystemBlocks[0]` 生效。

该文件只负责最高优先级主回复约束；角色人格仍由 `main_persona_system` 承接，动态场景仍由 `roleplay_runtime_context` 等动态块补充。

安全相关稳定块仍保留在 root 之后：`SecurityContract` 负责防泄密和防注入污染，route-level `safetyBoundary` 只限制现实可执行伤害、违法滥用和绕过细节，不负责压制普通黑暗创作、情绪聊天、历史/防御/解释性内容。

## Roleplay Runtime Context

`roleplay_runtime_context` 由主回复 runtime 构建，不替代 `config.SYSTEM_PROMPT`。字段来源：

- 时间：`options.currentTime/current_time/journalNow` 或当前时间，按 `TIMEZONE` 格式化。
- 场景/模式：`routeMeta.directedContext`、`groupId`、`chatType`、`topRouteType` 和 prompt surface。
- 关系/近期：`memoryContext.profile.relation_stage`、`userInfo.level`、`memoryContext.promptSummaryText/summary`、短期连续性摘要。
- 用户状态：只使用 `routeMeta.userVisibleState/userState` 或可见文本提示，不读取括号内心理。
- 本轮限制：默认 `pure_text_reply_only; no_structured_actions`。

该块在 planner catalog 中标记为 `must_use_when_available`，runtime 也会通过 `runtimeAddedIds` 强制保留。诊断可看 `promptSnapshot.dynamicBlockIds`、`selectionTrace` 和 `runtimeAddedBlocks`。

## 诊断

```bash
npm run diag:main-reply-prompt -- --limit 20
npm run diag:main-reply-prompt -- --limit 20 --json
npm run diag:continuity -- prompt --user <id>
npm run diag:continuity -- prompt --user <id> --json
```

查看最近主回复模型请求是否真的包含系统提示词、记忆标记、短期连续性和 MemOS 召回。日志只记录计数和布尔字段，不记录完整 prompt。

误召回排查可对照 `memory-recall-observability.ndjson` 的 `prepare_main_prompt_blocks` 和 `model-calls.ndjson` 的 `prompt_integrity`：如果 planner 未启用 `continuity_state`，但主模型调用仍出现 `[ContinuityState]`，优先查 runtime 注入层。2026-05-24 23:06 +08:00 起，单独旧 `active_topic` 不再触发这条强制路径。

主回复缓存诊断看 `prompt_caching.request_cache_breakpoints/system_cache_breakpoints/tool_cache_breakpoints` 和 usage 中的 `cache_read_input_tokens/cache_creation_input_tokens`；`openai_prompt_cache_key` 对主回复应为空。

`diag:continuity -- prompt` 会输出当前用户主回复实际可见的 `[ShortTermContinuity]`、summary、recent raw turns 和裁剪报告。

内部上下文泄露排查可先搜 `data/bot-runtime.out.log` 的 `I'll search for "[Context for assistant only]`，正常情况下该文本不会再成为 `replyPreview` 或进入 daily journal/post-reply 学习。

## 可实施改进目标

1. 为 `short_term_continuity` 增加 token 使用观测：在 `prepare_main_prompt_blocks` 记录实际注入 token、raw turn 条数、summary 条数和被裁剪原因。
2. 增加按路由/用户等级的上下文档位：普通聊天、长任务、记忆追问、管理员私聊分别使用不同短期窗口和 summary load count。
3. 给近期 raw turns 加重要性排序：保留最近消息的同时优先保留 quote、承诺、未闭环任务、用户纠错和高信息密度消息。
4. 扩展 session summary schema：把 `openLoops`、`assistantCommitments`、`userConstraints`、`recentTurns` 的可见数量和字符上限做成独立配置。
5. 增加上下文回归诊断命令：`npm run diag:continuity -- prompt --user <id>` 输出主回复实际可见的短期块、summary 和裁剪报告。
6. 给重启恢复 bridge 增加新鲜度分层：48 小时内 raw turns 优先，过期 bridge 只保留结构化摘要，避免旧上下文压过当前对话。
7. 建立主回复失忆评测集：覆盖“继续刚才”“你刚说过”“上次那个任务”“引用回复”和跨群/私聊场景。
8. 在 Web 面板暴露只读上下文预览：展示本轮 `short_term_continuity`、Memory V3、daily journal 和 MemOS recall 的命中情况。

## 验收重点

- 主回复 prompt 的 `short_term_continuity` 块包含更长 `[RecentRawTurns]`。
- 重启后 `sessionSummaryMessages` 至少能加载最近 5 条摘要。
- 长对话压缩后保留 240 条近期消息作为尾部窗口。
- `.env` 覆盖旧值时诊断能显示当前生效配置，避免误以为默认值生效。
