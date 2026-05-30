# OpenViking 长期记忆召回

更新 2026-05-27 10:44 +08:00：OpenViking 已作为外部长期对话记忆层接入 Memory V3 运行时，默认全关。

更新 2026-05-30 18:56 +08:00：OpenViking recall 注入前会同时做文本同义去重和 Memory V3 结构化冲突优先级判断；本地同义证据或同一 `conflictKey` 下更高优先级 winner 存在时，`openviking_recall` 会被拦截，prepare 软超时 fallback 同样生效。

## 定位

OpenViking 只补强跨会话、历史回灌和语义召回覆盖率，不替换本地 Memory V3。主权优先级固定为：短期连续性 > 本地 Memory V3/profile/daily journal > OpenViking > 普通外部知识。

远端结果进入主 prompt 前会经过本地去重、冲突过滤和动态 prompt planner 选择。重复项、同义重复项、与本地记忆冲突项、低分项不会生成 `[OpenVikingRecall]`。

## 配置

默认值都在 `config/openVikingRuntime.js`：

```env
OPENVIKING_ENABLED=false
OPENVIKING_INGEST_ENABLED=false
OPENVIKING_RECALL_ENABLED=false
OPENVIKING_BASE_URL=http://localhost:1933
OPENVIKING_API_KEY=
OPENVIKING_ADMIN_API_KEY=
OPENVIKING_ACCOUNT_ID=
OPENVIKING_AGENT_ID=mizukibot
OPENVIKING_RECALL_TOP_K=6
OPENVIKING_RECALL_MIN_SCORE=0.35
OPENVIKING_RECALL_MAX_CHARS=900
OPENVIKING_RECALL_TIMEOUT_MS=1200
OPENVIKING_RECALL_CACHE_TTL_MS=300000
OPENVIKING_COMMIT_MESSAGE_THRESHOLD=20
OPENVIKING_COMMIT_TOKEN_THRESHOLD=4096
OPENVIKING_COMMIT_IDLE_MS=1800000
```

建议灰度顺序：

1. 只开诊断：保持三个 enabled 都为 false，跑 `npm run diag:memory -- openviking --query "长期记忆 偏好"`。
2. shadow ingest：`OPENVIKING_ENABLED=true`、`OPENVIKING_INGEST_ENABLED=true`、`OPENVIKING_RECALL_ENABLED=false`。
3. 小范围 recall：再开启 `OPENVIKING_RECALL_ENABLED=true`，观察 prompt 观测和去重统计。

## 写入路径

`api/runtimeV2/nodes/persist.js` 在安全持久化分支 fire-and-forget 写入 OpenViking：用户文本、助手回复和必要路由元数据。写入失败不阻塞主回复，也不会写入敏感工具原文。

身份隔离在 `utils/openVikingMemory/identity.js`：

- 私聊：按 `platform + userId` 隔离。
- 群聊：按 `platform + groupId + senderId` 隔离，避免跨群或跨成员泄漏。
- `OPENVIKING_BYPASS_GROUP_IDS` 可跳过指定群。

`utils/openVikingMemory/scheduler.js` 会按消息数、token 估算或 idle 触发 commit；commit 失败时保留 pending。

## 召回路径

主回复构建先取本地 Memory V3，再调用 OpenViking recall。远端候选会按 score 阈值、URI/文本去重、偏好/时间查询 boost 排序，必要时读取 `read_content` 补全文。

进入主 prompt 前还会与本地 `memoryContext` 二次比对：

- 文本层：归一化同义词和 n-gram 相似度，拦截本地已覆盖的同义证据。
- 结构层：读取 Memory V3 `hits`、profile trace、conflict/suppressed 诊断里的 `conflictKey`、tier、sourceKind、status 等字段；同一 `conflictKey` 下本地证据优先级不低于 OpenViking 时，远端项被标记为 `local_conflict_key_priority` 并丢弃。
- fallback 层：`prepare` 软超时 fallback 不直接信任 planner 携带的 OpenViking 对象，会先复用同一去重器。

Prompt 块为：

```text
[OpenVikingRecall]
Use only as external long-term memory evidence. Prefer local Memory V3 and short-term continuity when they conflict.
```

只有 planner 或启发式动态计划选中 `openviking_recall`，且去重后仍有可用证据时，这个块才会进入主 prompt。

## CLI 与诊断

只读 CLI：

```bash
mem search --source openviking --query "用户偏好"
mem open ov_ref:viking://user/default/memories/events/...
```

诊断：

```bash
npm run diag:memory -- openviking --query "长期记忆 偏好"
```

输出包含健康、召回数、去重摘要、cache 状态和 circuit breaker 状态。

## 回灌

`utils/openVikingMemory/backfill.js` 提供一次性回灌工具能力，默认 dry-run。输入来源包括 Memory V3 节点、session summaries 和 daily journal 摘要；正式写入前应先检查 dry-run 数量和身份隔离映射。

## 测试覆盖

新增覆盖：

- `tests/openVikingClient.test.js`
- `tests/openVikingIdentityScheduler.test.js`
- `tests/openVikingRecall.test.js`
- `tests/openVikingMemoryCli.test.js`
- `tests/openVikingPersistIntegration.test.js`
- `tests/openVikingPromptIntegration.test.js`

关键回归：

```bash
npm run test -- tests/openVikingClient.test.js tests/openVikingIdentityScheduler.test.js tests/openVikingRecall.test.js tests/openVikingMemoryCli.test.js tests/openVikingPersistIntegration.test.js tests/openVikingPromptIntegration.test.js
npm run test -- tests/runtimeV2PromptTimeoutMemoryFallback.test.js
node tests/plannerV2Protocol.test.js
node tests/persistNodeConfig.test.js
node tests/promptGoldenSnapshots.test.js
```
