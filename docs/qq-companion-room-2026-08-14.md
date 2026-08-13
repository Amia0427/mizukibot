# QQ 私聊共处房间

最后更新：2026-08-14 00:23 +08:00。

## 功能边界

共处房间是 QQ 私聊中的限时陪伴功能，不是主动问候引擎。它不主动邀请用户、不处理群聊、不启动独立进程，也不加载任意 JavaScript 插件；“热插拔”只表示运行期启停、重载和状态查询。

首版支持两类活动：`focus` 用于学习、工作、画画和写作，`relax` 用于休息、发呆和睡前。每个用户最多有一个房间，默认 45 分钟，可配置为 15、30、45、60 或 120 分钟。

## 使用方式

自然语言入口只匹配高置信表达，例如：

```text
陪我学习半小时
陪我放松一下
切换到放松
暂停陪伴
继续陪伴
结束陪伴
安静一点
多陪我聊聊
```

确定性命令如下：

```text
/陪伴 开始 专注 30分钟
/陪伴 开始 放松 1小时
/陪伴 切换 专注
/陪伴 暂停
/陪伴 继续
/陪伴 结束
/陪伴 状态
/陪伴 回忆
/陪伴 回忆 修改 <id> <用户的一句话>
/陪伴 回忆 删除 <id>
```

管理员在 QQ 私聊中控制插件：

```text
/陪伴插件 开启
/陪伴插件 关闭
/陪伴插件 状态
/陪伴插件 重载
```

插件关闭后，普通 `/陪伴` 文本交给现有聊天管线；关闭插件会暂停已有活动房间，重新开启后用户可继续。管理员启停状态会持久化，只有首次没有状态文件时才读取 `COMPANION_ROOM_ENABLED`。

## 运行机制

公开入口位于 `src/features/companion-room/index.js`，组合根在 `index.js` 创建运行时并注入消息处理器。消息入口位于现有控制命令之后、连续消息预处理之前；已处理的陪伴命令从 `source=companion_room` 的现有 QQ 出站链路回复一次，不再进入普通聊天。

`core/tickEngine` 使用现有定时器调用房间 `tick()`。中段节点位于活动时间约 50%，结束前节点位于约 85%，安静模式跳过中段；每个节点最多成功发送一次。到时收尾、节点消息和手动结束都只在 QQ 确认发送成功后推进状态，失败时保留房间供下次扫描或用户重试。

停机时运行时等待在途扫描收尾，并把活动房间保存为暂停态。启动时意外中断的活动房间也恢复为暂停态，已跨过的节点直接标记为错过；用户下一条普通私聊或 `/陪伴 继续` 会恢复房间。

## 模型与数据

阶段消息复用现有模型调用，但设置 `disableTools=true` 和空工具白名单。结果限制为 100 字以内的单行纯文本，并经过提示泄露与用户可见内容守卫；空结果、媒体、网址、CQ 码、HTML、Markdown、模型异常均使用固定回退文案。

角色快照中的情绪、精力、压力和社交意愿只用于建议 `quiet`、`occasional` 或 `chatty` 节奏，不会拒绝用户进入或继续房间。

状态默认写入：

```text
DATA_DIR/companion-room-state.json
```

状态文件保存插件开关、每个用户的当前房间和最近共同回忆。每条回忆只包含活动类型、起止时间、实际时长、用户一句话、Bot 一句话和完成状态；房间对话不整段写入插件回忆，也不修改或删除普通聊天长期记忆。

相关配置：

```text
COMPANION_ROOM_ENABLED=false
COMPANION_ROOM_DEFAULT_DURATION_MINUTES=45
COMPANION_ROOM_SCAN_INTERVAL_MS=60000
COMPANION_ROOM_MODEL_TIMEOUT_MS=12000
```

## 验收记录

2026-08-14 00:23 +08:00 已通过六项聚焦测试：

```bash
node scripts/run-tests.js tests/companionRoomParser.test.js tests/companionRoomState.test.js tests/companionRoomModel.test.js tests/companionRoomRuntime.test.js tests/companionRoomMessageHandler.test.js tests/companionRoomTickEngine.test.js
```

覆盖解析、单用户单房间、启停与重载、暂停恢复、活动切换、节点上限、过期节点跳过、发送失败保留状态、模型纯文本回退、消息单次接管和 `tickEngine` 停止清理。损坏状态文件用例会产生一条预期的 `jsonHotStore` 读取失败日志，并在运行时状态中保留 `loadError=invalid_state_file`。

2026-08-14 00:31 +08:00 仓库级验收结果：

- 陪伴插件六项测试与 `privateProactiveMessageHandler`、`tickEngineStopGuard`、`tickEngineAdaptive` 相邻回归全部通过。
- `npm run lint` 通过，共检查 892 个文件；`npm run typecheck` 与 `git diff --check` 通过。
- 临时 `DATA_DIR` 已完成启用、15 分钟房间、暂停、继续、提前结束、查看和删除回忆、停机后暂停恢复；主入口测试模式确认运行时已注入且不会提前启动，非法默认时长 `20` 会回退为 `45`。
- `npm test` 运行 182.5 秒后仅 `tests/weatherAlertProvider.test.js:65` 失败；单独复跑同样失败。该既有夹具使用固定的 2026-08-07 预警并以当前 `Date.now()` 判断活跃状态，在 2026-08-14 已过期，本次没有修改天气模块。
- 当前测试运行时为 Node.js 24.14.1；项目声明的生产版本仍为 Node.js 20。
- 真实 QQ 私聊 smoke 已通过：NapCat `get_status` 返回 `online=true`、`good=true`；临时状态文件中的已到时 15 分钟房间经实际 `tick()` 和 `send_private_msg` 发送 1 条收尾，第二次扫描没有重复发送，消息 `1489089511` 已通过 `get_friend_msg_history` 定位并由 `get_msg` 回读。正式插件开关、正式房间状态和普通长期记忆均未修改。
