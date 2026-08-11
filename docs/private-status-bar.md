# QQ 私聊状态栏

更新时间：2026-08-11 22:17 +08:00

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
```

端点必须是 OpenAI 兼容 Chat Completions 接口；状态栏模型没有主模型凭据回退。启用状态栏时还需要现有 `VISUAL_RENDER_ENABLED=true` 和本机 HTML 渲染端点。

## 模型与模板

- `core/privateStatusBar/model.js` 只发送 `messages`，不发送工具 schema，要求 `response_format=json_object`，使用有限深度 JSON 解析和严格 zod Schema，只接受一个 `inner_thought` 字段。
- `core/privateStatusBar/template.js` 使用固定横条 CSS；好感度进度条宽度由已校验的数值计算，时间使用 `TIMEZONE` 格式化为 `YYYY-MM-DD HH:mm`，所有动态文本统一 HTML 实体转义。
- `core/privateStatusBar/runtime.js` 在模型、输出守卫、敏感词审查、本机渲染和 QQ 图片发送之间编排 freshness 检查；任一步失败均静默降级且不使用固定心里话兜底。

用户文本、主回复和状态快照会作为 `untrusted_*` JSON 字段交给独立模型。system/developer 上下文仍按主模型实际使用内容传入，但独立模型不能把其中的文本当成新指令；输出还会经过提示词泄露和用户可见内容守卫。最终 HTML 不接受模型控制的标签、CSS、属性、URL 或渲染尺寸，CSP 和 `validateMarkup` 继续作为最后边界。

## 验收记录

- 2026-08-11 22:17 +08:00：`node tests/privateStatusBarModel.test.js`、`privateStatusBarTemplate.test.js`、`privateStatusBarRuntime.test.js`、`messageHandlerModuleBoundary.test.js`、`runtimeHostCotSource.test.js` 通过。
- 2026-08-11 22:17 +08:00：`npm run lint`（886 个文件）、`npm run typecheck`、`npm run check:secrets`、`git diff --check` 通过。
- 2026-08-11 22:03 +08:00：真实本机渲染端点生成 `artifacts/private-status-bar/preview.png`，PNG 尺寸 `800×260`，大小 `30,588` 字节，人工检查确认字段完整且无布局重叠。
- 2026-08-11 22:14 +08:00：全量 `npm test` 187.1 秒退出 1；首轮同时发现本次模块边界断言，已改为函数内惰性加载并单独复跑通过，剩余 `weatherAlertProvider.test.js` 为既有天气夹具失败。本轮未调用真实状态栏模型或 QQ 发送器。
