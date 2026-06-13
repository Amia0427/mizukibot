# Gemini 用户对话导出

更新 2026-06-04 13:26 +08:00：新增 `scripts/export-gemini-user-dialogues.js` 和 `npm run export:gemini-dialogues`，用于导出最近 24 小时内使用 Gemini 模型的用户对话数据。本次本地导出文件为 `data/exports/gemini-user-dialogues-20260604-052608Z.jsonl`，包含 39 条用户消息、60 次 Gemini 模型调用，已排除 `model_self_check` 自检调用。

更新 2026-06-13 07:52 +08:00：新增 `scripts/diagnose-gemini-sampling-degradation.js` 和 `npm run diag:gemini-sampling`，把一次性 Gemini 样本导出升级为可复跑对比诊断。诊断读取导出 JSON/JSONL 中的 `assistant_reply_preview`，统计模板化、过顺从、节奏发僵、重复尾巴四类高风险模式；可用 `--before/--after` 比较修复前后，也可用 `--export-after` 先复用当前导出脚本重新生成 after 样本。小目标已完成：Gemini 采样退化复查不再依赖手工翻真实对话样本。

## 命令

```bash
npm run export:gemini-dialogues
node scripts/export-gemini-user-dialogues.js --hours 24
node scripts/export-gemini-user-dialogues.js --since 2026-06-03T05:00:00Z --format json
node scripts/export-gemini-user-dialogues.js --success-only --require-message
npm run diag:gemini-sampling
npm run diag:gemini-sampling -- --before artifacts/gemini-sampling-degradation-48h.json --export-after
npm run diag:gemini-sampling -- --before artifacts/gemini-sampling-degradation-48h.json --after data/exports/gemini-sampling-after.json --json
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

## 采样退化对比诊断

- 默认：若存在本地 `artifacts/gemini-sampling-degradation-48h.json`，`npm run diag:gemini-sampling` 会直接分析它。
- 复跑当前窗口：`npm run diag:gemini-sampling -- --before artifacts/gemini-sampling-degradation-48h.json --export-after` 会按最近 48 小时、`--success-only --require-message --format json` 重新导出 after 样本。
- 固定文件对比：`npm run diag:gemini-sampling -- --before <修复前.json> --after <修复后.json> --json` 输出机器可读报告。
- 频次分母只统计有 `assistant_reply_preview` 的 records；没有回复预览的 records 会单独计数，避免被误判为质量改善。
