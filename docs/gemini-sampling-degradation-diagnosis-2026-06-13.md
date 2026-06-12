# Gemini 采样退化真实样本诊断

时间戳：2026-06-13 01:53 +08:00

## 样本

- 导出命令：`node scripts/export-gemini-user-dialogues.js --hours 48 --success-only --require-message --format json --out artifacts/gemini-sampling-degradation-48h.json`
- 样本量：198 条最近 48 小时 Gemini 相关用户对话，263 次成功 Gemini 调用，43 条匹配到主回复预览。
- 模型：`gemini-3-flash-preview`、`gemini-3-flash-preview-search`、`gcli-gemini-3-flash-preview-nothinking`。
- 原始导出含真实对话，不提交；只保留本地 `artifacts/gemini-sampling-degradation-48h.json` 作为现场复核文件。

## 退化模式

最近最像退化的回复不是随机质量波动，而是稳定口吻坍缩：

- 高频起手和收束：`诶——`、`呜哇`、`哈——`、`呢/喔/嘛`、`♪`。
- 普通短句也被扩成舞台化解释或暧昧剧情推进，例如 `req_0deca2e5ec3feacd` 用户只发“区”，最终回复仍扩展成“数值/进度条/受伤”的完整段落。
- `chat/default` 正常快速回复一段很轻，但二段 `v2_streaming_reply/direct_reply` 又带入长期记忆、日记和短期连续性，容易把旧主题带回当前短句。

## 根因 1：Gemini 专属系统提示词过度风格化

证据文件：

- `prompts/GEMINI.txt`
- `prompts/prompt-manifest.json`
- `docs/gemini-system-prompt.md`

证据：

- 当前 `prompt-manifest.json` 已将 `gemini_system_prompt` 按 `model_pattern=gemini` 作为 `system_root` 注入，文档仍写着“不在 manifest 中注册”，说明接入边界已经变化。
- 旧 `prompts/GEMINI.txt` 含“从容、细腻、周全”“情绪含蓄内敛”“用细节、停顿和未说出的话让张力呼吸”“拒绝总结式抒情，让场景自己传递情绪”等叙事写作锚点。
- 这些锚点与 `persona/02_style.txt` 里的“QQ 短消息、默认简短、不要总结式结尾、语气词点到为止”方向冲突，Gemini 更容易把它解释成统一的轻小说口吻。

结论：这是 Gemini 专属系统提示词导致的口吻塌缩，不是单纯采样参数问题。

最小修复：

- `prompts/GEMINI.txt` 收敛为适配层，只保留防出戏、短消息、证据使用和重复口癖抑制。
- 明确禁止把每句写成固定 `诶——/呜哇/呢/喔/♪` 模式。

## 根因 2：普通聊天二段主回复误带召回证据

证据文件：

- `data/model-calls.ndjson`
- `data/request-trace.ndjson`
- `data/memory-recall-observability.ndjson`
- `api/runtimeV2/context/base-dynamic-prompt.chunk.js`
- `api/runtimeV2/context/dynamic-prompt.chunk.js`
- `api/runtimeV2/context/service-core.chunk.js`

证据：

- `req_0deca2e5ec3feacd`：`route_policy_key=chat/default`，`normal_fast_reply` 的 prompt 无记忆标记；随后 `v2_streaming_reply` 变为 `memory_injected=true`，同时 `has_retrieved_memory=true`、`has_daily_journal=true`、`has_short_term_continuity=true`。
- `req_573d683990e13a2e`：同样是 `chat/default`，快速回复无召回，二段 direct reply 带 `retrieved_memory + daily_journal + short_term`。
- `memory-recall-observability.ndjson` 中普通聊天存在 `retrieval_path=prepare_fallback_no_rag`，但仍出现 `injected_block_ids=["retrieved_memory_lite","daily_journal","long_term_profile"]` 的现场。

结论：这是动态上下文注入门过宽，不是模型“采样退化”本身；记忆召回噪声是二级放大因素。

最小修复：

- 新增 `shouldBlockAmbientMemoryForPlainChat`：`chat/default` 且本轮无明确召回意图时，阻断 `retrieved_memory_lite`、`daily_journal`、`memory_recall_policy` 自动进入主回复。
- 明确召回问题仍保留强制注入，例如“你还记得我们昨天聊了什么吗”仍保留 `retrieved_memory_lite` 与 `daily_journal`。
- 新增 `tests/geminiSamplingDegradationPromptGate.test.js` 覆盖普通短句不带旧记忆、显式召回仍带证据。

## 已排除

- 不是 Gemini native 二次注入导致的最近主样本：最近 48 小时主回复实际走 `openai_compatible` 网关 `gcli.ggchan.dev/v1/chat/completions`，不是 `gemini_native` `systemInstruction`。
- 不是纯提示词污染文件 `通用gemini.txt` 直接生效：该文件未被运行时引用；但其内容高风险，仍不应接入。

小目标完成：Gemini 主回复口吻坍缩的两个最可能根因已基于真实样本定位，并完成最小修复。
