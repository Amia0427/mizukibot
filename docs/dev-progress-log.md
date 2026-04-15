# 开发进度日志

## 2026-04-04

### 本轮已完成

- 只修改了 [core/messageHandler.js](/D:/0.01/linux-migration-pack/core/messageHandler.js) 的 clarify 接线，不碰 `router`、`routeExecution`、`agentGraph`、`ai.js`。
- 将 clarify 专用配置真正接入主聊天分发：
  - 当 `isClarifyRoute` 为真时，使用 `buildClarifyChatOptions(route, routeExecutionPlan, groupId, senderId)` 生成专用 options。
  - 将 `askAIDispatch(...)` 的传参从原来的 `streamOptions` 改为 `replyOptions`。
  - clarify 现在会稳定覆盖：
    - `routePrompt`
    - `routeType`
    - `topRouteType`
    - `routeMeta`
    - `disableTools: true`
    - `disableStream: true`
- 同步了服务器文件：
  - 目标路径：`/root/deployments/linux-migration-pack/core/messageHandler.js`
  - 远端备份：`/root/deployments/linux-migration-pack/core/messageHandler.js.bak_codex_clarify_route_20260404_135322`
- 重启了服务器服务：
  - `systemctl restart mizukibot.service`
- 已做线上真实消息验证，确认 clarify 行为生效。

### 本轮验证结果

- 本地验证通过：
  - `node --check core/messageHandler.js`
  - `node tests/messageFlowSource.test.js`
  - `node tests/runtimePrompts.test.js`
- 线上日志确认：
  - 输入消息：`这个我该怎么选`
  - 路由结果：`executor: 'clarify'`
  - 执行结果：
    - `toolExecutionTarget: 'none'`
    - `disableStream: true`
    - `clarifySafeMode: true`
  - 实际回复是自然追问，不是僵硬模板，也没有走工具链。

### 当前明确结论

- clarify 安全专线现在已经在主编排层真实生效。
- 当前 `routeType` 日志仍可能显示为 `chat`，这是 legacy 兼容标签仍未收口，不影响这次 clarify 的执行行为。
- 这次修改没有扩大到权限矩阵、tool policy 收口、route 协议收口。

### 当前还没做，但值得优先做的事

1. 收口本地工具链路的 `allowedTools` 执行期透传
- 问题：
  - 当前 [core/messageHandler.js](/D:/0.01/linux-migration-pack/core/messageHandler.js) 下发本地工具执行时，没有显式把 route 收敛后的 `allowedTools` 传给 [api/agentGraph.js](/D:/0.01/linux-migration-pack/api/agentGraph.js)。
  - [utils/localToolAccess.js](/D:/0.01/linux-migration-pack/utils/localToolAccess.js) 目前主要有测试覆盖，但尚未真正进入主链路。
- 风险：
  - 本地工具权限仍偏向“prompt 约束 + toolPolicy 参数校验”，不是完整的执行期工具白名单。

2. 继续清理 [core/routeExecution.js](/D:/0.01/linux-migration-pack/core/routeExecution.js) 对 legacy route 的强依赖
- 问题：
  - 当前 executor 判断虽然已开始吃 `topRouteType / intent.toolNeed / intent.executionMode`，但仍依赖 `route.type`、legacy route definition、legacy `toolHints`。
- 目标：
  - 让执行层主判断尽量只依赖顶层协议。

3. 收口 route policy 为更明确的单一权限来源
- 问题：
  - 当前项目里还没有一个真正统一、独立、完整生效的 route policy 主模块。
  - 权限边界仍散落在 `messageHandler`、`routeExecution`、`agentGraph`、`ai.js`、`toolPolicy.js`。

### 接下来建议的最小安全顺序

1. 先做本地工具 `allowedTools` 透传
- 目标是补执行期边界，不做大重构。
- 修改范围尽量限制在：
  - [core/messageHandler.js](/D:/0.01/linux-migration-pack/core/messageHandler.js)
  - [utils/localToolAccess.js](/D:/0.01/linux-migration-pack/utils/localToolAccess.js)
  - [api/agentGraph.js](/D:/0.01/linux-migration-pack/api/agentGraph.js)

2. 再做 `routeExecution` 的纯函数收口
- 先抽纯函数，不删 legacy route。
- 先保行为一致，再调整测试断言重心。

3. 最后再考虑更高层的 route policy 收口
- 这一步不要和前两步混做。

### 本轮约束

- 没有修改无关文件。
- 没有删除 legacy route。
- 没有把新能力堆回 `api/ai.js`。
- 没有依赖 prompt 替代执行期安全控制。
