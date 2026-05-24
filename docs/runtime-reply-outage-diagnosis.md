# 主回复不出声诊断

更新 2026-05-24 18:03 +08:00：普通直聊消息进站正常，QQ 发送链路正常；故障点在旧主进程的 planner 归一化阶段。

## 现象

- 最新普通群聊直聊请求进入 `direct_chat` 后没有发送回复，trace 结束为 `sent=false`。
- 管理员 `/check` 可正常回复，说明 WebSocket 和 `send_group_msg` 链路未断。

## 根因

运行中的主进程 PID `18032` 仍使用旧加载代码，`normalizePlannerDecisionV2` 调用 `shouldPrioritizeMemoryProbe(route)` 时本地符号未定义，抛出：

```text
ReferenceError: shouldPrioritizeMemoryProbe is not defined
```

磁盘上的 `src/runtime-v2/planning/prompt-normalizer.chunk.js` 和 HEAD 已包含 `shouldPrioritizeMemoryProbe` 绑定；问题实际是主进程未加载最新代码。

## 处理

- 精确停止 `.mizukibot.lock` 和 `.mizukibot-postreply-worker.pid` 指向的进程。
- 重新启动本地主 bot 与 post-reply worker。
- 新主进程 PID：`23912`；新 worker PID：`6772`。

## 验证

```powershell
node tests\plannerV2Protocol.test.js
npm run diag:runtime
```

验证结果：`plannerV2Protocol.test.js passed`；runtime 诊断显示主进程和 worker 均 running。重启后 `data/bot-runtime.err.log` 未继续出现 `shouldPrioritizeMemoryProbe is not defined`。
