# QQ 私聊状态栏

更新时间：2026-08-12 16:40 +08:00

## 行为边界

状态栏只在 QQ 私聊、`direct_chat`、无工具的正常主模型回复发送成功后触发。普通回复和已完成的流式回复都走同一个运行时；群聊、命令、工具、拒绝/安全限制、限流、故障回复和 freshness 过期回合不会发送。任务以非阻塞方式启动，不进入 post-reply 队列，也不改变主回复结果。

主模型完成后，Runtime Host 从本轮实际使用的 `preparedMainConversationContext.messages` 复制 `system/developer` 消息，并从 `affinity.variableSnapshot` 复制关系和角色快照，临时放在 `replyOptions.statusBarSystemMessages` 与 `replyOptions.statusBarVariableSnapshot`。这些字段只在内存中流转，不写数据库、请求追踪、正文日志或持久化任务。

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
- 独立模型严格输出 `{"affection_note":"...","mood_note":"...","inner_thought":"..."}`；好感度、关系等级、情绪、态度和时间仍来自主模型本轮快照。`PRIVATE_STATUS_BAR_IMAGE_URLS` 按好感度阈值选择本地图片或图床图片，本地文件在机器人进程内读取为内存图片，渲染器只接受调用方提供的受信任图片槽，不开放模型直接写入 `<img>`、文件路径或 URL。
- `core/privateStatusBar/runtime.js` 在模型、输出守卫、敏感词审查、本机渲染和 QQ 图片发送之间编排 freshness 检查；任一步失败均静默降级且不使用固定心里话兜底。

用户文本、主回复和状态快照会作为 `untrusted_*` JSON 字段交给独立模型。system/developer 上下文仍按主模型实际使用内容传入，但独立模型不能把其中的文本当成新指令；输出还会经过提示词泄露和用户可见内容守卫。最终 HTML 不接受模型控制的标签、CSS、属性、URL 或渲染尺寸；受信任图片由渲染器在校验后注入，CSP 和 `validateMarkup` 继续作为最后边界。

## 验收记录

- 2026-08-12 16:30 +08:00：实现提交 `eecd43b8`；四项聚焦测试、887 文件 lint、typecheck、暂存密钥扫描、`git diff --check` 通过。全量 `npm test` 196.7 秒退出 1，仅 `weatherAlertProvider.test.js` 的过期预警时间夹具失败，单独复跑结果相同，与状态栏无关。
- 2026-08-12 16:26 +08:00：真实本地立绘和本机 HTML 端点生成 `artifacts/private-status-bar/runtime-verification.png`，PNG 为 `960×640`、245,005 字节，像素检查非空；视觉复检确认四块布局完整、文字无重叠，小贴士第三行裁切已修复。
- 2026-08-12 16:30 +08:00：旧模型别名 `deepseek-v4-flash-free` 复现 HTTP 429 `FreeUsageLimitError`；端点模型列表中的正式 ID `deepseek-ai/DeepSeek-V4-Flash` 在 `max_tokens=25000` 下成功返回严格三字段 JSON。读取用户 `1960901788` 上次会话和真实变量快照执行完整链路，QQ 消息 ID `2130555069`，`get_msg` 回读为私聊单一图片段。
- 2026-08-12 16:40 +08:00：最终代码重启后主进程 PID `27312`、post-reply worker PID `30280` 均健康。小目标已完成：普通 QQ 私聊回复不再因“路由允许工具但实际未调用”而漏发状态栏。
