# MizukiBot

基于 **Node.js + LangGraph** 的 QQ 机器人运行时。当前主干已经不是“收到消息后直接调一次模型”的简单聊天机器人，而是一套带有 **消息接入、结构化路由、执行规划、工具调度、记忆检索、被动群感知、主动任务、子代理桥接、回复润色与持久化** 的多阶段系统。

当前主链可以概括为：

`NapCat / OneBot WebSocket -> 消息入口协调层 -> canonical route contract -> route execution plan -> LangGraph V2 runtime -> tool/memory/subagent/humanize -> persist/background jobs`

本文以当前仓库代码为准，重点说明：

- 真实入口和运行链路
- 当前仍在生效的核心模块
- 各层职责边界
- 开发、排障和接手时应该先看什么

---

## 1. 先说结论：当前真正生效的主链

### 1.1 运行时只有 V2

当前对外仍保留：

- `api/agentGraph.js`
- `api/agentGraphFacade.js`
- `api/agentGraphV2.js`

但**真正执行逻辑**已经收敛到：

- `api/runtimeV2/host.js`

也就是说：

- `api/agentGraph.js` 是稳定外观层
- `api/agentGraphFacade.js` 负责把旧入口统一转发到 V2
- `api/agentGraphV2.js` 只是一个薄代理
- `api/runtimeV2/host.js` 才是当前 LangGraph V2 主运行时

`LANGGRAPH_RUNTIME_VERSION` 现在只是兼容字段，运行时实际上始终走 V2。

### 1.2 顶层消息处理不是单文件硬写，而是协调多个子模块

当前入口协调器是：

- `core/messageHandler.js`

但它本身已经被拆成多个职责明确的模块，例如：

- `core/messageIngress.js`
- `core/messageRouteFlow.js`
- `core/messageDispatchCoordinator.js`
- `core/messageReplyRuntime.js`
- `core/messageBackgroundTasks.js`
- `core/messageAdminCommands.js`
- `core/messagePassiveFlow.js`
- `core/messageTelemetry.js`

所以理解系统时，不要把 `messageHandler.js` 当成一个“所有逻辑都堆在里面”的老式 handler；它现在更像是总协调层。

---

## 2. 项目整体结构

## 2.1 启动与基础设施

- `index.js`  
  进程入口。负责：配置校验、单实例锁、Web 服务、NapCat WebSocket 连接、重连、tick engine、scheduler、post-reply worker 启动。

- `config.js`  
  加载 `.env` / 环境变量，校验必要配置，确定数据目录、prompt 资产目录、模型参数、记忆开关、调度开关、子代理后端等。

- `web/`  
  本地 Web 服务与管理面能力。

## 2.2 核心消息链

- `core/messageHandler.js`
- `core/messageIngress.js`
- `core/router.js`
- `core/routeSchema.js`
- `core/routeExecution.js`
- `core/messageRouteFlow.js`
- `core/messageDispatchCoordinator.js`

## 2.3 主 Agent 运行时

- `api/runtimeV2/host.js`
- `api/runtimeV2/state.js`
- `api/runtimeV2/nodes/*`
- `api/runtimeV2/planning/service.js`
- `api/runtimeV2/context/service.js`
- `api/runtimeV2/model/service.js`
- `api/runtimeV2/capabilities/scheduler.js`

## 2.4 工具、技能与子代理

- `api/toolRegistry.js`
- `api/toolExecutors.js`
- `api/toolSchemas.js`
- `utils/toolPolicy.js`
- `utils/localToolAccess.js`
- `api/subagentExecutor.js`
- `api/openclawExecutor.js`
- `core/messageFullSubagent.js`

## 2.5 记忆与本地知识

- `utils/memory.js`
- `utils/shortTermMemory.js`
- `utils/shortTermBridgeMemory.js`
- `utils/memoryContext.js`
- `utils/memoryCli.js`
- `utils/localKnowledge.js`
- `api/localNotebook.js`
- `utils/dailyJournal.js`
- `api/memoryExtraction.js`

## 2.6 主动行为与后台任务

- `core/tickEngine.js`
- `core/proactiveGreetingFlow.js`
- `utils/postReplyWorkerRuntime.js`
- `utils/postReplyJobQueue.js`
- `core/schedulerRuntime.js`

---

## 3. 启动链路

当前进程从 `index.js` 启动，核心步骤如下：

1. `config.validateRequiredConfig()` 校验必要环境变量
2. 创建 `.mizukibot.lock`，防止重复启动抢占 OneBot 连接
3. 启动本地 Web 服务
4. 初始化 meme manager
5. 预热工具注册表
6. 连接 `NAPCAT_WS_URL`
7. WebSocket open 后启动：
   - `tickEngine`
   - `schedulerRuntime`
   - 可选内联 `post-reply worker`
8. 收到 OneBot 消息后交给 `createMessageHandler(...).handleIncomingMessage()`

### 3.1 单实例机制

当前已实现：

- 锁文件抢占
- 旧 PID 存活检测
- stale lock 替换
- `SIGINT` / `SIGTERM` 清理
- 退出时连带 shutdown Minecraft agent

### 3.2 NapCat 接入特征

当前通过 WebSocket 接 NapCat / OneBot，支持：

- Bearer token 鉴权
- 断线退避重连
- 统一 `safeSend` / `sendWithRetry`
- NapCat action client 与普通消息分流

---

## 4. 消息入口：先做接入判断，再决定走哪条链

主入口是 `core/messageHandler.js`。

但真正的入站前处理已经拆到 `core/messageIngress.js`，包括：

- `notice` 事件处理
- 非消息事件跳过
- 群聊 / 私聊识别
- bot 自己发出的消息跳过
- 构建统一的 `InboundMessageContext`

### 4.1 当前不仅支持群聊，也支持受限私聊

仓库定位仍然是 QQ 群聊机器人，但当前代码不再是“只处理群消息”。

现状是：

- `message_type=group` 正常走主链
- `message_type=private` 可以进入链路
- 私聊会额外经过白名单 / 特权用户 / 能力限制判断
- 私聊下很多写动作或群专属能力会被拒绝或降级

所以 README 不应该再写成“系统只接受群消息”。更准确的说法是：

> 以群聊为主，私聊为受限接入模式。

### 4.2 消息入口层现在负责什么

当前入口层大致负责：

- 事件去重
- 并发控制
- `@bot` 识别
- 连续消息 / 指向性上下文整理
- reply / quote / 图片上下文补全
- 被动群感知入口
- 正式 route flow 入口
- telemetry / side effects / reply send 收口

---

## 5. 路由系统：先产出 canonical route contract，再由执行层翻译

核心文件：

- `core/router.js`
- `core/routeSchema.js`
- `core/intentAI.js`
- `core/routeExecution.js`

## 5.1 当前顶层 route 只有 4 个

当前 canonical top route type 是：

- `ignore`
- `refuse`
- `admin`
- `direct_chat`

这和旧 README 里把顶层路由写成 `chat / lookup / transform / plan / act / ...` 不同。

现在的做法是：

- 顶层先只区分是否忽略 / 拒绝 / 管理 / 直接对话
- 再通过 `facets + intent + meta` 精细表达“这是 notebook 问答、网页总结、行动指导、图片问答、时间查询、研究规划”等场景
- 最后由 `routeExecution` 翻译成真正执行计划

## 5.2 canonical route contract 长什么样

`core/routeSchema.js` 负责把 route 规范成统一合同，核心字段包括：

- `topRouteType`
- `intent`
  - `risk`
  - `toolNeed`
  - `executionMode`
  - `needsPlanning`
  - `needsMemory`
- `facets`
  - `modality`
  - `sourceScope`
  - `domain`
  - `outputKind`
  - `freshness`
- `chatMode`
- `toolIntent`
- `responseIntent`

这一步的意义是：

- router 只负责“理解请求是什么”
- execution 层才负责“接下来怎么执行”
- profile / policy / planner 不再各自偷偷定义自己的路由真相

## 5.3 路由识别方式

`core/router.js` 当前使用：

- 规则优先
- 必要时 AI router 细化

已经显式覆盖的高优先级场景包括：

- 管理命令
- 明显危险 / 滥用 / 骚扰请求
- 图片问答 / 图片总结
- 时间直答
- notebook / 知识库相关请求
- 搜索 / 总结 / 研究 / 计划 / action guidance 等意图

安全边界相关模式也在 `router.js` 内被硬编码保护，例如：

- 恶意构造物
- 钓鱼 / 木马 / 爆破 / 绕过 / 盗取凭证
- 刷屏 / 骚扰 / flood / spam

AI router 在 `ENABLE_AI_ROUTER=true` 时可以参与 refinement，但不会轻易覆盖这些硬边界。

---

## 6. 执行策略层：route 不是直接拿来调用模型

文件：`core/routeExecution.js`

这层的职责不是继续分类，而是把 canonical route 翻译成**可执行计划**。

## 6.1 当前 executor 集合

当前导出的 executor 集合是：

- `ignore`
- `refuse`
- `admin`
- `direct`
- `background_direct`
- `full_subagent`

这说明当前执行层已经不再用旧式的 `chat / local_tools / subagent_tools / unavailable` 作为最终 executor 枚举。

## 6.2 routeExecution 会产出什么

当前会综合生成：

- `executor`
- `topRouteType`
- `policyKey`
- `routeDebugKey`
- `allowTools`
- `allowedTools`
- `allowedToolBuckets`
- `allowStream`
- `needsBackground`
- `unavailableReason`

也就是说，系统并不是：

> 判断出“像是查资料” -> 直接把所有工具扔给模型

而是：

1. 先定义 route contract
2. 再映射 policy key
3. 再收束 allowed tools
4. 再决定是否允许流式
5. 再决定是否必须 background / subagent / direct

## 6.3 policyKey 比旧顶层分类更重要

虽然顶层 route 只剩 4 个，但 execution 层会继续映射成更具体的策略，例如：

- `chat/default`
- `lookup/notebook-answer`
- `lookup/weather-live`
- `lookup/finance-live`
- `lookup/location-web`
- `transform/notebook-summary`
- `transform/web-summary`
- `transform/vision-summary`
- `plan/general-direct`
- `plan/general`
- `plan/research`
- `act/default`
- `admin/full`

所以“lookup/transform/plan/act”现在更适合被理解成**policy 维度**，而不是顶层 route type。

---

## 7. 正式消息链：由 route flow 和 dispatch coordinator 驱动

## 7.1 route flow

`core/messageRouteFlow.js` 负责正式的请求分流与路由后动作。

它处理的内容包括：

- route 解析
- admin command 分流
- `/full` 管理链
- 背景任务控制
- QQ 空间 / 定时任务相关动作
- direct route prompt 拼装
- 工具路由与 direct chat 路由的不同分支

## 7.2 dispatch coordinator

`core/messageDispatchCoordinator.js` 负责把已经确定的 `routeExecutionPlan` 真正落地：

- 生成 route prompt bundle
- 拼 perception prompt / safety prompt / streaming prompt / QQ rich reply prompt
- direct chat 走 `askAIDispatch(...)`
- 工具型请求走本地工具执行或后台工具任务
- unavailable 场景统一给用户态回复
- 跟踪是否已通过 streaming 发出内容

这层很重要，因为它是“路由结果”到“真实执行行为”的最后一跳。

---

## 8. LangGraph V2：当前真正的主 Agent 运行时

核心文件：

- `api/runtimeV2/host.js`
- `api/runtimeV2/state.js`
- `api/runtimeV2/nodes/*`

## 8.1 图状态切片

`api/runtimeV2/state.js` 定义了当前运行时状态：

- `request`
- `thread`
- `memory`
- `plan`
- `execution`
- `output`
- `messages`
- `events`

这是当前主链的重要特征：

> 它是显式状态机，不是“在一个函数里边调模型边拼变量”。

## 8.2 固定图拓扑

`api/runtimeV2/host.js` 中当前固定图拓扑为：

`prepare -> route -> direct_reply | planner -> dispatch -> validate -> repair_or_continue -> draft_reply -> humanize -> final_validate -> persist`

说明：

- 非工具型 / review / image / proactive / minecraft 请求可直接走 `direct_reply`
- 需要规划时转到 `planner`
- 工具执行后仍要经过 `validate / repair / synthesize / humanize / persist`

## 8.3 各节点职责

### `prepare`

负责：

- checkpoint 恢复
- short-term bridge 恢复 / rehydrate
- 短期历史压缩
- dynamic prompt 构建
- memory scope 记录
- global tool preflight
- continuity state 构建
- allowed tools 与 memory_cli turn 状态初始化

### `route`

负责确定当前运行模式，例如：

- `chat`
- `tool_plan`
- `review`
- `image`
- `proactive`
- `minecraft`

### `direct_reply`

负责无需完整 planner-dispatch 回路的直接生成：

- 普通聊天
- 图片链路
- review 模式
- proactive 模式
- Minecraft 模式

并支持：

- direct stream
- fallback
- direct memory_cli turn

### `planner`

负责把 route 提供的信息转成结构化 plan step：

- 标准化 step id
- kind / tool / inputs
- success criteria
- dependsOn / parallelGroup / sideEffect

### `dispatch`

负责真正执行工具步骤，并记录：

- `toolCalls`
- `toolResults`
- `evidence`
- `runtimeBinding`
- `memoryCliTurn` 演进

同时会特别保护 side-effect step，避免 repair 时重复执行危险动作。

### `validate`

检查计划是否完成、证据是否足够、是否需要 repair。

### `repair_or_continue`

只重开必要步骤，不会粗暴重跑所有内容。

### `draft_reply`

根据 final plan 与 exec logs 组织回复草稿。

### `humanize`

可选调用 humanizer 子代理，去除明显 AI 腔，同时保留事实和执行证据。

### `final_validate`

拦截 provider failure / tool loop / generic failure 等不合格最终输出。

### `persist`

负责：

- 短期记忆写入
- daily journal 写入
- 异步 memory extraction
- 持久化收尾

---

## 9. 规划与执行：当前是结构化 planner，不是随手调工具

文件：

- `api/runtimeV2/planning/service.js`
- `api/runtimeV2/capabilities/scheduler.js`

当前 planner 负责把请求翻成结构化执行图，步骤具备：

- `id`
- `tool`
- `kind`
- `inputs`
- `dependsOn`
- `parallelGroup`
- `sideEffect`
- `evidenceRequirement`
- `repairPolicy`
- `runtimeBinding`

这意味着系统的工具执行不是自由散弹式，而是：

- 有步骤图
- 有证据要求
- 有并行组
- 有修复策略
- 有副作用保护

在 direct chat 场景中，planner single authority 也已经进入主链：当启用后，某些工具型 direct_chat 请求必须先经过 planner 才能安全执行。

---

## 10. Prompt 系统：当前已经是“编译式 prompt 资产链”

核心文件：

- `config.js`
- `utils/promptManifest.js`
- `utils/promptCompiler.js`
- `utils/stagePromptContracts.js`
- `utils/runtimePrompts.js`
- `utils/routePromptPolicy.js`
- `api/runtimeV2/context/service.js`
- `prompts/`

## 10.1 persona prompt 不再是手写大字符串拼接

当前优先从：

- `prompts/prompt-manifest.json`

读取 section 定义，再装配 `prompts/persona/*` 资产。

manifest 支持：

- `stage`
- `priority`
- `budget_tokens`
- `conflict_tags`
- `required_variables`
- `include_in_system_prompt`

## 10.2 promptCompiler 做什么

`utils/promptCompiler.js` 会把 prompt block 进行：

- stage 过滤
- appliesWhen 过滤
- priority 排序
- conflict tag 冲突裁剪
- budget trimming
- snapshot 生成

也就是说，当前 prompt 系统的核心不是“有哪些 txt 文件”，而是：

> 这些 prompt 资产如何在不同 stage 下被编译成最终 system messages。

## 10.3 当前存在明确 stage contract

`utils/stagePromptContracts.js` 明确区分：

- main stage
- review stage
- planner stage
- router stage

这些 stage 不共享同一份人格合同：

- main stage 使用完整 persona
- review / planner / router stage 会故意避免直接继承完整 persona 口吻
- review 阶段更强调证据保真和不新增事实
- planner 阶段更强调任务判断与工具规划

## 10.4 runtime prompt 模板

`utils/runtimePrompts.js` 当前内置 / 装载的模板包括：

- `tool-guidance`
- `bridge-guidance`
- `direct-chat-planner`
- `streaming-segmentation`
- `qq-rich-reply`
- `llm-perception`
- `soft-clarify-chat`
- `review-system`
- `review-route`
- `review-payload`
- `meme-emotion-selector`

README 应把这套机制理解为“运行时可组合 prompt 模板”，而不是只说“系统 prompt 在 prompts 目录里”。

---

## 11. 记忆系统：现在是分层记忆 + 本地知识融合

核心文件：

- `utils/memory.js`
- `utils/shortTermMemory.js`
- `utils/shortTermBridgeMemory.js`
- `utils/memoryContext.js`
- `utils/memoryCli.js`
- `utils/localKnowledge.js`
- `api/localNotebook.js`
- `utils/dailyJournal.js`
- `utils/memory-v3/*`
- `api/memoryExtraction.js`

## 11.1 长期画像

`utils/memory.js` 维护用户层面的长期资料，例如：

- likes / dislikes
- goals
- recent topics
- relation stage
- summary / impression
- facts / favorites / points

## 11.2 短期记忆

`utils/shortTermMemory.js` 负责：

- session key
- scope
- 最近对话窗口
- token budget trimming
- structured compression
- restart rehydrate

## 11.3 短期桥接快照

`utils/shortTermBridgeMemory.js` 提供：

- `pre_reply` / `post_reply` snapshot
- 进程重启后的最近会话桥接恢复

## 11.4 Memory V3

当前 prepare 节点会在合适条件下写入 memory v3 event，并 materialize 视图。它已经不是“可选草稿系统”，而是主链的一部分。

## 11.5 memoryContext 已经融合 local knowledge

`utils/memoryContext.js` 当前不仅查长期记忆，也会调用：

- `queryLocalKnowledge(...)`
- `queryMemory(...)`

也就是说，模型上下文里的“可检索内容”已经不是单一向量记忆，而是融合：

- session projection
- short-term bridge
- session summary
- daily journal continuity / rollup
- memory v3 personal / task / group
- notebook 文档

## 11.6 localKnowledge 是新的本地知识层

`utils/localKnowledge.js` 当前会统一处理本地可读知识源，优先级来源包括：

- `session_projection`
- `short_term_bridge`
- `session_summary`
- `journal_continuity`
- `memory_v3_task`
- `memory_v3_group`
- `memory_v3_personal`
- `notebook_doc`
- `journal_rollup`
- `journal_entry`

这意味着“notebook / journal / session continuity / memory v3”已经开始被当作一个统一的本地知识检索面来处理。

## 11.7 Memory CLI

`utils/memoryCli.js` 是统一检索总线，不只是读 JSON。当前支持：

- `mem search`
- `mem open`
- profile / personal / task / group / journal / recent / style / jargon / notebook 等源
- rerank
- 多样化去重
- budget trim
- local knowledge 融合

---

## 12. Notebook 系统

文件：`api/localNotebook.js`

当前 notebook 不是摆设，已接入：

- `notebook_reindex_folder`
- `notebook_add_document`
- `notebook_list_docs`
- `notebook_search`

已实现机制包括：

- 用户作用域 notebook 根目录
- `index.json` 管理
- 文档 chunking
- content hash 去重
- 增量 reindex
- chunk 级打分检索
- notebook 元数据带 scope 信息

---

## 13. 工具系统

核心文件：

- `api/toolRegistry.js`
- `api/toolExecutors.js`
- `api/toolSchemas.js`
- `utils/toolPolicy.js`
- `utils/localToolAccess.js`

## 13.1 当前工具不是 schema 占位

工具执行器已经接通了真实能力，包括但不限于：

- web / search / weather / location
- notebook 系列
- memory CLI
- 各类 skill 包装器
- structured generation / research / study
- image / media 相关技能
- Minecraft agent 工具

## 13.2 工具权限边界

`utils/toolPolicy.js` 负责做参数正规化和安全边界约束，例如：

- notebook 路径必须留在 notebook root 内
- 某些本地文件读写必须留在安全目录
- image 输出路径受限
- memory_cli / web_search query 长度受限
- 天气 / 地点类参数字符过滤

## 13.3 global tool preflight

在 V2 `prepare` 节点里，当前还会做 capability preflight / global tool preflight，把少量高价值工具证据先注入上下文，而不是什么都等主模型自己临时决定。

---

## 14. 子代理与 full subagent

相关文件：

- `api/subagentExecutor.js`
- `api/openclawExecutor.js`
- `core/messageFullSubagent.js`

当前支持的子代理后端包括：

- `command`
- `openclaw`

已实现机制包括：

- 会话 ID 统一
- question / routePrompt / image / routeMeta 透传
- stdout / stderr 清洗
- JSON 结果提取
- review 整理
- 多 worker 协调
- 失败摘要与 fallback

当 routeExecution 产出 `full_subagent` executor 时，主链会明确走子代理分支，而不是把它伪装成普通 direct chat。

---

## 15. Humanizer

文件：`api/humanizerAgent.js`

humanizer 当前是独立子能力，不是简单字符串替换函数。

它的目标是：

- 去掉明显 AI 腔 / 客服腔 / 模板腔
- 保留原始事实、限制、证据和执行结论
- 支持流式收尾
- 失败时回退本地 humanize 逻辑

在 review 路由、失败回复或某些特殊 policy 下会跳过 humanizer。

---

## 16. 被动群感知与主动机制

## 16.1 被动群感知

相关文件：

- `core/passiveGroupAwareness.js`
- `core/messagePassiveFlow.js`
- `utils/groupAwarenessState.js`

这是一条独立于 `@bot` 正式调用链之外的分支。

核心特征：

- 非 `@bot` 群消息也会进入轻量分析
- 本地 gating 决定是否值得插话
- 命中过快双人对话 / 多人快聊 / cooldown / 低分场景时会压制
- 通过 gating 后再调用 decision model 与 reply model
- 回复偏短、轻、不主导话题

## 16.2 主动机制

相关文件：

- `core/tickEngine.js`
- `core/proactiveGreetingFlow.js`
- `utils/dailyJournal.js`
- `core/schedulerRuntime.js`

当前主动链包含：

- 主动关心 / 主动消息
- 早安 / 晚安问候
- daily journal 汇总触发
- 定时任务调度

---

## 17. 模型调用与 fallback

相关文件：

- `api/graphModelIO.js`
- `utils/mainModelFallback.js`
- `utils/modelProvider.js`
- `utils/modelCompat.js`

当前已实现：

- 主模型配置解析
- provider 兼容层
- main model fallback
- streaming / non-streaming 统一收口
- provider auth / blocked / tool loop / generic failure 分类
- tool schema 不兼容时的降级处理

---

## 18. 数据与运行目录

默认主要数据都在 `DATA_DIR` 下，由 `config.js` 控制。常见内容包括：

- 记忆数据
- short-term / bridge / journal 数据
- notebook 数据
- LangGraph checkpoint / event 数据
- 自我改进 / guide / rules 数据

prompt 资产默认在：

- `prompts/persona/`
- `prompts/runtime/`
- `prompts/prompt-manifest.json`

---

## 19. 常用命令

来自 `package.json` 的主要命令：

### 19.1 基础运行

```bash
npm start
npm run start:post-reply-worker
npm run console
```

### 19.2 测试与检查

```bash
npm test
npm run lint
npm run check:prompts
npm run check:agent
npm run check:agent:static
```

### 19.3 诊断与迁移

```bash
npm run diag:fallback
npm run diag:continuity
npm run memory:v3:migrate
```

### 19.4 Linux 运维

```bash
npm run linux:install
npm run linux:check
npm run linux:start
npm run linux:stop
npm run linux:restart
npm run linux:status
npm run linux:logs
npm run linux:systemd
npm run linux:wireguard:setup
```

### 19.5 Windows 运维

```bash
npm run win:daemon:install
npm run win:daemon:uninstall
npm run win:daemon:status
npm run win:mgmt:setup
```

---

## 20. 测试现状

`scripts/run-tests.js` 当前会：

1. 优先扫描 `tests/` 目录中的 `*.test.js`
2. 如果扫描结果不可用，再回退到内置维护的显式测试列表

这说明当前测试面不是摆设，仓库对以下区域都有明确覆盖：

- routing / route execution
- LangGraph V2 runtime
- planner protocol
- prompt compiler / prompt stage contract / prompt snapshot
- memory / memory v3 / memory CLI / conflict filtering
- local knowledge
- short-term compression / bridge restore / continuity state
- passive awareness
- subagent bridge
- streaming / fallback / reply failure
- background task / scheduler / post-reply worker

---

## 21. 推荐接手阅读顺序

如果第一次接手这个仓库，建议按下面顺序读：

1. `package.json`
2. `index.js`
3. `config.js`
4. `core/messageHandler.js`
5. `core/messageIngress.js`
6. `core/router.js`
7. `core/routeSchema.js`
8. `core/routeExecution.js`
9. `core/messageRouteFlow.js`
10. `core/messageDispatchCoordinator.js`
11. `api/agentGraph.js`
12. `api/agentGraphFacade.js`
13. `api/agentGraphV2.js`
14. `api/runtimeV2/host.js`
15. `api/runtimeV2/state.js`
16. `api/runtimeV2/nodes/prepare.js`
17. `api/runtimeV2/planning/service.js`
18. `api/runtimeV2/context/service.js`
19. `utils/promptManifest.js`
20. `utils/promptCompiler.js`
21. `utils/stagePromptContracts.js`
22. `utils/runtimePrompts.js`
23. `utils/memoryContext.js`
24. `utils/localKnowledge.js`
25. `utils/memoryCli.js`
26. `api/localNotebook.js`

---

## 22. 一句话概括当前系统

当前的 MizukiBot 已经是一个：

> **以 NapCat/OneBot 为接入层、以 canonical route contract + execution plan 为中枢、以 LangGraph V2 为主运行时、融合 prompt 编译链、分层记忆、本地知识、工具调度、被动感知、主动任务与子代理桥接的多阶段 Agent 系统。**

它的核心不是“能聊天”，而是：

- 能把消息先结构化理解
- 再根据策略决定是否用工具、是否规划、是否走后台、是否走子代理
- 再在统一状态图中完成执行、验证、修复、润色与持久化

---

## 23. 备注

仓库里存在较多诊断脚本、兼容外观层和历史保留接口。判断“当前正式主链”时，优先以以下文件为准：

- `index.js`
- `core/messageHandler.js` 及其拆分协作者
- `core/router.js`
- `core/routeSchema.js`
- `core/routeExecution.js`
- `api/agentGraphFacade.js`
- `api/agentGraphV2.js`
- `api/runtimeV2/host.js`
- `api/runtimeV2/state.js`
- `api/runtimeV2/nodes/*`

如果这些文件与旧文档、旧注释、旧备份文件表达不一致，以这些主链文件的当前实现为准。