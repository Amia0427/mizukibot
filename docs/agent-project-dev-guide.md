# Agent 项目综合开发交接文档

## 1. 文档目的

这份文档不是单讲某一个路由改造点，而是给下一位开发者一份覆盖整个 agent 项目的开发指导。

目标是回答 4 个问题：

- 这个项目现在的主链路到底是什么
- 哪些模块是核心骨架，哪些模块是兼容层或外围能力
- 现阶段最值得做的优化和重构是什么
- 接手开发时应该按什么顺序读代码、改代码、测代码、上服务器

当前建议总原则：

- 优先理解现有主链路，不要先做大清理
- 优先收口协议、权限、执行边界，不要继续堆分支
- 新能力尽量接入主链路，不要再把复杂逻辑回灌到旧兼容层
- 上线前先本地验证，再同步服务器，再做真实消息验证

---

## 2. 项目定位

这是一个面向 QQ 群聊场景的 Node.js Agent 项目。

当前项目的实际运行形态是：

- NapCat / OneBot WebSocket 接入 QQ
- `index.js` 作为统一启动入口
- `core/messageHandler.js` 作为消息主编排层
- 普通聊天和工具调用统一汇入主消息处理流程
- 主模型链路以 `api/agentGraph.js` 为核心
- 工具型请求按路由分流到：
  - 本地工具执行
  - OpenClaw 子 agent 执行
- 记忆系统、任务记忆、RAG、被动群感知、Web 控制台已接入

从工程视角看，这不是一个“单纯聊天机器人”，而是一个已经具备：

- 路由识别
- 执行计划
- 工具编排
- 子 agent 桥接
- 记忆注入
- 风险控制
- 运行可观测性

的复合 Agent 系统。

---

## 3. 当前主链路总览

建议先把项目理解成下面这条链：

1. `index.js` 启动服务、创建消息处理器、连接 NapCat
2. QQ 群消息进入 `core/messageHandler.js`
3. `core/router.js` / 路由相关模块识别请求类型
4. `core/routeExecution.js` 把 route 转成执行决策
5. `messageHandler` 根据执行决策分流到：
   - 自然聊天
   - direct executor
   - local tools
   - subagent tools
   - clarify / refuse / ignore / admin
6. 主模型调用通常进入 `api/agentGraph.js`
7. 工具结果、review、流式分片、记忆写回在后续流程中完成
8. 最终消息回发到 QQ

如果先不理解这条链，就很容易出现“局部修了一个点，但整体行为更乱”的问题。

---

## 4. 建议优先阅读的文件顺序

### 4.1 第一批必须先读

1. `core/messageHandler.js`
2. `core/router.js`
3. `core/routeExecution.js`
4. `core/routeProfiles.js`
5. `api/agentGraph.js`
6. `api/openclawExecutor.js`

这 6 个文件决定了系统最核心的路由、执行和结果生成方式。

### 4.2 第二批建议继续读

1. `config.js`
2. `utils/localToolAccess.js`
3. `utils/toolPolicy.js`
4. `utils/runtimePrompts.js`
5. `utils/subagentPrompting.js`
6. `api/toolSchemas.js`
7. `api/toolExecutors.js`

这批文件决定工具权限、prompt 装载和子 agent 行为边界。

### 4.3 第三批按需阅读

1. `utils/memory.js`
2. `utils/memoryContext.js`
3. `utils/shortTermMemory.js`
4. `utils/vectorMemory.js`
5. `utils/taskMemory.js`
6. `utils/dailyJournal.js`
7. `core/passiveGroupAwareness.js`
8. `web/server.js`
9. `tests/`

这批文件更偏能力增强、记忆、运维可视化和保护性测试。

---

## 5. 代码结构理解建议

### 5.1 顶层入口

- `index.js`

职责：

- 校验配置
- 获取单实例锁
- 启动 Web 服务
- 创建消息处理器
- 连接 NapCat WebSocket
- 处理群消息与定时任务

建议：

- 不要把复杂业务继续堆到 `index.js`
- `index.js` 应持续保持为启动编排层，而不是业务实现层
- 所有新增能力都优先挂到已有核心模块，不要在入口文件拼逻辑

### 5.2 核心编排层

- `core/messageHandler.js`

职责：

- 消息入口过滤
- 路由识别后编排执行
- 组装 route prompt / tool guidance / bridge guidance
- 控制 clarify、安全降级、流式发送、review 等行为

建议：

- 把它当成“运行时总调度器”维护，不要把它变成第二个大杂烩
- 能抽成纯函数的判断逻辑，尽量往 `core/` 或 `utils/` 下沉
- 每次改这个文件，都要同时检查路由、工具、review、streaming 是否被联动影响

### 5.3 路由层

- `core/router.js`
- `core/routeExecution.js`
- `core/routeProfiles.js`

职责分工应理解为：

- `router.js`：识别用户想干什么
- `routeExecution.js`：决定系统应该怎么执行
- `routeProfiles.js`：保存 route 的定义、toolHints、executionPlan 模板

建议：

- 继续把“识别”和“执行”分开，不要回退到一个文件同时做两件事
- route 的语义协议要越来越清晰，执行决策不要继续分散在多个层里隐式发生

### 5.4 主模型层

- `api/agentGraph.js`
- `api/ai.js`

当前建议理解：

- `agentGraph.js` 是主链路
- `ai.js` 是兼容链路与部分特殊能力入口

建议：

- 新功能优先接 `agentGraph.js`
- 除非明确是兼容需求，否则不要继续把核心能力堆回 `ai.js`
- 如果两个文件出现相同能力，优先考虑收敛，而不是双份维护

### 5.5 子 agent 与工具层

- `api/subagentExecutor.js`
- `api/openclawExecutor.js`
- `api/toolSchemas.js`
- `api/toolExecutors.js`
- `utils/localToolAccess.js`
- `utils/toolPolicy.js`

建议：

- 本地工具和子 agent 工具的边界必须继续保持清晰
- 工具权限不要只靠 prompt 约束，必须保留执行期校验
- 每次加新工具，都要同步检查：schema、executor、权限、routeHint、测试

---

## 6. 对当前架构的总体判断

当前项目已经有清晰主骨架，但还处在“新结构已建立、旧兼容仍然较厚”的阶段。

### 当前已经比较好的点

- 启动链路清晰
- 路由识别与执行选择已经拆层
- 工具调用和子 agent 桥接已经形成独立模块
- 主模型链路已集中到 `agentGraph.js`
- memory / task memory / RAG / daily journal 已形成完整辅助系统
- review、streaming、runtime prompts、bridge prompts 已经纳入体系

### 当前最需要警惕的点

- 双轨制继续扩散
- 旧 route type 继续深度影响执行层
- 失败路径和成功路径没有完全分离
- 工具权限、route policy、prompt policy 仍可能在多个地方重复判断
- graph 主链和旧 `ai.js` 能力存在重叠，后续维护成本会越来越高

一句话判断：

当前项目最需要的不是“继续加功能”，而是“让现有协议、执行和权限真正收口”。

---

## 7. 路由系统的开发建议

这部分是整个项目接下来最重要的工作之一。

### 7.1 继续坚持 top-route-first

当前路由改造方向是正确的：

- 顶层路由决定总体能力边界
- 旧细路由退化为兼容标签和提示信息

建议继续坚持：

- `topRouteType` 决定主处理模式
- `intent.toolNeed` 决定是否需要工具
- `intent.executionMode` 决定 immediate / staged / delegated / background
- `route.type` 逐步退化成兼容层字段

### 7.2 不要再让 legacy route 决定主执行流程

建议后续目标：

- `routeExecution.js` 主判断尽量只依赖顶层协议
- `routeProfiles.js` 从“旧细路由中心”逐步改成“顶层路由主定义 + legacy hint 补充”
- legacy route 保留给 telemetry、display、prompt hint、兼容测试

### 7.3 路由 schema 继续集中化

当前需要继续强化：

- `topRouteType` 的允许值
- `toolNeed` 的允许值
- `executionMode` 的允许值
- 默认值和 normalize 逻辑

建议：

- 继续把 schema、sanitize、normalize、allowed set 收口在统一模块
- 不要在 `router.js`、`routeExecution.js`、prompt 组装层再各自发明一套解释逻辑

### 7.4 路由测试要改成顶层协议优先

后续新增测试时，建议断言顺序改成：

1. `topRouteType`
2. `intent.*`
3. executor / permission / tool target
4. 最后才是 `route.type`

否则测试会继续把旧兼容层“固化成主结构”。

---

## 8. 对 `api/agentGraph.js` 的重点优化建议

这是当前最值得持续优化的核心文件之一。

### 8.1 增加明确的工具循环上限

当前风险：

- 工具调用链如果异常反复触发，会让 graph 进入冗长回圈

建议：

- 为单次请求设置明确的 max tool iterations
- 超限后直接进入失败兜底或总结回复

这是稳定性问题，不是风格问题。

### 8.2 失败回复不要混入正常记忆链路

当前建议：

- 明确区分“成功回答”和“失败/降级/报错回答”
- 不要把明显失败文案写入短期记忆、用户画像、长期学习链路

否则会污染记忆系统，后面越学越偏。

### 8.3 Humanizer 不要处理失败态文本

如果一段回复本质是错误说明、失败兜底或不可执行解释：

- 不建议再走 Humanizer 二次润色

否则会出现：

- 失败信息被美化
- 错误边界被弱化
- 调试信息更难判断

### 8.4 `agentNode` 和 `reviewAgentNode` 的重复逻辑需要收敛

如果两段节点逻辑只是 prompt、模式、开关不同：

- 建议抽共享调用路径
- 把差异保留为参数

这样能减少：

- fallback 不一致
- tracing 不一致
- 修 bug 只修到一半

### 8.5 单次请求内缓存动态 prompt 结果

如果 `buildDynamicPrompt()` 在同一次请求中被多次构造：

- 建议缓存 request-scope 结果

收益：

- 降低重复字符串拼接和 memory 读取成本
- 降低多节点 prompt 漂移风险

### 8.6 重新审视 Humanizer 与 streaming 的配合

当前如果“先完整生成，再人性化，再分片发送”：

- 这更像伪流式，不是真流式

建议：

- 明确区分真实 streaming 和 post-process segmentation
- 不要对外混用同一个概念

### 8.7 工具失败兜底应更可控

当工具不可用、schema 不匹配、结果为空时：

- 需要更稳定的 fallback path
- 需要把“不足以回答”和“可以降级回答”区分开

### 8.8 request summary / trace payload 应控制体积

建议：

- tracing 信息保留重点字段
- 避免在高频路径记录过大 payload

否则会影响日志可读性和后续排障成本。

### 8.9 去重 unmatched tool / failed tool 记录

同一轮里重复记录同一个无效工具名没有意义。

建议：

- 统一去重
- 输出更可读的聚合结果

### 8.10 并行工具调用不要只看粗粒度风险标签

如果现在只是按 `risk === low` 之类条件决定是否并行：

- 这不够稳

建议：

- 给工具定义更显式的 `parallelSafe`
- 由工具元信息决定并行能力，而不是只靠 route 粗分类

---

## 9. 对工具系统的开发建议

### 9.1 工具权限必须双层校验

应始终保留两层：

1. prompt 层提示模型怎么用
2. executor / policy 层真正拦截不该执行的工具

不要把安全边界建立在“模型应该听话”上。

### 9.2 新增工具时必须同步检查 5 个点

新增一个工具时，至少检查：

1. `api/toolSchemas.js`
2. `api/toolExecutors.js`
3. `utils/toolPolicy.js`
4. `utils/localToolAccess.js`
5. 相关 route 的 `toolHints` / tests

只加 schema 不加权限，或者只加 executor 不加测试，后面一定出隐性问题。

### 9.3 区分“工具能力存在”和“当前路由允许使用”

建议后续保持这种心智模型：

- registry 说明系统有什么工具
- policy 说明当前请求能不能用
- executor 说明工具怎么执行

这三层不能混。

### 9.4 普通用户与白名单用户要继续严格分流

当前模式是对的：

- 非白名单：只允许基础本地工具白名单
- 白名单：复杂工具路由可走子 agent

建议：

- 不要把白名单判断散落到多个模块里继续复制
- 条件越集中，线上越容易排障

---

## 10. 对子 agent / OpenClaw 桥接的建议

### 10.1 把 OpenClaw 看成独立后端，而不是本地工具的延伸

`api/openclawExecutor.js` 当前实际上是在做：

- CLI 参数拼装
- 会话隔离
- stdout/stderr 解析
- timeout 控制
- JSON / 文本结果适配

建议：

- 后续保持它作为清晰的“桥接适配层”
- 不要把业务规则直接硬写进 CLI 解析代码里

### 10.2 route prompt 与 bridge guidance 要保持一致性

子 agent 经常出问题的根源不是“模型不会做”，而是：

- route prompt
- bridge guidance
- review prompt

三层表达互相打架。

建议：

- 只要改子 agent 行为，就同时检查这三类 prompt 是否一致
- 不要只修桥接提示，不看 review 重写逻辑

### 10.3 review 只能做整理，不能改变事实边界

review 层建议继续遵守：

- 不新增事实
- 不凭空补步骤
- 不把“审核不能再调用工具”误写成“整个系统不能搜索”
- 不把工具失败伪装成已完成

review 的职责是清理表达，不是重做任务。

### 10.4 子 agent 的超时、失败、空结果要单独统计

这块后续如果继续增强，建议增加更清晰的 telemetry 字段，至少区分：

- timeout
- CLI 启动失败
- JSON 解析失败
- 空输出
- review 后为空

这样后面查问题会比纯看文本日志轻松很多。

---

## 11. Prompt 系统的开发建议

### 11.1 prompt 资产不要继续散乱增长

当前 prompt 已经不少：

- persona prompt
- tool guidance
- bridge guidance
- review prompts
- streaming segmentation
- route policies

建议：

- 新增 prompt 前先确认是否能复用现有模板
- 如果只是同一路由的轻微差异，优先参数化，而不是复制一份新模板

### 11.2 prompt 修改必须做真实消息验证

这个项目 prompt 不是纯静态文案，它会直接改变：

- 工具选择
- 子 agent 行为
- review 风格
- clarify 降级方式

因此建议：

- 改完 prompt，不要只跑静态测试
- 至少跑一条真实消息并看日志

### 11.3 route policy、tool guidance、bridge guidance 要统一语义

一个常见坏味道是：

- route policy 说允许
- tool guidance 说谨慎
- bridge guidance 说不要做

最后模型行为就会摇摆。

建议：

- 把“是否允许做”和“怎么做”分开写
- policy 定边界，guidance 定执行方式

---

## 12. 对记忆系统的建议

### 12.1 先保守，不要让记忆系统吞掉失败噪音

当前项目已经有：

- short-term memory
- 用户画像记忆
- vector memory / RAG
- task memory
- daily journal

建议优先原则：

- 成功回答、稳定偏好、明确事实才进入长期链路
- 失败回复、错误状态、临时异常不要轻易沉淀

### 12.2 记忆注入必须控制体积和优先级

如果后续继续增强记忆：

- 先解决“哪些内容值得注入”
- 再解决“注入多少”

不要一味加上下文，最后把主 prompt 压得越来越臃肿。

### 12.3 任务记忆和普通聊天记忆要继续分层

任务记忆更适合记录：

- 计划
- 已完成步骤
- 当前目标

普通聊天记忆更适合记录：

- 用户稳定偏好
- 长期设定
- 行为习惯

这两者不要混成一个大桶。

---

## 13. 对 `core/messageHandler.js` 的建议

### 13.1 保持它是编排层，不是实现层

当前它已经承担很多职责，如果继续无节制膨胀，后面会很难维护。

建议后续可以持续下沉的内容：

- 路由相关纯判断
- tool guidance / bridge guidance 构造细节
- clarify 选项组装
- streaming 分片策略

### 13.2 每次改这里都要特别检查 4 件事

1. clarify 是否仍然安全降级
2. local tool 和 subagent tool 是否仍正确分流
3. review 是否只在该进的路径触发
4. streaming / 非 streaming 是否仍能稳定发回 QQ

### 13.3 不要在 messageHandler 里继续叠“特判修 bug”

如果某个行为必须靠 messageHandler 多加一层 if 才正常：

- 先问是 route 协议不清楚
- 还是 execution 层边界不清楚
- 还是 tool policy 没收口

不要把它当默认修法。

---

## 14. 测试与验证建议

### 14.1 本地最少要保住的测试

建议持续至少跑这些：

```bash
npm test
npm run lint
npm run check:agent:static
npm run check:prompts
```

如果只改核心主链，至少补跑：

```bash
node tests/router.test.js
node tests/routerHybrid.test.js
node tests/routeExecution.test.js
node tests/messageFlowSource.test.js
```

如果改了主模型链或 planner，再补跑：

```bash
node tests/plannerConfig.test.js
node tests/runtimePrompts.test.js
```

### 14.2 语法检查不要省

如果改了大文件，建议顺手跑：

```bash
node --check core/messageHandler.js
node --check core/router.js
node --check core/routeExecution.js
node --check api/agentGraph.js
node --check api/ai.js
```

### 14.3 测试策略建议

后续测试要重点覆盖：

- `topRouteType -> executor`
- route policy -> tool permission
- clarify / refuse / ignore 的硬边界
- image route 必须走本地工具
- subagent whitelist 分流
- planner 模型配置不回退
- 工具失败兜底行为

### 14.4 真实请求验证不能省

因为这个项目有：

- 多模型
- 多 prompt
- 本地工具
- 子 agent
- 线上配置驱动

所以静态测试只能挡住一部分问题。

每轮核心改动后，建议至少验证一条真实消息。

---

## 15. 部署与服务器同步建议

### 15.1 不要直接本地改完就覆盖服务器

推荐顺序：

1. 先从服务器下载对应文件
2. 与本地版本做 diff
3. 确认没有线上独有改动
4. 服务器先备份
5. 再上传修改
6. 上传后先跑最小测试
7. 最后再发真实消息验证

### 15.2 上线后优先看的日志点

- route 是否识别正确
- `toolExecutionTarget` 是否符合预期
- `usedSubagent` 是否符合预期
- 主模型 / planner / review 实际调用了哪个模型
- 是否出现 tool loop、超时、fallback、空结果

### 15.3 不要把“启动成功”等同于“行为正确”

这个项目经常会出现：

- 服务能起来
- 语法没错
- 但 route 行为、tool 权限、review 结果已经偏了

所以必须看真实运行日志。

---

## 16. 代码风格与重构建议

### 16.1 优先做收敛型重构

当前最适合做的重构，不是大拆大建，而是：

- 抽重复逻辑
- 收口策略判断
- 收口 schema / policy / normalize
- 减少双份实现

### 16.2 不要在功能修改时顺手做大清理

当前仓库已经存在：

- 历史兼容层
- 备份文件
- 临时诊断逻辑
- 不同阶段演进留下的分支结构

建议：

- 功能改动任务和清理任务分开
- 否则很容易把“能运行的兼容态”删坏

### 16.3 新增抽象前先问是否真的复用

如果只是一次性逻辑，不要急着造 helper。

但如果已经出现下面任一情况，就值得收敛：

- 同样的 normalize 逻辑出现 2 次以上
- 同样的 policy 判断出现 2 次以上
- 同样的 tool/review/fallback 分支在 graph 和 ai 双份存在

---

## 17. 建议下一阶段的优先级

### 第一优先级：继续收口路由协议与执行层

重点：

- 让 `routeExecution.js` 更少依赖 legacy route type
- 让 executor 决策更多依赖顶层协议
- 让 route policy 成为统一能力边界来源

### 第二优先级：清理 `agentGraph.js` 的稳定性问题

重点：

- 工具循环上限
- 失败路径隔离
- Humanizer 边界
- tracing 体积控制
- 重复节点逻辑收敛

### 第三优先级：强化工具与子 agent 的可观测性

重点：

- 明确失败类型
- 更好区分本地工具失败和 bridge 失败
- 更容易从日志定位分流问题

### 第四优先级：再考虑逐步瘦身兼容层

重点：

- 不要先删
- 先让新主路径稳定
- 再让 legacy type 从主控制流退出

---

## 18. 明确不建议现在做的事

- 不要先大删 legacy route
- 不要把新功能优先接回 `api/ai.js`
- 不要把安全边界只写在 prompt 里
- 不要只改 bridge guidance 不看 review prompt
- 不要把失败回复写进长期记忆
- 不要在 `messageHandler.js` 里继续无限叠补丁
- 不要跳过服务器 diff、备份和真实消息验证

---

## 19. 下一位开发者的建议开工顺序

建议直接按这个顺序开始：

1. 先读 `README.md`
2. 再读：
   - `core/messageHandler.js`
   - `core/router.js`
   - `core/routeExecution.js`
   - `core/routeProfiles.js`
   - `api/agentGraph.js`
   - `api/openclawExecutor.js`
3. 先把当前 route / executor / tool / subagent 主链画出来
4. 第一轮只做收敛型修改，不做删除型修改
5. 每改一轮先跑局部测试，再跑真实消息
6. 真正稳定后，再考虑削弱 legacy 兼容层

---

## 20. 一句话总结

这个项目现在最重要的不是继续扩张能力，而是把已经存在的路由协议、执行决策、工具权限、子 agent 桥接、失败路径和记忆边界真正统一起来；只要这一步做稳，后续无论加功能还是减兼容层，成本都会明显下降。
