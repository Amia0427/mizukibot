# MizukiBot

面向 QQ 群聊场景的 Node.js 多阶段 Agent。当前主干不是单一聊天调用，而是完整的运行时系统：

`NapCat/OneBot 群消息入口 -> 规则+AI 混合路由 -> 执行策略解析 -> LangGraph V2 主 Agent -> 工具/记忆/子代理/润色 -> 持久化与主动触发`

本文基于当前仓库代码主干整理，目标是说明已经实现的机制、模块职责、调用链和主要边界。

## 1. 当前架构总览

当前系统由 6 层组成：

1. 接入层  
   `index.js` 负责配置加载、单实例锁、Web 服务、NapCat WebSocket 连接、断线重连、定时任务启动。

2. 消息入口层  
   `core/messageHandler.js` 负责群消息过滤、去重、@bot 判断、被动群感知、正式路由、结果发送。

3. 路由与执行策略层  
   `core/router.js`、`core/routeSchema.js`、`core/routeProfiles.js`、`core/routeExecution.js` 把消息转换成结构化 route 和 executor 计划。

4. 主 Agent 运行时  
   `api/agentGraphV2.js` 是当前唯一实际生效的 LangGraph 运行时，负责 direct reply、tool plan、验证、修复、合成答复、持久化。

5. 工具与辅助 Agent 层  
   包括本地工具、global tools、memory CLI、OpenClaw/命令子代理、humanizer agent、Minecraft agent。

6. 记忆与后台机制层  
   包括长期画像、短期会话桥接、向量检索、daily journal、被动群感知、主动触发调度。

## 2. 关键入口文件

- `index.js`  
  启动入口，创建单实例锁，连接 NapCat，启动 Web 服务、消息处理器、tick engine。

- `config.js`  
  加载 `.env`，校验必需配置，组装 persona prompt 与运行时能力开关。

- `core/messageHandler.js`  
  当前主消息入口，决定消息如何进入被动感知或正式执行链。

- `core/router.js`  
  负责消息意图识别，采用“规则兜底 + AI Router 修正”的混合模式。

- `core/routeExecution.js`  
  负责把 route 转成 executor、allowed tools、plan steps、stream policy。

- `api/agentGraph.js`  
  稳定外观层，实际全部转发到 `api/agentGraphV2.js`。

- `api/agentGraphV2.js`  
  当前主 Agent 运行时实现。

## 3. 启动与运行时机制

### 3.1 单实例

`index.js` 使用 `.mizukibot.lock` 防止同一目录启动多个实例竞争 OneBot 连接。

已实现：

- 进程存活检测
- 过期锁文件替换
- `SIGINT` / `SIGTERM` 时清理锁文件
- 关闭时顺带 shutdown Minecraft agent

### 3.2 NapCat 接入

当前通过 `NAPCAT_WS_URL` 连接 NapCat / OneBot WebSocket。

已实现：

- `Authorization: Bearer <token>` 鉴权
- 连接失败日志
- 关闭后退避重连
- 统一 `safeSend/sendWithRetry`

### 3.3 定时机制

当前有两类定时动作：

- 每分钟检查早安/晚安问候
- 后台 tick engine 做主动消息和日报汇总

## 4. 消息主链

主链入口在 `core/messageHandler.js` 的 `handleIncomingMessage()`。

### 4.1 处理顺序

1. 处理 `notice` 事件，必要时清理失效群绑定
2. 只接受群消息
3. 用 `messageDeduper` 去重
4. 忽略 bot 自己发的消息
5. 判断是否 `@bot`
6. 非 `@bot` 时尝试 `passiveGroupAwareness`
7. `@bot` 时进入正式路由与执行链
8. 统一归一化回复并发送回 QQ

### 4.2 已实现的入口能力

- OneBot 事件去重
- bot 自消息跳过，避免自触发循环
- QQ 富消息占位解析
- 长回复自动分片
- 流式发送节流与分段控制
- 回复失败文本识别与用户态降级

## 5. 被动群感知机制

文件：`core/passiveGroupAwareness.js`

这是一条独立于 `@bot` 的被动感知 agent 分支，不是简单关键词触发。

### 5.1 本地预判

每条非 `@bot` 群消息都会进入本地分析：

- 文本清洗
- 噪音消息过滤
- bot 相关话题识别
- question signal 检测
- bot presence cue 检测
- 最近对话窗口构建
- 快速双人对话/多人快聊识别
- 当前消息 addressee 判断
- reply type 分类

### 5.2 本地 gating

会阻止以下情况插话：

- 快速双人连续互聊
- 多人高速闲聊且没有 bot 话题连续性
- 单人连续刷屏但没有足够 bot signal
- 低分消息
- 群级 cooldown 未到
- 全局 cooldown 未到
- 每小时回复次数超限

### 5.3 两阶段模型调用

通过本地 gating 后，才会调用两阶段模型：

1. decision model  
   只输出 JSON，判断 `should_reply/confidence/reason`

2. reply model  
   生成极短、自然、不主导话题的插话

### 5.4 当前特征

- 明确区分“是否该回”和“回什么”
- reply 文本截断到短句
- 支持群级与全局回复节流
- 会把 bot 自己的插话再写回上下文窗口

## 6. 路由机制

核心文件：

- `core/router.js`
- `core/routeSchema.js`
- `core/routeProfiles.js`
- `core/routeExecution.js`
- `core/intentAI.js`

### 6.1 顶层 route 类型

系统固定使用以下顶层 route：

- `chat`
- `lookup`
- `transform`
- `plan`
- `act`
- `admin`
- `refuse`
- `ignore`

### 6.2 route 结构

每个 route 不只是分类，还会携带结构化意图：

- `intent.risk`
- `intent.toolNeed`
- `intent.executionMode`
- `intent.needsPlanning`
- `intent.needsMemory`

以及 facet：

- `facets.modality`
- `facets.sourceScope`
- `facets.domain`
- `facets.outputKind`
- `facets.freshness`

### 6.3 路由识别方式

当前是“规则兜底 + AI Router 修正”。

规则层已经覆盖：

- 危险/恶意请求 -> `refuse`
- 管理命令 -> `admin`
- 时间直答 -> `lookup + time`
- 自包含计划 -> `plan/general-direct`
- 自包含总结/改写/翻译 -> `transform/self-contained-direct`
- 图片问答/图片总结
- notebook 查询
- finance / weather / location / search / summarize / research / productivity 等场景

AI Router 在 `ENABLE_AI_ROUTER=true` 时可进一步修正 route，但以下强规则不会轻易被覆盖：

- `admin`
- `refuse`
- 图片类强判断
- direct route 的不变式约束

### 6.4 canonical policy

顶层 route 会继续映射到 canonical policy，例如：

- `lookup/notebook-answer`
- `lookup/weather-live`
- `lookup/finance-live`
- `lookup/location-web`
- `lookup/web-answer`
- `transform/notebook-summary`
- `transform/vision-summary`
- `transform/self-contained-direct`
- `transform/web-summary`
- `transform/quiz`
- `plan/general-direct`
- `plan/general`
- `plan/research`
- `act/default`

## 7. 执行策略机制

文件：`core/routeExecution.js`

routeExecution 负责把 route 进一步变成真实执行计划。

### 7.1 产出内容

每次 route 解析后会得到：

- `executor`
- `policyKey`
- `capability`
- `toolExecutionTarget`
- `allowTools`
- `allowedTools`
- `allowGlobalTools`
- `allowedGlobalTools`
- `allowStream`
- `planId`
- `planSteps`

### 7.2 executor 类型

当前 executor 主要有：

- `ignore`
- `refuse`
- `admin`
- `direct`
- `chat`
- `local_tools`
- `subagent_tools`
- `unavailable`

### 7.3 重要判断

系统会区分：

- 是否 direct executor
- 是否 tool route
- 是否优先走本地工具
- 是否优先走子代理工具
- 当本地工具不可用时是否转为 unavailable
- 是否还能只靠 global tools 保底

当前不是“route = tool 就直接让模型乱调工具”，而是先明确允许哪些工具、走哪个执行目标。

## 8. messageHandler 中的正式分发链

### 8.1 `@bot` 后的处理

`@bot` 消息进入正式链后：

1. `detectIntentHybrid()` 生成 route
2. `resolveRouteExecution()` 生成 execution plan
3. 根据 executor 分别处理：
   - `ignore` 直接结束
   - `refuse` 发送拒绝文案
   - `admin` 发送管理命令结果
   - `direct/chat` 走主 Agent
   - `local_tools/subagent_tools` 走工具任务链

### 8.2 工具路由

工具路由会构造：

- routePrompt
- bridge guidance
- sessionChannel
- sessionChatId
- allowedTools
- allowedGlobalTools
- routeMeta.planId / planSteps

然后根据目标执行：

- 本地工具链：`askToolTaskLocally()`
- 子代理桥接：`askToolTaskWithSubagentReview()`

### 8.3 普通聊天路由

普通聊天路由会进入 `askAIByGraph()`，支持：

- stream route prompt
- soft clarify chat
- QQ 富回复 prompt
- direct policy prompt
- global tools

## 9. LangGraph V2 主 Agent

文件：`api/agentGraphV2.js`

当前仓库里真正运行的是 V2。`agentGraph.js` 和 `agentGraphFacade.js` 只是稳定入口外壳。

### 9.1 图状态切片

V2 显式维护以下状态切片：

- `request`
- `thread`
- `memory`
- `plan`
- `execution`
- `output`
- `messages`
- `events`

### 9.2 固定图结构

当前图拓扑固定为：

`prepare -> route -> direct_reply | planner -> dispatch -> validate -> repair_or_continue -> draft_reply -> humanize -> final_validate -> persist`

### 9.3 各节点职责

#### `prepare`

- checkpoint resume
- 恢复短期桥接记忆
- 需要时做短期历史压缩
- 构建 dynamic prompt
- 决定是否暴露 memory_cli
- 注入 global tool evidence
- 记录 memory scope

#### `route`

- 计算当前运行模式
- 模式包括：
  - `chat`
  - `tool_plan`
  - `review`
  - `image`
  - `proactive`
  - `minecraft`

#### `direct_reply`

- chat/image/review/proactive/minecraft 等直接链路生成答案
- 支持主模型 fallback
- 支持 direct streaming
- 支持 direct memory_cli turn

#### `planner`

- 把 route plan step 或 allowed tools 转成执行步骤
- 规范化 step id / kind / tool / inputs / successCriteria

#### `dispatch`

- 真正执行工具步骤
- 记录 toolCalls / toolResults / evidence
- 跟踪 memory_cli turn state
- 区分 side-effect step，避免修复时重复执行危险动作

#### `validate`

- 校验 plan 是否完成
- 判断缺失项和是否需要 repair

#### `repair_or_continue`

- 仅重开失败步骤
- 已完成且带副作用的步骤不会回滚重做

#### `draft_reply`

- 根据最终 plan 与 exec logs 合成答案草稿

#### `humanize`

- 可选走 humanizer 子 agent 去 AI 腔
- 某些 policy 或 review route 会跳过 humanizer

#### `final_validate`

- 检查最终答案是否是 provider/tool loop/generic failure

#### `persist`

- 写短期记忆
- 写 daily journal
- 异步触发 memory extraction

### 9.4 当前运行时特征

- 支持 checkpoint 恢复
- 支持事件流
- 支持 plan round 验证与 repair
- 输出链固定为 `draft -> humanize -> validate -> persist`
- streaming 与 non-streaming 最终都收敛到统一 final reply

## 10. 模型调用与 fallback

文件：

- `api/graphModelIO.js`
- `utils/mainModelFallback.js`
- `utils/modelProvider.js`
- `utils/modelCompat.js`

已实现：

- 主模型配置解析
- main model failure tracking
- fallback 主模型自动切换
- tool schema 校验错误时自动降级为无 tool schema 请求
- streaming partial text 回收
- provider auth/block/tool loop/generic failure 分类

## 11. Dynamic Prompt 机制

文件：

- `api/graphPrompting.js`
- `utils/runtimePrompts.js`
- `utils/routePromptPolicy.js`
- `prompts/`

当前 prompt 不是单文件拼死写，而是模块化资产：

- persona prompt 由 `prompt-manifest.json` + persona section 组装
- runtime prompt 会按 route/policy 注入
- 支持：
  - `bridge-guidance`
  - `direct-time`
  - `direct-plan`
  - `direct-transform`
  - `soft-clarify-chat`
  - `review-system`
  - `review-route`
  - `streaming-segmentation`
  - `qq-rich-reply`

## 12. 工具系统

核心文件：

- `api/toolSchemas.js`
- `api/toolExecutors.js`
- `api/toolRegistry.js`
- `utils/toolPolicy.js`
- `utils/localToolAccess.js`

### 12.1 当前工具分层

当前工具可以分成 4 类：

1. 基础本地工具  
   如 `web_search`、`get_current_time`、`getWeather`、`search_nearby_places`

2. notebook / memory 工具  
   如 `notebook_search`、`notebook_list_docs`、`notebook_add_document`、`memory_cli`

3. skills/脚本工具  
   如 summarize、weather、youtube transcript、stock analysis、research/study/ppt 等 skill 包装器

4. 特殊 agent 工具  
   如 Minecraft agent 相关工具

### 12.2 工具执行器

`api/toolExecutors.js` 已经接通大量 executor，而不是空 schema：

- Web/search/weather/location
- notebook 系列
- memory_cli
- summarize / weather / youtube / stock / ontology / image generate 等 skill
- assistant / research / study 系列结构化生成工具
- Minecraft connect/status/move/follow/chat 等工具

### 12.3 工具权限收束

`utils/toolPolicy.js` 已实现参数正规化和边界保护：

- notebook user scope 不能越权到别的用户
- notebook 路径必须留在 notebook root 内
- summarize 本地文件必须留在 `DATA_DIR`
- image 输出路径必须落在安全目录
- memory_cli 命令长度受限
- web_search query 长度受限
- weather/location 字段过滤危险字符

## 13. Global Tool Runtime

文件：`api/globalToolRuntime.js`

这不是普通的工具调用，而是一个独立的“全局工具规划器”。

### 13.1 当前 global tools

当前只允许以下全局工具：

- `memory_cli`
- `web_search`
- `get_current_time`
- `skill_weather`

### 13.2 工作方式

global tool runtime 会：

1. 根据当前 route 和 allowlist 构建 planner prompt
2. 让模型先判断需不需要调用 global tools
3. 执行少量受限工具调用
4. 把结果整理成 evidence
5. 再注入主 reply 链

### 13.3 当前特点

- 只在允许的 route 中开放
- `memory_cli` 有 follow-up open 模式
- 每回合工具调用数受限
- evidence 会截断、格式化

## 14. 记忆系统

核心文件：

- `utils/memory.js`
- `utils/shortTermMemory.js`
- `utils/shortTermBridgeMemory.js`
- `utils/memoryContext.js`
- `utils/vectorMemory.js`
- `utils/taskMemory.js`
- `utils/groupMemory.js`
- `utils/dailyJournal.js`
- `api/memoryExtraction.js`
- `utils/memoryCli.js`

当前记忆不是单一日志，而是分层系统。

### 14.1 长期结构化画像

`utils/memory.js` 维护：

- favorites / points / group binding
- likes / dislikes / goals / recent_topics
- relation_stage
- summary
- impression
- facts

### 14.2 短期记忆

`utils/shortTermMemory.js` 已实现：

- session key 与 scope
- 最近对话保留
- token budget 裁剪
- 结构化压缩
- 重启后 recall / rehydrate

### 14.3 桥接快照

`utils/shortTermBridgeMemory.js` 已实现：

- pre_reply / post_reply snapshot
- 重启恢复最近会话上下文

### 14.4 检索记忆

`utils/memoryContext.js` 会把以下内容整理进 prompt：

- 用户画像
- impression / summary
- 向量召回记忆
- daily journal retrieval bundle

### 14.5 统一 Memory CLI

`utils/memoryCli.js` 已实现：

- `mem search`
- `mem open`
- profile / recent session / personal memory / task memory / group memory / journal raw window 的统一搜索与打开
- query facet 分类
- rerank
- 去重与多样化
- budget trimming

这部分已经是“统一记忆检索总线”，不是简单读 JSON。

### 14.6 自动学习

`api/memoryExtraction.js` 已实现：

- 从对话抽取 profile / summary / impression / fact
- 根据置信度决定 tier
- 写入向量记忆
- 写入 task memory
- 写入 group memory

该学习过程在主回复完成后异步触发。

## 15. Notebook 系统

文件：`api/localNotebook.js`

当前 notebook 已接通：

- `notebook_reindex_folder`
- `notebook_add_document`
- `notebook_list_docs`
- `notebook_search`

机制：

- 每个用户一个 notebook scope
- 自动维护 `index.json`
- 文档 chunking
- content hash 去重
- 增量 reindex
- chunk 级检索打分

## 16. Humanizer 子 Agent

文件：`api/humanizerAgent.js`

humanizer 不是简单字符串替换器，而是独立子 agent。

当前实现：

- 保留原文风格和语气方向
- 只去掉明显 AI 腔、客服腔、模板腔
- 支持 streaming
- 过度压缩检测
- 子 agent 失败时回退本地 `humanizeReply`

默认在以下情况会跳过 humanizer：

- review route
- 已判定 failure reply
- 某些 direct/tool policy
- humanizer 开关关闭

## 17. 子代理桥接

文件：

- `api/subagentExecutor.js`
- `api/openclawExecutor.js`

### 17.1 支持的后端

- `command`
- `openclaw`

### 17.2 已实现机制

- 并发槽限制
- 稳定 sessionId
- question/customPrompt/routePrompt/image 信息统一转发
- stdout/stderr 清洗
- 结果解析
- 失败摘要
- review model 对子代理输出二次整理

### 17.3 当前行为

- 白名单用户的工具型请求可优先走 subagent
- subagent 失败不会静默吞掉，会回到明确错误或回退文案

## 18. OpenClaw 适配

文件：`api/openclawExecutor.js`

当前适配层已实现：

- OpenClaw CLI 参数组装
- `--session-id`
- `--message`
- `--json` 输出兼容
- 从 stdout 中提取最后一个 JSON block
- 从 payload/result/reply/text 等多个路径读最终结果

## 19. Minecraft Agent

文件：`api/minecraftAgent.js`

当前 Minecraft 链路不是占位实现，已经接入：

- mineflayer
- mineflayer-pathfinder
- vec3

已实现工具：

- `minecraft_connect`
- `minecraft_disconnect`
- `minecraft_status`
- `minecraft_chat`
- `minecraft_move_to`
- `minecraft_follow_player`
- `minecraft_look_at`
- `minecraft_stop`

并且有：

- 连接参数校验
- spawn 等待
- pathfinding timeout / goal reached / reset 处理
- runtime follow state

## 20. 主动机制

文件：`core/tickEngine.js`

当前主动机制包含：

### 20.1 主动关心消息

触发条件包括：

- `PROACTIVE_REPLY_ENABLED=true`
- 用户有新鲜群绑定
- 好感度 points 达到阈值
- 用户空闲达到时长
- 每天触发次数不超过上限
- 仅在白天/晚间时段运行

### 20.2 定时问候

在 `index.js` 中每分钟检查：

- 08:30 早安
- 22:30 晚安

### 20.3 Daily journal 汇总

tick engine 还会定期检查 daily summary 是否该运行。

## 21. Prompt 资产

目录：`prompts/`

当前 prompt 资产分成两类：

- `persona/`
- `runtime/`

`config.js` 会优先读取 `prompt-manifest.json`，再按 section 装配系统 prompt，而不是硬编码一整段字符串。

## 22. 测试覆盖反映出的成熟机制

`tests/` 覆盖很广，说明以下机制不是“概念存在”，而是当前主干重点维护对象：

- route schema / route profile / hybrid router
- LangGraph V2 runtime
- global tool runtime
- memory CLI
- short-term compression / restart recall / bridge memory
- daily journal retrieval / rollup
- passive awareness
- humanizer agent
- main model fallback
- subagent bridge
- streaming 次序与 suppress
- reply failure 分类
- tool reply formatting

## 23. 关键模块关系图

### 23.1 正式 `@bot` 消息

`NapCat -> messageHandler -> router -> routeExecution -> agentGraphV2 / tool route / subagent route -> normalize reply -> send_group_msg`

### 23.2 非 `@bot` 消息

`NapCat -> messageHandler -> passiveGroupAwareness -> decision model -> reply model -> send_group_msg`

### 23.3 工具型请求

`router -> routeExecution -> local_tools 或 subagent_tools -> review/clean format -> QQ reply`

### 23.4 计划型请求

`routeExecution(planSteps) -> agentGraphV2 planner -> dispatch -> validate -> repair -> synthesize -> humanize -> persist`

## 24. 当前系统的一句话概括

当前 MizukiBot 已实现成一个“带结构化路由、规划执行、统一记忆、被动群感知、主动调度、工具规划器、子代理桥接和风格保护润色”的多阶段 agent 运行时，而不是普通聊天机器人。

## 25. 接手阅读顺序

如果要快速接手，建议按这个顺序读代码：

1. `index.js`
2. `core/messageHandler.js`
3. `core/router.js`
4. `core/routeExecution.js`
5. `core/routeProfiles.js`
6. `api/agentGraphV2.js`
7. `api/graphPrompting.js`
8. `api/graphModelIO.js`
9. `api/globalToolRuntime.js`
10. `utils/memory.js`
11. `utils/shortTermMemory.js`
12. `utils/memoryCli.js`
13. `core/passiveGroupAwareness.js`
14. `api/subagentExecutor.js`
15. `api/humanizerAgent.js`

## 26. 备注

当前仓库里仍有较多历史备份文件、诊断脚本和临时验证脚本。判断“当前正式主链”时，优先以本文列出的入口和运行时文件为准，不要把 `.bak`、`codex_verify_*`、`tmp_*` 文件误当成主实现。
