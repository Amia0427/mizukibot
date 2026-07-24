# Meme CommonJS Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将目标5的 `meme` 入口从9个共享词法作用域chunk迁为显式依赖、可独立解析且公开契约不变的CommonJS模块。

**Architecture:** 保持 `core/memeManager.js`、`src/features/meme` 的16项主入口API及5个子门面的精确键集合和函数身份不变。按模型配置、上下文归一化、运行状态、门控、素材分析、重建索引、选择器、管理命令、跟发编排和生命周期拆为单向依赖；6项可变singleton各归唯一模块，旧chunk保留但生产入口不再读取或执行。

**Tech Stack:** Node.js 20、CommonJS、TypeScript Compiler API、ESLint、项目自定义测试运行器。

---

## 文件职责与不变量

| 文件 | 唯一职责 | 迁移函数数 |
| --- | --- | ---: |
| `src/features/meme/model-config.js` | selector与素材分析的URL、密钥、模型配置 | 7 |
| `src/features/meme/context.js` | selector输出归一化、最近消息、引用与回复特征 | 21 |
| `src/features/meme/runtime-state.js` | 运行存储持久化与群跟发状态 | 9 |
| `src/features/meme/gate.js` | gate、分类评分与本地fallback判定 | 11 |
| `src/features/meme/asset-analysis-runtime.js` | 素材输入、模型分析与分析结果合并 | 6 |
| `src/features/meme/reindex-runtime.js` | 重建索引队列与串行消费 | 5 |
| `src/features/meme/selector-runtime.js` | 分类与素材选择、selector模型调用 | 10 |
| `src/features/meme/admin-runtime.js` | 上传会话、命令解析、管理命令和测试命令 | 19 |
| `src/features/meme/followup.js` | 跟发硬门控、图片编码与发送编排 | 4 |
| `src/features/meme/lifecycle.js` | 唯一初始化入口 | 1 |
| **合计** | 与9个legacy chunk逐名对账 | **93** |

依赖方向固定为：

```text
model-config / context / runtime-state
                -> gate / asset-analysis-runtime
                -> reindex-runtime / selector-runtime
                -> admin-runtime
                -> followup / lifecycle
                -> index
                -> legacy facade / five public facades
```

以下约束属于验收条件：

- `uploadSessions` 只在 `admin-runtime.js` 实例化。
- `followupRuntime`、`runtimeStoreCache` 只在 `runtime-state.js` 实例化。
- `reindexQueue`、`reindexQueueSet`、`reindexState` 只在 `reindex-runtime.js` 实例化。
- `runtimeStoreCache` 会在加载时重赋值；消费者必须通过模块对象的live getter或等价封装读取，禁止解构出启动时快照。
- runtime实现不得依赖 `index.js`、`store-runtime.js`、`selector.js`、`reindex.js`、`asset-analysis.js` 或 `admin.js`。
- `axios.get` 与 `httpClient.postWithRetry` 必须在调用时从模块对象取值，禁止解构缓存，以保持现有monkey-patch行为。
- 旧9个 `core/memeManager.*.chunk.js`、`src/shared/chunkedModule.js` 和 `core/memeManager.js` 不修改、不删除；删除需另行授权。

## Chunk 1: 动态加载与契约红灯

### Task 1: 建立模块边界、AST与身份测试

**Files:**
- Create: `tests/memeModuleBoundary.test.js`

- [x] **Step 1: 写入精确公开契约**

在测试内固定主入口16项键和5个子门面的精确键集合：

```js
const MAIN_EXPORTS = [
  'analyzeMemeAsset',
  'cleanupExpiredSessions',
  'consumePendingUploadFromMessage',
  'drainReindexQueue',
  'evaluateMemeGate',
  'getReindexStatus',
  'handleAdminCommand',
  'initializeMemeManager',
  'isSurfaceEnabled',
  'maybeSendMemeFollowup',
  'parseMemeCommand',
  'pickBestAssetForSelection',
  'resolveAssetAnalysis',
  'runMemeTest',
  'selectCategory',
  'startUploadSession'
].sort();

const FACADE_EXPORTS = {
  'store-runtime': ['initializeMemeManager'],
  selector: ['evaluateMemeGate', 'pickBestAssetForSelection', 'selectCategory'],
  reindex: ['drainReindexQueue', 'getReindexStatus'],
  'asset-analysis': ['analyzeMemeAsset', 'resolveAssetAnalysis'],
  admin: [
    'cleanupExpiredSessions',
    'consumePendingUploadFromMessage',
    'handleAdminCommand',
    'isSurfaceEnabled',
    'parseMemeCommand',
    'runMemeTest',
    'startUploadSession'
  ]
};
```

逐个断言子门面键精确相等且 `facade[name] === main[name]`；同时断言 `require('../core/memeManager') === require('../src/features/meme')`。

- [x] **Step 2: 注入定向失败的chunk loader**

先保存真实 `runCommonJsChunks`，再通过 `require.cache` 替换 `src/shared/chunkedModule.js`。仅当收到 `memeManager.*.chunk.js` 时抛出 `meme must not execute chunk loader`，其他尚未迁移入口委托真实loader；`finally` 恢复原cache。

- [x] **Step 3: 加入93/93 AST对账与singleton所有权检查**

使用直接开发依赖 `typescript` 的Compiler API解析9个旧chunk与上述10个新实现文件，只收集顶层具名 `FunctionDeclaration`。断言legacy与新实现均为93项、名称集合完全相等、无重复；再断言6个singleton顶层声明的唯一归属精确为：

```js
const SINGLETON_OWNERS = {
  uploadSessions: 'admin-runtime.js',
  followupRuntime: 'runtime-state.js',
  runtimeStoreCache: 'runtime-state.js',
  reindexQueue: 'reindex-runtime.js',
  reindexQueueSet: 'reindex-runtime.js',
  reindexState: 'reindex-runtime.js'
};
```

- [x] **Step 4: 加入本地依赖图检查**

从10个实现文件和 `index.js` 的静态相对 `require()` 构建本地有向图，断言不存在SCC或回边；并显式拒绝runtime文件依赖 `index.js` 或5个子门面。此检查只证明 `meme` 本地模块图，不提前宣称目标6的全仓生产依赖图完成。

- [x] **Step 5: 运行测试验证红灯**

Run: `node scripts/run-tests.js tests/memeModuleBoundary.test.js`

Expected: FAIL with `meme must not execute chunk loader`；不得因契约常量、测试拼写或其他入口失败。

Actual（2026-07-22）：退出码1；`memeModuleBoundary.test.js` 在 `src/features/meme/index.js:9` 调用 `runCommonJsChunks` 时抛出原始错误 `Error: meme must not execute chunk loader`，未提前触发其他断言。

## Chunk 2: 基础规则与运行状态

### Task 2: 迁移模型配置与上下文函数

**Files:**
- Create: `src/features/meme/model-config.js`
- Create: `src/features/meme/context.js`

- [x] **Step 1: 迁移7个模型配置函数**

`model-config.js` 迁移 `ensureChatCompletionsUrl`、selector的3个getter及素材分析的3个getter，只显式依赖 `../../../config`。不导出整个config对象，不新增fallback策略。

- [x] **Step 2: 迁移21个上下文函数**

`context.js` 同时拥有 `MOOD_ALIASES`、`INTENSITY_ALIASES`，迁移 `memeManager.selector-normalize.chunk.js` 的21个顶层函数；只显式依赖 `../../../config`、`../../../api/parser` 的 `extractMessageContent` 与 `../../../utils/groupAwarenessState` 的 `getRecentMessages`。

- [x] **Step 3: 独立解析新增模块**

Run:

```powershell
node --check src/features/meme/model-config.js
node --check src/features/meme/context.js
```

Expected: both commands exit 0。

### Task 3: 收口运行存储与跟发状态

**Files:**
- Create: `src/features/meme/runtime-state.js`

- [x] **Step 1: 迁移4个存储函数**

迁移 `ensureRuntimeStoreShape`、`safeReadRuntimeStore`、`persistRuntimeStore`、`loadRuntimeStore`，保留临时文件写入再rename的原子替换语义。

- [x] **Step 2: 迁移5个运行状态函数**

从gate chunk迁移 `trimRecentWindow`、`getFollowupRuntime`、`setFollowupRuntime`、`buildRuntimeSummary`、`updateFollowupRuntime`。模块唯一拥有 `followupRuntime` 与 `runtimeStoreCache`；导出的live状态接口必须让 `loadRuntimeStore()` 后的selector、gate和lifecycle读取同一实例。

- [x] **Step 3: 保持单向依赖**

`runtime-state.js` 只显式依赖 `fs` 与 `../../../config`，不得导入gate、selector、admin、followup、lifecycle或任何公开门面。

## Chunk 3: 决策、素材与选择器

### Task 4: 迁移gate与本地分类

**Files:**
- Create: `src/features/meme/gate.js`

- [x] **Step 1: 迁移11个无状态决策函数**

迁移 `buildReplyMeta`、`buildPassiveContext`、`buildContextSourceFlags`、`computeKeywordHits`、`clampProbability`、`getIntensityDistance`、`evaluateMemeGate`、`scoreCategory`、`compareCategoryScores`、`chooseCategoryBySelector`、`inferCategoryByLocalHeuristics`。

- [x] **Step 2: 显式导入真实依赖**

仅从 `./context`、`./runtime-state`、`../../../config`、`../../../utils/replyFailure` 与 `../../../core/routeSchema` 导入使用到的符号；不得反向依赖selector或index。

### Task 5: 分离素材分析与重建索引

**Files:**
- Create: `src/features/meme/asset-analysis-runtime.js`
- Create: `src/features/meme/reindex-runtime.js`

- [x] **Step 1: 迁移6个素材分析函数**

`asset-analysis-runtime.js` 拥有 `ASSET_ANALYSIS_FIELDS`，迁移 `toInlineImagePart`、`buildAssetAnalyzerPrompt`、`getAssetAnalysisResolvedFields`、`resolveAssetAnalysis`、`buildAssetAnalysisRequestContent`、`analyzeMemeAsset`。显式依赖 `fs`、config、`httpClient`模块对象、parser、runtime prompts、meme store、`./model-config` 与 `./context`。

- [x] **Step 2: 迁移5个reindex函数与3项singleton**

`reindex-runtime.js` 唯一拥有 `reindexQueue`、`reindexQueueSet`、`reindexState`，迁移 `getReindexTaskKey`、`getReindexStatus`、`enqueueReindexTasks`、`processReindexTask`、`drainReindexQueue`。只允许 `reindex-runtime -> asset-analysis-runtime`，禁止反向引用。

- [x] **Step 3: 保持串行队列语义**

保留任务去重、微任务启动、单worker drain、processed/failed统计、activeTask清理和分析结果写回顺序；不得引入第二个队列或额外try/catch。

### Task 6: 迁移selector与素材评分

**Files:**
- Create: `src/features/meme/selector-runtime.js`

- [x] **Step 1: 迁移10个selector函数**

原样迁移prompt、token overlap、reply tags、全局使用量、素材评分/比较、`pickBestAssetForSelection`、payload、`runSelector` 与 `selectCategory`。

- [x] **Step 2: 保持运行状态live读取**

`getAssetGlobalUsage` 每次调用都从 `runtime-state.js` 的live状态读取，禁止在模块加载时解构 `runtimeStoreCache`。

- [x] **Step 3: 保持HTTP monkey-patch边界**

使用 `const httpClient = require('../../../api/httpClient')` 并在调用点执行 `httpClient.postWithRetry(...)`；不得改为 `const { postWithRetry } = ...`。

## Chunk 4: 管理、跟发与稳定入口

### Task 7: 合并管理会话与命令编排

**Files:**
- Create: `src/features/meme/admin-runtime.js`

- [x] **Step 1: 迁移17个管理与上传函数**

模块唯一拥有 `uploadSessions`，迁移surface、session、列表/详情格式化、帮助、命令解析、图片扩展名/MIME和上传消费函数。

- [x] **Step 2: 迁移2个命令入口**

从commands chunk迁移 `runMemeTest` 与 `handleAdminCommand`，显式依赖context、gate、runtime-state、reindex-runtime、selector-runtime、config、meme store与router；保留现有命令结果和错误文本。

- [x] **Step 3: 保持Axios monkey-patch边界**

使用 `const axios = require('axios')` 并在调用点执行 `axios.get(...)`。继续由 `assertSafeHttpUrl` 在网络调用前拒绝不安全URL，不新增绕过或重复防御分支。

### Task 8: 迁移跟发与生命周期

**Files:**
- Create: `src/features/meme/followup.js`
- Create: `src/features/meme/lifecycle.js`

- [x] **Step 1: 迁移4个跟发函数**

`followup.js` 迁移 `shouldSkipFollowup`、`getHardSkipReason`、`toBase64ImageFile`、`maybeSendMemeFollowup`，显式依赖context、gate、runtime-state、admin-runtime、selector-runtime、config与群消息状态；不依赖index或公开门面。

- [x] **Step 2: 迁移唯一生命周期函数**

`lifecycle.js` 只实现 `initializeMemeManager`，复用同一 `followupRuntime`、runtime store与reindex队列；保持初始化、清空、加载、按配置排队和日志顺序。

### Task 9: 切换静态入口并恢复16项API

**Files:**
- Modify: `src/features/meme/index.js`

- [x] **Step 1: 删除生产动态加载接线**

移除 `path`、`createRequire` 与 `runCommonJsChunks` 接线；静态导入10个实现模块。不得读取旧chunk、调用 `new Function` 或复制函数包装器。

- [x] **Step 2: 精确聚合16项公开API**

`module.exports` 只包含Chunk 1固定的16个键，每个值直接引用所属实现模块的函数对象。现有 `core/memeManager.js` 与5个子门面无需修改，并必须继续返回同一对象/函数身份。

- [x] **Step 3: 运行边界测试转绿**

Run: `node scripts/run-tests.js tests/memeModuleBoundary.test.js`

Expected: PASS；包含不执行meme chunk loader、93/93函数、6项singleton归属、0本地循环、16项主API及5个子门面身份。

## Chunk 5: monkey-patch与行为回归

### Task 10: 锁定HTTP对象动态替换行为

**Files:**
- Create: `tests/memeManagerMonkeyPatch.test.js`

- [x] **Step 1: 写selector传输行为测试**

先加载 `selector-runtime.js`，随后替换 `httpClient.postWithRetry`，临时设置selector base URL/model，调用内部 `runSelector` 并断言替换函数收到请求且返回结果被解析；`finally` 恢复httpClient方法和config字段。该顺序专门防止把方法在require时解构缓存。

- [x] **Step 2: 运行HTTP与Axios monkey-patch回归**

Run:

```powershell
node scripts/run-tests.js tests/memeManagerMonkeyPatch.test.js tests/memeManagerSecurity.test.js
```

Expected: PASS；selector命中替换后的 `httpClient.postWithRetry`，不安全图片URL在 `axios.get` 前被拒绝。

Actual（2026-07-22 10:55 +08:00）：3个独立 `node -e` 进程通过 `Module._extensions['.js']` 仅在内存变换源码，且每次校验目标替换恰好命中1次。A将 `runtimeStoreCache` live getter退化为加载时快照，测试在 `testRuntimeStoreLiveBinding:57` 的对象身份断言失败；B将selector的 `httpClient.postWithRetry` 退化为加载时捕获，测试在 `testModelTransportMonkeyPatch:119` 以 `0 !== 1` 失败；C将admin的 `axios.get` 退化为加载时捕获，测试在 `testAxiosMonkeyPatch:220` 以 `0 !== 1` 失败。变异进程均退出1且未写磁盘；随后 `node scripts/run-tests.js tests/memeModuleBoundary.test.js tests/memeManagerMonkeyPatch.test.js` 2/2 PASS（521ms、188ms）。

### Task 11: 运行双版本定向回归

**Files:**
- Test: `tests/memeModuleBoundary.test.js`
- Test: `tests/memeManagerMonkeyPatch.test.js`
- Test: `tests/memeManagerSecurity.test.js`
- Test: `tests/messageBackgroundTasks.test.js`
- Test: `tests/refactorSrcFacades.test.js`

- [x] **Step 1: 验证Node 20运行时**

使用仓库此前验收过的本机运行时目录直接定位，不依赖预先设置的环境变量。该运行时对应的官方Windows x64归档已按仓库记录的SHA-256 `dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77` 校验；若文件不存在则停止并报告，不下载运行时、不覆盖当前Node安装、不修改依赖。

Run:

```powershell
$node20 = Join-Path $env:LOCALAPPDATA 'Temp\node20-runtime-verified-20260715\node-v20.20.2-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $node20 -PathType Leaf)) {
  throw "trusted Node 20.20.2 runtime not found: $node20"
}
$node20Info = & $node20 -p "JSON.stringify({node:process.versions.node,modules:process.versions.modules,execPath:process.execPath})"
if ($LASTEXITCODE -ne 0) { throw 'Node 20 runtime probe failed' }
$node20InfoObject = $node20Info | ConvertFrom-Json
if ($node20InfoObject.node -ne '20.20.2' -or $node20InfoObject.modules -ne '115') {
  throw "unexpected Node 20 runtime: $node20Info"
}
$node20Info
& $node20 scripts/run-tests.js tests/memeModuleBoundary.test.js tests/memeManagerMonkeyPatch.test.js tests/memeManagerSecurity.test.js tests/messageBackgroundTasks.test.js tests/refactorSrcFacades.test.js
```

Expected: probe输出 `node=20.20.2`、`modules=115` 及上述可信绝对路径；all focused tests PASS。

- [x] **Step 2: 验证当前Node 24运行时**

Run:

```powershell
node -e "if (Number(process.versions.node.split('.')[0]) !== 24) process.exit(1); console.log(process.versions.node)"
node scripts/run-tests.js tests/memeModuleBoundary.test.js tests/memeManagerMonkeyPatch.test.js tests/memeManagerSecurity.test.js tests/messageBackgroundTasks.test.js tests/refactorSrcFacades.test.js
```

Expected: version probe reports Node 24；all focused tests PASS。

## Chunk 6: 全门禁、提交与3/6记录

### Task 12: 运行完整质量门禁

**Files:**
- Verify only: repository-wide gates

- [x] **Step 1: 运行静态与安全门禁**

Run:

```powershell
npm run lint
npm run typecheck
npm run check:prompts
npm run check:secrets:all
npm audit --omit=dev
git diff --check
```

Expected: lint、typecheck、prompt、secrets和diff check退出0；audit记录真实结果。若仅保留迁移前既有 `body-parser@1.20.5` 低危项，明确记为既有例外，不修改并行中的 `package.json` 或lock文件。

Actual（2026-07-24 08:10 +08:00）：`npm run lint` 退出0并检查747个文件，`npm run typecheck`、`npm run check:prompts`、`npm run check:secrets:all`、`git diff --check` 均退出0。`npm audit --omit=dev` 退出1，稳定报告2项生产依赖漏洞：`express@4.22.2 -> body-parser@1.20.5` 的 `GHSA-v422-hmwv-36x6` 低危拒绝服务，以及直接依赖 `sharp@0.33.5` 继承libvips的 `GHSA-f88m-g3jw-g9cj` 高危漏洞（CVE-2026-33327、CVE-2026-33328、CVE-2026-35590、CVE-2026-35591）；中间一次复核遇到registry 503，最终复核再次得到同一2项结果。结构化比较 `HEAD` 与工作树的package和lock数据后，`sharp` 均为直接依赖 `^0.33.5`、锁定 `0.33.5`，`body-parser` 均非直接依赖，而由直接依赖 `express@^4.21.2` 的锁定版本 `4.22.2` 通过 `~1.20.5` 引入并锁定 `1.20.5`；三个目标lock对象逐项相同。未提交依赖改动仅新增开发依赖 `c8@11.0.0` 及其覆盖率依赖，因此两项audit告警均已存在于 `HEAD`，不是并行改动引入；本批未修改 `package.json` 或 `package-lock.json`。

- [x] **Step 2: 运行Node 24并发4完整测试**

Run:

```powershell
$env:TEST_CONCURRENCY = '4'
npm test
```

Expected: tracked完整测试自然结束且退出0；记录文件数和耗时，不以分片结果替代完整结果。

Actual（2026-07-24 08:10 +08:00）：当前运行时为Node 24.14.1（modules 137）。七项聚焦回归 `memeModuleBoundary`、`memeManagerMonkeyPatch`、`memeManagerSecurity`、`passiveAwarenessModuleBoundary`、`messageBackgroundTasks`、`privateChatAdminRouting`、`messageCopyMojibake` 全部通过，退出0，耗时1.593秒。随后设置 `TEST_CONCURRENCY=4` 执行 `npm test`，Git跟踪的521个测试文件自然结束、全部通过，退出0，外层实测150.957秒。原可信路径及 `D:\waifu-test-temp`、`%LOCALAPPDATA%\Temp`、`Downloads` 均未找到Node 20.20.2，因此从nodejs.org下载官方Windows x64归档到工作树外 `%LOCALAPPDATA%\Temp\node20-runtime-verified-20260724-0809`；归档大小30,283,903字节，SHA-256精确为 `dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77`。解压后的探针输出Node 20.20.2、modules 115及该目录下的绝对执行路径，同一七项聚焦回归全部通过，退出0，耗时8.242秒；未替换当前Node、未修改仓库依赖、未删除文件。

- [x] **Step 3: 核对改动范围**

Run:

```powershell
git status --short
git diff --name-only
git diff -- docs/superpowers/plans/2026-07-22-meme-commonjs-migration.md src/features/meme tests/memeModuleBoundary.test.js tests/memeManagerMonkeyPatch.test.js
```

Expected: 实现范围只包含本计划列出的meme实现、2个测试和本计划文件；并行中的CI、覆盖率、依赖与安全诊断改动保持未暂存。

Actual（2026-07-24 08:10 +08:00）：全量测试结束时 `git status --short --untracked-files=all` 与门禁前范围一致，最终复核期间另有并行新增的 `mobile-app-test-desktop-activation.png`，暂存区始终为空；该文件、三张 `mobile_app_test-*.png` 及CI、覆盖率、依赖、安全诊断相关并行改动均未修改、未暂存。`rg -l "module\.exports\s*=\s*runCommonJsChunks" src -g '*.js'` 精确返回3个生产动态入口：`src/memory/vector/index.js`、`src/message/handler.js`、`src/runtime-v2/context/index.js`；`meme` 入口已不再调用loader。

### Task 13: 提交实现

**Files:**
- Create: `src/features/meme/model-config.js`
- Create: `src/features/meme/context.js`
- Create: `src/features/meme/runtime-state.js`
- Create: `src/features/meme/gate.js`
- Create: `src/features/meme/asset-analysis-runtime.js`
- Create: `src/features/meme/reindex-runtime.js`
- Create: `src/features/meme/selector-runtime.js`
- Create: `src/features/meme/admin-runtime.js`
- Create: `src/features/meme/followup.js`
- Create: `src/features/meme/lifecycle.js`
- Modify: `src/features/meme/index.js`
- Create: `tests/memeModuleBoundary.test.js`
- Create: `tests/memeManagerMonkeyPatch.test.js`
- Create: `docs/superpowers/plans/2026-07-22-meme-commonjs-migration.md`

- [ ] **Step 1: 只暂存实现、测试与计划**

Run:

```powershell
git add -- src/features/meme/index.js src/features/meme/model-config.js src/features/meme/context.js src/features/meme/runtime-state.js src/features/meme/gate.js src/features/meme/asset-analysis-runtime.js src/features/meme/reindex-runtime.js src/features/meme/selector-runtime.js src/features/meme/admin-runtime.js src/features/meme/followup.js src/features/meme/lifecycle.js tests/memeModuleBoundary.test.js tests/memeManagerMonkeyPatch.test.js docs/superpowers/plans/2026-07-22-meme-commonjs-migration.md
git diff --cached --name-only
```

Expected: cached清单精确为上述14个文件，包含本计划且不包含任何并行文件。

- [ ] **Step 2: 创建实现提交**

Run:

```powershell
git commit -m "refactor: replace meme chunk loader"
git rev-parse --short HEAD
```

Expected: commit成功；保存实现短哈希供文档记录。不得推送远端。

### Task 14: 更新3/6路线图并提交文档

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`
- Modify: `docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md`
- Modify: `docs/superpowers/plans/2026-07-22-meme-commonjs-migration.md`

- [ ] **Step 1: 写入带时区的简短时间戳与验收证据**

本计划已随实现提交首次纳入版本控制；本步骤再次修改本计划并追加实现哈希与验收记录。在4个文档中记录 `YYYY-MM-DD HH:mm +08:00`、实现哈希、93/93 AST、16项API/5子门面身份、6项singleton归属、0本地循环、Node 20/24定向结果、全门禁结果、完整测试耗时和audit例外。

- [ ] **Step 2: 将目标5更新为部分完成3/6**

路线图写明 `daily-share`、`passive-awareness`、`meme` 已迁移；剩余动态入口精确为 `memory/vector`、`message/handler`、`runtime-v2/context`。目标6仍未完成，必须等待全部入口迁移后生成全仓权威生产依赖图。

- [ ] **Step 3: 只暂存4个文档并提交**

Run:

```powershell
git add -- README.md docs/maintenance-log.md docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md docs/superpowers/plans/2026-07-22-meme-commonjs-migration.md
git diff --cached --name-only
git commit -m "docs: record meme migration"
```

Expected: cached清单精确为4个文档；提交成功且不包含并行文件。不得推送远端。

- [ ] **Step 4: 提交后最终核对**

Run:

```powershell
git status --short
git log -2 --oneline
```

Expected: 两个新提交依次为实现与文档；工作树只保留任务开始前的并行改动，meme计划内文件无未提交差异。
