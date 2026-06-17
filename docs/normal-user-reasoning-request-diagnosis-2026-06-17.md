# 普通用户模型推理链路真实请求诊断

时间戳：2026-06-17 22:26 +08:00

## 小目标

确认普通用户模型链路是否“模型无思考能力”，以及本地代码是否存在推理参数无效、未开启思考模式的问题。

## 现场配置

- 普通主回复模型：`AI_MODEL=gemini-3-flash-preview`
- 普通主回复端点：`API_BASE_URL=https://gcli.ggchan.dev/v1/chat/completions`
- Provider：`openai_compatible`
- 普通主回复推理强度：`AI_REASONING_EFFORT=medium`
- 普通快速回复：`NORMAL_FAST_REPLY_ENABLED=true`

## 本地代码结论

- 普通主回复会从配置读取推理强度：`api/runtimeV2/model/shared.js:231`。
- 普通主回复请求体会写入 `reasoning_effort`：`api/runtimeV2/model/shared.js:609`。
- OpenAI-compatible 请求准备阶段会保留有效 `reasoning_effort`，值为 `off` 时才删除：`src/model/http/prepare.chunk.js:138`。
- Anthropic Messages 链路会把 `reasoning_effort` 转成 `thinking`/`budget_tokens`：`src/model/http/request-shaping.chunk.js:676`。
- 普通快速回复链路显式覆盖为 `reasoningEffort: 'off'`：`core/normalFastReplyRuntime.js:455`，这是当前设计，不是配置未生效。
- 解析层能读取 provider 显式返回的 `reasoning` / `reasoning_content` / `thinking`：`api/parser.js:617`、`api/parser.js:663`。

## 真实请求验证

1. 运行请求体诊断：

```powershell
node scripts/diagnose-provider-request.js --scenario main_reply
```

结果：`main_reply` 最终 provider 为 `openai_compatible`，目标 host 为 `gcli.ggchan.dev`，请求体 keys 包含 `reasoning_effort`，无 provider/鉴权/协议异常。

2. 同一普通用户主回复链路，对同一道逻辑题做 `medium` 和 `off` 对照真实请求。

问题：`A说B在说谎；B说C在说谎；C说A和B都在说谎。假设恰好一人说真话。只输出：谁说真话。`

| 案例 | 请求推理参数 | HTTP | 耗时 | 正文 | reasoning 字段 | usage |
| --- | --- | --- | --- | --- | --- | --- |
| medium | `reasoning_effort=medium` | 200 | 3558ms | `B` | 无 | prompt 39 / completion 1 / total 160 |
| off | 无 `reasoning_effort` | 200 | 4093ms | `B` | 无 | prompt 39 / completion 1 / total 159 |

## 结论

- 不是“普通主回复本地没开思考”：普通主回复请求体确实携带 `reasoning_effort=medium`。
- 不是“模型完全无思考能力”：真实逻辑题返回正确答案 `B`。
- 当前 gcli Gemini OpenAI-compatible 响应没有返回显式 `reasoning` / `reasoning_content` 字段，所以 QQ reasoning 转发没有可转发来源。
- `reasoning_effort=medium` 与关闭推理在这条短题上没有明显可观察差异；只能说明该上游不暴露推理字段，或该模型/网关对该参数的效果不可观测，不能证明模型没有内部推理。
- 如果问题发生在 `normal_fast_reply`，那条链路确实被代码主动关闭 reasoning，用于低延迟快速回复；它和普通主回复不是同一参数策略。

## 验收结果

- `node scripts/diagnose-provider-request.js --scenario main_reply`：通过，请求体包含 `reasoning_effort`。
- `medium` 真实请求：HTTP 200，正文 `B`，无显式 reasoning 字段。
- `off` 对照请求：HTTP 200，正文 `B`，无显式 reasoning 字段。

小目标完成：普通主回复本地推理参数链路已验证有效；未发现本地代码把主回复思考模式关掉。普通快速回复关闭 reasoning 属于现有设计边界。
