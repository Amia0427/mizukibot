# QQ 番外小剧场

更新时间：2026-07-31 02:38 +08:00

## 使用方式

在 QQ 群聊或私聊中发送：

```text
/小剧场 <剧情素材>
```

默认会读取长期记忆作为创作资料，但不会读取近期聊天。需要完全只使用本次素材时，将 `--无记忆` 紧跟在命令后：

```text
/小剧场 --无记忆 瑞希和我在雨夜捡到一封没有署名的信
```

也可以先回复一条文字消息，再发送命令：

```text
/小剧场 接着这段写成四幕番外，结局要轻松温暖
```

命令文字与引用文字合计最多 4000 个字符。首版只读取文字；图片、转发消息和网页内容会被忽略。

## 输出内容

每次成功生成一张 900px 宽、最高 2000px 的四幕竖版 PNG，包含标题、四幕场景、旁白、对白和片尾句。默认由瑞希和“你”主演；素材明确指定角色时，可以换角或加入原创角色。

## 记忆与隐私

- 私聊只读调用者自己的 `profile/personal/task/style/journal` 长期记忆。
- 群聊只读当前群的 `group/jargon` 记忆，不读取群成员私聊记忆。
- `--无记忆` 不发起记忆查询。
- 小剧场不读取近期对话，也不会把命令、引用、召回内容、剧情、HTML 或发送结果写入聊天历史、画像、Daily Journal、Persona Memory 或 post-reply 队列。
- QQ 平台仍会保存用户发送的命令和机器人回复的图片；“不储存”仅指机器人内部记忆系统。

用户素材和成品可见文字都会经过独立敏感词审查。命中敏感内容、词库不可用或审查异常时，不调用后续渲染和发送接口，管理员也不能绕过。

## 常见提示

- `小剧场暂时没有开放。`：本地开关未启用。
- `用法：/小剧场 ...`：命令和有效文字引用都为空。
- `这次的剧情素材太长了...`：素材与引用合计超过 4000 字符。
- `这一幕还在收尾...`：同一用户仍处于冷却期。
- `舞台现在正忙着...`：同一用户已有任务，或全局两个生成名额已满。
- `图片内容未通过敏感词审查...`：用户素材或生成成品被拦截。
- `舞台刚刚没搭好...`：模型、渲染器或 QQ 发送失败；5 秒后可以重试。

模型必须返回严格四幕 JSON。实际验收中，管理员专用模型曾两次返回未通过严格解析的 JSON，系统在剧情校验阶段拒绝，渲染和 QQ 发送次数均为 0；普通用户主模型随后成功。该情况按生成失败处理，不会放宽解析规则。

## 配置

```dotenv
SMALL_THEATER_ENABLED=true
SMALL_THEATER_MAX_INPUT_CHARS=4000
SMALL_THEATER_MEMORY_TOP_K=8
SMALL_THEATER_MODEL_TIMEOUT_MS=60000
SMALL_THEATER_COOLDOWN_MS=15000
SMALL_THEATER_FAILURE_RETRY_COOLDOWN_MS=5000
SMALL_THEATER_MAX_CONCURRENCY=2
```

HTML 渲染继续复用现有视觉渲染配置：

```dotenv
VISUAL_RENDER_ENABLED=true
VISUAL_RENDER_HTML_API_URL=http://127.0.0.1:6099/plugin/napcat-plugin-puppeteer/api/render
VISUAL_RENDER_TIMEOUT_MS=10000
```

详细渲染安全边界见 [QQ HTML/SVG 图片渲染](qq-visual-rendering-2026-07-30.md)。

## 验收记录

功能提交：`32becea feat: add QQ small theater command`

### 自动测试

2026-07-31 02:27 +08:00：

```text
npm test -- tests/smallTheaterCommandStory.test.js tests/smallTheaterRuntime.test.js tests/smallTheaterModerationGate.test.js tests/messageHandlerSmallTheater.test.js
结果：4/4 通过

npm run lint
结果：通过，检查 795 个文件

npm run typecheck
结果：通过

npm run check:secrets
结果：通过

git diff --cached --check
结果：通过
```

测试词库夹具分别覆盖用户素材命中、成品可见文字命中和词库文件缺失，三种场景的渲染与 QQ 发送调用次数均为 0。消息处理集成测试确认普通私聊和群聊可进入命令，回复引用通过 `get_msg` 展开，普通路由未执行；聊天历史、短期记忆和临时数据目录在处理前后完全一致。

完整 `npm test` 实际运行 182.2 秒后退出 1；四项小剧场测试通过，失败来自以下五项非本功能基线：

- `adminStableSystemPrompt`：Windows 测试临时文件写入返回 `EPERM`。
- `configPersonaPrompt`：管理员提示词格式断言失败。
- `mainReplyUnifiedDiagnostics`：缺少 `too_long` 诊断原因。
- `memoryV3EmbeddingBackfillConcurrency`：预期 4，实际 0。
- `memoryV3RagExplainDiagnostic`：诊断布尔断言失败。

### 运行验收

- 2026-07-31 02:28 +08:00：通过官方 `restart-bot.cmd restart confirm` 重启，主进程 PID `17616`、post-reply worker PID `18044`，健康检查通过。
- Puppeteer `/status` 返回 HTTP 200、`code: 0`，浏览器为 `connected=true`、`Chrome/131.0.6778.204`；3000/6099 仍仅监听 `127.0.0.1`。
- 群 `1083095371` 使用普通用户模型和默认记忆生成成功，召回当前群记忆 4 条；消息 ID `1365479523`。`get_msg` 返回唯一图片段 `DBB81602E9764F739646B6A22168BCAB.png`，127,815 字节，PNG 尺寸 `900×1316`。
- 管理员 `1960901788` 私聊使用回复引用与 `--无记忆` 生成成功，记忆查询 0 次；消息 ID `262404299`。`get_msg` 返回唯一图片段 `0935DCB1C7C7866183B57625DBE2B74A.png`，134,342 字节，PNG 尺寸 `900×1495`。
- 两张 QQ 回读图片的下载字节数与 OneBot 声明一致，通道像素范围均覆盖 32–255，确认不是空白图，且高度均未超过 2000px。

小目标已完成。未推送远端。
