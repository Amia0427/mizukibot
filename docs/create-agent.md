# Create Agent

更新时间：2026-08-20 +08:00

## `/create` 权限与私聊

`/create <提示词>` 可在群聊或私聊中调用。管理员和 `CREATE_AGENT_ALLOW_USER_IDS` 中的用户直接拥有权限；其他用户读取现有 conversation variables 快照，在 `relationship.affection >= CREATE_AGENT_AFFECTION_THRESHOLD` 时开放，默认阈值为 `30`。好感度不足时，群聊保持原有拒绝动作，私聊继续返回私聊白名单提示。

该阈值只负责授权，不会绕过 `CREATE_AGENT_ENABLED`、provider 鉴权、每日额度或并发限制；普通私聊、其他命令和自然聊天仍遵守原有私聊白名单。

本地验收（2026-08-20）：`tests/messageHandlerCreateCommand.test.js` 验证高好感群聊与私聊均进入执行器，低好感群聊保持 poke、低好感私聊与普通私聊保持白名单拦截；`tests/createAgentExecutor.test.js` 验证群聊和私聊分别使用对应发送上下文。

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
