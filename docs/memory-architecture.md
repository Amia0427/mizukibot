# Memory Architecture

## Summary

当前项目的记忆系统分成 4 层：

1. 短期记忆
2. 短期桥接记忆
3. 长期记忆
4. 主动记忆检索工具 `memory_cli`

它们不是互相替代关系，而是分工关系：

- 短期记忆负责“当前会话正在聊什么”
- 桥接记忆负责“重启后把刚刚聊到哪了接回来”
- 长期记忆负责“稳定画像、偏好、事实、任务经验、群上下文、日记”
- `memory_cli` 负责“模型在必要时主动查证长期记忆细节”

当前主聊天链会同时用到这几层，但注入顺序和写回时机不同。

## 1. Base Storage

### 1.1 进程内内存

定义在 [memory.js](D:/0.01/linux-migration-pack/utils/memory.js)：

- `chatHistory`
- `shortTermMemory`
- `favorites`
- `memories`

其中：

- `chatHistory` 是进程内的最近对话消息缓存，不持久化
- `shortTermMemory` 是进程内的短期摘要状态，不持久化
- `favorites` 和 `memories` 会落盘

### 1.2 持久化文件

当前主要文件有：

- `data/memories.json`
  - 用户稳定画像
  - `facts / profile / summary / impression`
- `data/memory_items.json`
  - 统一长期记忆 item 库
  - personal / task / group 等都进这里
- `data/memory_index.json`
  - 长期记忆的词法检索索引
- `data/short_term_bridge.json`
  - 短期桥接快照
- `data/memory_scope_index.json`
  - 用户可访问群/频道作用域索引
- `data/daily_journal/...`
  - 每日日记、summary、4day rollup、monthly rollup

## 2. Short-Term Memory

实现主入口在 [shortTermMemory.js](D:/0.01/linux-migration-pack/utils/shortTermMemory.js)。

### 2.1 会话隔离

短期记忆已经不是按 `userId` 直接存，而是按 `sessionKey`：

- 优先 `routeMeta.sessionId`
- 否则 `qq-group:{groupId}:user:{userId}`
- 否则 `channel:{channelId}:user:{userId}`
- 否则 `direct:{userId}`

对应 helper：

- `resolveShortTermSessionKey(...)`
- `resolveShortTermScope(...)`

这层解决的是：

- 同一用户在不同群之间不串线
- 私聊和群聊不串线
- restart recall 只恢复到当前会话，不污染别的会话

### 2.2 结构化短期状态

当前 `shortTermMemory[sessionKey]` 是结构化对象，不是单纯字符串：

- `summary`
- `activeTopic`
- `openLoops`
- `assistantCommitments`
- `userConstraints`
- `recentToolResults`
- `carryOverUserTurn`
- `lastCompressedAt`
- `rounds`

默认上限：

- `openLoops / assistantCommitments / userConstraints` 各最多 4 条
- `recentToolResults` 最多 3 条
- `carryOverUserTurn` 最多 220 字

### 2.3 对模型的注入方式

短期记忆仍然只注入一个 section，不新增 prompt 区块：

- `[ShortTermSummary]`

构造入口：

- `buildStructuredSummaryText(...)`
- `buildHistorySummaryMessage(...)`
- `buildShortTermContextMessages(...)`

输出顺序固定是：

1. `carryOverUserTurn`
2. `activeTopic`
3. `openLoops`
4. `assistantCommitments`
5. `userConstraints`
6. `recentToolResults`
7. `summary`

所以模型看到的仍然是一段压缩好的“最近会话上下文”，只是内部来源已经结构化。

### 2.4 追加与压缩

每轮正常聊天后，最近 user/assistant 消息会进入短期历史：

- `appendShortTermHistory(...)`

当短期历史超过阈值时，会触发压缩：

- `compressShortTermHistoryIfNeeded(...)`

压缩策略：

- 优先尝试让模型返回严格 JSON 结构
- JSON 解析成功就更新结构化状态
- JSON 解析失败则退回旧式纯文本摘要逻辑

当前没有为结构化状态额外增加新的模型调用次数，复用原有短期压缩调用。

## 3. Restart Recall

实现入口：

- `rehydrateShortTermMemoryAfterRestartIfNeeded(...)`

目的：

- 服务重启后，`chatHistory` 和 `shortTermMemory` 会清空
- 但长期记忆还在
- 所以首轮正常聊天时，会用长期个人记忆补种一个短期摘要

触发条件：

- 当前 `chatHistory[sessionKey]` 为空
- 当前 `shortTermMemory[sessionKey].summary` 为空
- 当前是正常 chat 流
- `RESTART_RECALL_ENABLED=true`

恢复源只用个人长期记忆：

- `profile`
- `summary`
- `impression`
- `facts`
- `retrieveRelevantMemories(..., { scopeType: 'personal' })`

不接入：

- group memory
- task memory
- daily journal

恢复结果只写短期状态：

- 写 `shortTermMemory[sessionKey].summary`
- 不伪造 user/assistant 历史消息

这层解决的是：

- 重启后的“第一条回复没有记忆感”

但它恢复的是“长期记忆反推的会话感”，不是上次会话原样续上。

## 4. Short-Term Bridge Memory

实现入口在 [shortTermBridgeMemory.js](D:/0.01/linux-migration-pack/utils/shortTermBridgeMemory.js)。

### 4.1 作用

桥接记忆解决的是：

- 重启后优先恢复“刚刚聊到哪了”
- 不只靠长期记忆反推

也就是：

- 先恢复上次该会话的短期状态
- bridge 没有可用快照时，再 fallback 到 restart recall

### 4.2 存储结构

文件：

- `data/short_term_bridge.json`

版本：

- `version: 2`

主结构：

- `sessions: { [sessionKey]: {...} }`

每个 session 保存：

- `userId`
- `scope`
  - `sessionKey`
  - `userId`
  - `groupId`
  - `channelId`
  - `sessionId`
- `updatedAt`
- `expiresAt`
- `snapshotType`
  - `pre_reply`
  - `post_reply`
- `shortTermState`
- `recentMessages`

### 4.3 双快照机制

当前桥接不是单快照，而是双快照：

#### `pre_reply`

写入时机：

- 收到正常聊天请求后
- 生成回复前

内容：

- 当前结构化短期状态
- 最近可见消息
- `carryOverUserTurn = 当前用户消息`

作用：

- 如果 bot 在“收到用户消息之后、回复之前”异常退出
- 重启后还能知道上次用户刚说了什么但还没答

#### `post_reply`

写入时机：

- 回复成功
- 并且 `appendShortTermHistory(...)` 完成后

内容：

- 追加后的最近消息
- 最新结构化短期状态
- 清空 `carryOverUserTurn`

作用：

- 正常恢复完整的“刚刚聊到哪”

### 4.4 恢复优先级

当前恢复链是：

1. `post_reply` bridge
2. `pre_reply` bridge
3. `restart recall`
4. `compressShortTermHistoryIfNeeded(...)`

其中 `pre_reply` 恢复时：

- 只恢复 `carryOverUserTurn`
- 不把未完成用户消息伪造成 `chatHistory`

### 4.5 清理策略

桥接文件在加载/保存时都会清洗：

- 过期 session 删除
- 非法结构删除
- 超过上限时按 `updatedAt` 裁剪

相关配置：

- `SHORT_TERM_BRIDGE_ENABLED`
- `SHORT_TERM_BRIDGE_TTL_HOURS`
- `SHORT_TERM_BRIDGE_RECENT_MESSAGES`
- `SHORT_TERM_BRIDGE_MAX_USERS`
- `SHORT_TERM_BRIDGE_FILE`

## 5. Long-Term Memory

长期记忆分两类：

1. 结构化画像型
2. item/index 检索型

### 5.1 结构化画像型

实现于 [memory.js](D:/0.01/linux-migration-pack/utils/memory.js)。

每个用户主要字段：

- `facts`
- `profile`
  - `identities`
  - `personality_traits`
  - `hobbies`
  - `likes`
  - `dislikes`
  - `goals`
  - `relation_stage`
  - `recent_topics`
- `summary`
- `impression`

这部分更像稳定画像，适合直接 prompt 注入。

### 5.2 item/index 检索型

实现于 [vectorMemory.js](D:/0.01/linux-migration-pack/utils/vectorMemory.js)。

它不是向量数据库，而是项目内自建的词法检索 memory library。

主要文件：

- `memory_items.json`
- `memory_index.json`

每条 memory item 统一字段包括：

- `id`
- `userId`
- `text`
- `canonicalText`
- `type`
- `source`
- `confidence`
- `importance`
- `tier`
- `status`
- `createdAt / updatedAt`
- `scopeType`
  - `personal`
  - `task`
  - `group`
- 以及 `groupId / sessionId / routePolicyKey / taskType / toolName / channelId` 等作用域元数据

### 5.3 检索与排序

长期检索核心接口：

- `retrieveRelevantMemories(...)`
- `retrieveRelevantMemoriesAsync(...)`
- `getCoreMemories(...)`

当前检索本质上是：

- 词法 token 化
- TF-IDF / 词项重叠 / 时间衰减 / 类型权重 / importance/tier 共同参与排序

类型上有不同衰减规则，例如：

- `fact / like / dislike / goal / impression / topic`

其中：

- `impression` 保持高权重
- `topic` 更容易衰减

## 6. Task Memory / Group Memory / Daily Journal

### 6.1 Task Memory

实现于 [taskMemory.js](D:/0.01/linux-migration-pack/utils/taskMemory.js)。

特点：

- 底层也写入统一 `memory_items.json`
- `scopeType='task'`
- 记录“任务类型、触发条件、策略、避免事项、结果”

典型字段：

- `taskType`
- `trigger`
- `strategy`
- `avoid`
- `outcome`

用途：

- 对“这类任务上次怎么做成功/失败”进行经验复用

### 6.2 Group Memory

实现于 [groupMemory.js](D:/0.01/linux-migration-pack/utils/groupMemory.js)。

特点：

- 也是统一 item 库
- `scopeType='group'`
- `userId` 实际写成 `group:{groupId}`

用途：

- 记录群共享事实、群常聊话题、群目标

### 6.3 Daily Journal

实现于 [dailyJournal.js](D:/0.01/linux-migration-pack/utils/dailyJournal.js)。

它维护：

- 每日日志
- 每日 summary
- 4 天 rollup
- 月度 rollup

主要用于：

- 给模型注入“最近几天发生过什么”
- 或被 `memory_cli` 搜索和打开

## 7. Memory Learning

长期记忆不是只读的，还会从对话中异步学习。

主要入口在 [memoryExtraction.js](D:/0.01/linux-migration-pack/api/memoryExtraction.js)。

当前会学习三类：

1. 个人长期记忆
2. task memory
3. group memory

### 7.1 个人长期记忆抽取

`learnSomethingNew(...)` 会从一轮 user/bot 对话中抽取：

- `identities`
- `personality_traits`
- `hobbies`
- `facts`
- `likes`
- `dislikes`
- `goals`
- `summary`
- `impression`
- `topics`

然后分别写回：

- `memories.json`
- `memory_items.json`

### 7.2 Task Memory 抽取

`learnTaskStrategy(...)` 会抽：

- `task_type`
- `trigger`
- `strategy`
- `avoid`
- `outcome`

然后写成 `scopeType=task` 的 memory item。

### 7.3 Group Memory 抽取

`learnGroupMemory(...)` 会抽：

- `shared_facts`
- `shared_goals`
- `shared_topics`

然后写成 `scopeType=group` 的 memory item。

## 8. Prompt Injection

长期记忆上下文由 [memoryContext.js](D:/0.01/linux-migration-pack/utils/memoryContext.js) 统一构造。

注入到主模型前，当前主要 section 包括：

- `[RelevantPersonalMemory]`
- `[RelevantTaskMemory]`
- `[CoreMemory]`
- `[RelevantGroupMemory]`
- `[RecentDailySummaries]`
- `[LongTermProfile]`
- `[Impression]`
- `[Summary]`

短期记忆则另外走：

- `[ShortTermSummary]`

所以当前主模型看到的是：

- 一段短期会话态
- 一段长期个人/任务/群/日记记忆
- 再叠加 route prompt 和系统 prompt

## 9. Memory CLI

实现于 [memoryCli.js](D:/0.01/linux-migration-pack/utils/memoryCli.js)。

目的：

- 把长期记忆从“只被动注入 prompt”
- 升级为“模型可以按需主动查证”

### 9.1 对 chat 暴露的命令

对正常聊天主要开放：

- `mem search --query "..."`
- `mem open --ref "..."`
- `mem open --source profile`
- `mem open --source personal|task|group|journal --id "..."`

chat 运行时不鼓励也不允许：

- `mem ls`
- `mem stats`

### 9.2 检索范围

统一检索源包括：

- `profile`
- `personal`
- `task`
- `group`
- `journal`

其中 group 的访问范围受 [memoryScopeIndex.js](D:/0.01/linux-migration-pack/utils/memoryScopeIndex.js) 控制。

### 9.3 作用域索引

`memory_scope_index.json` 记录用户见过哪些：

- `groups`
- `channels`

写入入口：

- `recordMemoryScope(userId, routeMeta)`

作用：

- `memory_cli` 打开 group memory 时只允许访问该用户历史出现过的群
- 避免跨用户、跨群越权读取

### 9.4 本轮收束策略

正常 chat 中，`memory_cli` 当前有单轮预算：

- 最多 `1 次 search + 1 次 open`

收束实现：

- `memoryCliTurnPolicy.js`

策略：

- `search -> answer`
- `search -> open -> answer`
- `open -> answer`

如果再继续 search/open：

- 会被拦截
- `mustAnswer=true`
- 下一轮不再给 `memory_cli`

### 9.5 非法命令修复层

现在 `memory_cli` 前面还有一层命令归一化：

- `prepareMemoryCliCommand(...)`

它可以修正常见轻微格式错误：

- 缺 `mem` 前缀
- `memsearch` / `mem-open`
- `search "xxx"` 自动补 `--query`
- `open mc_ref:...` 自动补 `--ref`
- 中文引号 / 全角空格 / 代码块包裹
- 简单 JSON 包装的 `{"command":"..."}`

但不会做意图猜测，也不会放宽 shell 安全限制。

## 10. Current Runtime Flow

以正常 chat 为例，当前记忆相关顺序大致是：

1. 解析 `routeMeta`，得到 `sessionKey`
2. 记录 `memory_scope_index`
3. 首轮尝试恢复 bridge
4. bridge 失败时尝试 restart recall
5. 构造长期记忆上下文
6. 构造 `[ShortTermSummary]`
7. 发主模型
8. 如果模型需要，可调用 `memory_cli`
9. 生成最终回复
10. 追加短期历史
11. 需要时压缩短期状态
12. 写 `post_reply` bridge
13. 异步做长期记忆抽取和日记写入

## 11. Known Issues and Boundaries

### 11.1 不是向量数据库

当前长期记忆检索是本地词法索引，不是独立 embedding DB。

优点：

- 简单
- 可控
- 无额外基础设施

缺点：

- 对复杂语义召回能力有限
- 主要靠词重叠、类型权重和规则

### 11.2 Restart recall 不是原样恢复历史

它恢复的是“精简会话感”，不是完整历史复原。

真正更接近“原样续上”的是短期 bridge。

### 11.3 Bridge 只恢复有限最近消息

默认只恢复最近 4 条可见消息，不恢复完整聊天记录。

这是有意的：

- 控制体积
- 控制隐私
- 控制 prompt 污染

### 11.4 memory_cli 仍然是只读

当前 `memory_cli` 只负责：

- search
- open

不负责：

- 写入
- 删除
- 治理

### 11.5 子 agent 路由不等于 memory_cli

像 `lookup/web-answer` 这种工具路由，可能走 `subagent_tools/openclaw`，不等于当前 chat 主链里的 `memory_cli`。

两者区别：

- `memory_cli` 是主模型在正常 chat 中主动查长期记忆
- `subagent/openclaw` 是某些工具路由把整任务委托给子 agent

## 12. Relevant Files

核心代码文件：

- [memory.js](D:/0.01/linux-migration-pack/utils/memory.js)
- [shortTermMemory.js](D:/0.01/linux-migration-pack/utils/shortTermMemory.js)
- [shortTermBridgeMemory.js](D:/0.01/linux-migration-pack/utils/shortTermBridgeMemory.js)
- [memoryContext.js](D:/0.01/linux-migration-pack/utils/memoryContext.js)
- [vectorMemory.js](D:/0.01/linux-migration-pack/utils/vectorMemory.js)
- [taskMemory.js](D:/0.01/linux-migration-pack/utils/taskMemory.js)
- [groupMemory.js](D:/0.01/linux-migration-pack/utils/groupMemory.js)
- [dailyJournal.js](D:/0.01/linux-migration-pack/utils/dailyJournal.js)
- [memoryScopeIndex.js](D:/0.01/linux-migration-pack/utils/memoryScopeIndex.js)
- [memoryCli.js](D:/0.01/linux-migration-pack/utils/memoryCli.js)
- [memoryCliTurnPolicy.js](D:/0.01/linux-migration-pack/utils/memoryCliTurnPolicy.js)
- [memoryExtraction.js](D:/0.01/linux-migration-pack/api/memoryExtraction.js)
- [agentGraph.js](D:/0.01/linux-migration-pack/api/agentGraph.js)
- [ai.js](D:/0.01/linux-migration-pack/api/ai.js)

