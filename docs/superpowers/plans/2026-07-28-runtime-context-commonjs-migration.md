# Runtime V2 Context CommonJS Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将目标5剩余的 `runtime-v2/context` 入口从共享词法作用域动态chunk迁为显式依赖的CommonJS模块，保持主回复prompt行为、公开API、缓存和惰性加载边界不变。

**Architecture:** 先用边界测试锁定13项公开API、`api/runtimeV2/context/service` 与新入口的精确对象/函数身份、`promptLayerCache` 单例和memory-inputs惰性加载。随后按纯规范化/配置、上下文连续性与记忆、prompt块、路由与时序、计划与缓存、输入收集、基础/动态渲染、vision拆成单向模块；两个旧chunk强连通分量只通过提取最小共享依赖打破，禁止以新聚合模块或反向require复建循环。

**Tech Stack:** Node.js 20/24、CommonJS、TypeScript Compiler API、ESLint、项目自定义测试运行器。

---

## 审计基线与不变量

当前生产入口 `src/runtime-v2/context/index.js` 调用 `runCommonJsChunks`，按顺序执行10个 `api/runtimeV2/context/*.chunk.js`。审计必须先将这10个文件按入口声明顺序拼接为一个 `SourceFile`，再用 TypeScript Compiler API 统计：110个顶层具名函数、5个顶层变量、115个唯一顶层绑定。不得按单chunk解析后相加，因为4个chunk本身是跨文件函数片段，所得16/126不是运行时词法作用域的口径。

迁移后必须满足：

- `src/runtime-v2/context/index.js` 不得导入或调用 `runCommonJsChunks`、`createRequire`、legacy chunk。
- `api/runtimeV2/context/service.js` 继续是唯一直接兼容门面，且其导出对象与 `src/runtime-v2/context` 完全相同；`api/graphPrompting.js`仅维持现有转发链并观察同一对象。
- 精确13项主API：`buildBaseDynamicPrompt`、`buildDirectedContextPromptSnippet`、`buildDynamicPrompt`、`buildRoleplayInnerProtocolPromptSnippet`、`buildRoleplayRuntimeContextPromptSnippet`、`buildShortTermContinuityPrompt`、`buildVisionLiteTextContent`、`buildVisionMessageContent`、`formatResearchBriefsForPrompt`、`mergeAllowedToolsWithMemoryCli`、`promptLayerCache`、`shouldBypassHumanizerForPolicy`、`shouldExposeMemoryCli`。
- `promptLayerCache` 仍由一个实现模块唯一创建；所有门面和调用方观察同一对象，不复制Map或包装API函数。
- `memory-inputs-core` 保持可被热路径独立require；实际记忆收集所需的 `utils/memoryContext`、`utils/personaMemoryState`、`utils/memosPlannerRecall`、`utils/memoryRecallDeduper`、`utils/openVikingMemory/recall`、`utils/openVikingMemory/deduper`、`utils/recallHeuristics`、`utils/memory-v3/storage`、`utils/memory-v3/materializer`、`utils/memory-v3/embeddingIndex`、`utils/lancedbMemoryStore`、`utils/memorySemanticIndex` 和原生 `@lancedb/lancedb` 只在调用期加载；仅require context入口或 `memory-inputs` 不得触发它们。
- 保留10个legacy chunk和 `src/shared/chunkedModule.js`，不删除、不修改；删除文件需要另行授权。
- 新实现图必须是DAG。模块只可依赖下游明确导出，禁止模块依赖 `index.js` 或任一门面；每个可变缓存/状态仅有一个owner。
- `scripts/lint.js` 不得再把保留的context chunk逐个传给 `new Function`：其中 `base-dynamic-prompt*.chunk.js` 与 `dynamic-prompt*.chunk.js` 不是独立语法单元。lint必须将精确的10个文件按旧入口顺序合并后仅作语法验证，不得require或执行合并内容，并在JSON报告标为 `coverage: legacy-retained-combined`、`execution: not-run`。

目标实现目录：

| 模块 | 职责 | 允许本地依赖 |
| --- | --- | --- |
| `normalization.js` | 通用字符串、数组、时间、hash、token归一化 | 无 |
| `config.js` | 运行配置读取、prompt常量与稳定键 | `normalization.js` |
| `memory-inputs-core.js` | 热路径可独立加载的memory CLI可见性与工具合并 | 无本地依赖 |
| `continuity.js` | 短期连续性、定向上下文和角色运行时片段 | `normalization.js`、`config.js` |
| `memory.js` | 记忆需求、回退记忆上下文和调用期重依赖入口 | `normalization.js`、`config.js`、`memory-inputs-core.js` |
| `prompt-blocks.js` | block创建、排序、预算和序列化 | `normalization.js`、`config.js` |
| `route-timing.js` | 路由条件、时序诊断和prompt决策辅助 | `normalization.js`、`config.js` |
| `support.js` | research brief与无状态通用辅助 | `normalization.js`、`config.js` |
| `plan.js` | 动态prompt计划校验、过滤和允许工具合并 | `normalization.js`、`config.js`、`prompt-blocks.js`、`memory-inputs-core.js` |
| `cache.js` | `promptLayerCache`、key、TTL、clone和裁剪 | `normalization.js`、`config.js` |
| `prompt-inputs.js` | 聚合运行时、连续性、记忆和planner输入 | `continuity.js`、`memory.js`、`plan.js`、`route-timing.js`、`support.js` |
| `base.js` | 基础动态prompt构建 | `prompt-inputs.js`、`prompt-blocks.js`、`support.js`、`plan.js`、`cache.js` |
| `render.js` | prompt层渲染与结构化消息输出 | `prompt-blocks.js`、`cache.js`、`support.js`、`base.js` |
| `dynamic.js` | 主动态prompt编排和cache写入 | `base.js`、`render.js`、`plan.js`、`cache.js` |
| `vision.js` | 视觉文本和图片消息内容 | `normalization.js`、`config.js`、`support.js` |

### SCC拆解和最终DAG

先在边界测试中记录下面两个旧词法耦合组，禁止把同一组直接改为互相require：

| 旧组 | 现有跨边 | 最终owner与切断方式 |
| --- | --- | --- |
| `service-core.chunk.js` <-> `dynamic-plan.chunk.js` | service core读取`cloneDynamicPromptPlan`；dynamic plan读取`normalizeText`、`normalizeArray`、`DYNAMIC_CONTEXT_PLAN_VERSION`和`ensureGroupDirectPersonaModulePlan` | `normalization.js`拥有两个normalize函数，`config.js`拥有版本键，`plan.js`拥有clone/plan校验和group-direct计划；二者只向下游导入，不再互引。 |
| 基础/动态prompt跨片段组（`base-dynamic-prompt*.chunk.js`、`dynamic-prompt*.chunk.js`、`render-helpers.chunk.js`） | `renderPromptLayers -> buildBaseDynamicPrompt`，动态编排读取cache/plan/block，旧片段以同一函数局部变量续接 | `base.js`拥有基础构建，`render.js`拥有渲染到base的单向调用，`dynamic.js`拥有最终编排；共享选择/缓存分别下沉到`plan.js`/`cache.js`，不允许base、render或dynamic反向require。 |

最终15个实现模块的允许本地边必须与上表逐项一致；边界测试收集真实require图并断言下面的依赖先行拓扑（允许边是上表各行的并集，禁止任何额外边）：

`normalization -> config -> memory-inputs-core -> continuity -> memory -> prompt-blocks -> route-timing -> support -> plan -> cache -> prompt-inputs -> base -> render -> dynamic -> vision`

该顺序的箭头表示“后者可依赖前者”，并非运行时调用方向。`promptLayerCache`唯一owner是`cache.js`；不得创建同名缓存、缓存工厂或包装对象。

## Chunk 1: 契约与低层依赖

### Task 1: 建立红灯模块边界测试

**Files:**
- Create: `tests/runtimeContextModuleBoundary.test.js`
- Modify: `scripts/lint.js`
- Read: `src/runtime-v2/context/index.js`
- Read: `api/runtimeV2/context/service.js`
- Read: `api/graphPrompting.js`

- [x] **Step 1: 写入会失败的完整契约测试**

在测试中排序比较13项键，断言 `require('../api/runtimeV2/context/service') === require('../src/runtime-v2/context') === require('../api/graphPrompting')`，并逐项断言函数引用相等。固定六个子门面精确键和identity：`cache`=`promptLayerCache`；`dynamic-plan`=`buildBaseDynamicPrompt,buildDynamicPrompt`；`memory-inputs`=`mergeAllowedToolsWithMemoryCli,shouldExposeMemoryCli`；`prompt-blocks`=`buildDirectedContextPromptSnippet`；`render`=`buildBaseDynamicPrompt,buildDynamicPrompt,formatResearchBriefsForPrompt`；`vision`=`buildVisionMessageContent,shouldBypassHumanizerForPolicy`。每项必须与主入口同一引用，不能只验证行为相等。

- [x] **Step 2: 固定缓存、门面和完整惰性约束**

以完整`require.cache`快照包裹每个探针，finally中逐项还原原Module对象、环境变量和cache key集合。删除相关缓存后加载入口，断言`promptLayerCache` identity与`cache.js`相等；对“不变量”段列出的12个项目模块和`@lancedb/lancedb`逐一断言未加载。另独立require `memory-inputs`，断言它不加载入口、service或`memory-v3/materializer`，覆盖既有`hotpathRequireGuard`契约。将`chunkedModule`替换为仅对这10个旧chunk抛错的cache模块后重新加载入口，验证当前入口红灯且探针无泄漏。

- [x] **Step 3: 固定审计映射、DAG和lint旧分片协议**

测试先按旧入口顺序拼接10个chunk，生成包含110个函数和5个变量的逐名映射（旧名、旧声明位置、目标模块、目标声明位置），再断言新实现映射恰好覆盖115个唯一名。使用TypeScript Compiler API收集15个实现模块的本地require边，断言无未知自由变量、无额外边、0循环、拓扑顺序符合“SCC拆解和最终DAG”、`promptLayerCache`仅在`cache.js`声明，且新模块不得require `index.js`、任一门面或chunk。最后以子进程运行`node scripts/lint.js --report-json`并解析stdout，断言context的10个chunk只有一个`coverage: legacy-retained-combined, execution: not-run`记录、按旧顺序合并；同时AST检查lint的合并分支不调用require。

- [x] **Step 4: 确认红灯**

Run: `node tests/runtimeContextModuleBoundary.test.js`

Expected: FAIL，指出 `index.js` 仍执行 `runCommonJsChunks`；测试自身在每次探针后恢复 `require.cache`、被替换的loader和环境变量。

- [x] **Step 5: 写入最小lint兼容实现并确认仍保留迁移红灯**

在`scripts/lint.js`的chunk覆盖逻辑中为context声明固定的legacy-retained有序列表：它只能拼接并用`new Function`作语法校验，绝不require、绝不调用`runCommonJsChunks`，并把JSON记录为`coverage: legacy-retained-combined, execution: not-run`。不得更改10个chunk或让静态入口保留chunk字符串。

Run: `node scripts/lint.js --report-json`

Expected: JSON中context旧分片为一个通过的合并语法记录；`node tests/runtimeContextModuleBoundary.test.js`仍因旧动态入口失败。

### Task 2: 提取规范化、配置及共享无状态支持

**Files:**
- Create: `src/runtime-v2/context/normalization.js`
- Create: `src/runtime-v2/context/config.js`
- Create: `src/runtime-v2/context/support.js`
- Test: `tests/runtimeContextModuleBoundary.test.js`

- [x] **Step 1: 从逐名映射中选择低层owner**

按AST将无本地依赖的文本/数组、时间、hash、token处理移入 `normalization.js`；将 `getConfig()`、常量和稳定配置键移入 `config.js`；research brief与纯辅助移入 `support.js`。保留原函数名、参数、返回值和现有依赖读取时机。

- [x] **Step 2: 以显式导入替代共享词法作用域**

为每个跨模块使用点添加具名CommonJS导入；不把调用点改为宽泛对象传递，不新增吞错或类型转换，不捕获可被测试替换的方法引用。

- [x] **Step 3: 验证低层DAG仍为红灯阶段**

Run: `node tests/runtimeContextModuleBoundary.test.js`

Expected: 仍因入口动态加载失败，但AST子断言显示新低层模块无未知变量、无反向依赖。

- [x] **Step 4: 暂不提交不完整迁移**

不得提交只包含部分实现且仍由动态入口执行的中间状态；保留工作树，继续完成同一实现提交。此步骤防止可发布分支落入半迁移状态。

## Chunk 2: 上下文语义与编排依赖

### Task 3: 提取连续性、记忆与prompt块

**Files:**
- Create: `src/runtime-v2/context/continuity.js`
- Create: `src/runtime-v2/context/memory.js`
- Create: `src/runtime-v2/context/prompt-blocks.js`
- Modify: `src/runtime-v2/context/memory-inputs.js`
- Test: `tests/promptGoldenSnapshots.test.js`
- Test: `tests/runtimeV2PromptTimeoutMemoryFallback.test.js`
- Test: `tests/messageDirectedForwardContext.test.js`

- [x] **Step 1: 从红灯映射迁移连续性和定向上下文函数**

将 `buildShortTermContinuityPrompt`、`buildDirectedContextPromptSnippet`、角色运行时与inner protocol片段归入 `continuity.js`，只显式依赖Task 2模块；保持转发消息、Unix seconds时间戳和当前用户回合去重语义。

- [x] **Step 2: 建立精确的惰性记忆边界**

保留`memory-inputs-core.js`的两个现有导出和其热路径独立加载能力；`memory-inputs.js`只薄转发这两个引用。把记忆召回预算、fallback和真正的memory输入桥接归`memory.js`，并让它只在`collectPromptInputs`实际请求时逐路径require不变量列表中的重依赖。不得在任一新模块顶层加载memory-v3、LanceDB、语义索引、memoryContext、personaMemoryState、memos或OpenViking运行时。

- [x] **Step 3: 拆出block生命周期**

将创建、规范化、选择、预算、消息序列化和snapshot字段处理归 `prompt-blocks.js`；它不读取记忆存储、不拥有cache、不调用render。

- [x] **Step 4: 运行语义聚焦绿灯**

Run: `node scripts/run-tests.js tests/promptGoldenSnapshots.test.js tests/runtimeV2PromptTimeoutMemoryFallback.test.js tests/messageDirectedForwardContext.test.js tests/hotpathRequireGuard.test.js`

Expected: 全部通过，普通chat fallback不构建环境记忆上下文，显式记忆召回仍保留，forwarded context和时间格式保持原行为。

- [x] **Step 5: 不提交，继续完成依赖闭包**

本任务产生的模块尚未被静态入口使用；除非Task 6的边界测试已绿，不得单独提交。

### Task 4: 提取路由、时序、计划、缓存和输入聚合

**Files:**
- Create: `src/runtime-v2/context/route-timing.js`
- Create: `src/runtime-v2/context/plan.js`
- Create: `src/runtime-v2/context/cache.js`
- Create: `src/runtime-v2/context/prompt-inputs.js`
- Modify: `src/runtime-v2/context/memory-inputs.js`
- Test: `tests/runtimeV2SessionPromptCacheStability.test.js`
- Test: `tests/runtimeV2PromptOptimization.test.js`
- Test: `tests/plannerV2Protocol.test.js`

- [x] **Step 1: 按已登记cut打破第一个SCC**

将路线分类、耗时记录和无状态判定放入`route-timing.js`；将planner schema、clone、决策校验、过滤和`mergeAllowedToolsWithMemoryCli`放入`plan.js`。先将`normalizeText`/`normalizeArray`和`DYNAMIC_CONTEXT_PLAN_VERSION`分别迁至normalization/config，确保`plan.js`不再反向取service-core。`plan.js`只读取block目录和`memory-inputs-core.js`，不可反向调用输入收集。

- [x] **Step 2: 让cache成为唯一状态owner**

在 `cache.js` 唯一创建 `promptLayerCache = { stable: Map, session: Map }` 并迁移key、clone、TTL/prune逻辑。所有消费者显式导入同一对象；禁止重建或导出cache工厂。

- [x] **Step 3: 汇聚调用期输入并固定第二个cut**

`prompt-inputs.js`负责收集route、continuity、memory、planner、persona/worldbook输入并返回既有对象形状；它是调用时边界。基础/动态prompt的共享选择和缓存只能从`plan.js`/`cache.js`向下读取，禁止通过render或index回调，消除第二个旧跨片段组。

- [x] **Step 4: 运行缓存和planner绿灯**

Run: `node scripts/run-tests.js tests/runtimeV2SessionPromptCacheStability.test.js tests/runtimeV2PromptOptimization.test.js tests/plannerV2Protocol.test.js`

Expected: 全部通过；稳定/会话缓存为同一Map，planner必须块、dynamic plan过滤和memory CLI工具合并保持不变。

- [x] **Step 5: 不提交，等待静态入口绿灯**

这四个模块需要和Task 5/6共同提交，避免保留一个可require但不完整的内部图。

## Chunk 3: 渲染、入口和全量验收

### Task 5: 提取基础、渲染、动态与vision实现

**Files:**
- Create: `src/runtime-v2/context/base.js`
- Create: `src/runtime-v2/context/render.js`
- Create: `src/runtime-v2/context/dynamic.js`
- Create: `src/runtime-v2/context/vision.js`
- Test: `tests/runtimeV2VisionMessageContent.test.js`
- Test: `tests/adminStableSystemPrompt.test.js`
- Test: `tests/openVikingPromptIntegration.test.js`
- Test: `tests/localPromptRecall.test.js`

- [x] **Step 1: 将基础prompt构建收敛到 `base.js`**

迁移 `buildBaseDynamicPrompt` 及其仅基础层依赖，保持stable prompt、管理员边界和已有snapshot字段。

- [x] **Step 2: 将层渲染与动态编排分离**

`render.js` 只转换已选block为文本/消息，`dynamic.js` 负责 `buildDynamicPrompt`、cache读取写入、plan与base调用。两者不得反向依赖，避免重建SCC。

- [x] **Step 3: 迁移视觉路径**

将图片URL去重、意图识别、文本预算、`buildVisionLiteTextContent`、`buildVisionMessageContent` 和 `shouldBypassHumanizerForPolicy` 移入 `vision.js`；保留data URL和大上下文裁剪行为。

- [x] **Step 4: 运行渲染与视觉绿灯**

Run: `node scripts/run-tests.js tests/runtimeV2VisionMessageContent.test.js tests/adminStableSystemPrompt.test.js tests/openVikingPromptIntegration.test.js tests/localPromptRecall.test.js`

Expected: 全部通过；vision重复上下文受限、管理员prompt不泄漏给普通用户、OpenViking输入与cache可观察性不变。

- [x] **Step 5: 保持未提交，进入入口切换**

不得在入口仍动态加载时提交此任务的结果。

### Task 6: 静态入口与兼容门面

**Files:**
- Modify: `src/runtime-v2/context/index.js`
- Modify: `src/runtime-v2/context/cache.js`
- Modify: `src/runtime-v2/context/dynamic-plan.js`
- Modify: `src/runtime-v2/context/memory-inputs.js`
- Modify: `src/runtime-v2/context/prompt-blocks.js`
- Modify: `src/runtime-v2/context/render.js`
- Modify: `src/runtime-v2/context/vision.js`
- Read: `api/runtimeV2/context/service.js`
- Read: `api/graphPrompting.js`
- Test: `tests/runtimeContextModuleBoundary.test.js`

- [x] **Step 1: 以静态显式导入重写index**

按DAG加载实现模块，构造且仅导出精确13项键。导出的函数必须直接引用实现函数，`promptLayerCache` 必须直接引用 `cache.js` 的对象。

- [x] **Step 2: 保持现有子门面和graph转发的精确identity**

将当前`cache/dynamic-plan/memory-inputs/prompt-blocks/render/vision`门面改为直接从对应实现模块取已有公开引用；键必须分别精确等于Task 1所列六组，不能添加辅助导出。`api/runtimeV2/context/service.js`和`api/graphPrompting.js`保持原兼容require链，均与主入口同一对象；不得从`index.js`反向取值而形成循环。

- [x] **Step 3: 将边界和lint测试由红转绿**

Run: `node tests/runtimeContextModuleBoundary.test.js; node scripts/lint.js --report-json`

Expected: PASS；动态loader未执行，13项API/函数身份、六个门面、graph转发、cache identity和惰性memory输入全部通过；110函数/5变量/115绑定的逐名映射完整，未知自由变量和循环均为0；lint报告的旧分片仅为一个不执行的合并语法记录。

- [x] **Step 4: 提交可运行的实现和边界测试**

先运行`git status --short`和`git diff --name-only`，人工确认没有其他代理修改目标路径；再只暂存本计划列出的精确文件，禁止目录级`git add`：

```powershell
git add -- scripts/lint.js tests/runtimeContextModuleBoundary.test.js src/runtime-v2/context/index.js src/runtime-v2/context/normalization.js src/runtime-v2/context/config.js src/runtime-v2/context/memory-inputs-core.js src/runtime-v2/context/continuity.js src/runtime-v2/context/memory.js src/runtime-v2/context/prompt-blocks.js src/runtime-v2/context/route-timing.js src/runtime-v2/context/support.js src/runtime-v2/context/plan.js src/runtime-v2/context/cache.js src/runtime-v2/context/prompt-inputs.js src/runtime-v2/context/base.js src/runtime-v2/context/render.js src/runtime-v2/context/dynamic.js src/runtime-v2/context/vision.js src/runtime-v2/context/dynamic-plan.js src/runtime-v2/context/memory-inputs.js api/runtimeV2/context/service.js
git diff --cached --check
git diff --cached --name-status
git commit -m "refactor: replace runtime context chunk loader"
```

Expected: 仅实现、lint协议、兼容门面和边界测试进入提交；旧10个chunk、并行CI、覆盖率、依赖/安全诊断、`.codex/`和移动端截图均不进入暂存区。

### Task 7: 完整质量门禁

**Files:**
- Test: `tests/runtimeContextModuleBoundary.test.js`
- Test: `tests/promptGoldenSnapshots.test.js`
- Test: `tests/runtimeV2PromptTimeoutMemoryFallback.test.js`
- Test: `tests/runtimeV2SessionPromptCacheStability.test.js`
- Test: `tests/runtimeV2VisionMessageContent.test.js`
- Test: `tests/localPromptRecall.test.js`
- Test: `tests/hotpathRequireGuard.test.js`

- [ ] **Step 1: 校验双Node前置条件**（未完成：当前环境未提供 Node 20）

在PowerShell中将外置Node 20绝对路径设置为`$env:NODE20_EXE`（推荐`C:\Program Files\nodejs-20\node.exe`）。若该文件不存在或版本不是v20，本任务不得把双版本门禁记为通过；当前默认`node`必须是v24。

Run:

```powershell
$node20 = $env:NODE20_EXE
if (-not $node20 -or -not (Test-Path -LiteralPath $node20)) { throw 'Set NODE20_EXE to an absolute Node 20 node.exe path.' }
if (-not ((& $node20 --version) -match '^v20\.')) { throw 'NODE20_EXE is not Node 20.' }
if (-not ((node --version) -match '^v24\.')) { throw 'Default node is not Node 24.' }
& $node20 --version
node --version
```

Expected: 输出一个v20和一个v24版本；缺少任一版本是明确阻塞，不得以单版本替代。

- [ ] **Step 2: Node 20和24运行相同聚焦测试**（未完成：缺少 Node 20）

Run:

```powershell
$focused = @('tests/runtimeContextModuleBoundary.test.js', 'tests/promptGoldenSnapshots.test.js', 'tests/runtimeV2PromptTimeoutMemoryFallback.test.js', 'tests/runtimeV2SessionPromptCacheStability.test.js', 'tests/runtimeV2PromptOptimization.test.js', 'tests/runtimeV2VisionMessageContent.test.js', 'tests/messageDirectedForwardContext.test.js', 'tests/adminStableSystemPrompt.test.js', 'tests/openVikingPromptIntegration.test.js', 'tests/localPromptRecall.test.js', 'tests/hotpathRequireGuard.test.js')
& $node20 scripts/run-tests.js @focused
node scripts/run-tests.js @focused
```

Expected: Node 20和Node 24均全部通过；记录两套版本和用例数。

- [x] **Step 3: 执行静态与安全绿灯**

Run: `npm run lint; npm run typecheck; npm run check:prompts; npm run check:secrets:all; npm audit --omit=dev; git diff --check`

Expected: lint/typecheck/prompts/secrets/diff通过；如audit仅有HEAD既有依赖问题，记录为已知外部风险而非迁移回归。

- [ ] **Step 4: 并发全量绿灯与未跟踪文件检查**（未完成：全量包含既有基线失败）

Run: `$env:TEST_CONCURRENCY='4'; npm test; git status --short; git ls-files --others --exclude-standard`

Expected: 全量测试通过；状态只含本任务文件，未跟踪文件清单为空或仅为明确将提交的迁移文件。

### Task 8: 精确提交与文档验收

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`
- Modify: `docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md`
- Modify: `docs/superpowers/plans/2026-07-28-runtime-context-commonjs-migration.md`

- [x] **Step 1: 回读实现提交，不重复暂存**

Run: `git show --stat --oneline HEAD && git show --format= --name-only HEAD`

Expected: HEAD是Task 6的`refactor: replace runtime context chunk loader`，且只含精确实现、lint协议、兼容门面和边界测试；不纳入并行CI、覆盖率、依赖/安全诊断、`.codex/`或移动端截图文件。

- [x] **Step 2: 更新面向用户的状态文档**

在README、维护日志和32目标路线图追加简短 `2026-07-29 09:57 +08:00` 验收记录：10个chunk已替换、13项契约/惰性边界、Node 24聚焦和静态门禁结果。目标5更新为 `5/6`，仅余 `message/handler`；目标6仍等待最后入口后生成权威生产依赖图。

- [x] **Step 3: 精确暂存文档、提交并回读验收**

Run:

```powershell
git status --short
git add -- README.md docs/maintenance-log.md docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md docs/superpowers/plans/2026-07-28-runtime-context-commonjs-migration.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: record runtime context migration"
git status --short
git log -2 --oneline
```

Expected: 两个精确提交存在、工作树无本任务遗留修改；不推送远端。

## 实际验收记录（2026-07-29 09:57 +08:00）

- 实现提交：`0144d51`。10个 legacy context chunk 保持未修改，生产入口改为15个显式 CommonJS 模块；`promptLayerCache` 仅由 `cache.js` 创建，边界测试确认13项主 API、6组子门面、惰性 memory 输入和0本地循环依赖。
- Node 24.14.1 聚焦：`runtimeContextModuleBoundary`、prompt golden、timeout/memory fallback、session cache、prompt optimization、vision、directed context、openViking、local recall、hotpath guard 共10项通过；会写入只读 `prompts/admin.txt` 的 `adminStableSystemPrompt` 未运行。
- 静态门禁：`npm run lint`（785文件）、`npm run typecheck`、`npm run check:prompts`、`npm run check:secrets:all`、`git diff --check` 全部通过。context lint 仅生成一条 `legacy-retained-combined` 且 `execution=not-run` 记录。
- 环境限制：当前未找到 Node 20，未宣称双版本；`TEST_CONCURRENCY=4 npm test` 仍失败于只读 admin prompt 测试及 `mainReplyUnifiedDiagnostics`、`memoryV3EmbeddingBackfillConcurrency`、`memoryV3RagExplainDiagnostic` 四项既有基线断言，均可脱离本批单独复现。
- 依赖审计：`npm audit --omit=dev` 退出1，报告 HEAD 既有 `sharp` 高危和 `body-parser` 低危；本批未修改 `package.json` 或 lock。`prompts/admin.txt` 保持310字节、ReadOnly，SHA-256 为 `2D42628CF64AB3235F1AB7AE6306081CA0FBCE8114AB344B193F686A7DB7C607`。
