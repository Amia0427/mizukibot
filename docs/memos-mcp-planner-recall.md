# MemOS MCP Planner Recall

更新时间：2026-05-19 22:37 +08:00

## 目标

把 MemOS MCP 接成 planner 内部召回器。主回复模型不直接拿 MemOS MCP 工具，只接收 planner 认可后的短记忆摘要。

## 流程

```text
prepare/planner
  -> utils/memosPlannerRecall.recallForPlanner()
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
- 默认不写远端记忆，避免和现有 Memory V3 重复污染。

## 真实连通性记录

2026-05-19 22:37 +08:00：Windows 本地真实调用通过，`memos-api-mcp` 以 `protocolMode=line` 初始化成功，`search_memory` 返回 `code=0`。当前 `MEMOS_USER_ID` 下远端列表为空，因此不生成 `[MemOSRecall]` 动态块。

## 验证

```bash
node tests/memosPlannerRecall.test.js
node tests/memosPlannerPromptIntegration.test.js
node tests/mcpLazyDiscovery.test.js
```
