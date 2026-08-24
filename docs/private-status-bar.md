# QQ 私聊状态栏

更新时间：2026-08-24 09:26 +08:00

## 行为边界

状态栏只在 QQ 私聊、`direct_chat`、无工具的正常主模型回复发送成功后触发。普通回复和已完成的流式回复都走同一个运行时；群聊、命令、工具、拒绝/安全限制、限流、故障回复和 freshness 过期回合不会发送。任务以非阻塞方式启动，不进入 post-reply 队列，也不改变主回复结果。

主模型完成后，Runtime Host 从本轮实际使用的 `preparedMainConversationContext.messages` 复制 `system/developer` 消息，并从 `memory.statusBarVariableSnapshot` 复制关系和角色快照，临时放在 `replyOptions.statusBarSystemMessages` 与 `replyOptions.statusBarVariableSnapshot`。变量快照由 prepare 阶段本轮已经读取的生活状态结果提供，不再混入只负责上下文预算的 `affinity`；这些字段只在内存中流转，不写 checkpoint、数据库、请求追踪、正文日志或持久化任务。

为让角色短期状态真正变化，正常私聊会在 post-reply worker 中运行一次 conversation-variable-only 提取。该任务只提交本轮关系/角色增量（包括 `moodDelta`），不运行长期画像提取和自我改进；写入完成后由下一轮 prepare 快照反映，状态栏独立模型仍只生成文字字段。

## 配置

```dotenv
PRIVATE_STATUS_BAR_ENABLED=false
PRIVATE_STATUS_BAR_API_BASE_URL=placeholder
PRIVATE_STATUS_BAR_API_KEY=placeholder
PRIVATE_STATUS_BAR_MODEL=placeholder
PRIVATE_STATUS_BAR_TIMEOUT_MS=8000
PRIVATE_STATUS_BAR_MAX_TOKENS=25000
PRIVATE_STATUS_BAR_IMAGE_URLS={"0":"D:/waifu/zhungtailan.jpg"}
```

端点必须是 OpenAI 兼容 Chat Completions 接口；状态栏模型没有主模型凭据回退。启用状态栏时还需要现有 `VISUAL_RENDER_ENABLED=true` 和本机 HTML 渲染端点。

## 模型与模板

- `core/privateStatusBar/model.js` 只发送 `messages`，不发送工具 schema，要求 `response_format=json_object`，使用有限深度 JSON 解析和严格 zod Schema，只接受 `affection_note`、`mood_note`、`inner_thought` 三个字段。
- `core/privateStatusBar/template.js` 使用参考图同构的 `960×640` 粉白手账模板：左侧人物相框、右侧好感度/心情/心里话三块信纸和左下小贴士。好感度进度条宽度由已校验的数值计算，时间使用 `TIMEZONE` 格式化为 `YYYY-MM-DD HH:mm`，所有动态文本统一 HTML 实体转义。
- 模板不使用省略号或固定行数裁切动态字段；好感说明、心情说明、心里话和稳定态度按内容长度选择受控字号，三张右侧卡片的空间按真实字段上限分配。
- 右侧三块面板为 8px 圆角加左侧 4px 色条（粉/珊瑚/藕），不再使用 dashed 内框；缎带、胶带、纸夹保留手账氛围，右下角剪刀装饰已移除。心情面板按 `mood` 取愉快/平静/低落三档心形符号与配色，稳定态度长文本在面板内流式排布为 11px，小贴士只保留日期与更新时间两行。
- 独立模型严格输出 `{"affection_note":"...","mood_note":"...","inner_thought":"..."}`；好感度、关系等级、情绪、态度和时间仍来自主模型本轮快照。`PRIVATE_STATUS_BAR_IMAGE_URLS` 按好感度阈值选择本地图片或图床图片，本地文件在机器人进程内读取为内存图片，渲染器只接受调用方提供的受信任图片槽，不开放模型直接写入 `<img>`、文件路径或 URL。
- `core/privateStatusBar/runtime.js` 在模型、输出守卫、敏感词审查、本机渲染和 QQ 图片发送之间编排 freshness 检查；任一步失败均静默降级且不使用固定心里话兜底。

用户文本、主回复和状态快照会作为 `untrusted_*` JSON 字段交给独立模型。system/developer 上下文仍按主模型实际使用内容传入，但独立模型不能把其中的文本当成新指令；输出还会经过提示词泄露和用户可见内容守卫。最终 HTML 不接受模型控制的标签、CSS、属性、URL 或渲染尺寸；受信任图片由渲染器在校验后注入，CSP 和 `validateMarkup` 继续作为最后边界。

## 验收记录

- 2026-08-14 00:31 +08:00：实现提交 `3aba67f1`。用户截图中的好感说明、心情说明和心里话底部裁切已修复；使用 `80/120/80/120` 字的好感说明、稳定态度、心情说明和心里话同时做浏览器边界检查，全部满足 `scrollHeight <= clientHeight` 且位于对应卡片内。用户截图自然文案与本地立绘经真实 HTML 端点生成 `960×640`、251,913 字节 PNG，字段完整且无重叠。状态栏聚焦测试、lint、typecheck、全量密钥扫描和差异检查通过；完整测试唯一失败为与本目标无关且可单独复现的 `weatherAlertProvider.test.js:65` 固定过期时间断言。小目标已完成。
- 2026-08-17 10:02 +08:00：修复私聊 post-reply 未运行变量提取导致 `mood` 永远为默认值的问题。`persist` 保留长期记忆任务的群聊边界，同时为带 `chatType=private` 的 `direct_chat` 写入变量任务；worker 将其标记为 `conversationVariablesOnly`，不写画像。`privateStatusBarTemplate`、`persistNodeConfig`、`postReplyWorkerRuntime` 和变量提取回归测试通过。
- 2026-08-13 23:57 +08:00：实现提交 `e754e356`。9 项状态栏及 Runtime V2 相邻测试、887 文件 lint、typecheck、暂存密钥扫描和差异检查通过；完整 `npm test` 运行 187.1 秒，唯一失败为既有 `weatherAlertProvider.test.js:65` 过期时间夹具，单独复跑相同。本机仅有 Node 24.14.1，未宣称 Node 20 验收。
- 2026-08-13 23:57 +08:00：真实用户 `1960901788` 的会话变量经 Runtime Host 捕获后包含关系、角色和 system 消息，资格原因为空；真实独立模型、本地立绘和本机 HTML 渲染生成 `960×640`、245,878 字节非空 PNG，发送器替换为内存检查，未向 QQ 发送验收消息。重启后主进程 PID `33088`、post-reply worker PID `35792`，`/live` 与 `/ready` 均返回 200。小目标已完成。
- 2026-08-12 16:30 +08:00：实现提交 `eecd43b8`；四项聚焦测试、887 文件 lint、typecheck、暂存密钥扫描、`git diff --check` 通过。全量 `npm test` 196.7 秒退出 1，仅 `weatherAlertProvider.test.js` 的过期预警时间夹具失败，单独复跑结果相同，与状态栏无关。
- 2026-08-12 16:26 +08:00：真实本地立绘和本机 HTML 端点生成 `artifacts/private-status-bar/runtime-verification.png`，PNG 为 `960×640`、245,005 字节，像素检查非空；视觉复检确认四块布局完整、文字无重叠，小贴士第三行裁切已修复。
- 2026-08-12 16:30 +08:00：旧模型别名 `deepseek-v4-flash-free` 复现 HTTP 429 `FreeUsageLimitError`；端点模型列表中的正式 ID `deepseek-ai/DeepSeek-V4-Flash` 在 `max_tokens=25000` 下成功返回严格三字段 JSON。读取用户 `1960901788` 上次会话和真实变量快照执行完整链路，QQ 消息 ID `2130555069`，`get_msg` 回读为私聊单一图片段。
- 2026-08-12 16:40 +08:00：最终代码重启后主进程 PID `27312`、post-reply worker PID `30280` 均健康。小目标已完成：普通 QQ 私聊回复不再因“路由允许工具但实际未调用”而漏发状态栏。
- 2026-08-24 09:26 +08:00：模板视觉精修只改 `template.js` 样式层，未动 `runtime.js` 的文本上限与 `model.js` 的三字段 schema。改动包括底纸 `#f3e7e0` 与信纸 `#fffdfb` 拉开明度差、正文与标题加深、强调粉与进度条提饱和、面板 8px 圆角加左侧 4px 色条、删除 dashed 内框与剪刀装饰、心情三档心形配色、稳定态度长文本由 9.5px 绝对定位改为 11px 流式排布、小贴士删除写死文案后高度收到 112px。`privateStatusBarTemplate`、`privateStatusBarModel`、`privateStatusBarRuntime`、`runtimeStatusDiagnostics` 四项测试通过，`67.25 / 100`、`width:67.25%`、`960px/640px`、极限用例类名等硬断言均未破。真实 HTML 渲染端点生成三张 `960×640` PNG：`refresh-happy-natural.png` 220,751 字节、`refresh-calm-natural.png` 217,477 字节、`refresh-low-limit.png` 215,436 字节；对 80/80/120 字与 120 字稳定态度的极限组合裁剪心情面板复检，文字完整无截断、无溢出、无重叠。小目标已完成。
