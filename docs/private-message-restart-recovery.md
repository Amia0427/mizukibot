# QQ 私聊重启续传

更新时间：2026-08-25 01:04 +08:00

## 解决范围

该功能处理两类重启丢回复：

1. 机器人已经收到私聊，但模型生成、工具调用或发送流程尚未完成时进程退出。
2. HTTP 反向入口停机期间，NapCat 收到了私聊，但消息没有投递到机器人进程。

群消息、通知事件、请求事件和斜杠命令不做启动重放。斜杠命令仍会在 HTTP 返回前落盘，但启动时只标记为已核对，避免 `/restart confirm` 等有副作用的命令被重复执行。

## 工作方式

- `core/napcatHttpReverseServer.js` 在返回 `204` 前调用接收钩子。
- `utils/privateMessageRecoveryStore.js` 将私聊消息同步写入 `DATA_DIR/private-message-restart-recovery.json`。
- 正常消息管线结束后删除 pending 记录；失败或进程退出时记录继续保留。
- 启动就绪后，`core/privateMessageRecoveryRuntime.js` 先核对 pending，再调用 NapCat 的 `get_recent_contact` 和 `get_friend_msg_history` 扫描停机窗口。
- 如果 QQ 历史中存在用户消息后 15 分钟内的机器人文字消息，则认为已经回复，只修复本地状态。
- 每个联系人只补最新一条未回复的停机窗口消息，避免连续消息逐条刷屏。
- 补偿失败不会阻塞机器人启动，保留原游标并按退避间隔重试。

该机制提供至少一次处理，不承诺严格的恰好一次。回复已经送达但进程在写完成标记前崩溃时，QQ 历史核对会尽量抑制重复发送。

## 配置

```dotenv
PRIVATE_MESSAGE_RESTART_RECOVERY_ENABLED=true
PRIVATE_MESSAGE_RESTART_RECOVERY_STATE_FILE=""
PRIVATE_MESSAGE_RESTART_RECOVERY_LOOKBACK_MS=21600000
PRIVATE_MESSAGE_RESTART_RECOVERY_OVERLAP_MS=120000
PRIVATE_MESSAGE_RESTART_RECOVERY_CONTACT_LIMIT=100
PRIVATE_MESSAGE_RESTART_RECOVERY_HISTORY_COUNT=30
```

- `STATE_FILE` 为空时使用 `DATA_DIR/private-message-restart-recovery.json`。
- `LOOKBACK_MS` 是历史扫描上限，默认 6 小时；首次启用只扫描启动前的 overlap 窗口。
- `OVERLAP_MS` 用于覆盖运行时心跳与实际退出之间的时间差，默认 2 分钟。
- `CONTACT_LIMIT` 控制 NapCat 最近会话数量。
- `HISTORY_COUNT` 控制每个候选私聊读取的历史条数。

## 验收记录

2026-08-25 01:04 +08:00 已执行并通过：

```text
node tests/privateMessageRecoveryStore.test.js
node tests/privateMessageRecoveryRuntime.test.js
node tests/messageIngressDispatcher.test.js
node tests/messageIngressAsyncEntrypointSource.test.js
node tests/napcatHttpReverseServer.test.js
node --check core/privateMessageRecoveryRuntime.js
node --check utils/privateMessageRecoveryStore.js
node --check index.js
npm run smoke:napcat-ingress
node scripts/run-tests.js tests/privateMessageRecoveryStore.test.js tests/privateMessageRecoveryRuntime.test.js tests/messageHandlerRestartCommand.test.js tests/mainProcessScheduledRestartDrain.test.js tests/restartResultFeedback.test.js tests/napcatActionClientConnectionState.test.js
npm run lint
npm run typecheck
node scripts/check-staged-secrets.js --all
git diff --check
```

`npm run lint` 检查 904 个文件。另对真实 NapCat 执行了只读 `get_recent_contact` 和 `get_friend_msg_history`，确认返回容器与恢复逻辑使用的字段一致；未发送消息，也未重启机器人。

`npm test` 已执行两次。确认轮失败 4 项：`agentPrompts.test.js`、`checkPromptsIntegration.test.js`、`promptCheckGovernance.test.js` 均由仓库既有 `prompts/ADULT.txt` 未登记到 prompt manifest/allowlist 引起；`memoryPromptContextRegression.test.js` 在并行全量测试中报提示词模块重复，单独复跑退出 0。上述文件不属于本目标，按最小改动要求未修改提示词或治理清单。
