# QQ 私聊共处房间

最后更新：2026-08-28 11:43 +08:00。

## 功能边界

共处房间是 QQ 私聊中的限时陪伴功能，不是主动问候引擎。它不主动邀请用户、不处理群聊、不启动独立进程，也不加载任意 JavaScript 插件；“热插拔”只表示运行期启停、重载和状态查询。

首版支持两类活动：`focus` 用于学习、工作、画画和写作，`relax` 用于休息、发呆和睡前。每个用户最多有一个房间，默认 45 分钟，可配置为 15、30、45、60 或 120 分钟。

2026-08-25 起，房间可围绕具体内容进入 `read`、`watch` 或 `listen` 模式。内容模式仍复用 `focus`/`relax` 的计时和说话节奏，只额外保存标题与用户主动记录的进度；插件不下载、同步播放或解析媒体。

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
/陪伴 开始 共读 三体 30分钟
/陪伴 开始 共看 葬送的芙莉莲 45分钟
/陪伴 开始 共听 世界计划音乐 30分钟
/陪伴 进度 看到第 3 章
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

状态文件保存插件开关、每个用户的当前房间和最近共同回忆。内容房间额外保存内容类型、标题和最后进度；每条回忆仍只保存有限字段，不整段写入房间对话，也不修改或删除普通聊天长期记忆。旧版状态缺少内容字段时会按普通专注/放松房间读取。

相关配置：

```text
COMPANION_ROOM_ENABLED=false
COMPANION_ROOM_DEFAULT_DURATION_MINUTES=45
COMPANION_ROOM_SCAN_INTERVAL_MS=60000
COMPANION_ROOM_MODEL_TIMEOUT_MS=12000
COMPANION_ROOM_WEB_USER_ID=
```

## PWA 陪伴房间

2026-08-28 起，已登录的 Web 管理会话可以访问 `/companion-room`。该页面是共处房间的独立操作面，不属于管理员大控制台，也不是新的聊天系统；开始、暂停、继续、结束、进度、密度和共同回忆都直接调用同一个 `companionRoomRuntime`，状态仍写入原有 `companion-room-state.json`。

`COMPANION_ROOM_WEB_USER_ID` 必须显式绑定一个 QQ 用户。API 不读取 `user_id` 查询参数或请求体字段，因此不能从页面切换到其他用户。读取允许 viewer 会话访问，所有写入仍由现有 Web 中间件限制为 admin 会话，并要求 `Origin` 或 `Referer` 与当前站点严格同源。

页面支持安装为 PWA。Service Worker 只缓存 `/companion-room` 应用壳和本地图片；最近一次成功状态保存在浏览器本地存储，离线时只读展示，写操作会失败并保留原状态。角色图来自仓库现有 `zhungtailan.jpg` 的裁切版本，页面不引用外部图片源。

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

2026-08-14 00:42 +08:00：实现提交 `82a4369b` 已完成，QQ 私聊共处房间 v1 小目标已完成；未修改天气模块、普通长期记忆结构、主动私聊创建策略或群聊行为，未推送远端。

2026-08-25 01:09 +08:00：共读、共看、共听扩展的解析、状态、模型、运行时、消息入口和 tick 相邻测试全部通过；覆盖标题、合法与非法时长、进度、旧状态兼容、结束后落盘和回忆展示。Bot 只基于用户给出的标题与进度生成陪伴消息，不声明实际消费媒体。

2026-08-28 11:43 +08:00：PWA 路由、固定用户绑定、房间状态序列化、开始与结束动作复用、manifest、Service Worker、登录重定向、viewer 只读、admin 同源写入测试通过。真实浏览器的桌面与移动端交互、离线缓存和控制台日志验收结果将在本阶段提交前追加。
