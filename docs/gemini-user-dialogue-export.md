# Gemini 用户对话导出

更新 2026-06-04 13:26 +08:00：新增 `scripts/export-gemini-user-dialogues.js` 和 `npm run export:gemini-dialogues`，用于导出最近 24 小时内使用 Gemini 模型的用户对话数据。本次本地导出文件为 `data/exports/gemini-user-dialogues-20260604-052608Z.jsonl`，包含 39 条用户消息、60 次 Gemini 模型调用，已排除 `model_self_check` 自检调用。

## 命令

```bash
npm run export:gemini-dialogues
node scripts/export-gemini-user-dialogues.js --hours 24
node scripts/export-gemini-user-dialogues.js --since 2026-06-03T05:00:00Z --format json
node scripts/export-gemini-user-dialogues.js --success-only --require-message
```

默认输出到 `data/exports/gemini-user-dialogues-<timestamp>.jsonl`。`data/` 是本地运行数据目录，不提交原始对话内容。

## 数据源

- `data/model-calls.ndjson*`：按 `model/provider/api_base_url/host` 匹配 `gemini`，得到 Gemini 模型调用和状态。
- `data/request-trace.ndjson*`：用 `request_id` 找到消息 ID、用户、群、路由和入站时间。
- `data/napcat-message-events.jsonl`：用消息复合键匹配用户原始消息、清洗文本和消息段。
- `data/langgraph_v2_events/*.json`：若能按 `requestId` 找到 `persist_complete`，补充 assistant 回复预览。

## 输出结构

JSONL 第一行是 `metadata`，后续每行是一个 `conversation`：

- `raw_message` / `clean_text`：用户原文和清洗文本。
- `user_id` / `group_id` / `message_id` / `message_time`：来源标识。
- `route`：主回复路由信息。
- `gemini_models` / `gemini_call_count` / `gemini_call_statuses`：关联的 Gemini 调用汇总。
- `gemini_calls`：每次调用的模型、provider、状态、错误码、token 用量和 prompt 摘要。
- `match`：关联依据，优先 `request_trace+napcat_composite`。
