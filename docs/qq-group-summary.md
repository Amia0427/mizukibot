# QQ 群总结

更新 2026-05-27 10:02 +08:00：新增管理员手动群总结命令 `/群总结 [条数]`，第一版只输出文本报告。

更新 2026-05-27 10:46 +08:00：群总结模型支持独立 env 配置，不再只能跟随管理员主模型。

## 用法

在 QQ 群内由 `ADMIN_USER_IDS` 中的管理员发送：

```text
/群总结
/群总结 50
```

- 默认读取最近 `GROUP_SUMMARY_DEFAULT_LIMIT=200` 条群消息。
- 单次上限为 `GROUP_SUMMARY_MAX_LIMIT=500` 条。
- 发给模型的清洗后聊天文本最多 `GROUP_SUMMARY_MODEL_MAX_CHARS=12000` 字符。

## 模型配置

可选独立模型配置：

```env
GROUP_SUMMARY_MODEL=summary-model
GROUP_SUMMARY_API_BASE_URL=https://example.com/v1/chat/completions
GROUP_SUMMARY_API_KEY=sk-xxx
GROUP_SUMMARY_MODEL_TYPE=openai_compatible
```

- `GROUP_SUMMARY_MODEL_TYPE` 可填 `openai_compatible`、`anthropic`、`gemini_native`。
- 兼容别名：`GROUP_SUMMARY_API_BASEURI`、`GROUP_SUMMARY_APIKEY`。
- 这组配置全空时，继续使用现有管理员主模型链路。

## 行为

- 只支持群聊，私聊返回“仅群聊可用。”
- 非管理员返回“仅管理员可用。”
- 历史消息来自 NapCat / OneBot `get_group_msg_history`。
- 报告包含整体概览、热门话题、金句/高能发言、活跃成员和氛围评价。
- 如果模型调用失败，会返回基础统计，不写入长期记忆，不触发定时任务。
