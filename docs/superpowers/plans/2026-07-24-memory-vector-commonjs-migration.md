# Memory Vector CommonJS Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将目标5的 `memory/vector` 入口从7个共享词法作用域chunk迁为显式依赖、可独立解析且公开契约不变的CommonJS模块。

**Architecture:** 保持 `utils/vectorMemory.js`、`src/memory/vector` 的23项主入口API及 `embedding/retrieval/store/write/stats` 5个门面的精确键集合、对象关系和函数身份不变。按规范化、存储、写入、统计、评分核心、评分选择与召回编排拆为单向依赖；3项store可变状态和1项写入重入状态各归唯一模块，旧chunk保留但生产入口不再读取或执行。

**Tech Stack:** Node.js 20/24、CommonJS、TypeScript Compiler API、ESLint、LanceDB、项目自定义测试运行器。

---

## 文件职责与不变量

7个legacy chunk共3243行，TypeScript Compiler API实测得到169个顶层具名函数、46个顶层变量绑定和215个唯一顶层绑定；169个函数名全部唯一。现有7个chunk在文件级依赖图中属于同一个强连通分量，禁止机械地将每个chunk原样改为一个CommonJS模块。

| 新实现文件 | 唯一职责 | 迁移函数数 | 允许的本地实现依赖 |
| --- | --- | ---: | --- |
| `src/memory/vector/normalization.js` | 文本、scope、kind、status、元数据归一化及token/TF-IDF数学 | 40 | 无 |
| `src/memory/vector/store-runtime.js` | HotStore、分片状态、水合、归档、索引、召回分片解析与查询 | 55 | `normalization.js` |
| `src/memory/vector/write-runtime.js` | 冲突/邻居、质量门禁、持久化、embedding回填与LanceDB同步 | 28 | `normalization.js`、`store-runtime.js`、`embedding.js` |
| `src/memory/vector/stats-runtime.js` | 访问统计与汇总统计 | 2 | `normalization.js`、`store-runtime.js`、`scoring-core.js` |
| `src/memory/vector/scoring-core.js` | 召回分层、过滤、基础分数和信号调整 | 24 | `normalization.js`、`store-runtime.js` |
| `src/memory/vector/scoring-selection.js` | 候选评分、冲突选择、多样性和rerank | 14 | `normalization.js`、`scoring-core.js`、`stats-runtime.js`、`embedding.js` |
| `src/memory/vector/retrieval-runtime.js` | 相关召回、统一召回与核心记忆 | 6 | `normalization.js`、`store-runtime.js`、`scoring-core.js`、`scoring-selection.js`、`embedding.js` |
| **合计** | 与7个legacy chunk逐名对账 | **169** | 本地依赖图必须为DAG |

依赖优先的拓扑顺序固定为：

```text
normalization
  -> store-runtime
      -> write-runtime
      -> scoring-core
          -> stats-runtime
              -> scoring-selection
                  -> retrieval-runtime
                      -> index
                          -> legacy facade / five public facades

embedding -> write-runtime / scoring-selection / retrieval-runtime
```

以下约束属于验收条件：

- `hotStoreRegistry`、`shardStateHydrated`、`memoryShardState` 只在 `store-runtime.js` 声明并修改；任何消费者只能通过该模块的函数访问状态。
- `writePipelineActive` 只在 `write-runtime.js` 声明，替代 `addMemoryItemsBatch.__pipelineActive` 函数属性；不得导出或复制第二份重入状态。
- `mergeMeta` 与 `resolveShardMetasForRecall` 归 `store-runtime.js`；`mergeMeta` 同时服务store与write，`store-runtime.js` 不得依赖 `write-runtime.js` 或 `retrieval-runtime.js`。
- `stats-runtime.js` 必须显式依赖 `scoring-core.js` 的 `calcMemoryStrength`；`scoring-core.js` 不得反向依赖 `stats-runtime.js`。
- `scoring-selection.js` 必须从 `../../../utils/memoryProjection/conflicts` 显式导入现有 `sourceKindRank`；不得复制实现。迁移前 `scoring-selection.chunk.js` 的该引用是唯一未知自由变量。
- 实现模块不得依赖 `index.js`、`retrieval.js`、`store.js`、`write.js` 或 `stats.js`；公开门面不得包装函数。
- `utils/vectorMemory.js` 必须继续与 `src/memory/vector/index.js` 返回同一对象；`src/memory/index.js` 的 `vector` 必须指向该对象。
- `embedding.js` 继续作为唯一embedding门面。现有文件只依赖 `../../../config`、`../../../utils/memoryEmbeddingClient` 与 `../../../utils/memorySemanticIndex`，不依赖 `index.js` 或7个新实现，因此它是实现图之外的外部leaf依赖，不计入7个实现节点、15条本地实现边或7节点拓扑顺序。`write-runtime.js`、`scoring-selection.js` 与 `retrieval-runtime.js` 可以单向依赖该leaf；`memorySemanticIndex` 的 `queryCache`、`memoryEmbeddingClient` 的失败冷却状态以及LanceDB模块/连接Promise继续由原权威模块拥有，不在新实现中复制。
- 仅加载 `src/memory/vector` 时可以加载 `utils/memorySemanticIndex.js` 与 `utils/memoryEmbeddingClient.js`，但不得加载 `utils/lancedbMemoryStore/index.js`、`@lancedb/lancedb`、`utils/memory-v3/storage.js`、`utils/memory-v3/materializer.js` 或 `utils/memory-v3/recallVerifier.js`。
- `recallVerifier`、memory-v3 storage/materializer与LanceDB store继续在真实调用路径中动态 `require()`；LanceDB方法在调用时解构，确保先加载模块再替换方法的测试patch仍可见。禁止在模块加载时捕获可被patch的方法。
- `utils/memoryWritePipeline` 继续在调用时取得 `utils/vectorMemory` 的稳定公开对象；不得通过新内部模块绕开该动态patch边界。
- 旧7个 `src/memory/vector/*.chunk.js`、`src/shared/chunkedModule.js`、`utils/vectorMemory.js` 和 `embedding.js` 不修改、不删除。所有既有memory专题文档不修改；删除任何文件需另行授权。

旧chunk清单固定为：

```js
const LEGACY_CHUNKS = [
  'normalize.chunk.js',
  'store.chunk.js',
  'archive-write-helpers.chunk.js',
  'write.chunk.js',
  'scoring-core.chunk.js',
  'scoring-selection.chunk.js',
  'retrieval-stats.chunk.js'
];
```

## Chunk 1: 动态加载、API与AST红灯

### Task 1: 建立模块边界测试

**Files:**
- Create: `tests/memoryVectorModuleBoundary.test.js`

- [ ] **Step 1: 固定23项主入口和5个门面契约**

在测试中固定精确主入口键：

```js
const MAIN_EXPORTS = [
  'addEpisodeMemory',
  'addMemoryItem',
  'addMemoryItemsBatch',
  'addMemoryItemsBatchAsync',
  'addMemoryItemsBatchWithVectorBackfill',
  'cosineArray',
  'getCoreMemories',
  'getMemoryItems',
  'getMemoryItemsByFilter',
  'getMemoryStats',
  'loadIndex',
  'loadLibrary',
  'rebuildMemoryIndex',
  'rememberExplicitMemory',
  'requestEmbedding',
  'retrieveRelevantMemories',
  'retrieveRelevantMemoriesAsync',
  'retrieveUnifiedMemories',
  'retrieveUnifiedMemoriesAsync',
  'saveIndex',
  'saveLibrary',
  'shouldUseRemoteEmbedding',
  'touchAccessStats'
].sort();

const FACADE_EXPORTS = {
  embedding: ['calcEmbeddingScore', 'cosineArray', 'requestEmbedding', 'shouldUseRemoteEmbedding'],
  retrieval: [
    'getCoreMemories',
    'retrieveRelevantMemories',
    'retrieveRelevantMemoriesAsync',
    'retrieveUnifiedMemories',
    'retrieveUnifiedMemoriesAsync'
  ],
  store: [
    'getMemoryItems',
    'getMemoryItemsByFilter',
    'loadIndex',
    'loadLibrary',
    'rebuildMemoryIndex',
    'saveIndex',
    'saveLibrary'
  ],
  write: [
    'addEpisodeMemory',
    'addMemoryItem',
    'addMemoryItemsBatch',
    'addMemoryItemsBatchAsync',
    'addMemoryItemsBatchWithVectorBackfill',
    'rememberExplicitMemory'
  ],
  stats: ['getMemoryStats', 'touchAccessStats']
};
```

断言主入口只有23项；`retrieval/store/write/stats` 每一项都与主入口对应函数严格相等。`embedding` 的 `cosineArray/requestEmbedding/shouldUseRemoteEmbedding` 与主入口严格相等，`calcEmbeddingScore` 只属于embedding门面。断言 `require('../utils/vectorMemory') === main`、`require('../src/memory').vector === main`。

- [ ] **Step 2: 注入定向失败的chunk loader并完整恢复cache**

在加载任何被测模块前保存 `require.cache` 的对象级快照，并从快照中移除测试文件自身。替换 `src/shared/chunkedModule.js` 时，仅当 `chunkFiles` 包含上述7个vector chunk时抛出 `memory/vector must not execute chunk loader`，其他未迁移入口继续委托真实loader。

`finally` 必须删除测试期间新增的所有cache项并逐项恢复原对象，最后同时断言cache键集合和每个cache对象身份与快照一致；不得只恢复 `chunkedModule.js`。

- [ ] **Step 3: 加入169/169、0未知和singleton归属门禁**

使用直接开发依赖 `typescript` 的Compiler API解析7个legacy chunk和7个新实现文件，只统计顶层具名 `FunctionDeclaration`。断言legacy为169项、169个唯一名称；新实现为169项、169个唯一名称；两个排序后的名称集合完全相同。

实现文件的函数数还必须精确等于：

```js
const IMPLEMENTATION_FUNCTION_COUNTS = {
  'normalization.js': 40,
  'store-runtime.js': 55,
  'write-runtime.js': 28,
  'stats-runtime.js': 2,
  'scoring-core.js': 24,
  'scoring-selection.js': 14,
  'retrieval-runtime.js': 6
};
```

将7个实现文件作为同一Program进行符号解析，排除声明位置、属性名、标签、CommonJS包装参数和TypeScript已解析的Node/ECMAScript全局后，断言未知自由变量集合精确为 `[]`。再断言可变状态唯一归属：

```js
const SINGLETON_OWNERS = {
  hotStoreRegistry: 'store-runtime.js',
  shardStateHydrated: 'store-runtime.js',
  memoryShardState: 'store-runtime.js',
  writePipelineActive: 'write-runtime.js'
};
```

`shouldUseRemoteEmbedding` 必须在 `write-runtime.js` 与 `retrieval-runtime.js` 的真实消费者中通过 `require('./embedding')` 显式绑定。

`scoring-selection.js` 只从embedding leaf显式绑定实际使用的 `calcEmbeddingScore`。不得把这些符号列入未知变量白名单，也不得导入未使用的embedding符号；`sourceKindRank` 同样必须通过权威模块显式绑定，0未知断言不得用新增全局名规避。

- [ ] **Step 4: 加入精确边集合、0循环和lazy-load门禁**

从7个实现文件的静态相对 `require()` 构建7节点本地有向图；边 `A -> B` 表示实现模块A依赖实现模块B。先断言实际边集合与TypeScript AST按上述函数归属派生的15条边精确相等：

```js
const EXPECTED_LOCAL_EDGES = [
  'retrieval-runtime -> normalization',
  'retrieval-runtime -> scoring-core',
  'retrieval-runtime -> scoring-selection',
  'retrieval-runtime -> store-runtime',
  'scoring-core -> normalization',
  'scoring-core -> store-runtime',
  'scoring-selection -> normalization',
  'scoring-selection -> scoring-core',
  'scoring-selection -> stats-runtime',
  'stats-runtime -> normalization',
  'stats-runtime -> scoring-core',
  'stats-runtime -> store-runtime',
  'store-runtime -> normalization',
  'write-runtime -> normalization',
  'write-runtime -> store-runtime'
].sort();

const EXPECTED_TOPOLOGICAL_ORDER = [
  'normalization',
  'store-runtime',
  'write-runtime',
  'scoring-core',
  'stats-runtime',
  'scoring-selection',
  'retrieval-runtime'
];

const EXPECTED_EXTERNAL_LEAF_EDGES = [
  'retrieval-runtime -> embedding',
  'scoring-selection -> embedding',
  'write-runtime -> embedding'
].sort();
```

15条 `EXPECTED_LOCAL_EDGES` 只覆盖7个新实现节点；另行断言实现到既有 `embedding.js` 的边精确为上述3条，不把它们混入15条边或7节点拓扑排序。解析 `embedding.js` 的静态require，断言它不依赖 `index.js`、公开门面或7个新实现，只依赖config、memoryEmbeddingClient与memorySemanticIndex。

使用DFS或Tarjan断言0循环，并对反向依赖图执行稳定拓扑排序，断言得到上述依赖优先顺序。额外逐项拒绝 `store-runtime -> write-runtime`、`store-runtime -> retrieval-runtime`、`scoring-core -> stats-runtime`，以及任何实现依赖公开门面或index；`index.js` 只允许依赖实现模块和 `embedding.js`，不得形成回边。

清空被测路径cache后只加载主入口，断言以下路径均未出现在 `require.cache`：

```js
const MUST_STAY_LAZY = [
  '../utils/lancedbMemoryStore/index.js',
  '../utils/memory-v3/storage.js',
  '../utils/memory-v3/materializer.js',
  '../utils/memory-v3/recallVerifier.js'
];
```

另外遍历cache路径，断言不存在 `@lancedb/lancedb`。同时断言 `utils/memorySemanticIndex.js` 与 `utils/memoryEmbeddingClient.js` 各只有一个已解析实例，防止迁移复制其singleton。

- [ ] **Step 5: 运行测试验证定向红灯**

Run:

```powershell
node scripts/run-tests.js tests/memoryVectorModuleBoundary.test.js
```

Expected: FAIL with `memory/vector must not execute chunk loader`；不得因API常量、cache恢复或AST测试自身错误提前失败。

## Chunk 2: 规范化与唯一存储状态

### Task 2: 迁移40个规范化函数

**Files:**
- Create: `src/memory/vector/normalization.js`

- [ ] **Step 1: 迁移纯规范化与数学函数**

从 `normalize.chunk.js` 迁移除7个存储函数之外的40个顶层函数。7个存储函数精确为 `atomicWriteJson`、`safeReadJson`、`safeWriteJson`、`getCompatItemsStore`、`getCompatIndexStore`、`defaultShardManifest`、`getManifestStore`，它们归下一Task。

- [ ] **Step 2: 将外部依赖放回真实消费者**

`normalization.js` 只导入本文件函数实际使用的config、tier与recall heuristic依赖。memory write pipeline、semantic index、reranker、embedding门面、fs/path与JsonHotStore不得为后续模块继续藏在该文件词法作用域中。

- [ ] **Step 3: 独立解析并保持红灯原因**

Run:

```powershell
node --check src/memory/vector/normalization.js
node scripts/run-tests.js tests/memoryVectorModuleBoundary.test.js
```

Expected: 新模块语法检查退出0；边界测试仍只因生产index执行旧chunk而失败。

### Task 3: 收口55个存储函数和3项状态

**Files:**
- Create: `src/memory/vector/store-runtime.js`

- [ ] **Step 1: 迁移存储基础与分片实现**

迁移 `normalize.chunk.js` 的7个存储函数、`store.chunk.js` 的35个函数及其路径/版本常量。`store-runtime.js` 唯一声明 `hotStoreRegistry`、`shardStateHydrated`、`memoryShardState`，保留原有HotStore惰性创建、manifest迁移、分片水合、aggregate dirty和兼容快照语义。

- [ ] **Step 2: 迁移9个归档和索引生命周期函数**

从 `archive-write-helpers.chunk.js` 迁移 `isExpired`、`pruneLibrary`、`getEpisodeArchiveAgeDays`、`isEpisodeMemory`、`getCoveredRollupLevels`、`archiveRolledUpEpisodes`、`buildDocTokens`、`rebuildMemoryIndex`、`ensureIndexFresh`。这些函数归store后，store不得反向依赖write或retrieval。

- [ ] **Step 3: 迁移4个共享存储与查询函数**

从 `archive-write-helpers.chunk.js` 迁移 `mergeMeta`，从 `retrieval-stats.chunk.js` 迁移 `resolveShardMetasForRecall`、`getMemoryItems` 与 `getMemoryItemsByFilter`。`resolveShardMetasForRecall` 同时服务scoring与retrieval，必须由两者共同依赖的store owner提供；`mergeMeta` 同时服务store与write，归store后write只单向依赖store，不得形成 `store-runtime -> write-runtime` 反向边。保持scope、status、kind、source、limit与cache选项语义，不新增全量扫描fallback。

- [ ] **Step 4: 验证函数分布和状态唯一性**

Run:

```powershell
node --check src/memory/vector/store-runtime.js
node -e "const ts=require('typescript'),fs=require('fs');const f='src/memory/vector/store-runtime.js';const s=ts.createSourceFile(f,fs.readFileSync(f,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const n=s.statements.filter(ts.isFunctionDeclaration).length;if(n!==55)throw new Error('expected 55 functions, got '+n);console.log(n)"
```

Expected: syntax PASS；输出 `55`。

## Chunk 3: 写入与统计

### Task 4: 迁移28个写入函数并保留动态边界

**Files:**
- Create: `src/memory/vector/write-runtime.js`

- [ ] **Step 1: 迁移11个冲突、邻居和upsert函数**

迁移 `archive-write-helpers.chunk.js` 剩余的 `jaccardFromTokens` 至 `upsertMemoryItem` 共11个函数，但不包含已归store的 `mergeMeta`。显式导入 `normalization.js` 与 `store-runtime.js` 的真实依赖；`findWriteRerankNeighbors` 只使用store的查询接口，不导入retrieval门面。

- [ ] **Step 2: 迁移15个批量写入与向量回填函数**

迁移 `write.chunk.js` 的15个函数。`write-runtime.js` 从 `./embedding` 只显式绑定真实使用的 `shouldUseRemoteEmbedding`；`writePipelineActive` 为模块私有布尔状态，并以原try/finally范围复位，不得继续修改公开函数对象属性。

- [ ] **Step 3: 迁移2个公开写入入口**

从 `retrieval-stats.chunk.js` 迁移 `rememberExplicitMemory`、`addEpisodeMemory`，直接调用同模块的 `addMemoryItem`，保持原返回值与元数据。

- [ ] **Step 4: 保持optional/native模块惰性与patch能力**

`normalizeRecallTargetIds`、`loadMemoryNodes`、`materializeMemoryViews`、`buildMemoryVectorRow/isLanceDbSyncEnabled/syncMemoryRows` 继续分别在调用函数内 `require()`。不得在文件顶部加载 `utils/lancedbMemoryStore`，不得直接加载 `@lancedb/lancedb`；调用时从当前module exports读取LanceDB方法，以保留测试替换。

- [ ] **Step 5: 独立解析并核对28项**

Run:

```powershell
node --check src/memory/vector/write-runtime.js
node -e "const ts=require('typescript'),fs=require('fs');const f='src/memory/vector/write-runtime.js';const s=ts.createSourceFile(f,fs.readFileSync(f,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const n=s.statements.filter(ts.isFunctionDeclaration).length;if(n!==28)throw new Error('expected 28 functions, got '+n);console.log(n)"
```

Expected: syntax PASS；输出 `28`。

### Task 5: 迁移2个统计函数

**Files:**
- Create: `src/memory/vector/stats-runtime.js`

- [ ] **Step 1: 收口访问与汇总统计**

从 `scoring-core.chunk.js` 迁移 `touchAccessStats`，从 `retrieval-stats.chunk.js` 迁移 `getMemoryStats`。显式从 `scoring-core.js` 导入 `calcMemoryStrength`，并依赖 `normalization.js` 与 `store-runtime.js`；不得依赖scoring-selection、retrieval、write、index或公开门面。`scoring-core.js` 不得反向导入stats-runtime。

- [ ] **Step 2: 独立解析并核对2项**

Run: `node --check src/memory/vector/stats-runtime.js`

Expected: exit 0；AST顶层函数数为2。

## Chunk 4: 评分与召回DAG

### Task 6: 迁移24个评分核心函数

**Files:**
- Create: `src/memory/vector/scoring-core.js`

- [ ] **Step 1: 迁移基础评分与过滤函数**

迁移 `scoring-core.chunk.js` 除 `touchAccessStats` 外的24个函数。category metadata继续按现有fallback语义在调用路径解析；store写入只通过 `store-runtime.js` 的显式函数完成。该模块不得依赖 `stats-runtime.js`，由stats单向导入 `calcMemoryStrength`。

- [ ] **Step 2: 验证独立解析与24项数量**

Run: `node --check src/memory/vector/scoring-core.js`

Expected: exit 0；AST顶层函数数为24。

### Task 7: 迁移14个评分选择函数并修复自由变量

**Files:**
- Create: `src/memory/vector/scoring-selection.js`

- [ ] **Step 1: 迁移原13个selection函数**

迁移 `scoring-selection.chunk.js` 的13个函数，显式依赖normalization、scoring-core、stats-runtime、semantic index、reranker和tier工具，并从 `./embedding` 只绑定真实使用的 `calcEmbeddingScore`；不得导入其他embedding门面函数。

- [ ] **Step 2: 将多样性选择归入selection**

从 `retrieval-stats.chunk.js` 迁移 `selectDiverseHits`，使selection不再反向依赖retrieval。

- [ ] **Step 3: 显式导入权威sourceKindRank**

使用：

```js
const { sourceKindRank } = require('../../../utils/memoryProjection/conflicts');
```

不得创建同名函数或fallback；迁移后的未知自由变量门禁必须为0。

- [ ] **Step 4: 验证独立解析与14项数量**

Run: `node --check src/memory/vector/scoring-selection.js`

Expected: exit 0；AST顶层函数数为14。

### Task 8: 迁移6个召回编排函数

**Files:**
- Create: `src/memory/vector/retrieval-runtime.js`

- [ ] **Step 1: 迁移召回编排**

迁移 `retrieveRelevantMemories`、`retrieveRelevantMemoriesAsync`、`buildUnifiedMemoryOptions`、`retrieveUnifiedMemories`、`retrieveUnifiedMemoriesAsync`、`getCoreMemories`。`resolveShardMetasForRecall` 已归 `store-runtime.js`，`retrieval-runtime.js` 必须显式导入该函数；同时从现有 `embedding.js` 显式导入 `shouldUseRemoteEmbedding`，不得依赖index转发或保留未知自由变量。同步与异步路径继续复用同一store、scoring和embedding singleton。

- [ ] **Step 2: 禁止反向依赖写入与公开门面**

召回实现不得导入write-runtime、index或5个门面；写入函数已经归 `write-runtime.js`。

- [ ] **Step 3: 验证独立解析与6项数量**

Run: `node --check src/memory/vector/retrieval-runtime.js`

Expected: exit 0；AST顶层函数数为6。

## Chunk 5: 稳定入口与公开门面

### Task 9: 切换静态index并恢复5个门面

**Files:**
- Modify: `src/memory/vector/index.js`
- Modify: `src/memory/vector/retrieval.js`
- Modify: `src/memory/vector/store.js`
- Modify: `src/memory/vector/write.js`
- Modify: `src/memory/vector/stats.js`

- [ ] **Step 1: 删除生产动态加载接线**

从 `index.js` 移除 `runCommonJsChunks` 和7个chunk清单，静态导入7个实现模块与现有 `embedding.js`。不得读取旧chunk、调用 `new Function` 或通过包装函数转发。

- [ ] **Step 2: 精确聚合23项公开API**

`module.exports` 只包含Chunk 1的23个键，每个值直接引用所属实现模块或embedding门面的函数对象。不得导出内部helper、状态或 `_test` 接口。

- [ ] **Step 3: 让4个非embedding门面直接引用实现**

`retrieval.js`、`store.js`、`write.js`、`stats.js` 直接从对应runtime选择既有键，不再先加载index；这些键与随后加载的index必须保持函数对象相同。`embedding.js` 不修改。

- [ ] **Step 4: 运行边界测试转绿**

Run:

```powershell
node scripts/run-tests.js tests/memoryVectorModuleBoundary.test.js
```

Expected: PASS；包含不执行vector chunk loader、23项主API、5门面/legacy身份、169/169函数、4项状态归属、0未知自由变量、0本地循环和lazy-load断言。

## Chunk 6: 双版本聚焦回归

### Task 10: 运行Node 20与Node 24的9项聚焦测试

**Files:**
- Test: `tests/memoryVectorModuleBoundary.test.js`
- Test: `tests/refactorSrcFacades.test.js`
- Test: `tests/memorySemanticRecall.test.js`
- Test: `tests/memoryWritePipeline.test.js`
- Test: `tests/memoryHybridRerankPipeline.test.js`
- Test: `tests/memorySemanticIndexCache.test.js`
- Test: `tests/memoryV3LanceDbRecall.test.js`
- Test: `tests/lancedbMemoryStore.integration.test.js`
- Test: `tests/postReplyVectorWatchdog.test.js`

- [ ] **Step 1: 定位或下载经官方SHA验证的Node 20.20.2**

优先复用仓库此前记录的工作树外可信运行时；若不存在，则只下载Node.js官方Windows x64归档到 `%LOCALAPPDATA%\Temp`，先核对官方SHA-256，再解压和使用。不得替换系统Node、不得把运行时放入仓库、不得修改依赖。

Run:

```powershell
$nodeVersion = '20.20.2'
$archiveName = "node-v$nodeVersion-win-x64.zip"
$expectedSha256 = 'dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77'
$knownNode20 = Join-Path $env:LOCALAPPDATA 'Temp\node20-runtime-verified-20260724-0809\node-v20.20.2-win-x64\node.exe'
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'Temp\node20-runtime-verified-20260724-memory-vector'
$node20 = $knownNode20

if (-not (Test-Path -LiteralPath $node20 -PathType Leaf)) {
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  $archivePath = Join-Path $runtimeRoot $archiveName
  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/$archiveName" -OutFile $archivePath
  }
  $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "Node 20 archive SHA-256 mismatch: $actualSha256"
  }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force
  $node20 = Join-Path $runtimeRoot "node-v$nodeVersion-win-x64\node.exe"
}

$node20Info = & $node20 -p "JSON.stringify({node:process.versions.node,modules:process.versions.modules,execPath:process.execPath})"
if ($LASTEXITCODE -ne 0) { throw 'Node 20 runtime probe failed' }
$node20InfoObject = $node20Info | ConvertFrom-Json
if ($node20InfoObject.node -ne '20.20.2' -or $node20InfoObject.modules -ne '115') {
  throw "unexpected Node 20 runtime: $node20Info"
}
$node20Info
```

Expected: 输出Node `20.20.2`、modules `115` 及工作树外绝对路径；若下载，归档SHA-256精确匹配上述值。

- [ ] **Step 2: 使用Node 20运行9项聚焦测试**

Run:

```powershell
& $node20 scripts/run-tests.js tests/memoryVectorModuleBoundary.test.js tests/refactorSrcFacades.test.js tests/memorySemanticRecall.test.js tests/memoryWritePipeline.test.js tests/memoryHybridRerankPipeline.test.js tests/memorySemanticIndexCache.test.js tests/memoryV3LanceDbRecall.test.js tests/lancedbMemoryStore.integration.test.js tests/postReplyVectorWatchdog.test.js
```

Expected: 9/9 PASS；包含真实LanceDB集成、semantic/embedding cache、动态patch和写入/召回回归。

- [ ] **Step 3: 使用当前Node 24运行同一9项测试**

Run:

```powershell
node -e "if (Number(process.versions.node.split('.')[0]) !== 24) process.exit(1); console.log(JSON.stringify({node:process.versions.node,modules:process.versions.modules}))"
node scripts/run-tests.js tests/memoryVectorModuleBoundary.test.js tests/refactorSrcFacades.test.js tests/memorySemanticRecall.test.js tests/memoryWritePipeline.test.js tests/memoryHybridRerankPipeline.test.js tests/memorySemanticIndexCache.test.js tests/memoryV3LanceDbRecall.test.js tests/lancedbMemoryStore.integration.test.js tests/postReplyVectorWatchdog.test.js
```

Expected: version probe报告Node 24；同一9项全部PASS。

## Chunk 7: 全门禁、双提交与4/6记录

### Task 11: 运行全静态、audit与并发4完整测试

**Files:**
- Verify only: repository-wide gates

- [ ] **Step 1: 运行静态、prompt、安全和差异门禁**

Run:

```powershell
npm run lint
npm run typecheck
npm run check:prompts
npm run check:secrets:all
npm audit --omit=dev
git diff --check
```

Expected: lint、typecheck、prompt、secrets与diff check退出0。audit记录真实退出码、漏洞链和是否已存在于HEAD；不得在本批修改并行中的 `package.json` 或 `package-lock.json`。

- [ ] **Step 2: 运行Node 24并发4完整测试**

Run:

```powershell
$env:TEST_CONCURRENCY = '4'
npm test
```

Expected: Git跟踪的完整测试集自然结束且退出0；记录测试文件数和耗时，不以分片或9项聚焦结果替代。

- [ ] **Step 3: 核对入口数量和禁止改动范围**

Run:

```powershell
rg -l "module\.exports\s*=\s*runCommonJsChunks" src -g '*.js'
git status --short --untracked-files=all
git diff --name-only
git diff -- src/memory/vector tests/memoryVectorModuleBoundary.test.js docs/superpowers/plans/2026-07-24-memory-vector-commonjs-migration.md
```

Expected: 动态chunk生产入口精确剩2个：`src/message/handler.js` 与 `src/runtime-v2/context/index.js`。本批差异只含7个新实现、5个入口/门面、1个新测试和本计划；7个旧chunk、`embedding.js`、`utils/vectorMemory.js`、所有既有memory专题文档及并行文件无差异。

### Task 12: 提交实现、测试与计划

**Files:**
- Create: `src/memory/vector/normalization.js`
- Create: `src/memory/vector/store-runtime.js`
- Create: `src/memory/vector/write-runtime.js`
- Create: `src/memory/vector/stats-runtime.js`
- Create: `src/memory/vector/scoring-core.js`
- Create: `src/memory/vector/scoring-selection.js`
- Create: `src/memory/vector/retrieval-runtime.js`
- Modify: `src/memory/vector/index.js`
- Modify: `src/memory/vector/retrieval.js`
- Modify: `src/memory/vector/store.js`
- Modify: `src/memory/vector/write.js`
- Modify: `src/memory/vector/stats.js`
- Create: `tests/memoryVectorModuleBoundary.test.js`
- Create: `docs/superpowers/plans/2026-07-24-memory-vector-commonjs-migration.md`

- [ ] **Step 1: 只暂存14个实现范围文件**

Run:

```powershell
git add -- src/memory/vector/normalization.js src/memory/vector/store-runtime.js src/memory/vector/write-runtime.js src/memory/vector/stats-runtime.js src/memory/vector/scoring-core.js src/memory/vector/scoring-selection.js src/memory/vector/retrieval-runtime.js src/memory/vector/index.js src/memory/vector/retrieval.js src/memory/vector/store.js src/memory/vector/write.js src/memory/vector/stats.js tests/memoryVectorModuleBoundary.test.js docs/superpowers/plans/2026-07-24-memory-vector-commonjs-migration.md
git diff --cached --name-only
```

Expected: cached清单精确为上述14个文件，不包含旧chunk、既有memory文档、依赖、CI、覆盖率、安全诊断或其他并行文件。

- [ ] **Step 2: 创建实现提交**

Run:

```powershell
git commit -m "refactor: replace memory vector chunk loader"
git rev-parse --short HEAD
```

Expected: commit成功；保存实现短哈希供文档记录。不得推送远端。

### Task 13: 更新4/6路线图并提交4个文档

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`
- Modify: `docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md`
- Modify: `docs/superpowers/plans/2026-07-24-memory-vector-commonjs-migration.md`

- [ ] **Step 1: 写入带时区的验收证据**

本计划随实现提交首次纳入版本控制；实现提交后只在上述4个文档追加 `YYYY-MM-DD HH:mm +08:00`、实现哈希、169/169 AST、23项API/5门面/legacy身份、3项store状态和writePipelineActive归属、0未知、0循环、lazy/native边界、Node 20/24九项结果、全门禁、audit真实结果以及并发4完整测试文件数和耗时。其他既有memory文档不修改。

- [ ] **Step 2: 将目标5更新为部分完成4/6**

路线图写明 `daily-share`、`passive-awareness`、`meme`、`memory/vector` 已迁移；动态chunk入口由3个降为2个，仅余 `message/handler` 与 `runtime-v2/context`。目标6仍未完成，必须等待两个剩余入口迁移后生成全仓权威生产依赖图。

- [ ] **Step 3: 只暂存4个文档并提交**

Run:

```powershell
git add -- README.md docs/maintenance-log.md docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md docs/superpowers/plans/2026-07-24-memory-vector-commonjs-migration.md
git diff --cached --name-only
git commit -m "docs: record memory vector migration"
```

Expected: cached清单精确为4个文档；提交成功且不包含其他memory文档或并行文件。不得推送远端。

- [ ] **Step 4: 提交后最终核对**

Run:

```powershell
git status --short --untracked-files=all
git log -2 --oneline
```

Expected: 两个新提交依次为实现与文档；工作树只保留任务开始前的并行改动，本计划范围无未提交差异。
