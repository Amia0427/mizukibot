# Streaming UTF-8 Handling

更新时间：2026-05-23 19:10 +08:00

## 结论

2026-05-23 19:10 +08:00：QQ 回复中出现 `……你���了啊` 这类乱码，主因是主模型 SSE 或 stdout 流把每个 `Buffer` 分片单独 `toString('utf8')`。中文字符跨分片时，半个 UTF-8 字符会被替换成 `�`，后续无法恢复。

2026-05-30 +08:00：OpenClaw / Claude CLI / HAPI 外部子 agent 激活链路已移除；本文只保留主模型和通用流式解码规则。

## 当前规则

- `api/parser.js` 的 `extractSSEEvents` 对 Buffer 使用 `StringDecoder('utf8')`，同一个 state 保留未完成字节。
- 通用读流通过 `utils/utf8Stream.js` 解码。
- 回归测试覆盖 SSE 中文跨分片和通用读流跨分片。

## 验证

```bash
node tests/parserOpenAICompatibleCacheUsage.test.js
node tests/utf8Stream.test.js
```
