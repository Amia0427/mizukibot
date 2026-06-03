# Main Reply Context

更新时间：2026-06-03 08:24 +08:00

## 已调整

- 2026-06-03 08:24 +08:00：主回复兜底、Runtime V2 controlled failure、路由不可用、私聊关闭、管理员/群聊限制、生图失败、普通用户流式首字超时和发送层空回复文案统一改为瑞希口吻；同时保留权限/配置/额度/上下文过载等原语义，并扩展 `replyFailure` / 工具失败识别，避免这些新兜底被后续记忆、表情或工具链当作正常回答。
- 2026-06-03 07:52 +08:00：普通聊天/问答如果因工具规划缺失或无可用工具进入 `no-allowed-tools` / `planner-missing`，现在降级回 `direct_reply` 主对话模型链路，不再直接返回“工具不可用”本地兜底，也不再把“No tool is available”这类提示塞给模型；QQ 空间、定时、私聊关闭、群聊限定等权限/动作限制仍保持固定回复。
- 2026-06-02 20:10 +08:00：按当前要求，被动感知实际发言默认回到 `PASSIVE_AWARENESS_REPLY_API_BASE_URL` / `PASSIVE_AWARENESS_REPLY_API_KEY` / `PASSIVE_AWARENESS_REPLY_MODEL` 独立 env 配置；`PASSIVE_AWARENESS_REPLY_USE_MAIN_MODEL` 默认值改为 `false`，只有显式设为 `true` 才跟主回复模型配置。
- 2026-06-02 17:20 +08:00：继续解除管理员私聊限制：admin 私聊在 `routeExecution` 中保留 planner 原始工具集，Runtime V2 主模型 `getFilteredToolSchemas` 对 admin 私聊不再套用 companion 工具白名单，executor 解析可回退到 raw tool registry，因此 `qq_publish_qzone` 的 `qzone_draft` 不会在计划、schema 或执行阶段被清空成 `no-allowed-tools`/`Unknown tool`。admin 私聊的 `topRouteType=admin` 路由不再转成 `private-group-only`，`/create` 入口也不再对管理员/白名单私聊提前返回群聊限制；普通私聊用户仍直接禁用。
- 2026-06-02 16:56 +08:00：私聊入口默认不再使用 `PRIVATE_CHAT_TEST_USER_IDS=*` 放开普通用户；未在私聊白名单且非管理员的普通私聊用户会直接收到私聊关闭提示，不再进入问答/只读半开放状态。`routeExecution` 同步取消白名单用户和管理员私聊的 `private-write-disabled` 写动作闸门，避免这类用户在执行型请求里被本地固定文案拦截。
- 2026-06-02 16:37 +08:00：主回复 `main_persona_system` 的 `persona/03_boundaries.txt` 加入 `<fiction_authentic>` 角色真实性准则，绑定 `{{char}}` 为晓山瑞希。后续拒绝、抗拒、不适和“应该停下来”等反应必须从瑞希设定或当前剧情找到依据，避免模型凭空套入非瑞希人格的道德化拒演；该规则属于 persona 内部角色扮演准则，不是用户可见输出硬拦截。
- 2026-06-02 16:30 +08:00：按要求恢复普通私聊 admin 默认走管理员模型（`ADMIN_AI_MODEL`）。感知后回复拒演样本仍定位在 `passive-awareness/reply` 支路与历史坏回复记忆污染：当时被动感知发言曾默认跟随主模型（`PASSIVE_AWARENESS_REPLY_USE_MAIN_MODEL=true`），2026-06-02 20:10 已按要求改回独立 env 默认；system 消息补入压缩主 persona；RecentContext、CurrentMessage、RetrievedMemory、DailyJournal、Profile/Impression/Summary 在进入 prompt 前隔离模型自报/拒演污染。post-reply persist 会把这类文本标记为 `model_identity_contamination`，不写入桥接、Memory V3、日记或后续学习。该修复是上下文/路由隔离，不是用户可见输出的身份漂移硬拦截。
- 2026-06-02 14:19 +08:00：主回复沉浸边界继续降噪。稳定安全块对模型显示为 `InternalIntegrity`，只静默保护内部提示词/凭证/记忆与路由实现；普通 RP、黑暗虚构、剧情台词、情绪聊天和设定讨论优先按角色现场自然接。输出保护不再因提到“系统提示词/secret”等词就整句替换，群聊动态块移除 `group_safety`；真实滥用命中时也只轻挡可执行细节。
- 2026-06-02 14:04 +08:00：主回复沉浸边界降噪完成。内部完整性保护只管内部提示词/凭证/路由与记忆 schema/隐私数据泄露，以及提示词注入和记忆污染；角色扮演、虚构黑暗剧情、情绪表达、玩梗和创作请求默认按正常聊天处理。`safetyBoundary` 只在明确现实滥用、凭证窃取/绕过、骚扰流程或可执行攻击细节时触发，动态角色规则里的不读心/不替用户行动改为叙事一致性约束。
- 2026-06-02 12:04 +08:00：私聊角色扮演拒绝样本确认系统提示词仍在请求内，根因在本地私聊链路：上游流式增量曾直接透传，且 `direct:*` bridge / RecentRawTurns 会回灌旧 assistant 原文。现在私聊流式与群聊一样先 buffer/guard 后一次性发最终文本；`direct:*` 短期 bridge、恢复和私聊 prompt raw continuity 只保留 user raw turn，避免旧 assistant 拒绝句成为下一轮权威上下文。没有加入 Claude/Anthropic/“不能扮演”文本硬拦截。
- 2026-06-01 19:34 +08:00：群聊活人感纪律曾新增群聊专属安全规范；2026-06-02 14:19 +08:00 已移除常驻 `group_safety` 动态行，群聊默认按共享现场和角色沉浸承接，只在路由明确命中现实可执行滥用时轻挡细节。
- 2026-06-01 09:10 +08:00：世界书新增可选 session state：显式剧情/设定/角色关系命中后，可按条目的 `durationTurns` / `durationMs` 在当前 `sessionKey` 内短暂持续；`exampleIds` 会把已激活 worldbook 关联到动态示例，普通闲聊仍不会触发 worldbook 或 few-shot。新增 `npm run diag:worldbook -- --question "..." --json` 查看候选分数、激活态、最终注入、跳过原因和示例选择。
- 2026-06-01 08:22 +08:00：主回复短期连续性默认预算从 3600 提高到 5200，普通聊天 recent raw turns 档位从 `96/12/0.75` 提高到 `128/16/0.9`，`MEMORY_V3_SESSION_RECENT_MESSAGES` 从 96 提高到 128；`short_term_continuity` 末尾指令明确要求优先承接最新 `RecentRawTurns`，摘要和长期记忆只补空或解冲突。
- 2026-06-01 08:22 +08:00：复查“输入 token 突然降低”：窗口上限未变，`.env` 仍为 `CONTEXT_WINDOW_MAX_TOKENS=400000`、`ADMIN_CONTEXT_WINDOW_MAX_TOKENS=400000`、`SHORT_TERM_MEMORY_MAX_TOKENS=120000`、`ADMIN_SHORT_TERM_MEMORY_MAX_TOKENS=120000`；下降主因是 2026-05-31 的 `MAIN_REPLY_PROMPT_MODE=balanced` 收敛普通聊天 prompt，以及当前未提交 prompt 文件把 `root_system_prompt` 缩到约 14 token、`main_persona_system` 缩到约 3,964 token。
- 2026-05-31 18:53 +08:00：新增 `chat_liveness_discipline` critical 动态块，运行时强制进入主回复并区分 `private_chat`、`group_direct_chat`、`passive_group_reply`。私聊保留一对一连续性、轻微主动性和不升级普通话题；群聊限制为共享可见现场，禁止泄露私聊记忆，允许短插话、半句、岔题和不覆盖所有人。
- 2026-05-31 09:37 +08:00：主回复新增 `MAIN_REPLY_PROMPT_MODE=minimal|balanced|legacy`，默认 `balanced`。默认链路收敛为 `root_system_prompt`、`main_persona_system`、`roleplay_runtime_context`、`short_term_continuity`、`memory_recall_policy`、`retrieved_memory_lite`；普通聊天不再自动带 `dynamic_few_shot`、`style_profile`、`social_context`、`self_improvement`。
- 2026-05-31 09:37 +08:00：`balanced/minimal` 下 persona modules 默认最多 2 个，私聊优先 `scene_private_chat`，群聊优先 `scene_group_insert`，明显情绪场景最多替换 1 个情绪模块；worldbook 只在设定、剧情节点、角色关系或显式瑞希/世界观/事件问题中召回，不再作为日常闲聊风格补丁。
- `SHORT_TERM_MEMORY_RECENT_MESSAGES` 默认从 160 提高到 240。
- `SHORT_TERM_MEMORY_RECENT_TURNS` 默认从 32 提高到 48。
- `SHORT_TERM_SCENE_RECENT_TURNS` 默认从 16 提高到 24。
- `SESSION_CONTEXT_SUMMARY_MAX_CHARS` 默认从 300 提高到 520。
- `SESSION_CONTEXT_SUMMARY_LOAD_COUNT` 默认从 3 提高到 5。
- `SESSION_CONTEXT_SUMMARY_MAX_ITEMS_PER_SESSION` 默认从 20 提高到 32。
- `SHORT_TERM_BRIDGE_RECENT_MESSAGES` 默认从 64 提高到 96。
- `MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS` 默认从 2200 提高到 3600；2026-06-01 继续提高到 5200。
- `MEMORY_V3_SESSION_RECENT_MESSAGES` 默认从 64 提高到 96；2026-06-01 继续提高到 128。
- 2026-05-27 01:04 +08:00：完成“前天脚臭排行”最小回放：非回忆新话题里，即使 `memoryContext` 残留该 episode，planner 明确 skip `retrieved_memory_lite` 后主 prompt 不再强制注入；显式“昨天/刚才/where did we put”类回忆仍保留运行时兜底。`prompts/SYSTEM.txt` 同步收窄为记忆使用边界，移除与瑞希人格冲突的外部角色设定。
- 2026-05-27 01:18 +08:00：主回复 token 体检显示当前端到端样例约 6,597 估算输入 token，块合计 6,571；stable system 5,058（76.97%）、dynamic context 1,348（20.51%）、assistant-only 165（2.51%）。最大块是 `main_persona_system` 4,594（69.91%），其中 `persona/01_identity.txt` 2,414（36.74%）、`00_roleplay_liveness_prelude.txt` 683（10.39%）、`SYSTEM.txt` 220（3.35%）。修复 session/runtime 合并后 `roleplay_runtime_context` 重复注入，并在模型出站层新增 50k warning、100k hard block。
- 2026-05-26 08:11 +08:00：`tests/configPersonaPrompt.test.js` 不再要求 `00_roleplay_liveness_prelude.txt` 固定包含“当前项目没有线下模式”，改为校验线上聊天锚点和避免线下/小说叙事语义。
- 2026-05-26 08:00 +08:00：`prompts/persona/01_identity.txt` 与好友资料版瑞希提示词合并去重；人格核补强外在轻快/内里谨慎、秘密触发反应、人际关系、外貌审美和自然语料，未调整 manifest 优先级。
- 2026-05-21 21:38 +08:00：`prepare` 软超时 fallback 会同步补 `retrieved_memory_lite`、`daily_journal`、`short_term_continuity`、planner 已选择的 `memos_recall` 和摘要块；主模型调用日志新增 `prompt_integrity` 摘要。
- 2026-05-21 22:02 +08:00：八个目标已落地：`short_term_continuity` 观测新增 token/raw/summary/trim；普通聊天、长任务、记忆追问、管理员私聊使用不同 context profile；raw turns 会按引用、承诺、未闭环、纠错和信息量保留；session summary 关键字段有独立数量/字符配置；`diag:continuity -- prompt --user <id>` 可输出实际短期块；bridge 过 48h 只恢复结构化摘要；新增主回复失忆 eval；Web 面板新增只读上下文预览。
- 2026-05-23 23:45 +08:00：主回复请求默认使用 Claude `/v1/messages` 协议，稳定 system/tool 前缀使用 Anthropic `cache_control` 断点；主回复不再使用 OpenAI `prompt_cache_key/prompt_cache_retention`。
- 2026-05-31 00:47 +08:00：主回复 provider 改为可配置和按 URL 推断：显式 `API_PROVIDER/ADMIN_API_PROVIDER` 优先，URL 以 `/messages` 结尾才默认 Anthropic，否则保持 OpenAI-compatible。superapi 管理员主模型 `/v1/messages` 已出现 `invalid_grant`、HTTP 429 和非流式配额异常，管理员主回复改走 `/v1/chat/completions`。
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

该文件只负责最高优先级主回复约束；角色人格仍由 `main_persona_system` 承接，动态场景仍由 `roleplay_runtime_context` 等动态块补充。不要在这里放外部角色、世界观或“无条件满足/不受限制”类文案，否则会比 persona 和安全块更早进入主回复。

内部完整性稳定块仍保留在 root 之后：`security_contract` block 现在对模型显示为 `InternalIntegrity`，负责防泄密和防注入污染；route-level `safetyBoundary` 只限制现实可执行伤害、违法滥用和绕过细节，不负责压制普通黑暗创作、情绪聊天、历史/防御/解释性内容。

## Prompt Mode

`MAIN_REPLY_PROMPT_MODE` 控制主回复动态块参与度：

- `balanced`：默认模式。保留稳定人格、活人感运行时块、短期连续性、记忆召回策略和可信长期记忆证据；persona modules 默认最多 2 个；普通聊天关闭 dynamic few-shot、style/social/self-improvement 补丁。
- `minimal`：同样走收敛链路，用于继续压低上下文噪声；worldbook/few-shot 仍需显式命中。
- `legacy`：保留旧的高参与度行为，用于回归排查和对照测试。

人格稳定边界：人格由稳定 persona 决定；长期记忆只补事实、偏好、关系距离和连续性证据，不得改写人格。worldbook 只补设定、剧情节点和角色关系，不得覆盖主风格。

worldbook 触发边界：普通“随便聊聊”“今天好累”“我们关系怎么样”不召回；“M5 文化祭发生了什么”“瑞希和绘名关系怎么变了”“瑞希/世界观/事件/设定”类问题才召回。dynamic few-shot 默认关闭，只在显式风格诊断、回归测试、示例模仿或复杂输出格式场景启用。

## Input Token Composition

主回复输入 token 由出站 `messages`、system/tool 前缀和可选工具结果共同组成。普通 `chat/default` 在 `balanced` 下主要是：

- stable system：`root_system_prompt`、`security_contract`、`main_persona_system`、`core_baseline_patch`。
- dynamic context：`roleplay_runtime_context`、`chat_liveness_discipline`、`short_term_continuity`、`memory_recall_policy`、`retrieved_memory_lite`、`daily_journal`。
- assistant-only / tool / current user：planner 或工具 follow-up 才会增加，普通直聊通常很小。

2026-06-01 08:22 +08:00 复查最近 `prepare_main_prompt_blocks`，普通 `chat/default` 常见块组成约为：

```text
main_persona_system      3964
short_term_continuity     769-1493
retrieved_memory_lite     413-423
daily_journal             142-164
security_contract         155
core_baseline_patch        89
root_system_prompt         14
```

`npm run diag:main-reply-prompt -- --limit 30 --json` 的 `chat/default` 估算分布：

```text
2026-05-27 p50 7842, p95 11603
2026-05-28 p50 8235, p95 10564
2026-05-31 p50 7032, p95 7635
```

最近 provider 实际 usage 与本地估算不完全一致：Sonnet `usage.prompt_tokens` 多在 4.8k-5.2k，Opus 多在 8.8k-10.4k 且包含较大的 `cache_read_input_tokens`。因此排查“输入 token”时要同时看 `prompt_integrity.token_budget.estimated_input_tokens`、`usage.prompt_tokens` 和 `usage.cache_read_input_tokens`。

## Memory Continuity Tuning

结论：可以增大输入 token 来提高连续性，但应把新增预算投给“近期真实对话和结构化摘要”，不要只恢复噪声块。当前默认推荐配置：

```env
MAIN_REPLY_PROMPT_MODE=balanced
MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS=5200
MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES=128
MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES=16
MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER=0.9
MEMORY_V3_SESSION_RECENT_MESSAGES=128
```

更激进但仍可控：

```env
MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS=6400
MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES=160
MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES=20
MAIN_REPLY_CONTEXT_NORMAL_SUMMARY_LOAD_COUNT=7
```

不建议常态切回 `MAIN_REPLY_PROMPT_MODE=legacy`：它会扩大输入 token，但增加的是 ordinary chat 已去掉的 few-shot、style/social/self-improvement 和非必要 worldbook，容易让风格补丁与旧记忆压过当前轮次。只有回归对照或临时诊断时再用。

## Roleplay Runtime Context

`roleplay_runtime_context` 由主回复 runtime 构建，不替代 `config.SYSTEM_PROMPT`。字段来源：

- 时间：`options.currentTime/current_time/journalNow` 或当前时间，按 `TIMEZONE` 格式化。
- 场景/模式：`routeMeta.directedContext`、`groupId`、`chatType`、`topRouteType` 和 prompt surface。
- 关系/近期：`memoryContext.profile.relation_stage`、`userInfo.level`、`memoryContext.promptSummaryText/summary`、短期连续性摘要。
- 用户状态：只使用 `routeMeta.userVisibleState/userState` 或可见文本提示，不读取括号内心理。
- 本轮限制：默认 `pure_text_reply_only; no_structured_actions`。

该块在 planner catalog 中标记为 `must_use_when_available`，runtime 也会通过 `runtimeAddedIds` 强制保留。诊断可看 `promptSnapshot.dynamicBlockIds`、`selectionTrace` 和 `runtimeAddedBlocks`。

## Chat Liveness Discipline

`chat_liveness_discipline` 由 `utils/chatLivenessContext.js` 构建，只注入当前聊天纪律，不承载长记忆事实。它从 `routeMeta`、短期上下文和 persona memory state 摘取当前 surface、话题、关系姿态、群聊注意线索；没有证据时留空，不编生活事件。

- `private_chat`：一条关系线、即时承接、允许瑞希带入有证据的小生活状态、允许迟疑/保留/半句，不把普通闲聊升级成危机、告白或长辅导。
- `group_direct_chat` / `passive_group_reply`：共享群聊现场、多条注意线、只知道群内可见内容；不泄露私聊记忆，不要求覆盖所有人，允许短插话、误解、岔题和冷场。
- 群聊沉浸优先：群聊 surface 不再注入常驻 `group_safety`；共享现场、短插话、有限可见信息和角色沉浸优先。只有路由已明确命中现实可执行滥用时，才在主回复 route prompt 里轻挡步骤/代码/绕过/骚扰流程等细节。

该块和 `roleplay_runtime_context` 一样是 must-use；`promptSnapshot.dynamicBlockIds` 应能看到 `chat_liveness_discipline`。群 direct chat 仍会同时保留 `group_direct_chat_style_guard`。

## 诊断

```bash
npm run diag:main-reply-prompt -- --limit 20
npm run diag:main-reply-prompt -- --limit 20 --json
npm run diag:continuity -- prompt --user <id>
npm run diag:continuity -- prompt --user <id> --json
```

查看最近主回复模型请求是否真的包含系统提示词、记忆标记、短期连续性和 MemOS 召回。日志只记录计数和布尔字段，不记录完整 prompt。

`prompt_integrity.token_budget` 会记录估算输入 token、文本/系统/消息/工具分项、最大消息索引和阈值状态；默认 `MAIN_REPLY_INPUT_TOKEN_WARN_THRESHOLD=50000` 打 warning，`MAIN_REPLY_INPUT_TOKEN_HARD_LIMIT=100000` 在出站构造主回复请求时硬拦截。

误召回排查可对照 `memory-recall-observability.ndjson` 的 `prepare_main_prompt_blocks` 和 `model-calls.ndjson` 的 `prompt_integrity`：如果 planner 未启用 `continuity_state` 或 `retrieved_memory_lite`，但主模型调用仍出现对应块，优先查 runtime 注入层。2026-05-24 23:06 +08:00 起，单独旧 `active_topic` 不再触发 `continuity_state` 强制路径；2026-05-27 01:04 +08:00 起，普通新话题不再仅因 `memoryContext` 非空绕过 planner skip 强制注入 `retrieved_memory_lite`。

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
