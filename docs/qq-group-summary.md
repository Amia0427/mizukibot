# QQ 群总结

更新 2026-05-27 10:02 +08:00：新增管理员手动群总结命令 `/群总结 [条数]`，第一版只输出文本报告。

更新 2026-05-27 10:46 +08:00：群总结模型支持独立 env 配置，不再只能跟随管理员主模型。

更新 2026-05-27 11:05 +08:00：群总结模板改为群日报结构，并支持 `GROUP_SUMMARY_STYLE=daily|brief|ops`。

## 用法

在 QQ 群内由 `ADMIN_USER_IDS` 中的管理员发送：

```text
/群总结
/群总结 50
```

- 默认读取最近 `GROUP_SUMMARY_DEFAULT_LIMIT=200` 条群消息。
- 单次上限为 `GROUP_SUMMARY_MAX_LIMIT=500` 条。
- 发给模型的清洗后聊天文本最多 `GROUP_SUMMARY_MODEL_MAX_CHARS=12000` 字符。
- 输出风格由 `GROUP_SUMMARY_STYLE` 控制，默认 `daily`。

## 模型配置

可选独立模型配置：

```env
GROUP_SUMMARY_MODEL=summary-model
GROUP_SUMMARY_API_BASE_URL=https://example.com/v1/chat/completions
GROUP_SUMMARY_API_KEY=sk-xxx
GROUP_SUMMARY_MODEL_TYPE=openai_compatible
GROUP_SUMMARY_STYLE=daily
```

- `GROUP_SUMMARY_MODEL_TYPE` 可填 `openai_compatible`、`anthropic`、`gemini_native`。
- `GROUP_SUMMARY_STYLE` 可填 `daily`、`brief`、`ops`。
- 兼容别名：`GROUP_SUMMARY_API_BASEURI`、`GROUP_SUMMARY_APIKEY`。
- 这组配置全空时，继续使用现有管理员主模型链路。

## 输出模板

默认输出包含：

- 今日概览
- 热门话题
- 关键结论/待办
- 高能发言/金句
- 活跃成员
- 氛围评价
- 数据概览

模板约束：

- 优先写具体事件、问题、决定和有信息量的发言。
- 禁止没有事实支撑的空话，例如“大家积极参与讨论”“群内气氛活跃”。
- 金句必须来自聊天记录，原文优先；不得合成多人发言或编造引语。

## 行为

- 只支持群聊，私聊返回“仅群聊可用。”
- 非管理员返回“仅管理员可用。”
- 历史消息来自 NapCat / OneBot `get_group_msg_history`。
- 报告包含整体概览、热门话题、金句/高能发言、活跃成员和氛围评价。
- 如果模型调用失败，会返回基础统计，不写入长期记忆，不触发定时任务。
