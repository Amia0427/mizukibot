# Create Agent

更新时间：2026-05-21 22:53 +08:00

## Right Code Draw 配置

按 Right Code Draw 文档，`CREATE_AGENT_API_BASE_URL` 推荐配置为 `https://www.right.codes/draw`，让代码按协议拼出 `/v1/images/generations` 或 `/v1/chat/completions`。

当前用于图片生成的推荐配置：

```env
CREATE_AGENT_API_BASE_URL=https://www.right.codes/draw
CREATE_AGENT_PROTOCOL=images
CREATE_AGENT_RESPONSE_FORMAT=url
```

`/draw` 基础地址会优先尝试文档路径 `/v1/images/generations`，再回退到 `/images/generations`。

## 生图错误映射

- `http_error 404` 默认仍表示上游接口路径不存在。
- `file not found, The resource is valid for 2 hours` 表示供应商返回的临时图片资源不可取或已失效，回复为“生图临时资源已失效，请重试或更换提示词”。
- axios 返回 Buffer 错误体时会先解码为 UTF-8，便于日志直接显示真实上游原因。
- 下载临时图片 URL 失败时，错误对象的 `requestUrl` 记录真实图片 URL，不再用模型请求 endpoint 混淆定位。
