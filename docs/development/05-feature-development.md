# 功能开发指南

更新：2026-07-31 +08:00

本章回答两个问题：新行为应该放在哪里，以及怎样在不破坏兼容入口、启动性能和持久化一致性的前提下完成改动。开始前先读 [消息与 Agent 运行时](./03-message-and-agent-runtime.md)；涉及记忆或 prompt 时再读 [记忆与 Prompt](./04-memory-and-prompts.md)。

## 1. 先确定行为所有者

不要从“哪个大文件最容易插一段代码”开始。先确认行为由哪个边界负责：

| 需求 | 首选所有者 | 组合或兼容入口 |
| --- | --- | --- |
| 消息意图、路由策略 | `core/router/`、`core/routeProfiles.js` | `core/routeExecution.js`、`core/messageRouteFlow/index.js` |
| Runtime V2 节点 | `api/runtimeV2/nodes/`、`api/runtimeV2/runtime/` | `api/runtimeV2/host/index.js` |
| 模型协议和请求 | `src/model/http/`、`api/createAgent/` | `api/httpClient.js`、`api/agentGraph.js`、`api/agentGraphV2.js` |
| 工具 schema | `api/toolSchemas/` | `api/toolSchemas.js` |
| 工具执行器 | `api/toolExecutors/`、`api/skills_native/` | `api/toolRegistry.js` |
| 后台任务 | `utils/backgroundTask/` 或对应 feature 模块 | `utils/backgroundTaskRuntime.js` |
| 回复后学习 | `utils/postReplyWorker/` | `scripts/post-reply-worker.js` |
| Web 管理能力 | `web/<feature>Route.js`、`web/<feature>Admin.js` | `web/server/index.js` |
| 配置 | 相关的 `config/*Runtime.js` | `config/index.js` |
| 记忆写入与召回 | `utils/memoryWritePipeline/`、`utils/memory-v3/` | `utils/memory-v3/index.js` |
| 诊断 | 可复用逻辑所在模块 | `scripts/diagnose-*.js` |

如果一个需求同时改变路由、工具和存储，先把它拆成三个可独立测试的行为，再由现有组合根连接。不要新增一个同时解析消息、调用模型、写文件和发送 QQ 回复的“服务类”。

## 2.6 按需语音输出的当前实现边界（2026-09-05）

本阶段先以 QQ 为可用目标，语音能力的稳定出站边界是 `src/platforms/qqAdapter.js`：私聊使用 `send_private_msg`，群聊使用 `send_group_msg`，消息段为 OneBot `record`，音频使用 MP3 Buffer 的 `base64://` 形式。`companion_voice_reply` 只接收文本，投递目标必须由当前入站消息上下文提供，不能接受模型传入的平台、用户或群 ID。

Provider 放在 `src/features/companion-voice/provider.js`，通过 `COMPANION_VOICE_PROVIDER` 在外部 OpenAI-compatible TTS 与本地 HTTP TTS 中显式二选一；服务层负责分段、顺序、并发和文字回退。QQ 发送错误中，NapCat 连接前失败属于 `not_submitted`，响应无法判断时属于 `unknown`；后者禁止自动重发或文字补发。

截至 2026-09-05，QQ 自动测试、lint、typecheck、密钥扫描和差异检查已通过，真实 TTS/QQ 客户端尚未在当前验收环境执行。完整 `npm test` 仍有 `agentPrompts.test.js`、`checkPromptsIntegration.test.js`（`prompts/ADULT.txt` 未被 manifest/allowlist 引用）和 `voiceInputIngress.test.js`（既有 `VOICE_INPUT_*` 配置期望不一致）失败，本轮未扩大范围修复。Discord 附件、微信 outbox 文件发送和微信 `voice_item` 实验代码暂不视为完成能力，后续实现必须分别补平台定向测试和真实平台验收，不要把 QQ 的 `record` 结构直接复用到其他平台。

## 2. 项目级设计约束

### 2.1 CommonJS 和稳定导出

项目由 `package.json` 声明为 CommonJS。新增模块使用 `require()` 与 `module.exports`，不要在局部引入 ESM、动态转译或第二套模块加载规则。

`src/` 中的实现入口和旧路径 facade 共同构成兼容契约。例如 `src/message/handler.js` 暴露实际实现，`core/messageHandler.js` 保持旧调用方的对象与函数引用一致。修改这类区域时：

1. 把实现放进已有所有者模块。
2. 通过明确的静态 `require()` 和 `module.exports` 暴露公共符号。
3. 保持 facade 的导出名、引用身份和冷启动加载行为。
4. 运行对应的模块边界测试，不通过 facade 复制实现。

旧的 `.chunk.js` 文件是迁移兼容资产，不是新功能扩展点。`scripts/lint.js` 会验证 chunk 组合的语法或入口覆盖；`tests/messageHandlerModuleBoundary.test.js`、`tests/runtimeContextModuleBoundary.test.js` 和 `tests/memoryVectorModuleBoundary.test.js` 还会检查导出身份、依赖方向、唯一所有者与禁止执行旧 chunk loader。不要直接 `require()` 单个 chunk，也不要向旧 chunk 回写新逻辑。

### 2.2 惰性加载只用于真实冷路径

`api/toolRegistry.js` 是工具注册兼容门面。静态 schema 和 executor 在首次访问时加载，动态 MCP 工具在门面中刷新并与能力策略合并。`api/toolExecutors/lazyModules.js` 的 `createLazyModuleProxy()` 用于把 Minecraft、原生技能等重型或低频模块留在冷路径。

新增惰性加载应同时满足：

- 模块不参与启动时的必需校验；
- 首次使用成本可以接受；
- loader 结果被缓存，后续调用保持单例身份；
- 加载失败能在当前功能边界内给出明确结果；
- 不用惰性 `require()` 隐藏循环依赖或所有权不清。

热路径和模块边界已有明确静态依赖时，不要为了“看起来更快”改成函数内 `require()`。相关约束由 `tests/hotpathRequireGuard.test.js` 以及各模块边界测试保护。

### 2.3 在组合根注入依赖

Runtime 节点、协调器和 Web 子路由普遍采用 `createXxx(deps)`、`createXxx(options)` 或 `registerXxxRoute(app, deps)`。例如 `web/mainReplyContextPreviewRoute.js` 可注入 `buildMainReplyContextPreview`，`api/runtimeV2/nodes/agentDecide.js` 与 `api/runtimeV2/nodes/executeTools.js` 可注入模型调用、工具执行、事件和 checkpoint 持久化函数。

遵循以下边界：

- 默认依赖在模块顶部静态导入，生产调用无需手工装配。
- 只在组合函数入口允许替换依赖，业务函数内部不要读取测试全局变量。
- 依赖对象只暴露当前模块真正需要的能力，不传整个运行时对象。
- 测试注入小型 fake，验证输入、输出和副作用；不要修改 `require.cache` 或 monkey patch 全局模块，除非边界测试本身就在验证模块加载语义。

### 2.4 存储和进程生命周期只有一个所有者

所有运行数据从 `config.DATA_DIR` 派生。JSON/JSONL 热存储优先经 `utils/storeRegistry.js` 取得同一路径的共享实例；SQLite 连接遵循 `utils/sqliteConnection.js` 的 WAL、busy timeout 和外键设置。

新增持久化行为时必须明确：

- 数据按用户、会话、群或全局中的哪一级隔离；
- 谁创建目录、谁写入、谁 flush、谁 close；
- 主进程和 post-reply worker 是否会同时访问；
- 崩溃恢复、重复执行和部分写入如何处理；
- 测试如何把 `DATA_DIR` 重定向到临时目录。

底层 store 不得注册 `SIGINT`、`SIGTERM` 并自行结束进程。主进程由 `index.js` 统一停止入口、HTTP 服务、后台引擎、hot store 和 SQLite；worker 由 `scripts/post-reply-worker.js` 统一 drain、flush 和 close。`tests/jsonHotStoreSignalOwnership.test.js` 与 `tests/sqliteConcurrency.test.js` 是这条规则的回归证据。

### 2.5 密钥和外部输入

密钥只来自进程环境、私有 `.env` 或受保护的 Web 设置写入，不进入源码、测试夹具、日志、异常文本和文档示例。新增外部 URL、文件路径或命令参数时，复用现有安全边界：

- 模型端点使用 `utils/networkSafety.js` 校验，避免 SSRF 到 loopback、私网和 metadata 地址；
- 工具参数在 schema 和 executor 两侧都验证；
- Web 写操作保留会话鉴权与严格同源检查；
- 日志只记录脱敏标识、状态、耗时和可关联的 request ID；
- 提交前运行 `npm run check:secrets:all`。

## 3. 常见开发配方

### 3.1 添加消息本地路由

本地规则应处理确定、低成本、无需模型判断的意图；模糊语义仍交给现有 hybrid/AI 路由。

1. 在 `core/router/index.js` 找到最窄的规则组：terminal、action 或 direct。
2. 如果产生新的策略键，在 `core/routeProfiles.js` 定义工具提示和执行计划。
3. 在 `core/routeExecution.js` 把路由归一为已有 executor 能理解的计划；不要在 router 里直接执行工具。
4. 只有发送或 Runtime 组合方式变化时才修改 `core/messageRouteFlow/index.js`。
5. 用窄测试覆盖命中、相近文本不误命中、普通/管理员权限差异和最终执行计划。

```bash
node scripts/run-tests.js tests/routerChineseKeywords.test.js tests/routeExecution.test.js tests/routeMetaEnvelope.test.js
npm run diag:route-decision -- --text "用于复现的消息" --user-id test_user
```

诊断命令的预测结果不能代替回归测试；它用于确认新规则在完整优先级中的位置。

### 3.2 添加模型能力或本地工具

一个可调用工具至少有 schema、executor、权限/路由策略和测试四部分。

1. 在最合适的 `api/toolSchemas/*.js` 数组中加入 OpenAI/LangGraph 兼容 schema，参数保持小而明确。
2. 在 `api/toolExecutors/index.js` 注册同名 executor；复杂实现放到 `api/skills_native/` 或独立模块，executor 只做归一化和调用。
3. 重型冷门实现通过 `createLazyModuleProxy()` 加载，普通小工具保持静态依赖。
4. 检查 `utils/toolPolicy/`、`utils/localToolAccess.js` 和 `core/routeProfiles.js` 是否需要显式允许；不要用扩大全局 allowlist 的方式修一个场景。
5. 通过 `api/toolRegistry.js` 的 `getToolSchemaByName()`、`getToolExecutor()` 等公共入口验证，不绕过 companion 过滤或动态 MCP 合并。

```bash
node scripts/run-tests.js tests/toolContractsValidation.test.js tests/toolExecutionValidation.test.js tests/nativeSkills.test.js
npm run check:agent:static
```

若改的是 provider 请求能力而不是工具，优先在 `api/httpClient.js` 或 `api/createAgent/` 的请求构造边界实现，并补对应协议测试，例如 Anthropic、OpenAI-compatible 或 Gemini 的请求体与响应解析测试。不要把 provider 特例散落到路由节点。

### 3.3 添加后台功能

先选择执行角色：

- 需要与当前对话生命周期绑定、可取消的工作，放入 `utils/backgroundTaskRuntime.js` 体系；
- 回复完成后的学习、提取和物化，进入 post-reply queue，由 `scripts/post-reply-worker.js` 执行；
- 周期扫描或主动触达，扩展已有 scheduler/tick/feature 引擎；
- 不要再创建第三个常驻进程，除非已有两种角色确实无法承担并且部署方案已获确认。

实现必须包含启动、停止、重复启动保护、取消/drain、持久化恢复和可观测状态。用注入的 clock、runner、store 或 sender 测试，不在单元测试中真实等待定时器。

```bash
node scripts/run-tests.js tests/backgroundTaskRuntimeRace.test.js tests/serverLifecycle.test.js
node scripts/run-tests.js tests/postReplyWorkerRuntime.test.js tests/postReplyWorkerDrain.test.js
```

### 3.4 添加 Web 管理端点

`web/server/index.js` 是 Express 组合根和内联管理页，不应继续堆积独立业务逻辑。参考 `web/mainReplyContextPreviewRoute.js`：

1. 把解析、边界值和路由注册放入独立 `web/<feature>Route.js`。
2. 把可复用查询/变更逻辑放回所属业务模块，通过 `deps` 注入测试替身。
3. 在 `createWebApp()` 的统一鉴权中间件之后注册管理 API。
4. GET 只读；POST/DELETE 等写请求依赖已有严格同源检查，并验证请求体上限、标识范围和权限。
5. 页面片段较大时放入 `web/<feature>Admin.js`，保持 route、HTML 和业务存储分离。
6. 返回密钥时只给 `has_*` 和掩码，不返回原值。

```bash
node scripts/run-tests.js tests/mainReplyContextPreviewRoute.test.js tests/webAuthSecurity.test.js tests/webSecurityHeaders.test.js
```

健康端点 `/live`、`/ready`、`/healthz` 位于鉴权之前，只允许返回最小布尔健康信息。不要把诊断详情加到这些公开探针。

### 3.5 添加配置项

1. 在相关 `config/*Runtime.js` 的 builder 中加入同一主题的配置；没有合适模块时才放入 `config/index.js`。
2. 使用 `pick()`、`pickBool()`、`pickNum()` 或 `pickList()`，默认值必须在缺省部署中安全且可运行。
3. 只验证会导致状态不一致的约束。不要对可信内部调用叠加重复防御和宽泛 `try/catch`。
4. 在 `.env.example` 写名称和非敏感说明，不填真实 token、账号或内网地址。
5. 默认值或配置回退变化必须有测试；跨进程配置还要覆盖 main/worker 两个角色。

```bash
node scripts/run-tests.js tests/envFile.test.js tests/nodeVersionPolicy.test.js tests/lowResourceConfig.test.js
npm run check:agent:static
```

配置模块在首次 `require('../config')` 时读取环境，因此测试必须先设置环境变量和临时 `DATA_DIR`，再清理项目模块缓存并加载配置。

### 3.6 添加 Prompt 模块

静态资产由 `prompts/prompt-manifest.json` 声明，加载和校验由 `config/promptRuntime.js`、`utils/promptManifest.js` 与 `utils/promptCompiler.js` 负责；运行时动态块由 `src/runtime-v2/context/` 组装。

1. 先判断内容是稳定系统约束、动态上下文还是 few-shot 示例。
2. 静态资产同时更新 manifest 的 stage、authority、priority、预算和适用条件。
3. 动态块复用 `utils/stagePromptContracts.js` 和现有 prompt block 结构，明确 source/lane/budget。
4. 私有 `prompts/admin.txt` 和 `prompts/persona/` 不进入提交；任何情况下都不要修改管理员私有 prompt。
5. 补编译、顺序、预算、普通用户/管理员隔离及注入安全测试。

```bash
npm run check:prompts
node scripts/run-tests.js tests/promptCompiler.test.js tests/promptSecurity.test.js tests/promptStageContracts.test.js
```

不要靠字符串拼接把新规则塞进最终请求，也不要只更新 snapshot 来接受未经解释的 prompt 变化。

### 3.7 修改记忆行为

记忆写入从 `utils/memoryWritePipeline/index.js` 进入质量门禁，再由 Memory V3 事件、版本化更新、投影和向量索引承担各自职责。召回查询位于 `utils/memory-v3/query.js` 及其 ranking/filter 模块。

1. 明确改变的是证据提取、写入门禁、事件格式、物化投影、召回候选、排序还是最终 prompt 包。
2. 保持 user/group/session namespace，不允许用默认值把不同用户的数据合并。
3. 更新是追加事件还是替换事实，必须沿用版本和冲突解决规则。
4. 向量索引是派生数据，权威事实仍由事件/结构化存储所有；不要为了召回方便直接写索引。
5. 测试使用临时 `DATA_DIR`，覆盖重复写入、冲突、重启恢复和旧数据兼容。

```bash
node scripts/run-tests.js tests/memoryWritePipeline.test.js tests/memoryWritePipelineQualityGate.test.js
node scripts/run-tests.js tests/memoryV3VersionedUpdate.test.js tests/memoryV3RecallVerificationFilter.test.js
npm run diag:memory -- diagnose --read-only --limit 5
```

### 3.8 添加诊断命令

诊断的核心是“解释证据”，不是另写一套业务判断。

1. 把日志读取、聚合和状态判定放入可导出的业务诊断模块。
2. `scripts/diagnose-*.js` 只解析参数、调用 builder、输出 text/JSON 并设置退出码。
3. 默认只读；可能清理、迁移、重排或重试时必须使用显式动作参数，并在帮助中标明副作用。
4. 输出 request ID、时间窗、来源文件、样本数和判定原因；密钥、完整 prompt 与用户原文默认脱敏。
5. 用临时数据目录构造正常、缺失、陈旧和损坏证据测试。

参考 `scripts/diagnose-runtime-status.js` 与 `tests/runtimeStatusDiagnostics.test.js` 的 CLI/逻辑分层。

## 4. 一次改动的最小闭环

1. 写下行为差异、所有者模块、兼容入口和数据副作用。
2. 先运行最接近的现有测试，确认基线。
3. 增加一个会因缺少新行为而失败的窄测试。
4. 做最小实现，不顺带迁移目录、清理旧代码或扩大配置面。
5. 运行该测试及相邻边界测试。
6. 运行与改动匹配的质量门禁，完整规则见 [测试与质量](./06-testing-and-quality.md)。
7. 用真实诊断或本地 smoke 验收跨模块行为，记录命令、结果和时间。
8. 检查 `git diff --check` 和变更文件列表，确认没有覆盖并行开发者的修改。

“代码能加载”只证明语法成立；功能完成必须同时有行为测试、边界测试和适合风险等级的运行验收。
