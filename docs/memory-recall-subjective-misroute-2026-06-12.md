# 长期记忆主观问题误召回复盘

时间戳：2026-06-12 23:08 +08:00

## 真实日志结论

- 样本：`messageId=699530001`，用户私聊“你最喜欢我的哪一点”。
- 路由：被标成 `lookup/notebook-answer`，`routePolicyKey=lookup/notebook-answer`。
- 召回：`memory-recall-observability.ndjson` 中 `req_f868b8d545f88b5b` 注入了 2026-05-27 的无关成人内容 journal segment，以及多个低分/背景级 Q/A。
- 结果：最终回复没有完全跑偏，但主回复 prompt 已经带入与问题无关的高刺激长期记忆，存在“文不对题”和风格污染风险。

## 根本原因

1. 召回意图误判：`classifyMemoryNeed` 把“我的 + 喜欢/哪一点”归入 `personal_history_question:preference`，没有区分“问 bot 当前主观看法”和“要求回忆用户历史偏好”。
2. 召回证据质量门过宽：运行时只要 trace 有命中、`retrieved_count > 0` 或 `injected_block_ids` 带 `retrieved_memory_lite`，就可能自动加入长期记忆块；弱相关/背景级命中也能进入 prompt。
3. 动态 prompt 启发式过度依赖“有候选记忆”，没有要求“本轮明确需要记忆”，普通聊天也会把 Retrieved/Daily Journal 当可用上下文。

## 已做修复

- 新增当前主观关系问题识别：如“你最喜欢我的哪一点”不再触发长期记忆；“你记得你最喜欢我的哪一点吗”仍触发 preference recall。
- `retrieved_memory_lite` 自动注入改为需要明确召回意图或强证据；弱/背景 trace 不再单独触发。
- heuristic 动态 prompt 只有 `forceMemoryContext=true` 时才默认选择 `retrieved_memory_lite` / `daily_journal`。
- 新增轻量回归：`tests/subjectiveRelationshipMemoryGate.test.js`。

## 后续优化建议

- preference/relationship 召回应按问题方向拆分：用户偏好回忆、bot 对用户评价、关系历史回忆分别走不同 facet。
- journal segment 进入 prompt 前增加低相关过滤：强制最低分、主题相似度或 rerank 通过，避免单个“喜欢”把成人/擦边历史拉入普通聊天。
- 对 `weakEvidence` 默认只做 trace，不进入主回复；仅在明确“想不起/更早/证据不足”场景下启用。
- profile 画像继续清理“用户正在讨论某术语”这类临时话题被写成 identity 的污染项。

小目标完成：主观情感提问不再因为“我/喜欢/哪一点”误走长期记忆召回。
