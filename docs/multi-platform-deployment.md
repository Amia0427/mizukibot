# Discord / Telegram 多平台部署

> 核验时间：2026-08-06 09:37 +08:00（Asia/Shanghai）。

本文只说明 Discord 与 Telegram 的新增部署项。QQ/NapCat 继续按原方式配置，三个平台由同一 `index.js` 进程启动，任一适配器故障不会停止其他平台。

## 1. 运行前提

- 使用项目声明的 Node.js 20，并先完成 `npm ci`。
- Discord Developer Portal 中为机器人开启 Message Content Intent；机器人至少需要查看频道、读取历史、发送消息、附加文件、添加 reaction 和使用 application commands 的权限。
- Telegram 在 BotFather 创建 bot；若需要群内普通消息和被动感知，关闭群隐私模式。只使用私聊或命令时可以保持隐私模式。
- 不把 token 写进源码、文档或提交。启用平台但 token 为空时，配置校验会直接失败。

## 2. 配置

```dotenv
DISCORD_ENABLE=true
DISCORD_BOT_TOKEN=<discord-bot-token>
DISCORD_PASSIVE_CHANNEL_IDS=123456789012345678,234567890123456789
DISCORD_COMMAND_GUILD_IDS=123456789012345678
DISCORD_REGISTER_COMMANDS=true

TG_ENABLE=true
TG_BOT_TOKEN=<telegram-bot-token>
TG_ALLOWED_CHAT_IDS=
TG_PASSIVE_CHAT_IDS=-1001234567890,-1001234567890:42

PLATFORM_BIND_TTL_MS=600000
PLATFORM_GROUP_CONTEXT_RETENTION_MS=86400000
PLATFORM_GROUP_CONTEXT_MAX_MESSAGES=500
```

`DISCORD_COMMAND_GUILD_IDS` 非空时只向这些 guild 注册 slash command，适合测试和快速生效；为空时注册全局命令。`DISCORD_PASSIVE_CHANNEL_IDS` 可填写频道或 thread 的父频道 ID。

`TG_PASSIVE_CHAT_IDS` 支持群 ID，也支持 `<chatId>:<topicId>` 精确开启某个 topic。`TG_ALLOWED_CHAT_IDS` 仅保留旧 Telegram 门面的兼容配置；当前主适配器的私聊向所有用户开放，仍受现有配额、并发、工具授权和安全策略约束。

## 3. 身份绑定

绑定只能在私聊中操作：

1. 在任一平台私聊发送 `/bind begin`，获取 8 位、单次、10 分钟有效的绑定码。
2. 在目标平台私聊发送 `/bind <code>`。
3. 使用 `/bindings` 查看统一人物下的身份；发送 `/unbind confirm` 解绑当前平台身份。

存在 QQ 身份时，QQ ID 保持人物主键。长期记忆、画像和日记会按绑定身份别名聚合读取，新数据只写人物主键；不会批量改写旧事件。短期会话不会跨平台、频道、Discord thread 或 Telegram topic 拼接。任一绑定身份属于 `ADMIN_USER_IDS` 时，该统一人物继承管理员权限；Discord/TG 平台管理员身份本身不会提权。

## 4. 消息与能力边界

- 文本、图片、引用、提及、普通文本命令、主模型、工具、长期个人记忆、图片生成、小剧场、舞萌、PJSK、瑞幸、任务控制和管理员诊断共用原主管线。
- Discord slash command 与 Telegram command 只是文本命令别名，最终进入同一命令处理器。
- Discord/TG 被动感知只在白名单开启。短期群记录按频道或 topic 保留 24 小时、最多 500 条，只供被动回复和群总结使用，不写长期群记忆，不进入 post-reply 学习。
- 定时群消息保存平台和投递目标；旧任务缺少平台时按 QQ 处理。主动私聊使用统一人物最近活跃且当前在线的平台目标，并共用人物级冷却。
- QZone、QQ 动态、自动日常发布和其他仅有 OneBot 实现的能力仍为 QQ 专属；不支持的 reaction、typing 或历史能力按能力表跳过。

## 5. 启动与健康检查

```bash
npm run check:node
npm start
```

访问 `GET /ready`。响应中的 `platforms` 会分别列出 `qq`、`discord`、`telegram` 的 `online`、`degraded`、`stopped` 或 `disabled` 状态。只要至少一个已启用消息入口在线，整体消息入口仍可 ready；所有已启用平台都不可用时返回 503。

临时网络故障由各 SDK 自身重连并反映为 degraded。关闭进程时，平台适配器会在 SQLite/hot store 关闭前停止；不要为单个平台另起第二个主进程。

## 6. 上线验收

先用 Node 20 执行：

```bash
npm test
npm run lint
npm run typecheck
npm run check:secrets
git diff --check
```

随后在三个真实平台逐项验证私聊、群聊、图片、引用、提及、原生命令、跨平台绑定、记忆召回、群总结、定时消息、主动私聊和优雅停机。Discord 还要分别验证普通频道与 thread；Telegram 要分别验证普通群和 topic。自动测试不能替代真实 token、Intent、BotFather 隐私模式和平台权限验收。
