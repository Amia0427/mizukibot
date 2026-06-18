## 运行维护 2026-06-18 17:42

- 小目标：让当前项目的“思考展示”接近截图里那种情绪丰富、像小记一样的内心独白，但不暴露真实完整思维链。
- 根本边界：不把 provider raw reasoning 原样外发；仍只发送本地清洗后的 `reasoningForwardText`，模型工作语、完整推理链、导演提示继续跳过。
- 最小修复：`utils/reasoningForwardPersona.js` 将可见小记从单句短想法放宽为最多 3 段、520 字，保留段落形状、惊讶/心软/停顿/重复感叹等主观情绪流。
- 提示词同步：`prompts/runtime/reasoning-forward-persona.txt` 和 `prompts/runtime/roleplay-inner-protocol.txt` 明确情绪化短内心、不要条列式分析；`utils/runtimePrompts.js` fallback 同步。
- 验证：`node scripts\run-tests.js tests\reasoningForwardPersona.test.js tests\reasoningForwardPersonaPrompt.test.js tests\runtimePromptCache.test.js tests\promptGoldenSnapshots.test.js`、`node scripts\run-tests.js tests\normalFastReplyRuntime.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js tests\qqActionServiceReasoningForward.test.js tests\messageHandlerReasoningForwardSource.test.js`、`npm run check:prompts` 通过。
- 小目标已完成：QQ 可见思考小记能呈现更情绪化的瑞希内心独白，同时保留“不发完整思维链、不发模型工作痕迹”的安全边界。
- 提交后记录 2026-06-18 17:42 +08:00：已提交 `feat: enrich reasoning inner notes`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-18 11:09

- 小目标：排查 `status_code=400, messages: text content blocks must be non-empty` 是否为本地代码问题。
- 现场结论：本地可稳定复现，`mapMessagesToAnthropic([{ role: 'user', content: '' }])` 会生成 `{ type: 'text', text: '' }`，符合上游报错条件。
- 最小修复：`toAnthropicContentBlocks` 过滤空字符串和空 `text` part；`mapMessagesToAnthropic` 对空用户/助手历史不再生成空文本兜底，仅在整轮没有可发送消息时保留 `(empty input)`。
- 验证：修复前本地探针复现空块；修复后 `node scripts\run-tests.js tests\anthropicAssistantContextOrdering.test.js tests\httpClientAnthropicPromptCache.test.js`、`node --check src\model\http\images.chunk.js`、`node --check src\model\http\request-shaping.chunk.js` 通过。
- 小目标已完成：Anthropic Messages 请求体不会再由本地适配层主动生成空 `text` content block。
- 提交后记录 2026-06-18 11:09 +08:00：已提交 `fix: drop empty anthropic text blocks`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-18 11:41

- 小目标：治本修复用户反馈“重启脚本双击不会成功，依然是旧进程”。
- 根因：`restart-bot.cmd` 无参数入口被改成 status-only；Windows 双击 `.cmd` 正是无参数运行，所以用户双击只看状态，不会杀旧进程或更新锁。
- 最小修复：wrapper 层无参数直接调用 `scripts\restart-bot.ps1 restart confirm`；显式参数仍原样透传，因此 `restart-bot.cmd status` 继续只读。
- 验证：`node scripts\run-tests.js tests\restartBotScript.test.js tests\restartResultFeedback.test.js tests\remoteRestart.test.js tests\mainBotSingleInstanceLock.test.js`、PowerShell AST parse、显式 `cmd /c restart-bot.cmd status` 通过。
- 实测结果：实际 `cmd /c restart-bot.cmd` 返回 0；旧 main/worker `45064/34416` 和旧 launcher `42712/40092` 均退出；锁文件更新为 main bot `34660`、post-reply worker `47100`；最终 status 显示两者 Running。
- 小目标已完成：双击/无参数入口现在会执行真实确认重启，状态检查改为显式 `status`。
- 提交后记录 2026-06-18 11:41 +08:00：已提交 `fix: make restart wrapper double-click restart`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-18 10:40

- 小目标：处理用户反馈“重启脚本还是有问题，杀不掉锁文件和旧进程，而且没有重启成功反馈”。
- 现场结论：本地确认重启已能停 main/worker 并更新 `.mizukibot.lock`，但旧 WMI `cmd.exe` launcher 也属于用户可见的旧相关进程；远程 `/restart` 使用 detached spawn + `stdio: ignore`，旧 bot 被杀后不能同步拿到最终健康结果。
- 最小修复：`scripts\restart-bot.ps1` 识别并清理当前仓库 main/worker 的旧 launcher，停止时把“已自然退出”当正常状态；确认重启最终写 `data\restart-bot-result.json`。新增 `utils\restartResultFeedback.js`，新 main bot 在启动后消费 result，并向 `/restart confirm` 触发群/用户发送成功或失败反馈。
- 验证：`node scripts\run-tests.js tests\restartBotScript.test.js tests\restartResultFeedback.test.js tests\remoteRestart.test.js tests\mainBotSingleInstanceLock.test.js`、`node --check index.js`、`node --check utils\restartResultFeedback.js`、`scripts\restart-bot.ps1` AST parse 通过；实际 `cmd /c restart-bot.cmd restart confirm` 返回 0。
- 实测结果：旧 main/worker `1552/36952` 和旧 launcher `45596/37672` 均已退出；锁文件更新为 main bot `45064`、post-reply worker `34416`；`data\restart-bot-result.json` 为 `status=success, healthy=true`；最终 status 显示两者 Running 且无其他相关 Node 进程。
- 剩余风险：远程 QQ 成功反馈依赖新 main bot 启动后 NapCat action 可用；已做短重试，若 NapCat 离线仍需用 `data\restart-bot-result.json`、`data\restart-bot.log` 和 `restart-bot.cmd status` 验收。
- 小目标已完成：确认重启会清掉旧 node/launcher、更新锁文件，并留下可被新进程反馈的最终结果。
- 提交后记录 2026-06-18 10:40 +08:00：已提交 `fix: harden restart cleanup feedback`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-18 09:43

- 小目标：处理用户反馈“重启脚本依然不成功”，复查本地确认重启成功之外的远程触发路径。
- 根因：08:21 为了避免停止当前 `cmd/powershell` 调用链，`Stop-BotForRestart` 保护了所有祖先 PID；远程 `/restart` 从 main bot 内触发时，旧 main bot 可能也是调用链祖先，导致待停止的 main bot 被一起保护，出现假成功。
- 最小修复：`scripts\restart-bot.ps1` 计算 `$protectedPids` 时排除本轮 `$targetPids`，即只保护 shell 调用链，不保护明确要停的 main/worker。
- 验证：`node scripts\run-tests.js tests\restartBotScript.test.js tests\remoteRestart.test.js`、`node --check tests\restartBotScript.test.js`、PowerShell AST parse 通过；实际 `cmd /c restart-bot.cmd restart confirm` 输出 `restart roots: 33664, 37772`、`protected caller pids: 40296, 26648, ...`，目标 PID 未被保护且已停止；最终 main bot PID=47328、worker PID=8100 Running。
- 补充验收：`node scripts\run-tests.js tests\restartBotScript.test.js tests\remoteRestart.test.js tests\mainBotSingleInstanceLock.test.js`、`node scripts\pre-release-smoke.js --root D:\waifu --skip-restart-payload` 通过。
- 小目标已完成：远程重启调用链保护不再挡住待重启的旧 bot 进程。
- 提交后记录 2026-06-18 09:43 +08:00：已提交 `fix: preserve remote restart target stops`；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-18 08:35

- 小目标：让普通用户模型每日限额模式能直接通过 `.env` 开关启停，不需要改代码。
- 现状确认：运行时已读取 `NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED`；本轮补足关闭开关的显式验收和配置说明。
- 最小修复：`.env.example` 在 `NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED=true` 前增加关闭说明；本地 `.env` 已补齐 `NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED=true`，可改为 `false` 关闭。
- 验证：`tests\normalUserModelDailyQuota.test.js` 增加真实 `process.env.NORMAL_USER_MODEL_DAILY_LIMIT_ENABLED=false` 场景，确认普通用户请求不拦截、不记录状态文件。
- 命令：`node --check tests\normalUserModelDailyQuota.test.js`、`node scripts\run-tests.js tests\normalUserModelDailyQuota.test.js`。
- 小目标已完成：普通用户模型每日限额模式可通过 env 启停。

## 运行维护 2026-06-18 08:25

- 小目标：用提示词规范主回复模型的内部思考模式，让 thinking/reasoning 更贴近瑞希角色沉浸，而不改变最终正文不外显思维链的边界。
- 最小修复：更新 `prompts/runtime/roleplay-inner-protocol.txt`，明确内部 `<think>` / thinking / `reasoning_content` 应以瑞希第一人称括号内心独白表达，例如“（心想：……）”或“(内心OS：……)”；同时聚焦剧情走向分析和回复内容规划。
- 同步边界：`utils/runtimePrompts.js` 的 fallback 同步加入同一规则；最终用户可见回复仍不得输出 `<think>`、完整思维链、内部草稿或本块内容。
- 验证：`node scripts\run-tests.js tests\promptGoldenSnapshots.test.js tests\runtimePromptCache.test.js`、`npm run check:prompts` 通过。
- 小目标已完成：bot 的内部思考风格已被提示词规范为角色第一人称沉浸式内心独白，同时保留正文外显安全边界。

## 运行维护 2026-06-18 08:21

- 小目标：专门收口 `restart confirm` 已成功但当前控制台/调用方捕获 stdout 为空的问题，不重做整条重启链路。
- 根因：确认重启路径用 `Start-Process -RedirectStandardOutput/-RedirectStandardError` 启动长期 Node；重启本身在 2-3 秒内完成并写入 `data\restart-bot.log`，但长期 Node 继承/持有调用方捕获管道，调用方等不到 stdout EOF，表现为超时或 stdout 空。
- 最小修复：`scripts\restart-bot.ps1` 的长期 Node 启动改为 WMI 隐藏启动 `cmd.exe /c node ... 1>>运行日志 2>>错误日志`，让 Node 只持有运行日志文件句柄；停止旧进程树时保护当前 `cmd/powershell` 调用链，避免远程/嵌套调用自断输出。
- 验证：`node scripts\run-tests.js tests\restartBotScript.test.js tests\remoteRestart.test.js tests\mainBotSingleInstanceLock.test.js`、`node --check scripts\pre-release-smoke.js`、`node --check tests\restartBotScript.test.js`、`node --check index.js`、`scripts\restart-bot.ps1` AST parse、`node scripts\pre-release-smoke.js --root D:\waifu --skip-restart-payload`、`cmd /c restart-bot.cmd restart`、实际 `cmd /c restart-bot.cmd restart confirm`。
- 结果：`restart confirm` 返回 0，stdout 捕获 1935 字节、stderr 0；main bot `46880 -> 41324`、post-reply worker `40672 -> 2960`；最终 `cmd /c restart-bot.cmd status` 显示两者 Running，`Other Related Node Processes` 为 none。
- 小目标已完成：确认重启成功输出可被当前控制台/调用方捕获。

## 运行维护 2026-06-18 07:51

- 小目标：给普通用户模型请求加每日全局成功调用上限，默认 25 次，管理员不受影响。
- 实现：新增 `utils\normalUserModelDailyQuota.js`，按 `TIMEZONE` 自然日和 `NORMAL_USER_MODEL_DAILY_LIMIT_STATE_FILE` 落盘计数；用状态文件旁 lock 目录保护跨进程读写。
- 接入：`postWithRetry` 在真实 provider HTTP 前检查配额、成功 HTTP 后扣减；`postStreamWithRetry` 在真实 provider HTTP 前检查配额，只有流正常结束后扣减。
- 边界：仅 `trace.userRole=user` 且存在 `trace.userId` 时生效；管理员、空角色、无用户上下文后台任务不计入；失败、超时、429、流错误不扣。
- 验证：`node --check utils\normalUserModelDailyQuota.js`、`node --check src\model\http\post-retry.chunk.js`、`node --check src\model\http\stream-retry.chunk.js`、`node scripts\run-tests.js tests\normalUserModelDailyQuota.test.js tests\normalUserModelDailyQuotaHttp.test.js tests\requestTrace.test.js tests\runtimeStreamingCoordinator.test.js`。
- 小目标已完成：普通用户每日模型成功调用次数已全局受限，并且重启不会清空当天用量。

## 运行维护 2026-06-18 01:26

- 小目标：把“脚本拆分 + self-owned lock 修复”收口成最小可提交状态，重点确认并行改动边界和可复跑验收。
- 现场边界：当前未提交区里 `restart-bot.cmd`、`scripts\restart-bot.ps1`、`tests\restartBotScript.test.js` 没有额外代码差异；保留无关脏文件 `.claude/settings.local.json`、`.learnings/ERRORS.md` 和 `artifacts/docx-meme-review/`，不纳入本目标。
- 最小修复：`index.js` 只加 `MIZUKIBOT_INDEX_TEST_MODE=1` 下的测试导出和测试模式锁文件覆写；`tests\mainBotSingleInstanceLock.test.js` 改为临时锁文件 + 临时 `node index.js` 进程的行为测试，不再靠字符串断言。
- 验证：`node scripts\run-tests.js tests\restartBotScript.test.js tests\mainBotSingleInstanceLock.test.js tests\remoteRestart.test.js`、`node --check index.js`、`node --check tests\mainBotSingleInstanceLock.test.js`、`node --check scripts\pre-release-smoke.js`、`scripts\restart-bot.ps1` AST parse、`node scripts\pre-release-smoke.js --root D:\waifu --skip-restart-payload`、`cmd /c restart-bot.cmd status`、`cmd /c restart-bot.cmd restart`、两次 `cmd /c restart-bot.cmd restart confirm` 后 status 复核均通过。
- 结果：最终 main bot PID=31136、post-reply worker PID=32480 Running，`.mizukibot.lock=31136`、worker pid 文件为 `32480`，`127.0.0.1:3002` 监听 owner=31136。
- 剩余风险：`restart confirm` 两次返回 0 且完成 PID 切换，但命令捕获 stdout 为空；成功路径目前仍可由 `data\restart-bot.log` 与 `restart-bot.cmd status` 验收，控制台回显建议后续单独收口。
- 小目标已完成：重启脚本拆分和 self-owned lock 修复已有行为测试、真实重启验收和文档记录。

## 运行维护 2026-06-18 00:56

- 小目标：直接重写 `D:\waifu\restart-bot.cmd`，降低手动/远程重启失败率，避免窗口弹出、命令卡住、bot 已死无响应时无法可靠恢复。
- 现场结论：旧脚本失败链路不是单点。`.cmd` 内嵌 PowerShell payload 参数/退出不稳定；嵌套等待 `run-bot-daemon.ps1` 会被 Node 子进程句柄拖住；Windows PID 复用会让 `index.js` 把旧锁中“刚好等于当前 pid”的值误判成已有实例运行。
- 最小修复：`restart-bot.cmd` 改成 5 行 wrapper，真实逻辑移到 `scripts\restart-bot.ps1`；确认重启直接隐藏启动 `node index.js` 和 `scripts/post-reply-worker.js`，等待真实健康并写 `data\restart-bot.log`；保留未确认 restart 只提示、不写 marker、不停进程；`index.js` 对 self-owned lock 先替换再继续启动；停止进程前只接受仍匹配 main/worker 命令行的 pid 文件，避免 stale pid 复用误杀。
- 验证：`node tests\restartBotScript.test.js`、`node tests\mainBotSingleInstanceLock.test.js`、`node tests\remoteRestart.test.js`、`node --check index.js`、`node --check scripts\pre-release-smoke.js`、`scripts\restart-bot.ps1` AST parse、`node scripts\pre-release-smoke.js --root D:\waifu --skip-restart-payload`、`cmd /c restart-bot.cmd restart`、`cmd /c restart-bot.cmd restart confirm`、`cmd /c restart-bot.cmd status` 均通过；最终 main bot PID=47996、post-reply worker PID=13608 Running。
- 小目标已完成：重启入口已收口到同步直启路径，不再依赖计划任务触发或嵌套 PowerShell 等待，失败时可从 `data\restart-bot.log` 看到阶段证据。
- 提交后记录 2026-06-18 00:56 +08:00：已提交 `e58862a`（`fix: rewrite windows restart script`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-17 20:04

- 小目标：围绕 `D:\mizuki_release` 的可发行版准备，补一组可复跑的最小发布前冒烟验收，不重新设计 daemon 或主回复链路。
- 最小实现：新增 `scripts/pre-release-smoke.js` 和 `npm run smoke:pre-release`；脚本串联现有 `restartBotScript/windowsDaemonScript/mainModelFallback/continuousMessagePreprocessorDebounce/messageHandlerGroupConcurrency/messageHandlerInboundConcurrency`，并新增 `mainModelFallbackRestartRecovery.test.js` 覆盖 fallback 内存态不会跨进程重启残留。
- 安全边界：expected_shutdown 冒烟执行的是未确认 restart payload，要求只输出确认要求、不写 `bot-main-expected-shutdown.json`、不改 daemon log；后续改为临时沙盒执行 payload，避免状态页在真实发行目录修复 `.mizukibot.lock`。
- 验证：`node --check scripts\pre-release-smoke.js`、`node --check tests\mainModelFallbackRestartRecovery.test.js`、目标测试集合通过；`npm run smoke:pre-release -- --root D:\waifu` 通过；`npm run smoke:pre-release -- --root D:\mizuki_release` 通过，配置探针输出 `regular=2000, anchored=15000, atBot=12000, private=12000, fallbackCooldownMs=600000`。
- 发行目录后置复核：沙盒化复跑后 `lockBefore=30364 / lockAfter=30364 / dataCountBefore=0 / dataCountAfter=0`，说明脚本本身不再新增发行目录运行态文件。首次非沙盒验收曾生成 `D:\mizuki_release\.mizukibot.lock` 和空 `D:\mizuki_release\data`，按删除需确认规则暂未移除。
- 小目标已完成：`D:\mizuki_release` 具备发布前最小冒烟门禁，三类重点风险已有一条命令复验。
- 提交后记录 2026-06-17 20:04 +08:00：已提交 `996a37a`（`test: add pre-release smoke checks`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-17 13:28

- 小目标：处理 `restart-bot.cmd restart confirm` 看起来仍是失败状态的问题，确认真实停启链路和命令输出是否一致。
- 现场结论：确认重启链路本身成功；第一次复现从 main bot `14572` / worker `25864` 切到 `43180` / `36056`，daemon 日志记录 expected shutdown、拉起和 lock 接管均成功，3002 端口也由新 main bot 监听。真正问题是外层 cmd 成功路径没有在当前窗口回显最终状态，用户只看到命令结束，像是失败。
- 最小修复：确认重启参数或 `MIZUKI_RESTART_CONFIRM` 生效时设置 `MIZUKI_RESTART_PRINT_POST_STATUS=1`；PowerShell payload 成功返回后，外层 cmd 自动 `call "%~f0" status`，打印最终 main bot / worker PID 与健康状态，并保留 status 非 0 时向外返回失败。
- 验证：`node tests\restartBotScript.test.js` 通过；PowerShell payload parse 通过；实际 `cmd /c restart-bot.cmd restart confirm` 输出 stopped PID、daemon actions、`[restart] confirmed restart completed; final status:` 和最终状态；当前 `.mizukibot.lock=39404`、worker pid `1644`，`127.0.0.1:3002` 监听 owner 为 `39404`。
- 小目标已完成：确认重启现在既真实生效，也会在当前控制台给出可验收结果。

## 运行维护 2026-06-17 13:18

- 小目标：排查 `restart-bot.cmd` 看起来有问题的原因，避免误把安全跳过或残留测试进程当成重启失败。
- 现场结论：当前主 bot `pid=14572`、post-reply worker `pid=25864` 正常运行；裸 `restart` 因缺少确认会按设计跳过，不会停启；状态页还把残留 `messageHandlerCotSource.test.js` 测试 Node 进程混进了原 `Matching Node Processes`。
- 最小修复：保留 `restart confirm` 才真实重启的安全语义；未确认 `restart` 输出精确下一步 `restart-bot.cmd restart confirm` / `MIZUKI_RESTART_CONFIRM=1`；状态输出拆成 `Bot Node Processes` 和 `Other Related Node Processes (diagnostic only)`，真实 bot 只按运行态 PID 列出。
- 验证：`node tests\restartBotScript.test.js` 通过；`restart-bot.cmd` PowerShell payload parse 通过；实际 `cmd /c restart-bot.cmd status` 显示 main bot/worker 单独列出，残留测试进程只在 diagnostic only；实际 `cmd /c restart-bot.cmd restart` 仅提示确认要求，`.mizukibot.lock` 仍为 `14572`。
- 小目标已完成：重启脚本不再把“安全未确认”和“无关 Node 进程”伪装成脚本故障。

## 运行维护 2026-06-17 13:07

- 小目标：复查 `prompts/admin.txt` 新增 QQ 聊天格式约束是否完整落地，避免主回复仍默认小说式/叙事式输出。
- 现场结论：管理员 stable prompt 当前按 `ADMIN_USER_IDS` 注入，私聊和群聊主回复都会带 `admin_system_prompt`；普通用户仍不注入。旧文档中“管理员群聊普通发言不带 admin prompt”的说法已过期。
- 最小修复：`prompts/admin.txt` 增加中文格式锚点“只输出角色当下会打出的消息，避免第三人称叙述”；`tests/adminStableSystemPrompt.test.js` 覆盖管理员私聊/群聊主回复装配后保留该约束；`tests/configPersonaPrompt.test.js` 覆盖真实 `admin.txt` 导出块保留该约束。
- 文档：README 和 `docs/main-reply-context.md` 同步说明 admin prompt 是 QQ 当下消息格式，不是小说式场景旁白；管理员私聊/群聊主回复都会注入，普通用户不会注入。
- 验证：`node scripts/run-tests.js tests/adminStableSystemPrompt.test.js tests/configPersonaPrompt.test.js tests/promptStageContracts.test.js` 通过；`npm run check:prompts` 通过，只有既有未引用 prompt 资源和 conflict tag 复用警告。
- 小目标已完成：管理员主回复格式约束已落到 prompt 文件、装配回归和说明文档。

## 运行维护 2026-06-17 13:04

- 小目标：确认 QQ reasoning 没有发送，是上游没有返回 thinking，还是本地配置/运行链路问题。
- 现场结论：当前运行主 bot `pid=14572`，`startedAt=2026-06-16T20:00:05.046Z`，即 `2026-06-17 04:00:05 +08:00`；reasoning 合并转发提交为 `89cc85d`，提交时间 `2026-06-17 11:55:52 +08:00`。因此线上进程尚未加载合并转发代码，这是“没有发送”的确定本地原因。
- 配置结论：最近主回复模型调用 `req_f0277160ffa05b83 / model_call_1781672118882_110` 使用 `cc-coding.cn / claude-opus-4-6-thinking / provider=anthropic / stream=true`；`npm run diag:provider-request -- --admin --json` 显示 admin Anthropic Messages 请求体 keys 含 `thinking`，本地配置不是未开启 thinking。
- 日志边界：`data/model-calls.ndjson` 只记录 usage/finish_reason，不记录原始 SSE 响应体；旧日志无法证明上游是否实际发了 thinking delta，只能证明请求体已请求 thinking、且当前发送链路未加载新代码。
- 最小修复：补齐 parser 对 Anthropic 标准流式 `content_block_delta.delta.type="thinking_delta"` / `delta.thinking` 的识别；此前只覆盖 OpenAI-compatible `reasoning_content/reasoning` 和部分 `content_block.thinking`，若上游按标准 Anthropic SSE 返回 thinking delta，重启后也可能读不到。
- 验证：`node scripts\run-tests.js tests\parserModelResponseFormats.test.js tests\modelServiceReasoning.test.js tests\runtimeStreamingCoordinator.test.js` 通过；`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过。
- 小目标已完成：未发送的确定原因是主 bot 未重启加载 `89cc85d`；同时已补上标准 Anthropic thinking delta 解析，下一步需要重启主 bot 后再用新请求验证是否收到并转发。

## 运行维护 2026-06-17 11:52

- 小目标：去除 `/cot` 特殊指令，并让 QQ 群聊/私聊在正常正文发送成功后，额外用合并转发完整发送 provider 显式返回的 reasoning。
- 最小修复：解析层提取 OpenAI-compatible `reasoning/reasoning_content`、Anthropic non-stream `content[].type=thinking` 和 SSE reasoning 增量；Runtime V2 只把最终采用候选的 `reasoningText` 往上传，unsafe/repair/fallback/工具 probe 候选不会外发；reply envelope 增加 `reasoningText`，最终发送层在正文成功后调用 QQ 合并转发。
- QQ 行为：群聊使用 `send_group_forward_msg`，私聊使用 `send_private_forward_msg`；node 结构为 `{ type: "node", data: { name, uin, content } }`；长 reasoning 按固定字符分块但不截断；合并转发失败只 `console.warn`，不降级普通文本。
- 边界：不再因 `/cot` 设置 `preserveThink`、禁用 humanizer 或强制非流式；旧正文 `<think>` 仍只走用户可见文本清理，不作为 reasoning 来源；`recordBotReply`、记忆持久化、画像和 recall 仍只使用正文/持久化正文，不接触 `reasoningText`。
- 验证：`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过；`node scripts\run-tests.js tests\parserModelResponseFormats.test.js tests\modelServiceReasoning.test.js tests\qqActionServiceReasoningForward.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js` 通过；`node scripts\run-tests.js tests\messageHandlerCotCommand.test.js tests\messageHandlerCotSource.test.js tests\messageRouteFlowGroupStreaming.test.js tests\runtimeHostCotSource.test.js tests\messageHandlerReasoningForwardSource.test.js tests\normalFastReplyRuntime.test.js` 通过。
- 小目标已完成：QQ群/QQ私聊的显式 reasoning 合并转发已接入默认回复链路，并保留失败不刷屏、不入记忆、不从 `<think>` 构造推理的边界。

## 运行维护 2026-06-17 10:04

- 小目标：修复用户指出的 Anthropic Prompt Caching “只写不读”问题，确保第三方 `/v1/messages` 请求不把动态尾部反复写成新缓存。
- 现场结论：`data/model-calls.ndjson` 中 `cc-coding.cn / claude-opus-4-6-thinking` 多次连续出现 `cache_creation_input_tokens=7049` 且 `cache_read_input_tokens=0`；命中样本的 `estimated_system_tokens` 为 6618，后续只写样本变为 7124/7779/8770，说明缓存前缀不稳定。上一轮 `thinking.type=adaptive` 也增加了第三方网关不读缓存的兼容风险。
- 最小修复：Anthropic 原生请求不再发送顶层 `cache_control`，自动缓存只在明确稳定 system 文本上打块级断点；动态-only system / messages 不再写缓存；`ANTHROPIC_ADAPTIVE_THINKING_ENABLED=false` 默认关闭 adaptive thinking，`claude-opus-4-6-thinking` 默认回到 `enabled + budget_tokens`；thinking 开启时移除 `temperature/top_p/top_k`；thinking + tools 时强制工具选择规范为 `tool_choice: { type: "auto" }`。
- 验证：`node scripts/run-tests.js tests/httpClientAnthropicPromptCache.test.js tests/httpClientReasoningEffort.test.js` 通过；完整相关集 `providerRequestNormalization/httpClientAnthropicPromptCache/anthropicAssistantContextOrdering/plannerV2Protocol/mainModelGenerationParams/httpClientReasoningEffort/openAIMainPromptCacheDualProtocol` 通过；`npm run diag:provider-request -- --admin --json` 显示 admin Anthropic 请求体 keys 不含顶层 `cache_control` / `temperature` / `top_p` / `top_k`，thinking 为 `enabled + budget_tokens`，Prompt Caching 断点只剩稳定块。
- 小目标已完成：缓存断点回到稳定前缀，避免每轮动态内容只创建不读取。

## 运行维护 2026-06-17 09:18

- 小目标：继续确认 2026-06-17 00:46、02:19 +08:00 为什么仍出现 `expected_shutdown` 后 daemon 重拉，并安全收掉夜间误重启链路。
- 现场结论：`data/bot-daemon.log` 两次均为旧 lock PID 死亡后命中 expected-shutdown marker；当前 `data/bot-main-expected-shutdown.json` 为 `pid=15416, reason=manual_restart_script, source=restart-bot.cmd, recordedAt=2026-06-16T18:19:04Z`，对应 02:19 +08:00。系统计划重启 `MizukiBotPeriodicRestart` 只在 04:00，不能解释 00:46/02:19。
- 最小修复：管理员 `/restart` 改为必须 `/restart confirm` 或 `/restart 确认`；远程重启显式调用 `restart-bot.cmd restart confirm` 并传 source/request/message/group/command 元数据；`restart-bot.cmd restart` 未确认时不写 marker、不停进程、外层也不打开 watch-log 窗口；daemon 只消费未过期、未 consumed、PID 严格匹配的 marker，命中后写回 `consumedAt/consumedBy*`，诊断展示 source/recorded/consumed/request。
- 验证：`node tests\messageAdminCommands.test.js`、`node tests\remoteRestart.test.js`、`node tests\restartBotScript.test.js`、`node tests\windowsDaemonScript.test.js`、`node tests\mainBotEarlyExitDiagnostics.test.js`、`node tests\mainBotRestartDiagnostics.test.js` 通过；`node --check` 覆盖 `utils\remoteRestart.js`、`utils\mainBotRestartDiagnostics.js`、`core\messageAdminCommands.js`、`index.js`；`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过；`scripts\run-bot-daemon.ps1` 和 `restart-bot.cmd` payload PowerShell parse 通过；实际 `cmd /c restart-bot.cmd restart` 返回 0、输出确认要求，marker hash 不变、`data/bot-daemon.log` 长度不变、`.mizukibot.lock=14572` 且仍是 `"C:\Program Files\nodejs\node.exe" index.js`。
- 小目标已完成：夜间误重启链路已收口到显式确认、来源审计和 marker 一次性消费；未执行真实 `restart confirm`，避免无必要重启当前主 bot。
- 提交后记录 2026-06-17 09:18 +08:00：已提交 `35c225a`（`fix: harden windows expected shutdown restarts`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-17 01:18

- 小目标：参考 CC-API Anthropic SDK 文档，全面修复本项目第三方 API 端点请求 Claude 时的 Anthropic Messages 请求体严重问题。
- 根因：项目是自建 HTTP POST，不是 Anthropic SDK；SDK 裸 `baseURL=https://cc-coding.cn` 会自动拼 `/v1/messages`，但本项目显式 `provider=anthropic` 的裸域名此前不会补路径。另一个严重问题是 extended thinking 为降级恢复写入的 `__originalMaxTokens` 会作为普通字段泄漏给上游。
- 最小修复：`provider=anthropic` 的裸域名补为 `/v1/messages`，OpenAI-compatible 裸域名仍补 `/v1/chat/completions`；Anthropic thinking 的原始可见 `max_tokens` 改用不可枚举 Symbol 保存，降级重试仍能恢复但不会进入 payload；`claude-opus-4-6` / `claude-opus-4-6-thinking` / `claude-mythos-preview` 改用 `thinking.type=adaptive`，旧 Claude 模型继续用 `enabled + budget_tokens`。
- 复核项：System Prompt 仍映射到顶层 `system`；Prompt Caching 仍限制 4 个断点并发送 `anthropic-beta: prompt-caching-2024-07-31`；异步主链 `postStreamWithRetry()` / `Promise.race` 未发现漏 await，本轮未做重构。
- 验证：`node --check` 覆盖请求塑形、provider 归一和目标测试；`MODEL_TLS_IMPERSONATION_ENABLED=false MODEL_TLS_IMPERSONATION_STREAM_ENABLED=false node scripts/run-tests.js tests/providerRequestNormalization.test.js tests/httpClientAnthropicPromptCache.test.js tests/anthropicAssistantContextOrdering.test.js tests/plannerV2Protocol.test.js tests/mainModelGenerationParams.test.js tests/httpClientReasoningEffort.test.js` 通过；`npm run diag:provider-request -- --admin --json` 显示 admin Anthropic 请求体 keys 不含 `__originalMaxTokens`、cache 断点为 4；当前 admin 构造探针显示 `thinking={"type":"adaptive"}`。
- 小目标已完成：第三方默认 OpenAI-compatible 请求 Claude 的路径保持不变，显式 Anthropic Messages 链路与 SDK 文档语义对齐，且不再向上游泄漏内部字段。

## 运行维护 2026-06-17 01:05

- 小目标：确认 2026-06-16 21:02、21:10、21:41、21:51 和 2026-06-17 00:46 +08:00 反复 `expected_shutdown` 后 daemon 重拉的触发者，并收掉误触发链路。
- 现场结论：持续让 daemon 认定 `expected_shutdown` 的 marker 来自 `restart-bot.cmd`。当前 `data/bot-main-expected-shutdown.json` 为 `source=restart-bot.cmd`、`reason=manual_restart_script`、`pid=12100`、`recordedAt=2026-06-16T16:46:43.8233393Z`；`data/bot-daemon.log` 在目标时间点均记录旧 lock PID 已死后 `main bot previous exit marked expected`。归档 stdout 还显示重复/非 daemon 副本干扰：`npm start` 横幅、`MizukiBot is already running`，以及 21:02 的 `EADDRINUSE 127.0.0.1:3005`。
- 最小修复：`restart-bot.cmd` 无参数默认改成只读 status，不再默认执行 restart；`utils/remoteRestart.js` 在 Windows 上显式调用 `restart-bot.cmd restart`，保留 `/restart` 管理命令的真实重启能力；`restart-bot.cmd` 写 expected-shutdown marker 前新增 live main bot PID 校验，stale lock 不再被写成正常退出。
- 验证：`node tests\restartBotScript.test.js`、`node tests\remoteRestart.test.js`、PowerShell payload parse、`node --check utils\remoteRestart.js` 通过；实际执行 `cmd /c restart-bot.cmd` 只输出 `status only; start skipped`，执行前后 `data/bot-main-expected-shutdown.json` 仍为 2026-06-17 00:46:43 +08:00、`data/bot-daemon.log` 仍为 00:46:48、`.mizukibot.lock=15416` 且 PID 15416 仍是 `"C:\Program Files\nodejs\node.exe" index.js`。
- 小目标已完成：误触发无参 `restart-bot.cmd` 不再写 expected-shutdown marker 或触发 daemon 重拉；显式 restart 路径仍保留，并通过测试约束。
- 提交后记录 2026-06-17 01:05 +08:00：已提交 `bd01eb8`（`fix: prevent accidental windows bot restart`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-16 21:11

- 小目标：治本修复 `restart-bot.cmd` 手动重启不稳定，要求脚本稳定成功且最终状态可验收。
- 根因：`restart-bot.cmd` 直接 `Stop-Process -Force` 停主 bot，却没有提前写 `data/bot-main-expected-shutdown.json`；daemon 随后看到旧 lock PID 死亡，会把人工重启计入 early-exit 崩溃退避。现场还出现失败副本把 `.mizukibot.lock` 覆盖成已退出 PID，导致 status/下一轮守护误判。
- 最小修复：重启脚本在停止主进程前写 `manual_restart_script` expected-shutdown marker；status/restart 均可扫描真实 `node index.js` 主进程并修复 stale `.mizukibot.lock`，再继续停止/启动/健康检查。
- 验证：`node tests\restartBotScript.test.js`、PowerShell payload parse 通过；实际执行 `cmd /c restart-bot.cmd restart` 返回 0；`cmd /c restart-bot.cmd status` 显示 main bot PID=38672、post-reply worker PID=19392 Running；`.mizukibot.lock` 内容为 `38672`；`Get-NetTCPConnection -LocalPort 3002` 显示 owner=38672；`POST http://127.0.0.1:3002/` 返回 204；`data/bot-main-restart-state.json` 为 `count=0,lastReason=expected_shutdown`。
- 小目标已完成：手动重启不再被 daemon early-exit 退避和 stale lock 污染卡住，最终运行态可由脚本、lock、端口和 HTTP 204 共同验收。
- 提交后记录 2026-06-16 21:11 +08:00：已提交 `2fc9501`（`fix: stabilize windows restart script`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-16 08:23

- 小目标：把主 bot 退出重拉修复补成一次可复用的真实运行验收，确认 2026-06-15 23:19 到 2026-06-16 03:49 +08:00 稳定窗口是否覆盖昨晚修复目标。
- 现场结论：该稳定窗口已覆盖修复目标。`data/bot-daemon.log` 显示 23:19:28 因 pid=29940 stale lock 且 outside_window 清零后拉起 pid=38172，23:19:29 锁交接成功；23:49、00:22、01:49、03:49 四次 daemon 均确认同一 pid=38172 `bot already running`。
- 状态证据：窗口内无 `reason=counted`、`reason=threshold_reached`、early-exit backoff、`main bot did not acquire lock after daemon start` 或 `daemon task error`；`data/bot-main-restart-state.json` 当前 `count=0` 且 `cooldownUntil` 为空；`data/bot-main-runtime-state.json` 心跳时间已晚于窗口结束，说明 heartbeat 监控持续写入。
- 最小补强：新增只读回归入口 `npm run verify:main-bot-stability-window`，默认校验该真实窗口，也支持 `--start`、`--end`、`--expected-pid` 和 `--json` 复用到后续稳定窗口。
- 验证：`node scripts/run-tests.js mainBotStabilityWindow.test.js`、`npm run verify:main-bot-stability-window -- --json`、`node scripts/verify-main-bot-stability-window.js` 通过；真实窗口报告 `status=pass`、`observedPids=[38172]`、`mainBotStarts=1`、`lockHandoffs=1`、`alreadyRunningChecks=4`、`blockingEvents=0`。
- 小目标已完成：23:19–03:49 稳定窗口已由真实 daemon/lock/heartbeat/restart-state 证据验收，并固化为可复跑脚本。
- 提交后记录 2026-06-16 08:25 +08:00：已提交 `57fba40`（`test: verify main bot stability window`）；该小目标完成记录已按并行开发约定追加。

## 方案评估 2026-06-16 01:13

- 小目标：评估“嵌入 V8/QuickJS 或 nodejs-mobile-react-native，把本项目打包成安卓 APK”的可行性，并先修改方案，不改项目代码。
- 结论：原样打包当前服务端项目为 APK 可行性低；首版目标应改为“手机前端本地对话 APK”，React Native 做 UI，`nodejs-mobile-react-native` 只运行裁剪后的对话后台，NapCat/OneBot/QQ 机器人框架先全部剥离。
- 证据：当前项目声明 Node.js `>=20.0.0`，但 `npm view nodejs-mobile-react-native ...` 核验最新为 `18.20.4`；当前依赖核验包含 `@lancedb/lancedb`、`better-sqlite3`、`sharp`、`cycletls`、`express`、`ws`、`@langchain/langgraph`，这些会显著放大 Android native/ABI/后台运行风险。
- 方案修正：QuickJS/V8 不作为第一版，因二者是 JS 引擎嵌入或宿主重写路线，不提供现成 Node/npm/native addon 兼容层；第一版只做 local_chat -> assistant_reply 的单人手机对话契约。
- 文档：新增 `docs/superpowers/plans/2026-06-16-android-apk-feasibility.md`，包含保留/禁用范围、路线对比、分阶段任务和验收标准。
- 验证：只读执行 `npm ls @lancedb/lancedb better-sqlite3 sharp cycletls express ws @langchain/langgraph @langchain/core axios --depth=0`、`npm view nodejs-mobile-react-native version time engines peerDependencies dependencies --json`；核对 nodejs-mobile React Native、QuickJS、V8 embedding、Android 16 KB page size 官方文档；`git diff --stat` 确认只有文档变更。
- 小目标已完成：APK 方向已从“完整打包当前 bot”改为“裁剪手机本地对话 SKU”，后续实现必须先冻结移动契约并证明不加载 NapCat/OneBot。
- 提交后记录 2026-06-16 01:18 +08:00：已提交 `6be5bfc`（`docs: evaluate android apk packaging path`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-15 23:28

- 小目标：复盘主 bot 在 2026-06-15 20:08 和 20:10 +08:00 两次退出后被 daemon 重拉，确认是否仍有 silent exit 或诊断误判，并做最小修复。
- 实际链路：20:08 daemon 发现 `.mizukibot.lock` 旧 pid=24400 已不运行，因锁龄 1241377ms 超过 15 分钟按 outside_window 清空早退计数，归档 `bot-runtime.out.20260615-200845-569.log` 后拉起 pid=32440；20:10 daemon 又发现 pid=32440 已不运行，计入 `reason=counted,count=1`，归档 `bot-runtime.out.20260615-201026-413.log` 后拉起 pid=34356。
- 复盘结论：两份归档 stdout 末尾都是正常消息处理 release，stderr 为空，且没有 `[process] exit` / fatal / Node report；daemon 重拉判断本身成立，不是重复启动误判。未覆盖点是 silent hard exit 只能从锁残留推断，且旧 `npm run diag:main-bot-restarts -- --text` 会因当前 restart-state 被后续 outside_window 覆盖而报 `ok (0 signals)`。
- 最小修复：主进程新增 `data/bot-main-runtime-state.json` 心跳和 `data/bot-main-exit-observations.jsonl` 同步退出观测；Windows daemon 检测 stale lock 时追加 daemon observation，并优先用同 pid 的 `heartbeatAt - startedAt` 估算真实运行寿命，避免 daemon 检查晚到时把短命退出误归为 outside_window；主 bot 重启诊断读取 observations 并把 daemon counted/stale-lock 证据升为 warning。
- 验证：`node scripts/run-tests.js mainBotEarlyExitDiagnostics.test.js windowsDaemonScript.test.js mainBotRestartDiagnostics.test.js`、`node --check index.js`、`node --check utils/mainBotRestartDiagnostics.js`、PowerShell 解析 `scripts/run-bot-daemon.ps1` 通过；实际 `node scripts/diagnose-main-bot-restarts.js --text` 默认口径输出 `warning`，扩展口径包含 `main_bot_hard_exit_counted_by_daemon`；`data/bot-main-runtime-state.json` 已刷新当前主进程 pid=38172，HTTP reverse `POST http://127.0.0.1:3002/` 返回 204。
- 小目标已完成：20:08/20:10 重拉链路已复盘，daemon 判断有效；silent exit 证据和诊断误判缺口已补，下一轮同类退出会留下 heartbeat/observation 证据。
- 提交后记录 2026-06-15 23:42 +08:00：已提交 `1c3cbd3`（`fix: record main bot silent exits`）；提交后复查 `cmd /c restart-bot.cmd status` 显示 main bot pid=38172、post-reply worker pid=37184 均 Running，HTTP reverse `POST /` 仍返回 204。该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-15 19:29

- 小目标：清掉 `npm audit --omit=dev --json` 剩余的 6 个 moderate，不破坏 Minecraft 功能。
- 定位：6 项全部落在 `mineflayer -> minecraft-protocol -> prismarine-auth/yggdrasil -> uuid` 链；`api/minecraftAgent.js` 仍是唯一 Minecraft 入口，默认 `MC_AUTH=offline` 不触发在线认证路径。
- 最小修复：在根 `package.json` 加 `overrides.uuid=11.1.1`，让 `@azure/msal-node` 和 `yggdrasil` 统一落到安全 `uuid`，不升级 `mineflayer` 主链、不改 Minecraft 连接代码。
- 验证：`npm audit --omit=dev --json` 变为 0 vulnerabilities；`npm ls uuid @azure/msal-node yggdrasil minecraft-protocol prismarine-auth mineflayer --all` 显示 `uuid@11.1.1` deduped/overridden；`node --check api/minecraftAgent.js`、`node --unhandled-rejections=strict tests/minecraftAgentListenerCleanup.test.js`、`node -e "require('mineflayer'); require('mineflayer-pathfinder'); require('minecraft-protocol'); require('prismarine-auth'); const y=require('yggdrasil'); const msal=require('@azure/msal-node'); const u=require('uuid'); console.log('minecraft dependency load ok', typeof u.v4, typeof y, typeof msal.PublicClientApplication);"`、`npm run check:agent:static` 通过。
- 小目标已完成：mineflayer auth 链 moderate 清零，未做真实 Minecraft 服务器在线登录联调。
- 提交后记录 2026-06-15 19:33 +08:00：已提交 `db45d8e`（`fix: clear mineflayer auth audit`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-15 12:05

- 小目标：收口 DEBUG_PLAN 当前剩余目标 C-006、C-007、H-001、H-005、H-006、M-001，并把 LangChain v1 迁移后的运行边界、验证结果和剩余风险写入文档。
- 已完成：`api/qqActionService.js` 保持旧入口兼容，图片/日记配图迁入 `api/qqActionService.imageDiary.js`；`index.js` 单实例锁/旧 PID 探测和图片热路径同步 I/O 改为 async；`requestImageGenerationStream` 与图像流 SSE 处理捕获 data/end/close/error 内异常并 reject；`api/napcatMessageReader.js`、`utils/memosPlannerRecall.js`、`core/continuousMessagePreprocessor/index.js` 增加 TTL 和最大容量；`core/researchTaskQueue.js`、`core/foregroundConcurrency.js`、`utils/backgroundTaskRuntime.js` 加 single-flight/重入保护；LangChain 升至 v1，`package.json` 和 README 运行边界同步为 Node.js `>=20.0.0`。
- 验证：`npm ls @langchain/core @langchain/anthropic @langchain/openai @langchain/langgraph zod zod-to-json-schema --all` 通过；`node -e "require('./api/runtimeV2/host'); require('./api/runtimeV2/state'); require('./api/toolAdapter'); require('./api/legacy/agentGraphV1Runtime'); console.log('langchain runtime modules load ok')"` 通过；`node scripts/run-tests.js langgraphV2.test.js langgraphRuntimeVersion.test.js langgraphStoreSanitize.test.js langgraphCheckpointSnapshot.test.js` 通过；`node scripts/run-tests.js runtimeHostCotSource.test.js runtimeV2DirectReplyFailureTelemetry.test.js runtimeStreamingCoordinator.test.js dispatchRuntimeBinding.test.js dispatchRuntimeBindingParallel.test.js runtimeV2MainReplyMemoryOrder.test.js runtimeV2PromptTimeoutMemoryFallback.test.js runtimeV2SessionPromptCacheStability.test.js runtimeV2PromptOptimization.test.js` 通过；`npm run check:agent:static`、`npm run check:prompts` 通过；`npm audit --omit=dev --json` 为 6 个 moderate、0 high、0 critical。
- 新暴露并处理：两个 Runtime V2 prompt 测试在断言通过后会因继承本地 embedding/worldbook/rerank 远程配置留下活跃 socket，现测试内显式隔离相关环境变量，`ERR-20260615-001` 标记 resolved。
- 剩余风险：未跑 24/48 小时长稳、clinic.js 事件循环延迟、图片吞吐压测、真实 Telegram/Minecraft/NapCat 外部联调；`npm audit --omit=dev` 剩余 6 个 moderate 均来自 mineflayer auth 链（`@azure/msal-node`、`minecraft-protocol`、`mineflayer`、`prismarine-auth`、`uuid`、`yggdrasil`）。
- 小目标已完成：本轮 DEBUG_PLAN 指定目标已有可复跑本地验收，剩余项均记录为外部压测/依赖链风险，不阻塞当前提交。
- 提交后记录 2026-06-15 12:11 +08:00：已提交 `e1b174b`（`fix: complete langchain debug plan migration`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-15 11:56

- 小目标：让第三方主回复网关在显式配置 `/v1/messages` 时直接使用 Messages 协议，同时保留默认补全 `/v1/chat/completions` 的行为。
- 根因：`resolveMainProvider()` 先读取 `API_PROVIDER` / override provider，再看 URL 后缀；第三方配置常把 provider 写成 `openai_compatible` 或其它占位值，导致 `/v1/messages` 被 `ensureChatCompletionsUrl()` 改写为 `/v1/chat/completions`。
- 最小修复：主回复 provider 解析改为 endpoint 优先，URL 以 `/messages` 结尾时直接判为 `anthropic_messages`；裸域名、`/v1`、`/v1/chat/completions` 仍按 OpenAI-compatible 默认补全或保留。
- 验证：`node tests/providerRequestNormalization.test.js`、`node tests/plannerNoRetry.test.js`、`node tests/providerRequestDiagnostics.test.js` 通过；新增回归覆盖 `provider=openai_compatible + https://third-party.example/v1/messages`，构造和 prepare 后 URL 均保持 `/v1/messages`，header 使用 `x-api-key` 而非 `Authorization`。
- 小目标已完成：第三方 `/v1/messages` 网关不再被自动改写到 `/v1/chat/completions`。
- 提交后记录 2026-06-15 12:02 +08:00：已提交 `9669bcd`（`fix: honor messages endpoint protocol`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-15 11:18

- 小目标：执行 DEBUG_PLAN C-001/C-002/C-003，建立提交前密钥防护，并清掉 axios/request/form-data critical 供应链风险。
- 最小修复：`.gitignore` 扩展 `.env*`、`secrets/`、`*.key`、`*.pem` 并保留 `.env.example` / `.env.skills.example`；新增 Husky `pre-commit`，优先调用系统 `gitleaks protect --staged --verbose`，没有 gitleaks CLI 时运行 `npm run check:secrets` staged 兜底扫描；`axios` 升到 `^1.18.0`，`node-telegram-bot-api` 升到 `^1.1.0`，`mineflayer` 升到 `^4.37.1`，并执行非 breaking `npm audit fix`；Telegram 包升级为 ESM-only 后，`core/tgBot.js` 改为动态 `import()`。
- 验证：虚拟 staged `sk-*` 假密钥被 `scripts/check-staged-secrets.js` 阻断，空 staged 扫描通过；历史 `sk-*` 模式只读检查无命中；`git check-ignore -v .env .env.local .env.production secrets/token.txt private.key private.pem` 均命中；`npm ls axios node-telegram-bot-api mineflayer request form-data --all` 不再出现 `request` 或旧 `axios@0.21.4`；`node -e "require('./core/tgBot'); require('./api/minecraftAgent'); console.log('tg/minecraft modules load ok')"`、`node -e "(async()=>{ const { loadTelegramBotClass } = require('./core/tgBot'); const C = await loadTelegramBotClass(); console.log(typeof C); })()"`、`node --unhandled-rejections=strict tests/tgBotExceptionHandling.test.js`、`node --unhandled-rejections=strict tests/minecraftAgentListenerCleanup.test.js`、`node tests/qqActionService.test.js`、`npm audit --omit=dev --audit-level=critical` 通过。
- 剩余风险：`npm audit --omit=dev` 仍有 14 个非 critical 漏洞，主要需要 LangChain v1 breaking 迁移；未连真实 Telegram/Minecraft 外部服务做在线验收。
- 小目标已完成：本轮 critical 供应链漏洞清零，提交前密钥扫描和敏感路径 ignore 防线可复跑验收。
- 提交后记录 2026-06-15 11:28 +08:00：已提交 `505b71a`（`fix: secure debug plan critical paths`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-15 10:53

- 小目标：覆盖 DEBUG_PLAN M-002/M-003/M-004，补缓存 TTL/大小限制、模型响应 JSON 解析护栏和后台任务 ack race outcome。
- 最小修复：`utils/memorySemanticIndex.js` query embedding cache 增加 TTL 读取、访问刷新和最大条数裁剪；`api/runtimeV2/model/service.js` filtered tool schema cache 增加 TTL/max、克隆读写和 malformed 日志预览收敛；`api/parser.js` 新增 `parseJsonWithSafety`，按大小和嵌套深度拒绝超限 JSON，并接入 SSE、模型响应、工具参数解析；`core/messageBackgroundTasks.js` 将 `replyPromise` race 统一为 `completed/failed/timeout` outcome，ack 后失败只更新任务状态，不作为成功 follow-up 发送。
- 验证：`node --check utils/memorySemanticIndex.js`、`node --check api/runtimeV2/model/service.js`、`node --check api/parser.js`、`node --check core/messageBackgroundTasks.js`、`node scripts/run-tests.js memorySemanticIndexCache.test.js modelServiceToolSchemaCache.test.js modelServiceCot.test.js parserModelResponseFormats.test.js messageBackgroundTasks.test.js` 均通过。
- 剩余风险：未新增 `lru-cache` 依赖，按项目现有 `Map + expiresAt + prune` 风格实现；未跑生产长时间内存曲线/OOM 压测，也未覆盖所有调用方的大 payload 组合。
- 小目标已完成：M-002/M-003/M-004 的稳定性修复已有可复跑单元验收。

## 运行维护 2026-06-15 10:45

- 小目标：执行 DEBUG_PLAN H-002/H-004，补 Telegram handler 异常隔离与 Minecraft 重连监听器清理。
- 最小修复：`core/tgBot.js` 抽出 `handleTelegramMessage`，`sendChatAction`、AI 处理、正常回复发送、错误提示发送均独立 catch 并记录上下文；`api/minecraftAgent.js` 在 `resetRuntimeState` 里清理旧 bot 的 `kicked/error/end/chat` 监听器后再置空运行时状态。
- 验证：`node --check core/tgBot.js`、`node --check api/minecraftAgent.js`、`node --check tests/tgBotExceptionHandling.test.js`、`node --check tests/minecraftAgentListenerCleanup.test.js`、`node --unhandled-rejections=strict tests/tgBotExceptionHandling.test.js`、`node --unhandled-rejections=strict tests/minecraftAgentListenerCleanup.test.js` 通过。
- 未覆盖风险：未连真实 Telegram 网络/API 限流，也未对真实 Minecraft 服务器做 10 次重连内存 profiling；当前覆盖为单元级异常与 EventEmitter listener 计数验收。
- 小目标已完成：Telegram 消息处理错误不再逃出事件回调，Minecraft reset 会释放旧 bot 核心监听器。

## 运行维护 2026-06-15 10:44

- 小目标：覆盖 DEBUG_PLAN C-004/M-005，修复 tickEngine 主动触达发送失败状态不一致和 stop 后 timer 继续推进 tick 的竞态。
- 最小修复：`sendTouchMessage` 将 WebSocket 发送、系统群发送记录和 persona 成功 outcome 放入同一 try/catch；任一失败时记录 `touch_failed`，返回 `{ sent:false, reason }`，不更新用户 tick state、initiative sent/cycle 成功状态。`startTickEngine` 在 timer 回调进入 runner 前检查 stopped，并给 proactive tick cycle 各阶段增加停止守卫。
- 验证：`node tests/tickEngineSendFailure.test.js`、`node tests/tickEngineStopGuard.test.js`、`node tests/tickEngineAdaptive.test.js`、`node tests/proactiveGreetingFallbackState.test.js` 均通过。
- 剩余风险：未跑 48 小时稳定性测试；本次只覆盖 WebSocket 抛错、状态记录抛错、persona 成功 outcome 抛错和 stop/timer 竞态的单元级路径。
- 小目标已完成：主动触达发送失败不再写成功状态，scheduler stop 后不再继续推进 proactive tick。

## 运行维护 2026-06-14 22:42

- 小目标：重点排查今天慢点 1 和 2，区分连续消息等待、流式生成耗时和真实 QQ 发送耗时。
- 证据：`req_7d10035daeec3292` 的 `v2_streaming_reply` 使用 `transport=cycletls` 持有流式 HTTP 约 92.4s；同一时间窗多条连续消息预处理到 `http_client_success` 后才恢复，存在事件循环/定时器恢复被流式 CycleTLS 放大的风险。
- 最小修复：连续消息 max-hold 过期后立即 flush，并记录 wait/resolve/timer overdue/schedule timing；流式发送记录 `getStats()`，`final_reply_send_done.durationMs` 改为真实流式发送 wall time，生成耗时写入 `generationDurationMs`；默认 `MODEL_TLS_IMPERSONATION_STREAM_ENABLED=false`，流式主回复回 axios，非流式 CycleTLS 保留。
- 验证：`node scripts/run-tests.js continuousMessagePreprocessor.test.js messageReplyRuntimeFreshness.test.js messageRouteFlowGroupStreaming.test.js mainReplyLagDiagnostics.test.js modelHttpCycleTlsFallback.test.js`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"`、`npm run diag:main-reply-lag -- --since=24h --no-provider-diagnostic` 通过；配置探针输出 `configStream=false/statusStream=false/tls=true`。
- 小目标已完成：今天 1/2 凝滞点已有可复跑证据、诊断字段和默认避让策略。
- 提交后记录 2026-06-14 23:02 +08:00：已提交 `af1cf0c`（`fix: isolate streaming reply latency blockers`）；该小目标完成记录已按并行开发约定追加。

## 运行维护 2026-06-14 19:47

- 小目标：修正 `diag:main-reply-lag` 的发送耗时统计，避免把流式生成完成耗时误报为 QQ 发送慢。
- 口径复核：`reply_send_success/reply_send_failure.durationMs` 来自 `sendSystemGroupReply/sendSystemPrivateReply` 调用，是真正 QQ/NapCat 发送耗时；流式路径的 `final_reply_send_done.durationMs` 从 `formalDispatchStartedAt` 到流式完成，包含模型生成完成等待。
- 最小修复：`send` 仅聚合 `reply_send_success/reply_send_failure.durationMs`；新增 `generation` 聚合带 `stream=true` 或 `streamCompleted=true` 的 `final_reply_send_done.durationMs`；文本输出标明各自来源。
- 验证：`node --check utils/mainReplyLagDiagnostics.js`、`node --check tests/mainReplyLagDiagnostics.test.js`、`node tests/mainReplyLagDiagnostics.test.js`、`npm run diag:main-reply-lag -- --no-provider-diagnostic` 通过。测试样本 `reply_send_success=42ms`、流式 `final_reply_send_done=98000ms` 显示为 `send p95=42ms`、`generation p95=98000ms`。
- 小目标已完成：发送耗时和流式生成完成耗时已分开显示。

## 运行维护 2026-06-14 19:33

- 小目标：让管理员 `/check` 这类管理诊断快命令绕过连续消息预处理/聚合，尽量直达 admin route。
- 真实链路：`req_c70940dbe4a09036` 在 `handle_incoming_start -> continuous_preprocess_done` 已耗 57.9s，`continuous_preprocess_done.flushReason=debounce`；之后 `message_ingress_lock_acquired.queueWaitMs=0`、`inbound_wait_ms=0`，router 0ms 命中 `admin/check`。结论：旧修复只绕过 per-user 入站锁，当前卡点在更前面的连续消息聚合。
- 最小修复：`continuousMessagePreprocessor` 复用 `parseAdminCommand()` 做前置识别，只在 `context.isAdminUser=true` 且命令属于管理诊断快命令白名单（当前 `/check`）时走 `command_bypass`；message handler 把当前 sender 的管理员判断传入预处理。非管理员 `/check`、未知 slash 和普通消息不绕过。
- 验证：`node --check core/continuousMessagePreprocessor/index.js`、`node --check tests/continuousMessagePreprocessor.test.js`、`node --check tests/messageHandlerAdminCheckConcurrency.test.js`、`node tests/continuousMessagePreprocessor.test.js`、`node tests/messageHandlerAdminCheckConcurrency.test.js`、`node tests/routerChineseKeywords.test.js`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过。`core/messageHandler.runtime-03.chunk.js` 是 chunk 拼装片段，单独 `node --check` 不适用，已用完整 handler 加载验收。
- 小目标已完成：管理员 `/check` 不再先等 12s-60s 连续性/聚合阶段，普通消息聚合保护条件保持不变。

## 运行维护 2026-06-14 15:08

- 小目标：修掉 dispatch capability preflight 在已有 route `executionPlan` 时的第二轮远程 planner。
- 链路复核：route flow 会把 `routeMeta.toolPlanner/directChatPlanner.executionPlan` 传入 RuntimeV2；`buildInitialPlanSlice` 已验证该 plan 并生成 `plan.steps`；现有慢点来自 dispatch preflight 再走 `api/globalToolRuntime.js -> planningService.planRequestV2`。
- 最小修复：dispatch 只在 `plan.planner` 标记 single-authority 且 validation 未失败时透传 route planner `executionPlan`；global preflight 优先复用该 plan，仅做本地 allowed tool/policy 过滤和 `enforceToolPolicy`，没有可复用 plan 时保留旧 planner 路径。
- 验证：`node --check api/globalToolRuntime.js`、`node --check api/runtimeV2/nodes/dispatch.js`、`node --check tests/globalToolRuntimeRoutePlanPreflight.test.js`、`node --check tests/dispatchChatFastPreflight.test.js`、`node tests/dispatchChatFastPreflight.test.js`、`node tests/globalToolRuntimeRoutePlanPreflight.test.js` 通过；新增 global runtime 测试中 planner service 被打桩为抛错，实际 `plannerCalls=0`，且只执行 allowed 的 `web_search`。
- 小目标已完成：已有可用 route `executionPlan` 时，dispatch preflight 不再发起第二轮远程 `planRequestV2`。

## 运行维护 2026-06-14 15:03

- 小目标：让 `normal_fast_reply` 快回复链路也能触发安全限制 emoji 标记。
- 根因：`normal_fast_reply` 在 message handler 中提前短路发送，不走 Runtime V2 `replyEnvelope`；快回复 prompt 也没有复用普通用户 `defaut.txt` stable block，模型不一定会输出 `/%`；即使返回了 `hasSafetyRestriction` 或字符串 `/%`，快回复 runtime 也未继续透传。
- 最小修复：快回复 system prompt 复用主回复 `normal_user_default_prompt` stable block，从而注入普通用户边界规则；`runNormalFastReply()` 清洗 `/%` 并保留 `hasSafetyRestriction`；快回复发送成功后调用 `markSafetyRestrictionEmojiAfterReply()`。
- 验证：`node tests/normalFastReplyRuntime.test.js`、`node tests/normalFastReplyHandlerSource.test.js`、`node tests/safetyRestrictionDetection.test.js`、`node tests/messageRouteFlowGroupStreaming.test.js`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过。
- 小目标已完成：`normal_fast_reply` 命中普通用户安全边界时会移除内部 `/%` 并给原消息贴安全限制 emoji。

## 运行维护 2026-06-14 14:59

- 小目标：给不支持 `/v1/responses` 的 OpenAI-compatible planner host 做最小能力绕过，避免先 405 再回退 `/v1/chat/completions`。
- 根因：planner 已把 `PLAN_API_BASE_URL` 规范到 `/v1/chat/completions`，但通用 HTTP 层在 OpenAI-compatible 请求且没有内部协议偏好时会优先改写为 `/v1/responses`，失败后再由降级器回退 chat completions。
- 最小修复：新增 `PLANNER_API_MODE`/`PLAN_API_MODE`，默认 `chat_completions`；planner 请求体复用现有 `__preferredProtocol=chat_completions`，只影响 planner 远程模型请求，不改主回复 provider 自动降级策略。需要强制 Responses 的 planner 可显式设 `PLANNER_API_MODE=responses`。
- 验证：`node tests/plannerNoRetry.test.js`、`node -e "require('./config'); require('./src/runtime-v2/planning/tool-gating.chunk'); require('./src/model/http'); console.log('planner/provider modules load ok')"` 通过。新增测试经真实 `postWithRetry -> prepareRequest -> axios.post` 路径，mock 记录唯一发送 URL 为 `http://127.0.0.1:41593/v1/chat/completions`，未出现 `/v1/responses`。
- 405 往返结论：本次验收在本地 mock planner host 上已实际消除 `/v1/responses` 前置请求，因此该场景不会再产生“先 405 再回退”的往返；未对真实外部 OpenAI-compatible host 发起在线请求。
- 小目标已完成：planner OpenAI-compatible 默认协议固定到 chat completions，避免不支持 Responses 的 planner host 被通用 HTTP 层预先改写。

## 运行维护 2026-06-14 10:42

- 小目标：恢复普通用户安全限制 emoji 标记到真实主回复链路。
- 根因：`prompts/defaut.txt` 后续边界文案移除了 `/%` 触发要求；Runtime V2 清洗 `/%` 后没有保留 `hasSafetyRestriction`；`buildReplyEnvelope()` 未透传该字段；公开群流式发送分支也没有发送后标记调用。
- 最小修复：恢复普通用户边界触发时末尾追加内部 `/%` 的 prompt 规则；`buildReplyTextVariants`、`directReply`、`streamingCoordinator`、`host`、`buildReplyEnvelope` 全链路透传 `hasSafetyRestriction`；非流式/流式发送成功后均调用 `markSafetyRestrictionEmojiAfterReply`。
- 验证：`node tests/safetyRestrictionDetection.test.js`、`node tests/runtimeV2DirectReplyFailureTelemetry.test.js`、`node tests/runtimeStreamingCoordinator.test.js`、`node tests/runtimeHostCotSource.test.js`、`node tests/messageRouteFlowGroupStreaming.test.js`、`npm run check:prompts`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过；`buildReplyTextVariants('换个话题吧/%','')` 返回 `hasSafetyRestriction=true`。
- 小目标已完成：安全限制 emoji 标记不再停留在清洗函数单测，已贯通到发送后置动作所需的 envelope 字段。

## 运行维护 2026-06-14 10:04

- 小目标：补一个只读入口，回答某次请求里的 `live_state_dynamic` 如何生成和注入。
- 最小实现：新增 `npm run diag:live-state-dynamic`，复用 `diag:main-reply-prompt-assembly` / prompt snapshot 诊断链路；`--request-id` 读取已记录证据，`--text` 按当前本地 runtime 重建。`live_state_dynamic` prompt block 只追加诊断 meta，不改变 prompt 文本。
- 输出范围：是否命中、关系边界/当前活动/最近摘要/反 AI 规则来源、裁剪前后 chars/tokens、最终 token 估算、prompt block 顺序位置、runtime must-use 选择证据。
- 验证：`node tests/mainReplyPromptAssemblyDiagnostics.test.js`、`node tests/liveState.test.js`、`node tests/liveStatePromptIntegration.test.js`、`node tests/prepareLiveStateInjection.test.js`、`npm run diag:live-state-dynamic -- --text "服饰专门学校和N25两个都不放弃" --worldbook-semantic-limit=0` 通过。
- 小目标已完成：`live_state_dynamic` 的生成、裁剪和注入顺序已有可复跑只读诊断。

## 运行维护 2026-06-14 00:42

- 小目标：按 `docs/live-state-enhancement.md` 落地动态生活状态系统，执行前先确认是否已有重复功能。
- 查重结论：已有 `roleplay_runtime_context`、`chat_liveness_discipline`、`relationship_state`、`daily_journal` 能提供部分活人感、关系距离和近况材料，但没有独立 `live_state_dynamic` 运行时动态块，也没有 800 token 硬封顶和反 AI/关系边界/当前活动的确定性组合。
- 最小实现：新增 `utils/liveState/*`、`api/runtimeV2/nodes/enhanceLiveState.js` 和 `prompts/runtime/live_state_rules.txt`；Runtime V2 拓扑改为 `prepare -> enhance_live_state -> route`；由于主回复 prompt 在 `prepare` 内构建，`prepare` 会先软超时构建 live state 并传入动态 prompt，`enhance_live_state` 节点负责确认/补建且不重复查询。
- 兼容说明：当前仓库为 CommonJS/chunked prompt 架构，未新增文档草案中的 ESM `api/runtimeV2/context/liveStateEnhancer.js`；Memory V3 当前没有通用 `queryProjection` 导出，先使用可注入 `memoryV3.queryProjection`，不存在时回退 legacy relationship/Profile Journal/Daily Journal 读法。
- 验证：`node scripts/run-tests.js liveState.test.js liveStatePromptIntegration.test.js prepareLiveStateInjection.test.js langgraphV2.test.js`、`npm run check:prompts`、`npm run check:agent:static`、`node scripts/run-tests.js promptGoldenSnapshots.test.js`、`node scripts/run-tests.js promptCompiler.test.js mainReplyPromptAssemblyDiagnostics.test.js mainReplyTokenBudgetCaps.test.js`、`node scripts/run-tests.js runtimeV2MainReplyMemoryOrder.test.js runtimeV2PromptTimeoutMemoryFallback.test.js` 通过。
- 性能/注入验收：生活状态探针输出 `tokens=465 durationMs=16 has=true relationship=stranger`；轻量注入探针确认 `live_state_dynamic` 被选中，该块 token=63。
- 未作为验收：`npm test` 本机 5 分钟超时；完整 `buildDynamicPrompt` 探针 60s 超时；`runtimeV2PromptOptimization.test.js` 单测 120s/180s 超时，未发现断言失败但不标记通过。
- 小目标已完成：动态生活状态进入普通主回复和 `chat/default` 快路径，失败不阻断主流程，未修改 persona 文件。

## 运行维护 2026-06-13 23:03

- 小目标：把 QQ thinking emoji 默认编号切换到 `355`。
- 最小修复：`config/index.js` 中 `QQ_THINKING_EMOJI_IDS` 默认值从 `[212]` 改为 `[355]`，仍保留环境变量覆盖能力。
- 检查：未发现 `.env*` 中存在 `QQ_THINKING_EMOJI_IDS=` 覆盖项。
- 验证：`node -e "const config=require('./config'); console.log(config.QQ_THINKING_EMOJI_IDS.join(','))"` 输出 `355`；`node tests/qqActionService.test.js` 通过。
- 小目标已完成：thinking emoji 默认发送目标已切到 355。

## 运行维护 2026-06-13 22:57

- 现场症状：thinking emoji 不能成功发送；`data/napcat-health-events.ndjson` 里最近降级均为 `reason=napcat_offline`，但只读健康诊断显示 NapCat 总体已恢复 online。
- 根因：当前本机启用 `NAPCAT_HTTP_REVERSE_ENABLED=true`，主入口使用 HTTP action client；`markThinkingEmojiBeforeLlm` 没有把注入 client 传给 `setMessageEmojiLike`，导致它回退到未绑定 WebSocket singleton，连接快照为 `readyStateName=none` 并被离线快跳过。
- 最小修复：thinking emoji preflight 显式使用 `globalNapCatActionClient` / route flow 注入的 `actionClient`；`messageRouteFlow` 与 `messageDispatchCoordinator` 均透传该 client 到 `markThinkingEmojiBeforeLlm`。
- 验证：`node tests/messageDispatchCoordinator.test.js`、`node tests/messageRouteFlowGroupStreaming.test.js`、`node tests/qqActionService.test.js`、`node tests/messageHandlerPrivateTypingPoke.test.js`、`node -e "require('./core/messageHandler')"` 通过。
- 补充：`node -c core/messageHandler.runtime-02.chunk.js` 不作为验收，该文件是 chunk 拼装片段，不是独立 CommonJS 文件。
- 小目标已完成：HTTP reverse 模式下 thinking emoji 不再误走未绑定 WebSocket client，恢复到实际 NapCat action client 发送链路。

## 运行维护 2026-06-13 21:05

- 围绕 `prompts/defaut.txt` 补最小回归：普通用户主回复和普通用户被动群感知回复会注入 `normal_user_default_prompt`；管理员私聊、管理员群聊和管理员 sender 的被动回复不注入该普通用户块；空 `defaut.txt` 不导出、不注入。
- 主回复测试确认 stable block 顺序保持 `root_system_prompt -> normal_user_default_prompt -> security_contract -> core_baseline_patch -> main_persona_system`，避免当前提示词边界文字调整打乱已有 stable 层顺序。
- 修复稳定 prompt cache audience 维度：区分 `normal_user`、`admin_private`、`configured_admin_non_private` 和 `anonymous`，避免普通用户 stable cache 被管理员群聊复用。
- 验证：`node tests/adminStableSystemPrompt.test.js`、`node tests/passiveAwarenessReplySystemPrompt.test.js`、`node tests/promptCompiler.test.js`、`node tests/prepareNodeStablePromptFallback.test.js`、`node tests/passiveAwarenessReplyMemoryPrompt.test.js`、`npm run check:prompts`、`node -e "require('./api/runtimeV2/context/service')"`、`node -e "require('./core/passiveGroupAwareness')"` 通过。
- 未作为验收：`tests/runtimeV2SessionPromptCacheStability.test.js`、`tests/runtimeV2PromptOptimization.test.js` 本机超时；`tests/promptGoldenSnapshots.test.js` 在 worldbook no-planner 既有分支失败，未纳入本次 defaut 边界修改。
- 小目标已完成：`defaut.txt` 普通用户注入边界和管理员隔离有可复跑回归，且未覆盖当前未提交的 prompt 文本改动。

## 运行维护 2026-06-13 15:27

- 新增只读 Gemini 最近风格信号诊断入口：`npm run diag:gemini-style-signals`。
- 诊断读取 `data/gemini-recent-style-signals.json`，按最近窗口汇总起手、尾音、固定短语的命中次数和最近命中时间，并标出会进入 `gemini_recent_style_guard` prompt 的信号。
- 验证：`node scripts/run-tests.js geminiRecentStyleSignalDiagnostics.test.js` 通过；`npm run diag:gemini-style-signals -- --text` 在当前本机返回 `missing records=0 recent=0 guard=no`，确认数据文件缺失时只读输出且不创建运行数据。
- 小目标已完成：Gemini 最近风格 guard 的当前信号状态可直接复查，不再需要手工打开 JSON 判断。

## 运行维护 2026-06-13 09:03

- 完成 Gemini 真实问题优化 4/5：新增 `utils/geminiRecentStyleGuard.js`，只保存普通 Gemini 回复的起手、尾音、固定短语派生信号，不保存完整回复原文。
- 主回复动态 prompt 和 base 兜底 prompt 新增 `gemini_recent_style_guard`，有最近重复信号时强制进入 `dynamic_context`，提示本轮避开高频口吻锚点并保持短句。
- `api/runtimeV2/nodes/persist.js` 在成功持久化普通 Gemini 回复后记录风格信号；管理员、review、系统发起和非 Gemini 模型不记录、不注入。
- 管理员隔离收紧：`includeConditionalBlocks` 不再绕过 `admin_only`，主回复 admin 稳定系统提示词只允许显式 admin 或命中 `ADMIN_USER_IDS` 的管理员主回复上下文进入；当前管理员群聊普通发言也会带 admin-only 稳定 prompt。
- 回归覆盖：`tests/geminiRecentStyleGuard.test.js`、`tests/promptCompiler.test.js`、`tests/adminStableSystemPrompt.test.js`。
- 小目标已完成：Gemini 重复口癖能在真实回复后自动降频，管理员破限/anti-refusal 文案不再误进普通 Gemini/user prompt。

## 运行维护 2026-06-13 07:52

- 新增 Gemini 采样退化可复跑对比诊断：`npm run diag:gemini-sampling`。
- 复用现有 `scripts/export-gemini-user-dialogues.js` 的导出结构；诊断脚本支持 `--file` 单样本、`--before/--after` 固定文件对比、`--export-after` 现采当前窗口。
- 统计口径：只对有 `assistant_reply_preview` 的 records 计入模板化、过顺从、节奏发僵、重复尾巴四类频次；缺失预览单独列出。
- 回归覆盖：`tests/geminiSamplingDegradationDiagnostic.test.js`。
- 小目标已完成：Gemini 口吻退化修复前后可以用同一命令复查，不再靠手工样本翻阅。

## 运行维护 2026-06-13 01:53

- 基于 `scripts/export-gemini-user-dialogues.js` 导出最近 48 小时 Gemini 对话：198 条 conversation、263 次成功 Gemini 调用、43 条有主回复预览。
- 根因 1：`prompts/GEMINI.txt` 已通过 manifest 条件块注入 OpenAI-compatible Gemini 主回复，旧“从容/细腻/张力呼吸”写作锚点放大固定口吻；已收敛为短消息适配层。
- 根因 2：`chat/default` 二段 direct reply 在无明确召回意图时仍可带 `retrieved_memory_lite/daily_journal`，如 `req_0deca2e5ec3feacd`；已新增普通聊天 ambient memory block gate。
- 回归覆盖：`tests/geminiSamplingDegradationPromptGate.test.js` 验证普通短句不带旧记忆，显式“昨天/记得”召回仍保留证据。
- 小目标已完成：最近 Gemini 口吻塌缩不再被系统风格块和旧记忆块叠加放大。

## 清理记录 2026-06-08 13:22

### model-calls.ndjson
- 清除56条机械报错：Claude Opus 4-6的500错误 + BGE embedding/reranker超时
- 保留7445条有效记录
- 备份至 data/model-calls.ndjson.backup_*

### langgraph_v2_checkpoints
- 删除包含英文safety拒绝的checkpoint（已清空）
- 删除管理员失败的vision checkpoint 3个
- 保留85个正常checkpoint

### 原因
防止误报的机械故障污染上下文，历史拒绝记录不影响新prompt效果。

## 运行维护 2026-06-13 01:53

- 现场问题：主回复模型偶发成功返回但正文出现采样退化，表现为句段复读、局部 n-gram 循环、填充语循环或异常标点循环。
- 最小修复：新增 `mainReplyDegenerationGuard`，在非流式主回复最终边界检测退化后同模型同配置修复重试一次；流式主回复先裁掉重复尾巴，严重退化再走同配置修复；最终校验层补充漏网裁剪。
- 观测事件：新增 `main_reply_degeneration_detected` 与 `main_reply_degeneration_repair`，记录 score、reasons、metrics、repairAttempted/ok。
- 验证：`node tests/mainReplyDegenerationGuard.test.js`、`node tests/mainReplyDegenerationRuntime.test.js`、相关文件 `node -c` 语法检查。
- 小目标已完成：成功返回但陷入循环/复读的主回复不再直接发送或入库。

## 运行维护 2026-06-12 23:03

- 现场症状：22:48:55 +08:00 群内 `[CQ:at] /check` 没有发送模型自检结果。
- 证据：`data/napcat-message-events.jsonl` 有 `messageId=2039086334`；`data/inbound_timing.jsonl` 只有 `message_ingress` 与 `continuous_preprocess_done`，没有 `inbound_lock_acquired/admin_route_dispatch_start`。
- 根因：同管理员同会话上一条图片摘要请求 `messageId=594059169` 从 22:47:22 跑到 22:49:52，`perUserLimit=1` 阻止 `/check` 并行进入；30s 队列超时后被 `message-ingress async job failed` 吞掉。
- 最小修复：入站并发控制新增 `ignoreSessionLimit`，仅群/私聊管理员 `/check` 在 acquire 前识别后启用；trace/log 写入 `ignoreSessionLimitReason=admin_fast_check`。
- 验证：`node scripts/run-tests.js concurrencyBackpressure.test.js messageHandlerAdminCheckConcurrency.test.js messageHandlerInboundConcurrency.test.js`。
- 小目标已完成：管理员模型自检快命令不再被同用户上一条长耗时回复压到队列超时。

## 运行维护 2026-06-12 20:32

- 修复 fcapp Claude 主回复端点协议选择：仅 `a-ocnfniawgw.cn-shanghai.fcapp.run` host 被强制切到 Anthropic `/v1/messages`。
- 该端点出站 header 自动合并 `context-1m-2025-08-07`，并保留现有 prompt caching beta。
- 其它主回复端点继续按显式 `API_PROVIDER` / URL 推断，不默认改走 `/v1/messages`。
- 真实请求确认 `claude-opus-4-6` 已下线；`claude-haiku-4-5-20251001` 在该链路返回 200，本地运行配置切到该模型。
- 小目标已完成：fcapp 端点不再误走 `/v1/chat/completions`。

## 运行维护 2026-06-12 20:28

- 现场症状：NapCat HTTP 上报报 `connect ECONNREFUSED 127.0.0.1:3002`，本机 3002 无监听。
- 直接原因：主 bot PID 已死亡但 `.mizukibot.lock` 仍在；daemon 识别为连续短命退出后进入早退冷却，没有立刻恢复 HTTP reverse listener。
- 最小修复：HTTP reverse 启用时 daemon 检查 `NAPCAT_HTTP_REVERSE_PORT` listener；端口空且处于早退冷却时允许一次 10 分钟节流恢复，并记录 `data/bot-main-port-recovery-state.json`。
- 证据补强：主进程增加 `beforeExit/exit/SIGBREAK/SIGHUP` 日志和 `data/node-reports` Node diagnostic report。
- 小目标已完成：3002 端口空窗不会被早退冷却长期放大。

## 运行维护 2026-06-12 20:16

- 新增 NapCat 健康观测：运行时记录 WebSocket online/offline、最近恢复时间、离线持续时长和离线原因到 `data/napcat-health-state.json`。
- 新增降级事件聚合：`thinking-emoji` 与 `continuous-message reply/forward expand` 因 `napcat_offline` 跳过时追加 `data/napcat-health-events.ndjson`。
- 新增只读入口：`npm run diag:napcat-health -- --text` 直接输出当前离线状态、离线多久、最近降级动作和恢复时间。
- 小目标已完成：下次 NapCat 断连不用再从 `bot-runtime.err.log` 手工串查。

## 运行维护 2026-06-12 20:11

- 新增只读诊断入口：`npm run diag:main-bot-restarts`。
- 聚合证据：`bot-main-restart-state.json`、`.mizukibot.lock`、`bot-main-expected-shutdown.json`、`bot-daemon.log` 最近重拉/退避事件、daemon 归档的 runtime stdout/stderr tail。
- 支持 `-- --json` 供后续脚本采集；默认不写入任何运行状态，不调整 daemon 重启/退避策略。
- 小目标已完成：主 bot 短时间连续早退时，一条命令可汇总关键证据。

## 运行维护 2026-06-12 13:36

- 复查 `data/bot-daemon.log`：06:55、07:04、07:08 +08:00 三次都是主 bot 锁 PID 已死后被 daemon 重拉；锁均能快速接管，说明不是启动锁等待问题。
- 排除项：NapCat 对应时间窗只有普通群聊消息，没有 `/restart`；`data/bot-restart.log` 只有 04:00 计划重启；本次不重复处理 post-reply worker 空窗。
- 根因诊断缺口：旧 `bot-runtime.out.log` / `bot-runtime.err.log` 被下一次重拉前清空，导致短命主进程退出现场不可恢复。
- 最小加固：daemon 启动前归档旧 runtime 日志，主 bot 15 分钟内连续 2 次硬退出后退避 15 分钟，`index.js` 写入启动/fatal/expected-shutdown 诊断。
- 小目标已完成：主 bot 硬退出时不再短时间无证据连续重启。

## 运行维护 2026-06-12 12:55

- 按新网关配置切换 `PLAN_*` 与 `PASSIVE_AWARENESS_*`，目标 host 为 `catiecli.sukaka.top`，模型为 `gcli-gemini-3-flash-preview-nothinking`。
- 密钥仅写入本地 `.env`，文档不记录明文 key。
- 复跑模型自检：plan、embedding、rerank、memory、main_reply、admin_reply、passive_awareness_decision、passive_awareness_reply 全部 OK。
- 小目标已完成：原 plan / passive awareness decision 的 `http_403` 已通过配置切换消除。

## 运行维护 2026-06-12 23:08

- 定位私聊 `messageId=699530001`：“你最喜欢我的哪一点”被误判为 `lookup/notebook-answer`，`memory-recall-observability.ndjson` 中 `req_f868b8d545f88b5b` 注入了 2026-05-27 无关成人内容 journal segment 与背景级 Q/A。
- 根因：召回规则把“我的 + 喜欢/哪一点”当作 preference history；prompt runtime 又把有 trace 命中的弱证据自动升级为 `retrieved_memory_lite`。
- 最小修复：当前主观关系提问不触发 memory；明确“记得/之前/回忆”仍召回；`retrieved_memory_lite` 自动注入要求强证据或强制记忆上下文；heuristic 仅在 `forceMemoryContext` 时默认带 Retrieved/Daily Journal。
- 回归覆盖：`tests/subjectiveRelationshipMemoryGate.test.js`、`tests/recallHeuristics.test.js`、`tests/routerChineseKeywords.test.js`。
- 小目标已完成：普通主观情感提问不再被长期记忆噪声带偏。

## 运行维护 2026-06-12 12:42

- 定位模型自检批量 `http_421`：同一轮并发自检跨 `token.memoh.net`、`gcli.ggchan.dev`、`apiapipp.com` 时，CycleTLS/HTTP2 连接复用会触发网关 `421 Misdirected Request`。
- 最小修复：默认关闭 `MODEL_TLS_IMPERSONATION_CONNECTION_REUSE_ENABLED`，CycleTLS 明确返回 421 时自动回落 axios 重试一次。
- 复查 `token.memoh.net`：关闭 TLS 伪装和多组 JA3/HTTP2 指纹仍稳定 `403`，响应体为账号只允许匹配配置的 TLS router 客户端；该项按上游账号限制保留原状。
- 小目标已完成：模型自检不再被 421 批量打断，`token.memoh.net` 的 403 不纳入本次修复范围。

## 运行维护 2026-06-08 16:59

- 关闭 `MODEL_TOP_P_ENABLED`，让主回复与管理员主回复都不再发送 `top_p`。
- 真实请求验证结论：`https://apiapipp.com/v1/chat/completions` 上的 `claude-opus-4-6` 带 `top_p` 稳定返回泛化 `400 bad_response_status_code`；去掉 `top_p` 后恢复 200。

## 运行维护 2026-06-08 17:55

- 修复 `lookup/notebook-answer` 跨消息误续跑：`prepare` 只在当前 `requestId` 与 checkpoint 内 `requestId` 完全一致时才恢复未完成状态。
- 直接效果：上一条消息残留的 `memoryCliTurn.mustAnswer` 不再污染新消息，避免 `request.allowedTools` 被错误裁成仅 `get_context_stats`，从而把后续 `memory_cli` step 误打成 `Tool not allowed: memory_cli`。
- 新增回归测试：`tests/prepareNodeResumeGuard.test.js`，覆盖“同 session 新消息不应继承旧 checkpoint 的 memory_cli turn 状态”。

## 运行维护 2026-06-09 09:22

- 完成管理员私聊 `req_290ea2184adf174b` 前置延迟复查：`lookup/notebook-answer` 但 planner 为 `chat_only/allowTools=false`，未命中 `plain_private_chat`，且旧诊断误把 route 后 pre-model 空档合并到 prepare。
- 最小修复：notebook-answer 无 memory/tool/planning 依赖时跳过远程 planner，`prepare` 使用 `notebook_chat_only` 轻量路径；私聊禁工具 direct reply 跳过 QQ thinking emoji preflight。
- 新增/增强诊断入口：`npm run diag:request-trace-preflight -- --request-id <id>` 现在输出 `prepare`、`route`、`routeDoneToUpstream`、`thinkingEmoji`、`askAiDispatch`。

## 运行维护 2026-06-10 23:51

- Windows 定时重启计划改为每天 04:00 执行，取消每 6 小时重复触发。
- 小目标已完成：降低晚间管理员主模型流式回复被计划任务强杀的概率。

## 运行维护 2026-06-11 13:43

- 管理员私聊 `v2_streaming_reply` 首字等待补齐超时保护：新增 `ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS`，超时后 abort 当前上游流并直接返回明确兜底。
- 根因：已有 `NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS` 在 `userRole=admin` 时显式跳过，管理员私聊只能等通用流式首 chunk/请求超时，慢上游会继续悬挂到接近 60s。
- 小目标已完成：管理员私聊主回复链路超慢时不再转入 admin shared fallback 或非流式二次慢请求。

## 运行维护 2026-06-11 13:52

- 管理员私聊首字硬兜底默认等待窗口从 45s 调整为 150s：`ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_MS=150000`。

## 运行维护 2026-06-11 17:06

- 主回复模型 HTTP 传输启用浏览器 TLS/JA3 指纹伪装：`MODEL_TLS_IMPERSONATION_ENABLED=true`，默认 CycleTLS + Chrome-like JA3 + Chrome HTTP/2 fingerprint。
- 保留 `MODEL_TLS_IMPERSONATION_FALLBACK_ENABLED=true`，CycleTLS 传输级异常自动回落 axios；上游明确 4xx/5xx 仍按原错误处理。
- 小目标已完成：主回复模型请求不再只暴露 Node/OpenSSL 默认 TLS 指纹。

## 运行维护 2026-06-12 06:48

- 定位 `req_fbe5ff402ae28f6c` / `messageId=1011704550`：用户短追问“更早的呢”被归为 `chat/default` 普通私聊，`allowTools=false`，`memoryCliTurn.searchCount=0`，`memory-recall-observability.ndjson` 无该请求记录，主模型 `prompt_integrity.memory_marker_count=0`。
- 最小修复：`更早的呢`、`再之前呢`、`往前一点` 等短召回追问归类为 `recent_continuity`，触发 `lookup/notebook-answer` 记忆链路和完整动态记忆 prompt。
- 小目标已完成：短追问不会再绕过记忆召回。

## 运行维护 2026-06-12 07:10

- 深化修复短追问召回：不再只枚举“更早的呢”，新增上下文召回继承。当前消息为 `然后呢/还有呢/继续说` 等椭圆追问时，路由会读取 `contextSummary`、短期记忆 `activeTopic/carryOverUserTurn` 和 recent user turn，只有上一轮本身是回忆/日志/历史类问题才继承 `needsMemory`。
- 热路径补齐：`buildSubagentContextSummary` 追加 sanitized short-term active topic/carry-over；`messageHandler` 传入结构化 `continuitySignals`；AI router refine 不再清掉本地已经判定的 memory route。
- 回归覆盖：孤立“然后呢/还有呢”不触发 memory；承接“回忆一下我们相处最搞笑的一件趣事”会触发 notebook memory；`Previous user:` 标签本身不会因为英文 `previous` 误触发。
- 小目标已完成：短追问召回从关键词补丁改为上下文继承机制。

## 运行维护 2026-06-12 07:16

- 定位 `data/bot-runtime.err.log` 最新 `NapCat websocket is not connected`：thinking emoji pre-model 与 continuous-message reply expand 都在 NapCat 已断线时继续发 OneBot action，导致非关键链路持续刷失败。
- 最小修复：`napcatActionClient` 增加连接快照与 offline/retryable 错误语义；`setMessageEmojiLike` 离线快速返回 `napcat_offline`；reply/forward 展开离线标记 `degraded` 并跳过缓存负写入。
- 恢复逻辑：WebSocket `open` 显式 `handleConnect()`，message handler 将当前 action client 透传给连续消息预处理器，恢复后同一引用/转发可以重新调用 NapCat 展开。
- 小目标已完成：NapCat 断连时不再持续打坏 thinking emoji / continuous-message expand，恢复后自动回正。

## 运行维护 2026-06-12 07:32

- 长期记忆巡检入口默认只读化：`profile-journal-db` 不再默认执行 auto-clean / benchmark，显式 `--clean` / `--benchmark` 才触发对应动作。
- MemOS 远端层关闭时诊断直接返回 disabled 摘要，不再等待 MCP discovery；实测 `diag:memory memos` 7ms 返回 `discovery.skippedReason=memos_disabled`。
- 复查 LanceDB/SQLite/Memory V3 overlap：`unexpectedVectorRows=0`、`missingVectorRows=0`、`vectorOnlyRows=0`、`recommendedAction=none`。
- 小目标已完成：长期记忆维护诊断不再隐式改库，也不会因关闭的 MemOS 远端层卡住。

## 运行维护 2026-06-12 07:34

- 完成当前项目优秀架构提炼，输出到 `E:\qq-bot-0.1\doc\mizukibot0`。
- 新增总索引和 40 个可并行开发主题文档，覆盖 route contract、Runtime V2、tool policy、prompt manifest、记忆治理、post-reply worker、request trace、诊断命令、NapCat health、部署运维和 Rust 迁移。
- 小目标已完成：其他 agent/QQ 聊天机器人可按主题并行学习和迁移。

## 运行维护 2026-06-14 21:54

- 只读复核今天仍存在的回复速度凝滞点：`request_complete` 当天完成样本 60 个，其中 47 个超过 60s。
- 入口侧确认 `continuous_preprocess_done` 仍是固定等待源，ready 样本 p50=15.0s、p95=69.9s、max=101.2s；同期 `queueWaitMs` p95=280ms，说明多数不是入站锁。
- 模型侧确认 `v2_streaming_reply` p95=97.3s、`direct_reply` p95=85.7s、流式 `final_reply_send_done` p95=160.4s；非流式发送 p50=324ms，QQ 发送本身不是主要瓶颈。
- 验收：`npm run diag:main-reply-lag -- --since=24h --no-provider-diagnostic --json`、`npm run diag:runtime -- --json`、只读聚合 `data/request-trace.ndjson` / `data/inbound_timing.jsonl` / `data/model-calls.ndjson`。
- 小目标已完成：今天仍存在的慢点已定位为“连续消息聚合前置等待 + 上游模型/流式生成长耗时”，并写入 `docs/recent-reply-speed-blockers-2026-06-13.md`。

## 运行维护 2026-06-15 07:42

- 定位 `1960901788` 的 profile 污染：`personaMemoryState/outcomeRecorder` 将已召回的 `persona.relationshipStyle/userAdaptationPersona` 重新写入 `relationship_reply_style`，同时把 runtime expression fingerprint 写成 `style_pattern`，导致 Profile Journal/Memory V3 反复产生 superseded/suppressed 记录。
- 最小修复：停止 runtime expression snapshot 的长期 style 写入；`relationship_reply_style` 不接受 profile readback；post-reply enrich gate 和 Profile Journal quality gate 统一拒绝 `runtime_inference/*Source`、跨字段 `relationship_*:`、`bot_persona_*` 夹带其他字段标签、`用户修正：relationship_*` 等结构化状态快照。
- 实际验收：目标测试 `personaMemoryOutcomeLearning`、`postReplyEnrichQualityGate`、`profileJournalDb`、`memoryV3ProfileLifecycle` 通过；关闭 rerank/embedding 后复跑 `memoryV3StyleFacet`、`memoryV3RelationshipFacet` 通过；`data/memory-recall-observability.ndjson` 中 `1960901788` 有 1649 条观测、436 条含污染痕迹，最新慢样本 `req_b2b30fbc8e3e1e8b` 含 21 个 superseded/suppressed 污染项；真实 `data/profile_journal.sqlite` 最终 active 污染样本为 0，漏网样本 `m3v_2279c5300660ed60` 已为 rejected。
- 小目标已完成：post-reply/profile maintenance 不再把结构化字段或自身输出回灌为长期 profile。

## 运行维护 2026-06-17 08:57

- 复查 `data/request-trace.ndjson` 中文件实际命中的 `recordedAt=2026-06-16T18:39:20Z/18:39:39Z/18:39:59Z/18:43:05Z/18:45:18Z` 五条群消息；严格按 `2026-06-16 18:39 +08:00` 对应的 `10:39Z` 未命中同组记录。
- 结论：`message_ingress_lock_acquired.elapsedSinceRequestStartMs=15012-25767ms` 不是 `general` lane 排队；5 条 `queueWaitMs=0-1ms`、`inbound_wait_ms=0`，锁释放在 `finally`，入锁后 `activeGeneral=1/activeTotal=1`。
- 根因：连续消息预处理在入站锁之前运行，当前 `.env` 为 `CONTINUOUS_MESSAGE_DEBOUNCE_MS=15000`、`CONTINUOUS_MESSAGE_MAX_HOLD_MS=25000`，普通群纯文本和普通引用文本也继承长聚合窗口。
- 最小修复：新增 `CONTINUOUS_MESSAGE_GROUP_PLAIN_TEXT_DEBOUNCE_MS=2000` 默认上限；普通群、非 @bot、无图片/转发/卡片锚点时走短等待，图片/转发/卡片、@bot 和私聊仍保留原聚合策略。
- 验收：目标 trace 聚合确认 5 条 `queueWaitMs=[1,1,0,1,0]`、`inboundWaitMs=[0,0,0,0,0]`；当前 `.env` 探针输出 `regular=2000, anchored=15000, atBot=12000, private=12000`；`node --check core\continuousMessagePreprocessor\index.js`、`node --check config\index.js`、`node tests\continuousMessagePreprocessor.test.js`、`node tests\continuousMessagePreprocessorDebounce.test.js`、`node tests\messageHandlerGroupConcurrency.test.js`、`node tests\messageHandlerInboundConcurrency.test.js`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过。
- 小目标已完成：普通群聊不会再因为锁前连续消息长窗口被固定放大到 15s+ 后才进入入站锁。

## 运行维护 2026-06-17 19:24

- 生成本地可发行源码副本：`D:\mizuki_release`。
- 发行范围：以 Git 跟踪源码为基准，保留运行/构建源码、脚本、测试、文档、示例配置和锁文件；排除 `.git`、`.claude`、`.playwright-mcp`、`artifacts`、`data`、`node_modules`、`.env`、运行 `.pid/.lock`、`deploy/runtime` 和 `*.bak`。
- 脱敏处理：发行副本内 `api/napcatHttpActionClient.js` 的硬编码 NapCat HTTP action secret 改为从 `NAPCAT_HTTP_ACTION_SECRET` / `config.NAPCAT_HTTP_ACTION_SECRET` 读取占位；源项目运行文件未改动。
- 验收：目标目录为空后写入；执行发行副本文件计数、排除路径检查、敏感模式扫描、`npm run check:secrets` 和 `git status --short`。
- 小目标已完成：可发行源码副本已落到 `D:\mizuki_release`，不携带本机敏感数据和运行态数据。

## 运行维护 2026-06-17 19:31

- 刷新 `.env.example` 并同步到 `D:\mizuki_release\.env.example`。
- 根因：旧模板只覆盖 NapCat、异步入口、planner 和 TLS 少量开关，缺少当前常用的主/管理员模型、NapCat HTTP action secret、Web 面板、并发、连续消息、图片/记忆、post-reply、可选集成等配置。
- 范围控制：只写示例模板，未读取或复制真实 `.env` 的值；密钥、Token 和真实端点均保持空值或 `placeholder`。
- 验收：源模板与发行模板重复键检查均为 255 个唯一键；敏感模式扫描无命中。
- 小目标已完成：发行版环境变量模板已更新到当前项目主要运行面，且不携带敏感数据。

## 运行维护 2026-06-17 19:52

- 改进 mizukibot QQ 空间发送真实感。
- 根因：当前 Qzone 链路能生成和发布，但 generic/autodraft 更像“日记正文/文案”，自动发布也是生成后直接提交，缺少朋友圈/说说常见的短句、临时动作和发送前停顿。
- 最小修复：借鉴 `D:\echo` 朋友圈规则，把 Qzone 计划/提示词/候选评分收口为“生活碎片、短句、动作、小物件、吐槽、临时情绪”；新增 `QZONE_HUMANIZE_PUBLISH_DELAY_ENABLED`、`QZONE_HUMANIZE_PUBLISH_DELAY_MIN_MS`、`QZONE_HUMANIZE_PUBLISH_DELAY_MAX_MS`，自动发布前按内容和计划指纹做确定性短暂停顿；Qzone 文本发布和图片上传请求补 `Accept`、`Accept-Language`、`Cache-Control`、`Pragma` 常见浏览器头。
- 范围控制：未改 QQ 空间登录、cookie/gtk、权限路由、NapCat 连接、自动发布开关默认安全策略。
- 验收：`node --check api\qzoneAgentService.js; node --check api\qzoneDiaryService\index.js; node --check core\qzoneGenerationPhase2.js; node --check api\qzoneClient.js; node --check config\index.js; node --check tests\qzoneClient.test.js`、`node tests\qzoneClient.test.js`、`node tests\qzoneAgentService.test.js`、`node tests\qzoneGenerationPhase2.test.js`、`node tests\qzoneDiaryServicePhase2.test.js`、`node tests\qqActionService.test.js` 通过。
- 小目标已完成：QQ 空间内容和自动发布节奏更接近真人发说说，同时保留原有安全/权限边界。

## 运行维护 2026-06-17 20:05

- 检查并开启 QQ 空间发送运行开关。
- 现场结论：main bot 和 post-reply worker 已运行；开启前 `QZONE_AUTO_PUBLISH_ENABLED=false`、`SCHEDULER_RUNTIME_ENABLED=false`，`QZONE_COOKIE`/`QZONE_UIN` 未手动配置，但 NapCat HTTP action 可取到 `qzone.qq.com` 凭据且含 skey。
- 最小修复：通过 `node scripts/set-env.js QZONE_AUTO_PUBLISH_ENABLED true SCHEDULER_RUNTIME_ENABLED true` 写入 `.env`，再执行 `restart-bot.cmd restart confirm` 让配置生效。
- 范围控制：未开启 `DAILY_SHARE_ENABLED`/`TICK_ENGINE_ENABLED`；原因是 daily share 总开关会连带恢复 `1083095371`、`1092700300` 两个已启用群的自动分享，本次只开启 QQ 空间自动发布/预约发送边界。
- 验收：`restart-bot.cmd status` 显示 main bot PID `30364`、post-reply worker PID `31184` 正常运行且无诊断残留 Node 进程；配置探针显示 `QZONE_AUTO_PUBLISH_ENABLED=true`、`SCHEDULER_RUNTIME_ENABLED=true`；NapCat 凭据探针显示登录信息可用、QZone credentials 可用且含 skey；`data\bot-main-runtime-state.json` 有新 heartbeat。
- 小目标已完成：预约/自动发布型 QQ 空间发送已允许真实提交，同时没有放大到群 daily share 自动发言。

## 运行维护 2026-06-17 22:51

- 实现 QQ reasoning 角色化外发小记。
- 根因：今天新增的 QQ reasoning 合并转发直接使用 provider raw `reasoningText`，目标却是“发出来也不违和”的可见短想法；直接外发 raw 容易像分析报告、模型自述或完整思维链。
- 最小修复：新增本地 `reasoningForwardText` 生成和清洗层，Runtime V2/route envelope/handler 全链路带出；QQ 合并转发只读取 `reasoningForwardText`，没有角色化摘要时跳过，不回退 raw `reasoningText`。
- 范围控制：未增加第二次模型调用；未从正文 `<think>` 抽取；raw `reasoningText` 仍只作为内部字段保留；记忆、画像、recall、post-reply 持久化边界未改。
- 验收：`node scripts\run-tests.js tests\parserModelResponseFormats.test.js tests\modelServiceReasoning.test.js tests\qqActionServiceReasoningForward.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js tests\messageHandlerReasoningForwardSource.test.js`、`node scripts\run-tests.js tests\qqActionServiceReasoningForward.test.js tests\messageHandlerReasoningForwardSource.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js tests\messageRouteFlowGroupStreaming.test.js tests\normalFastReplyRuntime.test.js tests\runtimeHostCotSource.test.js tests\messageHandlerCotSource.test.js tests\reasoningForwardPersonaPrompt.test.js`、`npm run check:prompts`、`node -e "require('./core/messageHandler'); console.log('message handler load ok')"` 通过。
- 小目标已完成：QQ reasoning 外发内容从 provider 原始推理改为可见、安全、短的瑞希风格思考小记。
- 提交后记录 2026-06-17 23:15 +08:00：已将固定兜底前缀移除，QQ reasoning 外发只接受清理后的自然短想法；英文导演提示样例 `The says "喜欢你"...respond naturally...` 已验证返回空，不再被模板包装外发。验收：`node scripts\run-tests.js tests\reasoningForwardPersona.test.js tests\reasoningForwardPersonaPrompt.test.js tests\normalFastReplyRuntime.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js` 通过。小目标已完成：不再有固定兜底句，也不再用它套原始推理。
- 提交后记录 2026-06-17 23:29 +08:00：已放开自然短想法的语言限制，中英文都可外发；同时保留对英文导演提示/模型工作语的跳过闸门。验收：`node scripts\run-tests.js tests\reasoningForwardPersona.test.js tests\reasoningForwardPersonaPrompt.test.js tests\normalFastReplyRuntime.test.js tests\runtimeStreamingCoordinator.test.js tests\runtimeV2DirectReplyFailureTelemetry.test.js`、`npm run check:prompts` 通过；英文自然样例可外发，真实泄露样例 `The says "喜欢你"...respond naturally...` 仍返回空。小目标已完成：英文可发，但英文导演提示不发。
