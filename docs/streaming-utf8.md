# Streaming UTF-8 Handling

更新时间：2026-05-23 19:10 +08:00

## 结论

2026-05-23 19:10 +08:00：QQ 回复中出现 `……你���了啊` 这类乱码，主因是主模型/子代理 SSE 或 stdout 流把每个 `Buffer` 分片单独 `toString('utf8')`。中文字符跨分片时，半个 UTF-8 字符会被替换成 `�`，后续无法恢复。

## 当前规则

- `api/parser.js` 的 `extractSSEEvents` 对 Buffer 使用 `StringDecoder('utf8')`，同一个 state 保留未完成字节。
- HAPI、Gateway、system proxy 和子代理 stdout/stderr 统一通过 `utils/utf8Stream.js` 解码。
- 新增回归测试覆盖 SSE 中文跨分片、通用读流跨分片、持久子代理 JSON 行跨分片。

## 验证

```bash
node tests/parserOpenAICompatibleCacheUsage.test.js
node tests/utf8Stream.test.js
node tests/persistentSubagentUtf8Stream.test.js
node tests/persistentSubagentCommandBackend.test.js
node tests/hapiBackend.test.js
```
