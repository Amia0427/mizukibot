# 主回复模型内置联网搜索诊断

更新 2026-05-23 23:20 +08:00：新增 `scripts/diagnose-main-model-web-search.js`，用于分别探测普通主回复、管理员主回复和管理员 fallback 参考链路是否具备模型/供应商内置联网搜索能力。

更新 2026-05-23 23:55 +08:00：主回复 Claude Messages 请求默认注入 Anthropic 原生 `web_search_20250305` server tool。诊断脚本新增 `runtime_without_native_search` 和 `runtime_with_native_search` 对照探针，用同一套主回复构建器验证关闭/开启原生搜索后的真实请求结果。

更新 2026-05-24 00:18 +08:00：`web_search_20250305` 注入调整为官方 server tool 形态：不对 server tool 写入 `cache_control`，仅存在 server tool 时不写 `tool_choice`，`user_location` 自动补 `type=approximate`，并避免同时发送 `allowed_domains` 和 `blocked_domains`。诊断脚本把“参数已注入”和“供应商实际执行原生搜索”拆开判断，后者只认 `server_tool_use`、`web_search_tool_result` 或 `usage.server_tool_use`。

## 诊断命令

```bash
node scripts/diagnose-main-model-web-search.js
node scripts/diagnose-main-model-web-search.js --json --timeout-ms=60000
```

脚本会跑五类探针：

- `runtime_without_native_search`：按主回复实际 Claude Messages 链路请求，但显式关闭原生搜索注入。
- `runtime_with_native_search`：按主回复实际 Claude Messages 链路请求，并启用原生 `web_search_20250305` 注入。
- `no_tool`：兼容旧字段，等同于 `runtime_without_native_search`。
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

复测时间：2026-05-24 00:15-00:17 +08:00。

- 普通主回复 `runtime_with_native_search`：`injectedAnthropicWebSearch=true`，`preparedAnthropicWebSearch=true`，但响应无 Anthropic 原生搜索执行证据。
- 管理员主回复 `runtime_with_native_search`：`injectedAnthropicWebSearch=true`，`preparedAnthropicWebSearch=true`，但响应无 Anthropic 原生搜索执行证据。
- `anthropic_messages_web_search` 裸探针在当前网关可返回 Reuters URL 或伪工具文本，但响应体没有 `server_tool_use`、`web_search_tool_result`、`usage.server_tool_use`；URL 只能说明模型文本中出现来源，不能证明 Anthropic server tool 真正执行。
- OpenAI Responses `web_search_preview` 仍返回 `500 not implemented`。

## 使用判断

当前主回复链路已注入 Anthropic 原生搜索参数；如果临时关闭 `MAIN_MODEL_ANTHROPIC_WEB_SEARCH_ENABLED`，普通和管理员主回复仍会退回无内置联网能力。需要确定线上渠道是否真的完成搜索时，看 `runtime_with_native_search.inference.providerSearchEvidence`，不要只看文本里是否出现 URL。
