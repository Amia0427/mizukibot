# 主回复模型内置联网搜索诊断

更新 2026-05-23 23:20 +08:00：新增 `scripts/diagnose-main-model-web-search.js`，用于分别探测普通主回复、管理员主回复和管理员 fallback 参考链路是否具备模型/供应商内置联网搜索能力。

## 诊断命令

```bash
node scripts/diagnose-main-model-web-search.js
node scripts/diagnose-main-model-web-search.js --json --timeout-ms=60000
```

脚本会跑三类探针：

- `no_tool`：按主回复实际 chat-completions 链路请求，不提供任何工具，判断模型自身是否能联网。
- `openai_responses_web_search_preview`：尝试 OpenAI Responses `web_search_preview` 原生工具参数。
- `anthropic_messages_web_search`：尝试 Anthropic Messages `web_search_20250305` 原生工具参数。

## 本次实测

测试时间：2026-05-23 23:18-23:24 +08:00。

- 普通主回复模型：`AI_MODEL=claude-opus-4-6`，`API_BASE_URL=https://superapi.buzz/v1/chat/completions`。
- 管理员主回复模型：`ADMIN_AI_MODEL=claude-opus-4-6`，`ADMIN_API_BASE_URL=https://superapi.buzz/v1/messages`。
- 管理员 fallback 参考：`ADMIN_AI_FALLBACK_MODEL=按量K-claude-opus-4-6`，`ADMIN_AI_FALLBACK_API_BASE_URL=https://api.ekan8.com/v1/messages`。

结论：

- 普通主回复 `no_tool` 返回 `can_web_search=false`，明确说明没有模型内置联网搜索能力。
- 管理员主回复 `no_tool` 返回 `can_web_search=false`，明确说明没有模型内置联网搜索能力。
- OpenAI Responses `web_search_preview` 对普通、管理员和 fallback 链路均返回 `500 not implemented`，当前网关不支持这一路原生搜索。
- Anthropic Messages `web_search_20250305` 在普通主回复和管理员主回复专用渠道均可被接受，并返回 Reuters 来源 URL；管理员 fallback 参考链路也返回成功，但文本自述搜索能力有限。
- 管理员主回复专用渠道中途曾多次返回供应商 `503 system cpu overloaded`，23:24 +08:00 复测已成功，因此判定为临时渠道负载问题。

## 使用判断

当前线上主回复链路没有把任何原生联网搜索参数传给主模型，所以“主回复模型”和“管理员主回复模型”按实际链路都没有内置联网搜索能力。需要实时信息时仍应走项目已有 `web_search` / `web_fetch` 工具链路，或后续显式实现 provider-native search 参数注入。
