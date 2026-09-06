# 管理员用户封禁

更新时间：2026-09-06 19:20 +08:00

自动安全封禁实施与验收记录：2026-09-06

## 指令

管理员在 QQ 群聊或管理员私聊中发送以下指令：

```text
/block <QQ号> <时长>
/unblock <QQ号>
```

`/block` 的时长规则：

- 裸数字按分钟解释，例如 `/block 123456789 30` 表示封禁 30 分钟。
- 支持 `s`/`m`/`h`/`d`/`w`，例如 `30m`、`2h`、`1d`、`1w`。
- 支持中文单位“秒”“分”“分钟”“时”“小时”“天”“周”。
- `永久`、`永封`、`forever` 和 `permanent` 表示永久封禁。

## 权限与行为

- 管理员身份沿用 `ADMIN_USER_IDS`，非管理员发送这些指令不会改变任何封禁状态。
- 管理员通过 `/block` 创建的手动封禁会在 bot 入口处静默忽略普通用户消息，不触发回复、连续消息处理、模型调用、记忆写入或后续副作用。
- 管理员账号跳过封禁拦截，始终可以执行管理指令。
- `/unblock` 在没有对应记录时会返回提示，但不会报错。

## 自动安全封禁

- 仅审核普通用户；管理员完全跳过本地审核、自动封禁和封禁拦截。
- 使用本地规则审核私聊，以及群聊中明确 @、回复或点名机器人的消息；审核当前、引用和转发文字，不审核图片，也不调用模型。
- 政治内容、明确恶意请求、定向暴力威胁和定向性骚扰一次命中即封禁；普通辱骂或挑衅在 15 分钟窗口内命中两条后封禁。
- 审核窗口按用户全局累计，保留最近 15 分钟内最多 5 条符合审核范围的消息。
- 自动封禁固定 15 分钟。触发封禁及封禁期间符合对话范围的消息回复“您已被瑞希临时封禁，请十五分钟后再来”，不延长原到期时间。
- 自动封禁与手动封禁复用同一套持久化状态，`/unblock` 均可解除；不新增环境变量。
- 引用和转发文字按当前用户主动提交的审核载荷处理；当前正文、回复和转发文本分别分类，不跨来源拼接动作、目标或意图条件。

## 持久化

封禁状态保存在 `DATA_DIR/user_blocks.sqlite` 的 `user_blocks` 表中，包含 QQ 号、到期时间、执行封禁的管理员和时间信息。到期时间到达后，记录仍可由 `/unblock` 清理，但不会继续拦截消息。

## 验收

2026-09-06 19:27 +08:00：封禁存储、命令权限与时长解析、入口静默拦截及既有管理员路由回归测试通过；lint、typecheck 和差异检查通过。全量 `npm test` 的既有失败为 `agentPrompts.test.js`、`checkPromptsIntegration.test.js` 和 `voiceInputIngress.test.js`，分别涉及提示词治理清单和语音输入配置基线，本功能未修改这些范围。

实现提交：`92a7ed03`（`feat: add admin user block commands`）。

自动安全封禁验收（2026-09-06）：`inboundUserSafety`、`userBlockStore`、`userBlockCommands`、`messageHandlerUserBlock`、`messageHandlerAutomaticSafetyBlock`、`continuousMessagePreprocessor`、`continuousMessagePreparedEntry`、`groupReplySensitiveGuard`、`routerSafetyGuards` 和 `safetyRestrictionDetection` 定向测试通过；`npm run lint`、`npm run typecheck`、`git diff --check` 通过。额外边界复核确认否定、制止、举报、引用后独立威胁、正常垃圾复合词、15 分钟事件去重、精确过期和窗口回收均符合预期。

全量 `npm test` 已运行完成，除本功能无关的既有基线失败外其余测试通过：`agentPrompts.test.js`（临时 prompt 资产 `ADULT.txt` 未被清单引用）、`checkPromptsIntegration.test.js`（同一 `ADULT.txt` 清单问题）和 `voiceInputIngress.test.js`（现有语音输入超时基线断言为 60 秒、当前配置为 600 秒）。本功能未修改这些范围。
