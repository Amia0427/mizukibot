# 下一位开发者执行清单

## 1. 接手当天先做的事

- [ ] 先读 `README.md`
- [ ] 再读 `docs/route-refactor-handoff.md`
- [ ] 再读 `docs/route-next-dev-guide.md`
- [ ] 再读 `docs/agent-project-dev-guide.md`
- [ ] 确认当前主入口是 `index.js`
- [ ] 确认当前主消息编排层是 `core/messageHandler.js`
- [ ] 确认当前主模型链路是 `api/agentGraph.js`
- [ ] 确认当前子 agent 桥接是 `api/openclawExecutor.js`

---

## 2. 第一轮必须读完的核心文件

- [ ] `core/messageHandler.js`
- [ ] `core/router.js`
- [ ] `core/routeExecution.js`
- [ ] `core/routeProfiles.js`
- [ ] `api/agentGraph.js`
- [ ] `api/openclawExecutor.js`
- [ ] `utils/localToolAccess.js`
- [ ] `utils/toolPolicy.js`
- [ ] `utils/runtimePrompts.js`
- [ ] `utils/subagentPrompting.js`

建议顺序：

1. 先看消息怎么进来
2. 再看 route 怎么判
3. 再看 executor 怎么选
4. 再看主模型怎么跑
5. 最后看工具和子 agent 怎么接

---

## 3. 先建立的心智模型

在开始改代码前，先确认自己能清楚回答：

- [ ] 普通聊天现在走哪条链
- [ ] 工具型请求现在如何从 route 进入执行层
- [ ] 哪些情况走本地工具
- [ ] 哪些情况走子 agent
- [ ] clarify / refuse / ignore / admin 分别在哪一层被处理
- [ ] review 在什么条件下触发
- [ ] memory 在什么阶段注入和写回
- [ ] streaming 是真实流式还是后处理分片

如果这 8 个问题答不清楚，不建议直接开始改。

---

## 4. 第一轮禁止事项

- [ ] 不要先删 legacy route
- [ ] 不要先清理备份文件和 `.bak` 文件
- [ ] 不要先大改 prompt 目录结构
- [ ] 不要把新能力优先堆回 `api/ai.js`
- [ ] 不要只改 prompt 不看执行期权限
- [ ] 不要跳过真实消息验证

---

## 5. 第一优先级任务

### 5.1 路由与执行层收口

- [ ] 复查 `core/routeExecution.js` 还有哪些主判断依赖 `route.type`
- [ ] 标记哪些地方已经可以只依赖 `topRouteType`
- [ ] 标记哪些地方已经可以只依赖 `intent.toolNeed`
- [ ] 标记哪些地方已经可以只依赖 `intent.executionMode`
- [ ] 明确哪些 legacy route 仍在主控制流中起决定作用

目标：

- [ ] 让 executor 选择尽量由顶层协议决定
- [ ] 让 legacy route 逐步退化成兼容标签

### 5.2 route policy 收口

- [ ] 确认工具权限是否已统一从 policy 出发
- [ ] 确认子 agent 权限是否已统一从 policy 出发
- [ ] 确认 web 权限是否已统一从 policy 出发
- [ ] 确认高风险动作权限是否已统一从 policy 出发
- [ ] 确认 streaming 权限是否已统一从 policy 出发

目标：

- [ ] 不再在多个文件里散落写隐式 if/else

---

## 6. `api/agentGraph.js` 专项清单

- [ ] 确认当前工具循环是否存在明确上限
- [ ] 确认失败回复是否会写入记忆系统
- [ ] 确认 Humanizer 是否会处理失败态文本
- [ ] 确认 `agentNode` / `reviewAgentNode` 是否存在重复逻辑
- [ ] 确认动态 prompt 是否在单次请求里被重复构建
- [ ] 确认 tracing/request summary 是否过大
- [ ] 确认 unmatched tool / failed tool 记录是否去重
- [ ] 确认并行工具调用是否有明确 `parallelSafe` 之类元信息

建议优先改动顺序：

1. 工具循环上限
2. 失败路径隔离
3. Humanizer 边界
4. 重复逻辑收敛
5. tracing 体积控制

---

## 7. 工具系统检查清单

每新增或修改一个工具，至少检查：

- [ ] `api/toolSchemas.js`
- [ ] `api/toolExecutors.js`
- [ ] `utils/toolPolicy.js`
- [ ] `utils/localToolAccess.js`
- [ ] route 的 `toolHints`
- [ ] 相关测试是否补齐

额外确认：

- [ ] 普通用户是否仍只能用基础白名单工具
- [ ] 白名单用户是否仍按预期走子 agent
- [ ] 工具不可用时是否有稳定 fallback

---

## 8. 子 agent / OpenClaw 检查清单

- [ ] 确认 `api/subagentExecutor.js` 和 `api/openclawExecutor.js` 的职责边界清晰
- [ ] 确认 route prompt 与 bridge guidance 一致
- [ ] 确认 review prompt 不会篡改事实边界
- [ ] 确认 timeout / 空输出 / JSON 解析失败有清晰日志
- [ ] 确认 search 类请求仍遵守“先搜再读正文”原则

如果子 agent 行为异常，优先同时检查：

- [ ] `utils/subagentPrompting.js`
- [ ] `prompts/runtime/bridge-guidance.txt`
- [ ] `prompts/runtime/review-route.txt`
- [ ] `core/messageHandler.js`

---

## 9. Prompt 修改清单

每次改 prompt 后，至少确认：

- [ ] policy 与 guidance 没冲突
- [ ] review 不会误改事实边界
- [ ] clarify 不会退回僵硬模板
- [ ] 修改后至少跑一条真实消息
- [ ] 日志中工具行为与 prompt 预期一致

---

## 10. Memory 检查清单

- [ ] 确认失败回复不会进入长期记忆
- [ ] 确认短期记忆不会无限膨胀
- [ ] 确认 task memory 与普通聊天记忆没有混层
- [ ] 确认 memory 注入内容体积可控
- [ ] 确认 daily journal 不会吞入无意义失败噪音

---

## 11. 本地开发最小验证清单

每轮核心修改后至少跑：

```bash
npm test
npm run lint
npm run check:agent:static
npm run check:prompts
```

如果只改主链路，至少补跑：

```bash
node tests/router.test.js
node tests/routerHybrid.test.js
node tests/routeExecution.test.js
node tests/messageFlowSource.test.js
```

如果改了 planner / prompts / graph，再补跑：

```bash
node tests/plannerConfig.test.js
node tests/runtimePrompts.test.js
```

如果改了大文件，顺手做语法检查：

```bash
node --check core/messageHandler.js
node --check core/router.js
node --check core/routeExecution.js
node --check api/agentGraph.js
node --check api/ai.js
```

---

## 12. 上服务器前检查清单

- [ ] 先从服务器下载对应文件
- [ ] 与本地版本 diff
- [ ] 确认没有线上独有改动
- [ ] 上传前先做服务器备份
- [ ] 上传后先跑最小测试
- [ ] 再发真实消息验证
- [ ] 再看运行日志是否符合预期

---

## 13. 上线后日志检查清单

重点看：

- [ ] route 是否识别正确
- [ ] `executor` 是否符合预期
- [ ] `toolExecutionTarget` 是否符合预期
- [ ] `usedSubagent` 是否符合预期
- [ ] planner / main model / review 实际用了哪个模型
- [ ] 是否出现 tool loop、timeout、空结果、异常 fallback
- [ ] 最终回复是否与日志中的工具行为一致

---

## 14. 下一阶段推荐顺序

- [ ] 第一步：继续收口 route 协议和 executor 决策
- [ ] 第二步：处理 `api/agentGraph.js` 稳定性问题
- [ ] 第三步：增强工具与子 agent 可观测性
- [ ] 第四步：确认新主路径稳定后，再逐步瘦身 legacy 兼容层

---

## 15. 一句话执行原则

先理解主链路，先做收敛型修改，先测再传，先验证再删旧代码。
