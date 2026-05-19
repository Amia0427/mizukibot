# MemOS MCP Planner Recall

更新时间：2026-05-19 23:48 +08:00

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

2026-05-19 23:48 +08:00：支持 `MEMOS_KB_IDS` 按知识库 ID 只读召回，真实验证会通过 `search_memory` 传入 `knowledgebase_ids` 并生成 `[MemOSRecall]`。

2026-05-19 23:41 +08:00：默认召回源改为 MemOS 远端知识库只读文档，关闭本地 agent 对远端 MemOS 的写入能力。

- `search_memory` 的真实入参支持 `knowledgebase_ids: string[]`，适合按知识库 ID 召回；`get_kb_documents` 的真实入参是 `file_ids: string[]`，只适合已知具体文档 ID。
- planner 仍负责过滤噪声；主回复 prompt 只收到 `[MemOSRecall]` 摘要，不收到原始 MCP 工具。
- 没有配置 `MEMOS_KB_IDS` 或 `MEMOS_KB_FILE_IDS` 时，召回结果为 `used=false`、`rejectedReason=kb_file_ids_missing`，主流程继续降级。
- 写入类工具只保留 discovery 诊断，不参与运行时调用。

## 去重策略

2026-05-19 23:12 +08:00：新增 MemOS/local recall 去重层，覆盖 planner 输入和主 prompt 生成兜底。

- 精确去重：去标签、编号、标点、常见中文连接词后比较 canonical 文本。
- 模糊去重：使用中文/英文 char 3-gram Dice，相似度默认阈值 `0.82`。
- 包含去重：短文本被长文本覆盖且覆盖率达到 `0.85` 时视为重复。
- 优先级：本地短期/Memory V3/向量召回优先于 MemOS 远端重复项。
- 全部 MemOS 项都重复时，`memosRecall.used=false`，`rejectedReason=deduped_by_local_memory`，主 prompt 不生成 `memos_recall` 块。

## 真实连通性记录

2026-05-19 22:37 +08:00：Windows 本地真实调用通过，`memos-api-mcp` 以 `protocolMode=line` 初始化成功，`search_memory` 返回 `code=0`。当前 `MEMOS_USER_ID` 下远端列表为空，因此不生成 `[MemOSRecall]` 动态块。

## 验证

```bash
node tests/memosPlannerRecall.test.js
node tests/memoryRecallDeduper.test.js
node tests/memosPlannerPromptIntegration.test.js
node tests/mcpLazyDiscovery.test.js
```
