# MemOS MCP Planner Recall

更新时间：2026-05-20 00:42 +08:00

## 目标

把 MemOS MCP 接成 planner 内部只读召回器，主要读取 MemOS 远端知识库文档。主回复模型不直接拿 MemOS MCP 工具，只接收 planner 认可后的短记忆摘要。

## 流程

```text
prepare/planner
  -> utils/memosPlannerRecall.recallForPlanner()
  -> utils/memoryRecallDeduper.dedupeMemosRecallAgainstMemoryContext()
  -> planner 判断是否启用 memos_recall
  -> runtimeV2/context 构建 [MemOSRecall] 动态块
  -> 主回复模型单次调用
```

## 配置

`.mcp.json` 服务名：`memos-api-mcp`

```env
MEMOS_MCP_ENABLED=false
MEMOS_MCP_SERVER_NAME=memos-api-mcp
MEMOS_API_KEY=
MEMOS_USER_ID=
MEMOS_CHANNEL=MODELSCOPE
MEMOS_RECALL_SOURCE=knowledge_base
MEMOS_KB_IDS=
MEMOS_KB_FILE_IDS=
MEMOS_KB_FALLBACK_SEARCH_ENABLED=false
MEMOS_RECALL_TOP_K=5
MEMOS_RECALL_MAX_CHARS=900
MEMOS_RECALL_TIMEOUT_MS=1200
MEMOS_WRITE_ENABLED=false
MEMOS_WRITE_ASYNC=true
```

## 约束

- planner 可增加一次 MCP recall/discovery 判断，主回复模型调用次数不增加。
- MemOS 工具发现固定对 `memos-api-mcp` 做真实 discovery；即使全局 `MCP_DISCOVERY_MODE=lazy`，也会校验实际工具列表。
- `memos_recall` 优先级低于 `short_term_continuity`，高于 `background_research`。
- MemOS 召回只作为证据，不覆盖 Memory V3、短期连续性、persona memory。
- MemOS 召回会先与本地 `memoryContext` 去重；重复项保留本地 Memory V3/向量记忆，MemOS 只进入 diagnostics，不重复进入 `[MemOSRecall]`。
- 默认召回源是 `knowledge_base`。配置 `MEMOS_KB_IDS` 时调用只读 `search_memory` 并传入 `knowledgebase_ids`；配置 `MEMOS_KB_FILE_IDS` 时调用只读 `get_kb_documents` 精确读取文档。
- 本地 agent 运行时不写远端记忆：即使误配 `MEMOS_WRITE_ENABLED=true`，`addMessageToMemos()` 也会返回 `remote_write_disabled`，不会调用 `add_message`。
- 不自动调用 `add_message`、`add_kb_document`、`create_knowledge_base`、`delete_kb_documents`、`remove_knowledge_base`。
- 如需临时兼容旧记忆搜索，可显式设置 `MEMOS_RECALL_SOURCE=search_memory`；如需 KB 为空再退回搜索，显式设置 `MEMOS_KB_FALLBACK_SEARCH_ENABLED=true`。

## 远端知识库只读模式

2026-05-20 00:19 +08:00：补充召回观测日志；MemOS 仍保持只读，不向远端写入本地 agent 记忆。

2026-05-19 23:48 +08:00：支持 `MEMOS_KB_IDS` 按知识库 ID 只读召回，真实验证会通过 `search_memory` 传入 `knowledgebase_ids` 并生成 `[MemOSRecall]`。

2026-05-19 23:41 +08:00：默认召回源改为 MemOS 远端知识库只读文档，关闭本地 agent 对远端 MemOS 的写入能力。

- `search_memory` 的真实入参支持 `knowledgebase_ids: string[]`，适合按知识库 ID 召回；`get_kb_documents` 的真实入参是 `file_ids: string[]`，只适合已知具体文档 ID。
- planner 仍负责过滤噪声；主回复 prompt 只收到 `[MemOSRecall]` 摘要，不收到原始 MCP 工具。
- 没有配置 `MEMOS_KB_IDS` 或 `MEMOS_KB_FILE_IDS` 时，召回结果为 `used=false`、`rejectedReason=kb_file_ids_missing`，主流程继续降级。
- 写入类工具只保留 discovery 诊断，不参与运行时调用。

## 召回观测日志

2026-05-20 00:42 +08:00：修复 planner decision 出口的 `memosRecall/memosRecallText` 传递；当 planner include `memos_recall` 但 prepare 前召回对象为空或最终 prompt 缺块时，记录 `stage=memos_recall_dropped_before_prompt`。

2026-05-20 00:19 +08:00：新增 `data/memory-recall-observability.ndjson`，用于评估 MemOS 远端知识库召回和本地 Memory V3/向量记忆召回的速度、命中和最终注入情况。

- `stage=planner_memos_recall`：记录 MemOS 召回耗时、召回源、工具名、知识库数量、去重前后候选数、`usedBeforeDedupe`、`usedAfterDedupe`、`rejectedReason`、去重原因。
- `stage=prepare_main_prompt_blocks`：记录主回复 prompt 的 `stableBlockIds`、`dynamicBlockIds`、`assistantOnlyBlockIds`，以及 `hasMemosRecall`、`hasRetrievedMemoryLite`、`hasShortTermContinuity`。
- `stage=memos_recall_dropped_before_prompt`：表示 planner 已选择 `memos_recall`，但召回对象未传到 prompt 构建或最终 block 未进入主 prompt。
- 日志只写候选的短 `textPreview` 和 `textHash`，不写完整远端知识库正文，不写 API key。
- 结合 `data/model-calls.ndjson` 可按 `requestId` 对齐主回复耗时和调用次数；主回复模型调用次数仍只看 main reply 记录。

## 去重策略

2026-05-19 23:12 +08:00：新增 MemOS/local recall 去重层，覆盖 planner 输入和主 prompt 生成兜底。

- 精确去重：去标签、编号、标点、常见中文连接词后比较 canonical 文本。
- 模糊去重：使用中文/英文 char 3-gram Dice，相似度默认阈值 `0.82`。
- 包含去重：短文本被长文本覆盖且覆盖率达到 `0.85` 时视为重复。
- 优先级：本地短期/Memory V3/向量召回优先于 MemOS 远端重复项。
- 全部 MemOS 项都重复时，`memosRecall.used=false`，`rejectedReason=deduped_by_local_memory`，主 prompt 不生成 `memos_recall` 块。

## 真实连通性记录

2026-05-19 22:37 +08:00：Windows 本地真实调用通过，`memos-api-mcp` 以 `protocolMode=line` 初始化成功，`search_memory` 返回 `code=0`。当前 `MEMOS_USER_ID` 下远端列表为空，因此不生成 `[MemOSRecall]` 动态块。

## 远端知识库召回优化

2026-05-20 00:19 +08:00：优化方向以“提高远端 KB 命中质量，但不污染远端记忆”为准。

- 知识库分层：按 `角色设定`、`关系称呼`、`风格示例`、`世界观规则`、`项目知识` 拆文档或分段，标题里放稳定主题词。
- query 改写：planner 前优先用“当前问题 + route intent + directed context”生成短 query，避免把整段聊天直接送检索。
- 路由加权：`设定/世界观/角色资料/规则` 类问题提高 MemOS KB 权重；`你是谁/我是谁/关系称呼` 类问题优先本地画像和短期连续性，降低泛角色设定命中的权重。
- 二阶段过滤：`MEMOS_RECALL_TOP_K` 可提高到 8-10，但进入主 prompt 前继续由去重层和 planner 过滤，只保留 1-3 条短摘要。
- 分源优先级：短期连续性 > 本地 Memory V3/向量记忆 > MemOS 远端 KB > 背景研究。远端 KB 只作证据，不覆盖本地事实。
- 负样本沉淀：把 planner 的 skip 原因、`deduped_by_local_memory`、低相关命中写入观测日志即可，不向 MemOS 远端写回。
- 后续可加配置：`MEMOS_RECALL_MIN_SCORE`、`MEMOS_RECALL_QUERY_MODE=compact|raw`、`MEMOS_RECALL_ROUTE_ALLOWLIST`，用于更细粒度地控召回范围。

## 验证

```bash
node tests/memosPlannerRecall.test.js
node tests/memoryRecallDeduper.test.js
node tests/memoryRecallObservability.test.js
node tests/memosPlannerPromptIntegration.test.js
node tests/mcpLazyDiscovery.test.js
```
