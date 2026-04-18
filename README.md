# MizukiBot

一个基于 **Node.js + LangGraph** 的 QQ 机器人运行时。

它现在已经不是“收到消息后直接调一次模型”的简单聊天脚本，而是一套完整的多阶段系统：**消息接入 -> 路由理解 -> 执行策略 -> LangGraph V2 运行时 -> 工具/记忆/子代理 -> 回复润色 -> 持久化/后台任务**。

如果你是第一次接手这个仓库，这份 README 不追求把所有细节一次讲完，而是优先回答下面几个问题：

- 现在真正生效的主链是什么
- 我应该先看哪些文件
- 改不同功能时应该去哪里下手
- 排障时先查哪一层

---

## 1. 先建立正确心智模型

### 1.1 当前正式主链

当前主链可以概括为：

`NapCat / OneBot WebSocket -> message handler -> canonical route contract -> route execution plan -> LangGraph V2 runtime -> tool/memory/subagent/humanize -> persist/background jobs`

### 1.2 运行时已经收敛到 V2

仓库里仍保留这些入口：

- `api/agentGraph.js`
- `api/agentGraphFacade.js`
- `api/agentGraphV2.js`

但**真正的运行时主体**已经收敛到：

- `api/runtimeV2/host.js`

可以把它们理解成：

- `api/agentGraph.js`：稳定外观层
- `api/agentGraphFacade.js`：兼容入口，统一转发到 V2
- `api/agentGraphV2.js`：薄代理
- `api/runtimeV2/host.js`：真实 LangGraph V2 runtime host

`LANGGRAPH_RUNTIME_VERSION` 现在主要是兼容字段，实际主链始终走 V2。

### 1.3 顶层消息处理已经不是单文件大杂烩

当前入口协调器是：

- `core/messageHandler.js`

但它现在更像调度层，实际职责已经拆给多个协作者，例如：

- `core/messageIngress.js`
- `core/messageRouteFlow.js`
- `core/messageDispatchCoordinator.js`
- `core/messageReplyRuntime.js`
- `core/messageBackgroundTasks.js`
- `core/messageAdminCommands.js`
- `core/messagePassiveFlow.js`
- `core/messageTelemetry.js`

所以读代码时，不要把 `messageHandler.js` 当成旧式单体 handler；它现在是入口编排层。

---

## 2. 新人第一天应该先看什么

推荐阅读顺序：

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

如果你只想先快速跑通脑图，最少先看这 8 个：

- `index.js`
- `config.js`
- `core/messageHandler.js`
- `core/router.js`
- `core/routeExecution.js`
- `core/messageDispatchCoordinator.js`
- `api/runtimeV2/host.js`
- `api/runtimeV2/nodes/prepare.js`

---

## 3. 从收到消息到发出回复，主链怎么走

### 3.1 启动层

进程入口是：

- `index.js`

启动时当前会做的事情包括：

1. `config.validateRequiredConfig()` 校验必要环境变量
2. 创建 `.mizukibot.lock`，防止重复进程竞争 OneBot 连接
3. 启动本地 Web 服务
4. 初始化 meme manager
5. 预热工具注册表
6. 建立 NapCat / OneBot WebSocket 连接
7. 在 WebSocket open 后启动：
   - `tickEngine`
   - `schedulerRuntime`
   - 可选内联 `post-reply worker`
8. 把消息交给 `createMessageHandler(...).handleIncomingMessage()`

### 3.2 接入层

消息入口先经过：

- `core/messageHandler.js`
- `core/messageIngress.js`

这里主要负责：

- 跳过非消息事件
- 识别群聊 / 私聊
- 跳过 bot 自己发出的消息
- 构建统一 `InboundMessageContext`
- 处理 reply / quote / 图片 / 连续消息上下文
- 对接被动群感知分支

### 3.3 路由层

消息随后进入：

- `core/router.js`
- `core/routeSchema.js`
- `core/intentAI.js`

这里不是直接决定“调哪个模型”，而是先产出一份统一的 **canonical route contract**。

当前顶层 route 只有 4 个：

- `ignore`
- `refuse`
- `admin`
- `direct_chat`

旧文档里常见的 `lookup / transform / plan / act`，现在更适合理解为**policy 维度**，而不是顶层路由类型。

### 3.4 执行策略层

canonical route 会继续进入：

- `core/routeExecution.js`

这一层负责把“理解结果”翻译成“执行计划”，当前会收敛出：

- `executor`
- `policyKey`
- `allowTools`
- `allowedTools`
- `allowStream`
- `needsBackground`
- `unavailableReason`

当前 executor 集合是：

- `ignore`
- `refuse`
- `admin`
- `direct`
- `background_direct`
- `full_subagent`

### 3.5 执行落地层

消息正式执行主要经过：

- `core/messageRouteFlow.js`
- `core/messageDispatchCoordinator.js`

可以把它们理解成：

- `messageRouteFlow`：路由后编排
- `messageDispatchCoordinator`：最后一跳执行协调

它们会根据 `routeExecutionPlan` 决定：

- 是走普通 direct chat
- 还是走本地工具 / 后台工具任务
- 还是走 full subagent
- 还是直接返回 unavailable / refuse / admin 类结果

---

## 4. LangGraph V2 runtime 应该怎么理解

核心文件：

- `api/runtimeV2/host.js`
- `api/runtimeV2/state.js`
- `api/runtimeV2/nodes/*`

### 4.1 当前图状态

`api/runtimeV2/state.js` 当前把主状态拆成：

- `request`
- `thread`
- `memory`
- `plan`
- `execution`
- `output`
- `messages`
- `events`

这说明主链是显式状态图，而不是把所有逻辑塞进一个大函数里拼变量。

### 4.2 当前固定图拓扑

`api/runtimeV2/host.js` 中的主图拓扑是：

`prepare -> route -> direct_reply | planner -> dispatch -> validate -> repair_or_continue -> draft_reply -> humanize -> final_validate -> persist`

可以粗略理解为：

- 简单或特殊模式请求：直接走 `direct_reply`
- 需要结构化执行时：先 `planner`，再 `dispatch`
- 工具后仍要继续走验证、修复、草稿、润色、最终校验和持久化

### 4.3 最值得先看的节点

如果你只准备快速理解 runtime，优先看这几个节点：

- `api/runtimeV2/nodes/prepare.js`
- `api/runtimeV2/nodes/route.js`
- `api/runtimeV2/nodes/directReply.js`
- `api/runtimeV2/nodes/dispatch.js`
- `api/runtimeV2/nodes/validate.js`
- `api/runtimeV2/nodes/persist.js`

其中 `prepare` 最关键，因为它做的远不只是初始化。当前它还负责：

- checkpoint 恢复
- short-term bridge 恢复 / rehydrate
- 短期历史压缩
- dynamic prompt 构建
- Memory V3 事件写入
- global tool preflight
- continuity state 构建
- allowed tools / memory_cli turn 初始化

---

## 5. 改代码时应该去哪里下手

这一节比“目录说明”更重要。接手开发时，通常不是从头理解所有模块，而是先找到你要改的入口。

### 5.1 想改消息接入、reply 上下文、并发或入口行为

先看：

- `core/messageHandler.js`
- `core/messageIngress.js`
- `core/messageReplyRuntime.js`
- `core/messageTelemetry.js`

适用场景：

- 改 OneBot 入站前置逻辑
- 调整连续消息 / reply / quote 行为
- 处理并发、去重、发送收口
- 加 telemetry 或补日志点

### 5.2 想改路由判断

先看：

- `core/router.js`
- `core/routeSchema.js`
- `core/intentAI.js`

适用场景：

- 新增一个“这类请求该怎么理解”的分类规则
- 调整高优先级安全边界
- 调整图片、搜索、总结、规划、action guidance 之类请求的判定

### 5.3 想改工具开放范围、执行策略或 policyKey

先看：

- `core/routeExecution.js`
- `utils/toolPolicy.js`
- `utils/localToolAccess.js`
- `api/toolRegistry.js`
- `api/toolExecutors.js`

适用场景：

- 某类请求该不该给工具
- 限制哪些工具能暴露
- 调整本地路径访问边界
- 新增工具执行器
- 调整 `policyKey -> allowed tools` 的映射

### 5.4 想改 planner / dispatch / tool evidence 行为

先看：

- `api/runtimeV2/planning/service.js`
- `api/runtimeV2/nodes/dispatch.js`
- `api/runtimeV2/nodes/validate.js`
- `api/runtimeV2/nodes/repair*.js`

适用场景：

- 调整 plan step 结构
- 改 `dependsOn / parallelGroup / sideEffect`
- 改证据校验或 repair 策略
- 避免 side-effect 步骤在 repair 中被重复执行

### 5.5 想改 prompt、人格、review/planner/router stage 规则

先看：

- `prompts/prompt-manifest.json`
- `prompts/persona/*`
- `prompts/runtime/*`
- `utils/promptManifest.js`
- `utils/promptCompiler.js`
- `utils/stagePromptContracts.js`
- `utils/runtimePrompts.js`
- `utils/routePromptPolicy.js`

当前 prompt 已经不是“手写大字符串拼接”，而是**manifest + block compiler + stage contract** 的组合。

所以很多 prompt 改动不应该只改某个 txt，而要顺手确认：

- 所属 stage 是什么
- priority 是否合理
- 有没有 conflict tag
- 会不会被 budget trim
- review / planner / router 是否应避免继承完整 persona

### 5.6 想改记忆、RAG、本地知识或 notebook

先看：

- `utils/memory.js`
- `utils/shortTermMemory.js`
- `utils/shortTermBridgeMemory.js`
- `utils/memoryContext.js`
- `utils/memoryCli.js`
- `utils/localKnowledge.js`
- `api/localNotebook.js`
- `utils/dailyJournal.js`

重点理解：

- `memoryContext.js` 已经不是只查长期记忆
- `localKnowledge.js` 是统一本地知识层
- notebook 只是知识源之一，不再是全部
- Memory V3、session projection、bridge、journal 都可能参与上下文组装

### 5.7 想改群感知、主动消息、调度或后台任务

先看：

- `core/messagePassiveFlow.js`
- `core/passiveGroupAwareness.js`
- `utils/groupAwarenessState.js`
- `core/tickEngine.js`
- `core/proactiveGreetingFlow.js`
- `core/schedulerRuntime.js`
- `utils/postReplyWorkerRuntime.js`
- `utils/postReplyJobQueue.js`

### 5.8 想改 full subagent 或子代理桥接

先看：

- `core/messageFullSubagent.js`
- `api/subagentExecutor.js`
- `api/openclawExecutor.js`

---

## 6. 现在有哪些关键子系统

### 6.1 Prompt 系统：已经是编译式资产链

相关文件：

- `config.js`
- `utils/promptManifest.js`
- `utils/promptCompiler.js`
- `utils/stagePromptContracts.js`
- `utils/runtimePrompts.js`
- `api/runtimeV2/context/service.js`

当前 prompt 机制的关键词是：

- manifest
- stage
- priority
- conflict tags
- budget trimming
- prompt snapshot
- runtime template

### 6.2 记忆系统：分层记忆 + 本地知识融合

相关文件：

- `utils/memory.js`
- `utils/shortTermMemory.js`
- `utils/shortTermBridgeMemory.js`
- `utils/memoryContext.js`
- `utils/localKnowledge.js`
- `utils/memoryCli.js`
- `api/localNotebook.js`

当前检索面已经融合：

- 长期画像
- 短期记忆
- bridge snapshot
- session summary
- daily journal
- Memory V3
- notebook 文档
- 其他本地知识源

### 6.3 Notebook 系统：已经接到主链

核心文件：

- `api/localNotebook.js`

当前 notebook 能力不是占位，已接入：

- `notebook_reindex_folder`
- `notebook_add_document`
- `notebook_list_docs`
- `notebook_search`

### 6.4 被动群感知与主动机制

被动群感知相关：

- `core/passiveGroupAwareness.js`
- `core/messagePassiveFlow.js`
- `utils/groupAwarenessState.js`

主动机制相关：

- `core/tickEngine.js`
- `core/proactiveGreetingFlow.js`
- `core/schedulerRuntime.js`
- `utils/postReplyWorkerRuntime.js`

### 6.5 私聊是“受限接入”，不是完全不支持

当前系统不只是群聊。

`message_type=private` 可以进入链路，但会额外受白名单、权限与能力边界控制。更准确的说法是：

> 以群聊为主，私聊为受限接入模式。

---

## 7. 排障时建议按哪条顺序查

### 7.1 消息根本没进来

先查：

- `index.js`
- NapCat / OneBot WebSocket 连接
- `.mizukibot.lock`
- `safeSend` / `sendWithRetry`

### 7.2 消息进来了，但没回复

先查：

- `core/messageIngress.js`
- `core/router.js`
- `core/routeExecution.js`
- `core/messageRouteFlow.js`
- `core/messageDispatchCoordinator.js`

重点看是不是被判成：

- `ignore`
- `refuse`
- `unavailable`
- `background_direct`

### 7.3 回复内容不对，但工具根本没跑

先查：

- `core/routeExecution.js`
- `api/runtimeV2/nodes/prepare.js`
- `api/runtimeV2/planning/service.js`

常见原因：

- `policyKey` 选错
- `allowTools` 没开
- planner single authority 介入后没有走 planner
- allowed tools 被策略层收紧

### 7.4 工具跑了，但结果没进入最终回复

先查：

- `api/runtimeV2/nodes/dispatch.js`
- `api/runtimeV2/nodes/validate.js`
- `api/runtimeV2/nodes/repair*.js`
- `api/runtimeV2/nodes/draftReply.js`
- `api/runtimeV2/nodes/finalValidate.js`

### 7.5 prompt 改了但看起来没生效

先查：

- `prompts/prompt-manifest.json`
- `utils/promptCompiler.js`
- `utils/stagePromptContracts.js`
- `scripts/check-prompts.js`

很多问题不是“txt 没改对”，而是：

- block 被 stage 过滤掉了
- priority 太低
- conflict tag 被更高优块覆盖
- budget trim 掉了
- 你改的是 main persona，但实际请求走的是 review / planner / router stage

### 7.6 记忆或 notebook 检索不对

先查：

- `utils/memoryContext.js`
- `utils/localKnowledge.js`
- `utils/memoryCli.js`
- `api/localNotebook.js`

---

## 8. 常用命令

### 8.1 基础运行

```bash
npm start
npm run start:post-reply-worker
npm run console
```

### 8.2 测试与检查

```bash
npm test
npm run lint
npm run check:prompts
npm run check:agent
npm run check:agent:static
```

### 8.3 诊断与迁移

```bash
npm run diag:fallback
npm run diag:continuity
npm run memory:v3:migrate
```

### 8.4 Linux 运维

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

### 8.5 Windows 运维

```bash
npm run win:daemon:install
npm run win:daemon:uninstall
npm run win:daemon:status
npm run win:mgmt:setup
```

---

## 9. 测试面大概覆盖哪些地方

`scripts/run-tests.js` 当前会优先扫描 `tests/` 下的 `*.test.js`，必要时回退到内置显式测试列表。

当前测试面已经覆盖到很多关键链路，包括：

- routing / route execution
- LangGraph V2 runtime
- planner protocol
- prompt compiler / stage contract / snapshot
- memory / memory V3 / memory CLI
- local knowledge / notebook
- short-term compression / bridge restore / continuity state
- passive awareness
- subagent bridge
- streaming / fallback / failure handling
- background task / scheduler / post-reply worker

如果你动了 runtime、prompt、memory、route 或 tool policy，建议至少先跑：

```bash
npm test
npm run check:prompts
```

---

## 10. 接手时最容易踩错的几点

### 10.1 不要把旧分类当成当前顶层 route

当前顶层 route 只有：

- `ignore`
- `refuse`
- `admin`
- `direct_chat`

`lookup / transform / plan / act` 更接近 policy 层。

### 10.2 不要把 `api/agentGraphV2.js` 当 runtime 主体

真正 runtime host 在：

- `api/runtimeV2/host.js`

### 10.3 不要把 prompt 系统理解成“改一个 txt 就结束”

现在 prompt 是：

- manifest 驱动
- stage 区分
- compiler 裁剪
- runtime template 注入

### 10.4 不要把 notebook 当成唯一知识检索来源

现在 memory context 已经融合多种 local knowledge source。

### 10.5 不要把私聊当成完全不支持

更准确的理解是：

- 群聊为主
- 私聊可进入
- 但能力受限

---

## 11. 一句话概括当前系统

当前的 MizukiBot 可以理解成：

> **一个以 NapCat/OneBot 为消息接入层、以 canonical route contract + execution plan 为中枢、以 LangGraph V2 为执行主链、融合 prompt 编译链、分层记忆、本地知识、工具调度、被动感知、主动任务与子代理桥接的多阶段 Agent 系统。**

如果你接下来要开始改代码，最实用的起点通常不是 README 里最细的章节，而是这三个文件：

- `core/router.js`
- `core/routeExecution.js`
- `api/runtimeV2/host.js`

因为它们最能代表系统现在的真实主干。
