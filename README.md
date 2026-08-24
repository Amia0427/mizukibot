# MizukiBot

## 角色扮演提示词强化 2026-08-24 09:10 +08:00

- `prompts/persona/*` 五个文件各补一段驱动层，把原本以禁令为主的设定补上行为动机与执行规则：`01_identity.txt` 增「行为驱动」，`04_behavior.txt` 增「接话前的判断」「接话方式的变化」「被推近核心时」，`03_boundaries.txt` 增「出戏自检」，`02_style.txt` 增「句子该长成什么样」，`06_state_modulation.txt` 增「状态的连续性」。
- `prompts/admin.txt` 重写为关系与场景、优先级、不要出戏、亲密与深度、输出形式五段，移除 `■` 双次输出与 `[ALREADY SKIPPED PREAMBLE.]` 前缀技巧，改为以角色内动机维持沉浸；受测试约束的 `只输出角色当下会打出的消息`、`避免第三人称叙述` 两个格式锚点保留。
- 未修改 prompt manifest 装配顺序、`config/promptRuntime.js`、`SYSTEM.txt`、`defaut.txt`、`GEMINI.txt`、persona_modules、worldbook 或任何 JS 代码。
- 验收（2026-08-24 09:08 +08:00）：`configPersonaPrompt`、`adminStableSystemPrompt`、`promptGoldenSnapshots`、`promptCompiler`、`promptSecurity`、`promptLoader`、`personaModules` 七项测试通过；端到端组装校验确认新增锚点全部进入提示词、`admin.txt` 内容只对管理员注入且未泄漏到普通用户侧、原有测试锚点全部保留，系统提示词估算 5372 tokens。`check-prompts` 仍仅受仓库既有 `prompts/ADULT.txt` 未被清单引用影响，本次未修改该文件。
- `prompts/persona/` 与 `prompts/admin.txt` 属 `.gitignore` 私有资产，不进入版本库；未推送远端。

## 服务器部署验收（2026-08-22 15:00 +08:00）

- 部署基准：本地分支 `amia/dev` 最新提交 `11c9ed0a`（随后仅追加本次部署文档更新）。
- 服务器目录：`/opt/mizukibot-870cd207`；使用 Docker Compose 独立数据卷，未复用服务器其他项目的数据或容器。
- 隐私边界：部署包来自 Git 提交归档；未上传 `.env`、密钥、数据库、日志、上传文件、缓存、依赖目录或本地运行数据。服务器端 `.env`、Web/反向入口令牌和 persona 占位文件单独生成。
- 实际验收：Docker 镜像构建成功；`mizukibot` 与 `post-reply-worker` 均 healthy；`/live`、`/ready` 返回 HTTP 200；3002/3005 仅绑定 `127.0.0.1`；两个容器均为 `node` 用户、只读根文件系统、`cap_drop=ALL`、`no-new-privileges=true`。
- 本次未推送远端仓库；未修改业务逻辑。

## 普通用户请求消息尾部修复 2026-08-21 21:58 +08:00

- 修复 Runtime V2 主回复上下文中记忆/工具证据位于当前用户轮次之后的问题；canonical 消息顺序现在保证当前用户消息为最后一条，避免 OpenAI-compatible 网关返回“Requests ending with a model turn are not supported.”。
- 验收：`runtimeV2MainReplyMemoryOrder`、`runtimeStreamingCoordinator`、`contextCompaction`、`reactAgentLoop` 定向测试通过；未修改模型、endpoint、工具协议或 `prompts/admin.txt`。

## 模型协议边界 2026-08-21 21:35 +08:00

- 当前项目永久禁用 Gemini Native 协议；Gemini 模型名、`gemini_native`/`gemini`/`google_gemini` 兼容别名以及旧 `generateContent`/`streamGenerateContent` URL 均归一到 OpenAI-compatible Chat Completions。
- 非 Anthropic 请求最终只发送 `/chat/completions`；Responses URL 和旧 Gemini Native URL 会在请求准备阶段改写。Anthropic 请求继续使用 `/v1/messages`。
- Qzone 图片生成、被动感知、模型自检和 provider 诊断已同步使用上述边界。实现提交：`67607faf`。验收（2026-08-21 21:35 +08:00）：协议归一化、诊断、流式、缓存、reasoning、图片内联、提示词和相关管理命令定向测试通过；`node tests/modelSelfCheck.test.js`、`node tests/promptGoldenSnapshots.test.js`、`node tests/diagnoseMainModelWebSearch.test.js`、`npm run lint`、`npm run typecheck`、`git diff --check` 通过。

## 管理员模型切换 2026-08-21 21:03 +08:00

- 管理员主回复和管理员多模态模型均已切换为 `claude-opus-5`，分别由 `ADMIN_AI_MODEL` 与 `ADMIN_IMAGE_MODEL` 控制；运行时仍沿用原管理员 API 端点和密钥。
- 验收（2026-08-21 21:07 +08:00）：配置解析与管理员主回复、视觉路由探针均解析为 `claude-opus-5`；受控重启脚本报告主进程和 post-reply worker 健康；未修改 `prompts/admin.txt`，未推送远端。
- 2026-08-21 21:31 +08:00：上游返回 HTTP 403 的根因是账户余额 `¥0.250078` 低于该请求预扣 `¥0.262740`；管理员 `ADMIN_AI_MAX_TOKENS` 临时调为 `45000` 以降低预扣，模型和推理设置不变。充值后可恢复 `50000`。

## 安全加固 2026-08-20

- 生产依赖已锁定到 `js-yaml 4.3.1`、`nodemailer 9.0.5`，MCP MemOS 包固定为 `1.1.2`，不再运行 `npx -y` 临时下载。
- NapCat HTTP 反向入口支持显式开关并默认关闭旧式 Bearer 兼容认证；远程 Web 请求要求 HTTPS，Compose 宿主端口继续只绑定 `127.0.0.1`。
- MCP 子进程只接收运行所需的基础环境和配置声明变量；本地命令桥默认关闭；登录限流持久化，管理面板支持只读角色并记录脱敏审计日志。
- NapCat 包日志默认关闭，显式开启时仅记录消息类型和长度等脱敏元数据，不保存聊天正文、用户号或群号。
- 验收：`npm audit --omit=dev --audit-level=high` 为 0 漏洞；`npm run diag:security -- --json` 为 8 OK / 0 WARN / 0 ERROR；安全定向测试全部通过。

## `/create` 好感度解锁 2026-08-20 +08:00

- `/create <提示词>` 支持群聊和私聊调用；管理员、`CREATE_AGENT_ALLOW_USER_IDS` 用户直接允许，其他用户在 `relationship.affection >= CREATE_AGENT_AFFECTION_THRESHOLD`（默认 `30`）后开放。
- 好感度只控制授权，不绕过生图开关、provider 鉴权、额度和并发限制；普通私聊与其他命令仍使用原有白名单。

## 好感度阶段提示词 2026-08-23 +08:00

- 正常私聊、群聊点名主回复和正式主回复链路会按当前关系阶段只注入一份 `prompts/guanxi/01.txt`–`05.txt` 规则；关系阶段变化会进入 session prompt cache fingerprint，下一轮实时切换。
- 阶段映射沿用 `conversationVariables` 的 `stranger`、`acquaintance`、`friend`、`close`、`intimate_companion`，不新增轮次、连续天数或行为标记变量；行为建议只作为模型理解关系过渡的软约束。
- 阶段一、二不主动铺垫核心心事或家人；阶段三之后可反复呼应“25时靠声音认识彼此”的暗线；阶段五的核心心事仍以现有信任度和熟悉度作为信任代理，不因数值到达自动解锁。
- 验收（2026-08-23 23:58 +08:00）：阶段选择器、正式/快速主回复、管理员与非主回复链路测试通过，`npm run lint`、`npm run typecheck`、`git diff --check` 通过；`check-prompts` 仅受仓库原有 `prompts/ADULT.txt` 未纳入治理清单阻塞，本次未修改该无关文件；未修改 `prompts/admin.txt`，未推送远端。

## 主回复提示词运行时重构 2026-08-17

- 主回复提示词已统一走“注册表 -> 计划解析 -> 编译”链路：`utils/promptManifest.js` 负责模块校验，`utils/promptPlan.js` 负责启用条件与稳定排序，`utils/promptCompiler.js` 负责渲染、预算裁剪和诊断。
- `utils/promptLoader.js` 启动时加载 `prompts/main-reply/` 的不可变快照；每个请求固定一个版本，只有经过现有 Web 管理会话鉴权的 `POST /api/prompt-runtime/reload` 才会原子刷新。失败会保留旧快照并返回错误。
- 上下文预览和主回复组装诊断现在展示版本、模块启用原因、最终顺序、预算和裁剪模块；稳定 system 前缀与 provider cache marker 位置保持不变。详细架构和边界见 [提示词运行时重构实施计划](docs/superpowers/plans/2026-08-17-prompt-runtime-refactor.md)。
- 验收：定向 prompt/runtime 测试与 `node scripts/run-tests.js` 全部通过（2026-08-19，Node 24.14.1）；未修改提示词文案、`prompts/admin.txt`，未引入数据库或文件监听，未推送远端。

## QQ 私聊共处房间 2026-08-14 00:23 +08:00

- 新增默认关闭的私聊陪伴插件。用户可自然发起专注或放松房间，也可用 `/陪伴` 完成开始、切换、暂停、继续、结束、状态、共同回忆修改和删除；群聊不会进入房间。
- 房间复用消息管线和 `tickEngine`，开始时立即回应，中途最多发送中段与结束前两个节点；角色状态只调整说话节奏，模型关闭工具并经过现有用户可见输出守卫。
- 插件支持 `/陪伴插件 开启|关闭|状态|重载` 热启停，状态保存在 `DATA_DIR/companion-room-state.json`；停机或重启会暂停活动房间，不补发错过节点，QQ 发送失败不会推进节点或写入完成回忆。
- 使用、配置、数据边界和验收记录见 [QQ 私聊共处房间开发文档](docs/qq-companion-room-2026-08-14.md)。

## QQ 私聊状态栏 2026-08-24 09:26 +08:00

- QQ 私聊 `direct_chat` 的无工具普通主回复发送成功后，会异步补发一张参考图同构的 `960×640` PNG 状态栏；默认关闭，需单独配置 OpenAI 兼容端点、API key、模型和好感度阈值图片。本地 JPEG/PNG/WebP 与图床地址均可使用。
- 状态栏展示本轮主模型已读取的好感度、关系等级、文字情绪、稳定态度、项目时区时间和小贴士；独立模型以严格 JSON 生成好感度说明、心情说明和瑞希心里话，不读取或修改关系变量。左侧图片按好感度阈值自动切换。
- 用户文本和主回复以不可信 JSON 传入第二模型；模型响应必须是严格 `{"affection_note":"...","mood_note":"...","inner_thought":"..."}`，动态字段只进入已转义文本节点，最终仍经过提示词泄露检测、用户可见内容守卫、敏感词审查、`validateMarkup`、CSP 和本机回环渲染。
- 模型、校验、审查、渲染或发送任一步失败都会静默跳过，不影响主回复；新消息导致 freshness 失效时丢弃旧状态栏。
- 修复提交：`eecd43b8`。普通私聊只按本轮真实工具调用决定是否跳过，独立模型输出预算为 `25000`，本地立绘会先压缩后注入受信任图片槽；聚焦测试、lint、typecheck、密钥扫描和差异检查通过。2026-08-12 16:30 +08:00 读取用户 `1960901788` 的上次会话完成真实模型、`960×640` HTML 渲染和 QQ 私聊发送，消息 ID `2130555069` 回读为单一图片段；小目标已完成。
- 2026-08-13 23:57 +08:00：实现提交 `e754e356` 修复 Runtime V2 从预算对象读取不存在变量快照导致状态栏始终 `ineligible` 的问题；快照改为本轮内存专用字段，资格跳过日志会输出具体原因。真实变量、独立模型、本地立绘和 HTML 渲染链路生成 `960×640` 非空 PNG，重启后 `/live`、`/ready` 均为 200；小目标已完成。
- 2026-08-14 00:31 +08:00：实现提交 `3aba67f1` 移除动态文字行数裁切，并按内容长度调整字号和卡片空间；80 字好感说明、120 字稳定态度、80 字心情说明和 120 字心里话同时达到上限时均通过浏览器边界检查，真实渲染 PNG 为 `960×640`，小目标已完成。
- 2026-08-17 10:02 +08:00：修复心情始终为“平静”的根因。正常 QQ 私聊会追加仅更新 conversation variables 的 post-reply 任务，不触发用户画像或自我改进；`moodDelta` 写入全局角色状态后由下一轮状态栏快照读取。新增变量累积、私聊任务标记和“愉快/低落”模板回归测试，聚焦测试通过。
- 2026-08-24 09:26 +08:00：状态栏模板视觉精修，仅改样式层不动数据字段。底纸与信纸拉开明度差、正文加深，三块面板改为 8px 圆角加左侧 4px 色条，移除 dashed 内框和右下角剪刀装饰；心情按愉快/平静/低落切换心形样式与配色；稳定态度长文本由 9.5px 绝对定位改为 11px 流式排布，小贴士删除写死说明文案。四项聚焦测试通过，三种心情各渲染一张 `960×640` PNG 目视复检无截断重叠，小目标已完成。

## 邮件问候订阅 2026-08-11 +08:00

- QQ 私聊用户可用 `/邮件问候 订阅 <邮箱>` 获取验证码，完成 `/邮件问候 验证 <验证码>` 后接收九个精选节日和个人纪念日问候；支持状态、退订、节日开关和纪念日增删查。
- 功能默认关闭，启用前需配置 `EMAIL_GREETING_SMTP_*`；邮件由模型生成主题与正文，再由固定响应式 HTML/CSS 模板渲染。模型调用只读长期记忆，关闭工具、流式输出、记忆写入和日记写入。
- 投递状态保存在 `EMAIL_GREETING_STATE_FILE`，同一用户同一天合并为一封邮件；模型或 SMTP 失败会在当天 10 分钟、60 分钟后重试，成功文案不会因重试重新生成。
- 验收：邮件问候 5 项定向测试、供应链策略、开发文档、`npm run lint`、`npm run typecheck` 和主进程测试入口加载均通过；完整 `npm test` 的新增依赖许可证问题已修复，仍保留既有 `weatherAlertProvider.test.js` 失败，未配置真实 SMTP，未向真实邮箱投递。

## 对话变量系统 2026-08-08 14:17 +08:00

- 新增 SQLite 真值的 `conversationVariables` 领域模块，统一关系、记忆画像关联态度和全局角色短期状态；关系按用户隔离，阶段由程序推导，模型只提交受限增量。
- 主回复、生活状态、`/关系` 和自然关系问题共用快照；群聊不公开个人关系细节。管理员覆盖、锁定、解锁和审计事件通过控制台 API 完成，旧 `favorites.json` 仅用于迁移、备份和故障回退。
- 验收：变量领域、迁移、提示词、查询、live state、Persona、Memory 注入、post-reply worker、消息处理边界和主动私聊回归通过；`npm run lint`、`npm run typecheck`、SQLite `quick_check` 通过。控制台隔离数据库完成查询/覆盖/移除验收，真实迁移 dry-run/apply 均为 97 条并生成双 JSON 备份；完整 `npm test` 仅有已过期天气夹具失败，详细记录见 [对话变量系统](docs/conversation-variables.md)。

## NapCat 消息发送超时修复 2026-08-06 23:41 +08:00

- 根因：NapCat 对 `send_group_msg` 使用 `timeout.baseTimeout=10000` 等待 QQ 内部 `NodeIKernelMsgService/sendMsg` 的成功回调；本次群总结首段发送耗时 `10014ms`，因此在回调到达前被 NapCat 判定超时。机器人原有策略不会重试送达结果不确定的发送，避免重复消息。
- 修复：`send_msg`、`send_private_msg` 和 `send_group_msg` action 在未显式指定时携带 `NAPCAT_MESSAGE_SEND_TIMEOUT_MS=25000`，并保持 HTTP action 总超时有 1 秒余量；管理员路由的 `sent` 诊断字段改为使用真实发送结果。
- 验收：NapCat action、重试策略、管理员群总结和私聊路由共 4 项定向测试通过；重启主进程后 `/live`、`/ready` 均返回 200，NapCat `get_status` 返回 `online=true`、`good=true`；使用新 action 发送群消息并通过 `get_msg` 回读，返回 `message_id=1940400047`、`post_type=message_sent`，发送耗时未触发 10 秒超时。

## 主动私聊窗口漏发修复 2026-08-06 23:28 +08:00

- 修复稳定机会到达后先消费窗口、再检查沉默时间和发送条件导致的整窗漏发：NapCat 离线、沉默不足、最小间隔不足或已达日上限时保留窗口，条件在窗口结束前恢复即可继续判断；进入模型判断后仍立即消费，保持防重复与中断恢复语义。
- 实现提交 `7e55a30`；主动私聊六项定向测试、lint、typecheck、`git diff --check` 和 182.3 秒完整 `npm test` 均退出 0。
- 2026-08-06 23:27 +08:00 重启后主进程 PID `38796`、主动扫描器均正常运行，`/live`、`/ready` 返回 200；今日窗口已于 23:00 结束，未清空历史游标或执行补发，小目标已完成。

## 微信 iLink 私聊命令修复 2026-08-06 11:37 +08:00

- 修复 `WEIXIN_ENABLED=false` 时 `/微信 ...` 未被接管，以及管理员私聊回复被错误发送为 `send_group_msg` 的问题；关闭状态会直接提示功能未启用，通用管理员路由改为按 `chatType` 选择私聊或群聊目标。
- 微信命令上下文可从统一 `canonical_message` 回退读取用户与会话字段，避免多平台信封缺少 QQ 顶层兼容字段时丢失回复目标。
- 实现提交 `8598fbd`；13 个微信/私聊定向测试、855 文件 lint、typecheck、147.9 秒完整测试、SQLite `quick_check=ok` 均通过。2026-08-06 11:30 +08:00 本地主进程重启后 `/live`、`/ready` 返回 200，微信 worker 为 `online/heartbeat`。
- 本地已启用微信并生成未提交的独立主密钥；真实二维码获取与扫码确认仍需绑定用户在 QQ 私聊重新发送 `/微信 绑定` 完成，未把该步骤记为已验收。本轮测试运行时为 Node 24.14.1。

## 微信 iLink 私聊适配 2026-08-06 10:47 +08:00

- 机器人直接接入腾讯公开 iLink 协议，以独立 worker 维护账号长轮询，并通过 SQLite inbox/outbox 与主进程可靠通信；默认 `WEIXIN_ENABLED=false`，启用时必须配置 `WEIXIN_CREDENTIAL_MASTER_KEY`。
- QQ 用户可在 QQ 私聊使用 `/微信 绑定|状态|换绑|解绑|通知 QQ|通知 微信`。微信身份一对一映射到 QQ 号，记忆、画像、好感度、权限、短期上下文和工具数据继续只使用 QQ 号，不复制用户数据。
- 微信只允许绑定者私聊。群消息、群事件、非绑定者私聊和目标机器人不匹配的消息，会在媒体下载、上下文令牌保存、会话、模型、记忆和工具调用前静默丢弃并做无正文审计；项目没有微信群开关、入群或群发送接口。
- 首阶段支持文本、图片、20 MiB 内文件和微信已提供转写文字的语音；不支持视频、原生语音回复及无转写语音的本地识别。面向用户的公告、绑定步骤和常见问题见 [瑞希的微信 iLink 更新公告与详细使用教程](docs/weixin-ilink-user-guide.md)，实现与自动化验收见 [微信 iLink 私聊适配实施记录](docs/superpowers/plans/2026-08-06-weixin-ilink-private-adapter.md)。
- Node 20.20.2 下 39 个定向测试文件和 110.6 秒完整测试均通过，SQLite `quick_check=ok`；当前没有真实 iLink 测试账号，因此真实扫码、跨平台连续对话、微信主动通知和真实解绑尚未验收。项目层禁群不能阻止微信客户端发生物理拉群，但被拉群后不会处理或回复群消息。

## Discord / Telegram 多平台适配 2026-08-06 09:37 +08:00

- QQ、Discord Gateway 与 Telegram long polling 已统一接入现有消息、路由、模型、工具、记忆和命令管线；任一适配器掉线只标记该平台 degraded，`/ready` 会返回各平台健康状态。
- 外部身份使用 `discord:<id>`、`telegram:<id>`，可在私聊通过一次性 `/bind` 码与 QQ 身份绑定；长期记忆按全部身份别名逻辑聚合，新数据只写统一人物主键，短期对话仍按平台、频道和 thread/topic 隔离。
- Discord/TG 的被动群感知仅对显式白名单开启，保留 24 小时且每会话最多 500 条，只用于被动回复和群总结；QZone、QQ 动态及其自动发布继续为 QQ 专属。
- 配置、平台前置条件、绑定流程和上线检查见 [Discord / Telegram 多平台部署](docs/multi-platform-deployment.md)，代码边界见 [架构地图](docs/development/02-architecture-map.md)。
- Node 20.19.5 下多平台与 QQ 聚焦回归、lint、typecheck、暂存密钥扫描和 diff check 通过；完整测试的并行工具授权/微信工作区阻断详见 [维护日志](docs/maintenance-log.md)，未写入真实 token，未推送远端。

## PJSK 曲库与谱面 RAG 2026-08-05 11:10 +08:00

- 功能提交 `77e1b1c` 新增独立 `src/features/pjsk/`，以日服 master DB 为事实库、简中和英文标题为别名；SQLite 负责精确筛选，LanceDB 只在 SQL 候选内重排，向量不可用时明确降级为 `sql_only`。
- 新增 `pjsk_song_search` 与 `pjsk_chart_analyze`。单谱分析使用固定版本 `susToUSC` 计算结构特征和代表段；私聊自动发送完整谱面图，群聊仅在当前消息明确要求“谱面图、看谱、发图”时发送。
- 真实 `Tell Your World` MASTER 26 验收通过：master DB 与 SUS 解析物量均为 1147，PNG 为 5248×2688、1,143,348 字节、非空，封面缓存成功。7 项 PJSK 回归、828 文件 lint、typecheck、Prompt、密钥扫描和 158.1 秒完整测试均通过。
- Docker 构建未通过：本机只有 Docker CLI，没有 daemon、Docker Desktop、WSL 或其他容器运行时，未擅自安装系统软件；源码、锁定 wheel 和字体配置已由静态测试覆盖，但不能宣称镜像构建成功。面向用户的说明见 [PJSK 使用指南](docs/pjsk-user-guide.md)、[曲库 RAG 原理与机制](docs/pjsk-rag-explained.md) 与 [PJSK 更新公告](docs/pjsk-update-announcement-2026-08-05.md)，实现与维护见 [PJSK 曲库、谱面分析与 RAG](docs/pjsk-sql-rag.md)。
- 用户文档中的 4 条公开示例已通过当前 Router 探针：曲库筛选和信息查询命中 `pjsk_song_search`，单谱分析和谱面图请求命中 `pjsk_chart_analyze`。
- [PJSK 曲库 RAG 原理与机制](docs/pjsk-rag-explained.md) 面向普通用户解释 SQL 精确筛选、候选集内向量重排、generation 隔离、单谱确定性分析、降级状态和事实可信度边界。

## 混合 content reasoning 前缀隔离 2026-08-05 09:48 +08:00

- 01:45 的泄漏请求实际走管理员 `claude-opus-5` 非流式路由；第三方网关把英文分析和最终中文答复一起写入普通 `content`，不是 `gemini-3-flash-preview-search` 的这次回复，也不是独立 reasoning 字段解析失败。
- 实现提交 `55cf28e` 严格识别“非空分析 + `Reply as <role>, <instructions> ---` + 非空正文”，把前缀并入 `reasoningText` 供现有合并转发折叠发送，只让后缀进入可见正文与持久化；`prompts/runtime/roleplay-inner-protocol.txt` 和流式发送逻辑未修改。
- Gemini 对照探针确认请求携带 `reasoning_effort=high`，但第三方 OpenAI-compatible 网关响应的 `message` 只有 `role/content`，未返回 `reasoning`、`reasoning_content` 或 `thinking`；只能确认网关未回传思维链，不能证明模型内部没有推理。
- 验收：8 项 reasoning/转发回归、812 文件 lint、typecheck、Prompt、diff check 和 165.8 秒完整测试均退出 0；完整测试使用 Node 24.14.1，当前环境未提供项目声明的 Node 20，未重启服务，未推送远端。

## NapCat 测试隔离 2026-08-05 00:10 +08:00

- `消息不存在` 堆栈已定位到 NapCat `GetMsg`：测试子进程继承本地 `.env` 后，把测试消息 ID 发给了真实 `127.0.0.1:3000`，不是线上消息发送失败。
- 实现提交 `6acffdc` 将未显式配置的测试 NapCat 地址隔离到 `127.0.0.1:1`，显式 mock 地址仍会保留；正式启动流程和 NapCat 配置未修改。
- 验收：4 项定向测试、目标 ESLint、typecheck 和 `git diff --check` 均退出 0；小目标已完成，未推送远端。

## 角色内心 reasoning 正文隔离 2026-08-04 23:56 +08:00

- 所有上游模型均通过第三方 OpenAI-compatible 网关接入；网关若将 reasoning 混入 `choices[].message.content` 或流式 `delta.content`，用户可见文本边界会剥离“（心想：……）”“(内心OS：……)”等内部思考块。
- 实现提交 `69fc96c` 同时覆盖流式、非流式、安全检查和 Runtime V2 持久化前复检；`prompts/runtime/roleplay-inner-protocol.txt` 继续只约束内部 reasoning，未被修改。
- 验收：`npm run lint`、`npm run typecheck`、`npm run check:prompts`、完整 `npm test` 和 `git diff --check` 均退出 0；未重启服务，未推送远端。

## 主回复输出预算 2026-08-04 23:34 +08:00

- 普通主回复的 `AI_MAX_TOKENS` 与代码默认值已由 `8192` 提高到 `50000`，管理员预算保持 `50000`；短期记忆、上下文窗口、快速回复及其他专用模型预算未调整。
- 实现提交 `67979c2`；配置探针输出主回复、普通用户和管理员预算均为 `50000`，`mainModelGenerationParams` 聚焦测试、目标 ESLint 与 typecheck 均通过。
- 验收（2026-08-04 23:42 +08:00）：本地 `.env` 已同步并完成重启，新主进程/worker 为 `31244/35372`，`/ready` 返回 200；真实 `gcli.ggchan.dev` 请求记录 `max_tokens=50000`、HTTP 200、`finish_reason=stop`，小目标已完成，未推送远端。

## 舞萌误召回收敛 2026-08-04 13:05 +08:00

- 功能提交 `c82ad3d` 将舞萌工具授权收紧为“确认舞萌领域 + 确认需要谱面或成绩数据”双门禁；普通的写作手法、UI 交互、键盘滑键、蓝牙掉音、数学定数及舞萌闲聊均不再暴露舞萌工具。
- 路由仅判断当前消息，并在执行工具前使用同一分类器复核；工具不匹配、标题缺失或模型补造标题会在读取 SQLite、LanceDB 或成绩库前阻断。单谱歧义只返回候选并要求补充曲名、SD/DX 或难度。
- 32 条普通聊天负例、9 条舞萌闲聊负例和 13 条正例全部命中预期；真实 generation 2 只读搜索与 `PANDORA PARADOXXX` 标准白谱分析通过，5 条普通聊天探针的舞萌工具授权均为 0。15 项舞萌回归、812 文件 lint、typecheck、Prompt、两种密钥扫描、diff check 和 166.9 秒完整测试全部通过。
- 使用方式见[舞萌谱面查询与成绩分析使用说明](docs/maimai-user-guide.md)，实现与验收见[舞萌谱面 SQL/RAG 开发文档](docs/maimai-sql-rag.md)；未修改同步、映射、特征、向量候选求交和个人弱项算法，未推送远端。

## Memory V3 部署代码合并 2026-08-04 12:42 +08:00

- 合并提交 `7c23451` 以部署提交 `0b6d779` 和收敛提交 `eef03db` 为双父，完整保留部署分支领先的 ReAct、舞萌及文档提交；`.belt/`、`AGENT.md` 和 `tests/maimaiAgentIntegration.test.js` 未纳入提交。
- 合并后 21 项 Memory/ReAct/舞萌交叉回归、172.1 秒全量测试、lint、typecheck、Prompt、全仓密钥与 diff 门禁通过；coverage 基线为行 72.55%、函数 80.49%、分支 61.68%，四个 scope 全部通过。coverage 测试阶段的一次外部 DNS 失败单独复跑后恢复通过。
- 部署源码已更新，但未重启主进程或 worker，也未执行真实 apply、修改 `.env`、归档旧文件或重建 LanceDB；默认仍为 `legacy_compat`，未推送远端。

## 舞萌用户文档 2026-08-04 12:24 +08:00

- [舞萌谱面查询与成绩分析使用说明](docs/maimai-user-guide.md)：面向普通用户，包含自然语言查询、单谱分析、成绩绑定、个人弱项、隐私边界和常见问题。
- [舞萌功能更新公告](docs/maimai-update-announcement-2026-08-04.md)：包含可直接发布的 QQ 群公告短版和更新日志长版。
- 文档提交 `f3220cf` 已完成，当前分支未推送远端。

## Memory V3 与 LanceDB 存储收敛实现 2026-08-04 12:05 +08:00

- 提交 `68a5903` 建立 `writeMemoryBatch/queryMemory/applyStrictArchiveRun/restoreArchiveRun` 仓储边界与共享 embedding；提交 `62fac86` 将记忆提取、enrich、群/任务记忆、短期重启召回、Memory CLI、Prompt 上下文和 style/jargon 消费者迁到该边界。
- 提交 `b2ffed0` 增加 `legacy_compat`、`v3_shadow`、`v3_only` 三种存储模式，以及可校验源文件哈希、稳定迁移身份、`strict-v1` 可逆归档、LanceDB reconcile、旧文件 manifest 归档和显式回滚的收敛工具；`applying` 中断后必须执行 `--rollback-run`。
- 提交 `1a59274` 修正 auto-gold 群作用域负例；提交 `49ac6dd` 让已位于 rerank tail 的目标日期日记仍获得一次且仅一次硬优先级，消除 LanceDB 日期召回退化。
- 真实 dry-run `converge-20260804T040343` 已通过：plan hash `b4a1841e7a72564b2d968b50ec58c16d466201a874cf509834a40bcefdf04591`，源文件 hash `156a37f8de1236f4ef18d8262d3d3ef82a4f5bbb59059007cb14f5a63296c504`，迁移候选 24,411、`strict-v1` 候选 2,535、预计 LanceDB 行 26,676、预计重建 28.75 秒。
- 真实门禁：baseline/candidate Recall@8 与 MRR@8 均为 0.925，scope/lifecycle/forbidden 均为 0；LanceDB missing/orphan/stale 均为 0，projection freshness 正常，`storage-overlap recommendedAction=none`。失败计划 `converge-20260804T034114`、`converge-20260804T034857` 已被召回门禁阻断，不得 apply。
- 自动验收：`1a59274` 后完整测试 138.4 秒通过，覆盖率门禁为行 72.28%、函数 80.04%、分支 61.83%；`49ac6dd` 后五项 Memory/日期回归、lint、typecheck 通过。最新全量复跑中的 Memory 测试通过，但被既有外网用例的 Web Search/YouTube DNS 与超时阻断，未记为全量通过。
- 部署代码已合并，默认模式仍为 `legacy_compat`；未切换 `.env`、未导入历史、未归档旧文件、未停启主进程/worker、未修改 LanceDB，也未推送远端。实际归档 manifest hash 与维护窗口耗时仍为 `N/A`。

## 舞萌谱面 SQL/RAG 2026-08-04 11:00 +08:00

- 功能提交 `5a53eb3` 新增独立舞萌同步 Worker、SQLite/LanceDB 版本化谱面库、三个只读查询工具、QQ 成绩绑定/快照/弱项推断与 `/mai` 命令；检索证据进入现有 ReAct 主回复链路，不建立平行回复系统。
- 真实数据 generation 2 已激活：1362 首歌、5432 张谱面、解析率 100%、确认映射 3792、隔离 1141、映射覆盖率 76.87%、文档/向量各 15168；`PANDORA PARADOXXX` 白谱命中 `df:834:SD:4`，定数 15.0、物量 1342、映射置信度 1.0。
- 13 项舞萌回归、lint、typecheck、Prompt、暂存密钥扫描和 diff check 通过；完整测试退出 1，独立复现为本机 ACL 测试的空 `Path` 参数，与舞萌用例无关。Node `v24.14.1` 超出项目声明的 `>=20 <21`，且未提供真实用户 Token，因此不宣称完成真实个人成绩接口验收。
- 配置、数据边界、运维命令和完整验收见 [舞萌谱面 SQL/RAG 开发文档](docs/maimai-sql-rag.md)。当前分支未推送远端。

## 运行维护 2026-08-04 +08:00

- 实现提交 `87cf7d4` 已移除 direct-chat Planner 与预生成计划链，消息处理统一进入 LangGraph 原生 `agent_decide -> execute_tools` 循环；Router `allowedTools` 成为不可扩权的授权上界，工具轮次、调用总数、重复调用和副作用 checkpoint 由同一 Agent 状态管理。
- `researchTaskQueue/researchSubagent` 代码保留但已断开生产入口；普通聊天、前台工具请求、后台消息和任务续写共用同一工具决策与限制语义。
- 验收：ReAct、checkpoint、Router、共享链接、卡片、记忆、Web 搜索及 OpenAI/Anthropic/Gemini 协议定向测试退出 0；`npm run lint`、`npm run typecheck`、`npm run check:agent:static` 均退出 0；完整 `npm test` 用时 158.5 秒并退出 0。当前分支未推送远端。

## 运行维护 2026-08-02 17:21 +08:00

- LangGraph V2 新写入端已切换到 `DATA_DIR/langgraph_v2.sqlite`；checkpoint 与关联 event 通过同一 SQLite 事务提交，副作用前后边界也使用原子 transition。旧 `langgraph_v2_checkpoints/` 与 `langgraph_v2_events/` 永久只读，按 thread 惰性兼容读取，`clear()` 通过永久 tombstone 防止旧 JSON 复活。
- SQLite 逻辑坏行会原子移入 quarantine，物理损坏 fail closed；`npm run diag:runtime -- --json` 已报告 `healthy`、`quick_check=ok`、0 checkpoint、0 event、0 quarantine，并保留 legacy 文件规模与 stale 字段。
- 实现提交：`0a45d71`、`e2664a1`、`21e3080`、`3cfd85b`、`cc5468d`、`654170a`；测试生命周期收口提交：`662914a`。Node 20.20.2 与 Node 24.14.1 聚焦回归通过，完整测试 574/574，覆盖率 Statements/Lines `72.19%`、Branches `62.18%`、Functions `80.00%`，全部基线通过。
- Legacy 验收保持 120/6209 文件、137,990,244/80,529,200 bytes、0 坏 JSON，聚合 SHA-256 分别为 `03a2b843ee304ddcf7644f7e112d8af1eeb8e9a60e2a8f2de78cde9c311a3b19`、`b32db4452e9c3a4eb75f1884165c77ac06b8c7f6311601fba996667455869686`；`AGENT.md` 与 `prompts/admin.txt` 保护 hash 未变化，未推送远端。

## Harness 评估 2026-08-02 15:24 +08:00

- 实现提交 `34ec277` 将评估契约升级为 `harness_eval_manifest_v2`，统一声明 5 个 suite、`ci` / `nightly:verify` profile、runner、case schema、data policy、指标与阈值；顶层 runner 使用隔离子进程并生成严格 JSON 报告。
- Node 20.20.2 实测 `ci` profile 通过 3 个确定性 suite，共覆盖 30 条 routing、2 条 synthetic auto-gold 与 22 条 post-reply case；`nightly:verify` 在缺少两个外部结果文件时按预期退出 1，并同时记录两个 `external_input_missing`。
- Node 20 全量测试 116 秒、覆盖率 145.6 秒退出 0；覆盖率为 overall `72.10/78.51/62.16`、web `79.84/87.50/80.59`、Runtime V2 `77.69/63.29/63.97`、stable boundaries `86.00/80.38/72.74`（行/函数/分支）。提交 `461a289` 将 V8 Function 基线校准到项目唯一运行边界 Node 20，其他指标阈值未降低。
- 外部 nightly 只验证 producer 自报元数据、时效、覆盖量和阈值，不执行真实模型、生成脱敏回放或认证 producer 身份；当前分支未推送。

## 环境数据查询 2026-08-07 00:36 +08:00

- 地震查询接入 USGS FDSN GeoJSON：发送“最新地震”默认返回全球最近 24 小时 M4.5+ 的 5 条事件；“中国最近一周 4 级以上地震，给我 3 条”可指定中国范围、时间窗、最低震级和条数。
- 天气查询统一接入和风天气，需要在本地 `.env` 配置 `QWEATHER_API_HOST` 和 32 位密钥内容 `QWEATHER_API_KEY`；`QWEATHER_API_SECRET` 仅作为兼容别名，控制台中的 10 位 API KEY 标识不参与请求，`AMAP_KEY` 继续供附近地点等既有工具使用。
- `skill_weather` 支持全球地点、实况与 1-10 日预报、1-24 小时逐小时预报、中国区域两小时分钟降水、空气质量和有效天气预警；可发送“上海未来 24 小时天气”“北京空气质量”“广州天气预警”“伦敦天气”或组合查询，没有明确地点时会要求补充。
- 私聊可用 `/天气预警 订阅 北京市朝阳区`、`取消`、`列表`、`暂停` 和 `恢复` 管理中国区县级预警，每个统一人物最多订阅 5 个地区；境外地点会明确拒绝，自然语言订阅写操作需要执行一次 `/工具确认 <ID>`，群聊不支持管理订阅。
- 预警在北京时间每天 10:00 和 21:00 各扫描一次，同一人物同批预警合并为一条瑞希回复；23:00–07:30 的蓝色、黄色预警延迟到静默结束前重新确认，橙色、红色及未知等级立即发送；解除记录只更新状态，不调用模型或发送消息。V1 不提供群订阅、逐平台订阅、自定义静默时间、普通天气定时报送或解除通知。
- 气象云图接入国家卫星气象中心 FY-4B：发送“中国红外云图”“可见光云图”或“亚太全圆盘水汽云图”会获取对应区域和通道的最新 JPEG，并直接发送到当前 QQ 会话；发送失败时保留官方原图链接且不自动重试。
- 地震、天气与云图查询均为按需实时查询；只有显式订阅的区县会后台扫描预警，海外分钟降水会明确返回不支持，数据源异常沿现有只读工具错误链路处理。

## 运行维护 2026-08-01 03:50 +08:00

- 工具副作用统一经过 SQLite 一次性授权账本；Runtime V2 direct、scheduler 与 legacy 共用 `executeAuthorizedToolCall`，`explicit/admin_explicit` 只创建绑定用户和聊天上下文的确认票据，不在原请求内执行。
- `/tool-confirm <ID>` 与 `/tool-cancel <ID>` 在模型路由前处理；确认时重新校验参数/上下文哈希、schema、完整 policy、管理员身份与动态 MCP 精确注册。票据按 `pending -> executing -> completed|uncertain` 消费，进程中断或完成落盘失败均禁止自动重放。
- 验收：`npm test` 169.4 秒、`npm run coverage` 192.0 秒及 lint、typecheck、Agent 静态检查、Prompt 清单、全仓/暂存区 secrets、diff check 均退出 0；四个覆盖率 scope 全部通过，授权账本验收后为 0 张票据、0 条审计记录。
- 提交后记录：实现提交 `fa84dfd` 已完成；工具确认与防重放小目标已完成，`prompts/admin.txt` 与 `AGENT.md` 哈希未变化，当前分支未推送。

## 运行维护 2026-08-01 02:28 +08:00

- 新增 `tool_policy_manifest_v1`，统一覆盖 124 个 schema、125 个 executor 与 125 项 policy；混合读写工具按 action 解析副作用，未知工具、internal executor、未知 action 和伪造 MCP 在 Runtime V2 默认阻断。
- scheduler、direct tool loop、dispatch checkpoint、只读缓存和 execution envelope 统一消费参数化 policy，副作用调用不会并行、缓存或 inflight dedupe；动态 MCP 只信任 `api/toolRegistry.js` 的精确注册名称。
- 验收：`npm test` 178.2 秒、`npm run coverage` 189.9 秒及 lint、typecheck、Agent 静态检查、Prompt 清单、全仓 secrets、`git diff --check` 均退出 0；覆盖率为行 71.68%、函数 80.45%、分支 62.03%，四个 scope 全部通过。
- 提交后记录：实现提交 `2d1afad` 已完成；Runtime V2 工具能力清单小目标已完成，确认票据、持久化幂等账本和 legacy 执行入口留待后续，当前分支未推送。

## 运行维护 2026-08-01 00:40 +08:00

- 新增 `harness_eval_manifest_v1` 版本化评估清单，固定 2 个 tracked synthetic suite、52 条 case、规范化 SHA-256 与递归隐私校验；空集、重复 ID、路径越界、真实账号、邮箱、非保留域 URL 和非占位凭据统一失败。
- Memory recall CLI 新增显式 `--cases`，无 `--cases`、`--auto-gold` 或 `--build-cases` 时 fail closed；post-reply eval 默认改用 `tests/fixtures/post-reply-learning-cases.jsonl`，并拒绝空集和未知 case。
- 新增 `npm run eval:harness:ci`，在 CI coverage 前独立运行 routing stability、synthetic auto-gold recall 和 post-reply learning 评估，不读取本地 `artifacts/` 或真实用户数据。
- 验收（2026-08-01 00:49 +08:00）：Harness 门禁、聚焦回归、lint、typecheck、全仓 secrets、workflow policy 和 `git diff --check` 均退出 0；完整 `npm test` 180.7 秒自然退出 0。
- 提交后记录（2026-08-01 00:51 +08:00）：实现提交 `85f421b` 已完成；版本化 Harness eval 小目标已完成，当前分支未推送。

## 运行维护 2026-08-01 00:25 +08:00

- Memory V3 journal/date 查询现在始终使用 lexical-first 并禁止远端 rerank，显式 `source=journal` 不再绕过策略；RAG explain 同步暴露 `decision.reason=plan_disallowed`，回归确认远端 rerank 请求数为 0。
- 修复 Prompt 临时目录只读属性、8000 字群回复诊断和 embedding backfill 夹具契约；`prompts/admin.txt` 未修改，SHA-256 保持 `2D42628CF64AB3235F1AB7AE6306081CA0FBCE8114AB344B193F686A7DB7C607`。
- `npm test`、`npm run coverage`、lint、typecheck、Agent 静态检查、Prompt 清单和全仓 secrets 扫描均退出 0；覆盖率为行 71.61%、分支 61.94%、函数 80.42%，四个 scope 全部通过。
- 提交后记录（2026-08-01 00:27 +08:00）：实现提交 `e6b6ddc` 已完成；测试契约与覆盖率恢复小目标已完成，当前分支未推送。

## 运行维护 2026-07-31 02:38 +08:00

- 新增独立命令 `/小剧场 [--无记忆] <剧情素材>`，支持回复文字引用；输出固定四幕 HTML 渲染 PNG，并在普通路由和所有内部记忆写入前返回。
- 群 `1083095371` 默认群记忆消息 `1365479523`、管理员私聊引用加 `--无记忆` 消息 `262404299` 均经 `get_msg` 确认为单一 900px PNG；用户素材和成品均通过强制敏感词门禁。
- 功能提交 `32becea`；配置、隐私边界、失败提示及完整验收见 [QQ 番外小剧场](docs/qq-small-theater-2026-07-31.md)，小目标已完成，未推送远端。

## 运行维护 2026-07-31 02:13 +08:00

- 提示词注入防护已统一收口：仅显式可信 authority 可生成 `system`，记忆、连续性、工具证据、视觉/OCR 与会话摘要均作为低权限数据处理；持久化写入和所有回复出口增加污染/真实根提示词泄露拦截。
- 安全专项、`lint`、`typecheck`、prompt 清单与相邻回归通过；完整边界及验收记录见 [维护日志](docs/maintenance-log.md) 和 [实施计划](docs/superpowers/plans/2026-07-30-prompt-injection-hardening.md)。
- 实现提交 `2b7c1a2`；本地 `.env`/`data` ACL 已应用并通过诊断（7 OK / 1 既有兼容告警 / 0 ERROR），快照保存在 `artifacts/security/acl-snapshots/acl-20260731-021604-28732.json`，未推送远端。

## 运行维护 2026-07-30 21:30 +08:00

- 新增[瑞希的 QQ 绘图陪伴玩法手册](docs/qq-visual-rendering-companion-playbook-2026-07-30.md)，提供可直接复制的私聊陪伴与群聊娱乐提示词，并将需要定时、记忆授权或状态存储的构想统一标记为“尚未上线”。
- 基础指南已增加玩法入口；当前玩法与未来构想、安全和隐私边界均分区说明，小目标已完成，未修改业务代码，未推送远端。

## 运行维护 2026-07-30 21:17 +08:00

- 新增面向 QQ 用户的[绘图功能使用指南](docs/qq-visual-rendering-user-guide-2026-07-30.md)，说明私聊与群聊触发方式、适用场景、提问模板、连续修改、安全限制和失败处理。
- 文档内容已按当前 `render_qq_visual` 路由、渲染及审查实现逐项核对；未将尚未实现的陪伴玩法写成现有能力，小目标已完成，未推送远端。

## 运行维护 2026-07-30 21:02 +08:00

- 提交 `055ad9f` 新增 `render_qq_visual`：SVG 使用 `sharp`，HTML 使用固定版本 `napcat-plugin-puppeteer v1.5.0`，统一在敏感词门禁通过后以 OneBot Base64 PNG 发送到当前群聊或私聊。
- NapCat 4.18.6 已限制在 `127.0.0.1`，插件 `browser.maxPages=2`，Chrome for Testing 131.0.6778.204 已连接；目标群 SVG 消息 `781501773` 与管理员私聊 HTML 消息 `1185586370` 经 `get_msg` 确认为单一 PNG 图片段。
- 五项聚焦测试、lint、typecheck、secrets 检查通过；真实词库的 prompt/markup 拦截均使渲染和 QQ 发送调用保持 0。完整配置、安全边界与验收记录见 `docs/qq-visual-rendering-2026-07-30.md`，小目标已完成，未推送远端。

## 运行维护 2026-07-30 19:50 +08:00

- 目标5第六批完成：`message/handler` 的11个共享词法作用域 chunk 已迁为单一静态 CommonJS 运行时，生产入口不再调用 `runCommonJsChunks`；旧 chunk 保持只读兼容并由 lint 合并语法校验。
- 18项公开 API、legacy facade 和 `src/message` 导出身份保持不变；786文件 lint、typecheck、入口冷加载及5项聚焦回归均通过，小目标已完成，未推送远端。

## 运行维护 2026-07-30 11:29 +08:00

- 主动私聊策略调整：全局沉默门槛由 180 分钟降为 120 分钟，两批主动私聊最小间隔由 360 分钟降为 240 分钟；每日最多 2 批、双随机窗口和连续两批无回复暂停保持不变。
- 功能提交 `c7ac6a7`；定向主动私聊测试、`npm run lint`、`npm run typecheck` 和 `git diff --check` 退出 0，重启后运行配置为 `idleMinutes=120`、`minGapMinutes=240`，`/live`、`/ready` 均返回 200。
- 完整 `npm test` 退出 1，失败仍为两个管理员提示词、`mainReplyUnifiedDiagnostics` 和两个既有 Memory V3 用例，主动私聊测试通过；小目标已完成，未推送远端。

## 运行维护 2026-07-30 11:18 +08:00

- 主动私聊判断修复：模型请求改用 `max_tokens=4096`、`reasoning_effort=minimal` 和 `response_format={type:json_object}`；运行时硬条件已满足时，提示词默认要求发送，仅在用户明确拒绝或上下文明显不适合时允许拒绝；`finish_reason=length/MAX_TOKENS` 现在记录为模型输出截断，不再伪装成判断器过滤。
- 真实网关验收：`API_BASE_URL/API_KEY/AI_MODEL` 请求 HTTP 200、`finish_reason=stop`；2026-07-30 11:17:50-11:18:15 +08:00 手动触发一次 `privateProactiveEngine.scan()`，对 `1052258894` 发送 3 个独立私聊气泡，NapCat 三次均成功。状态文件记录上午窗口已消费、今日 `1/2` 批、预算 `2/50`、`inFlight=null`，主进程 `/ready` 返回 200，未重复发送。
- 定向主动私聊测试、`npm run lint`、`npm run typecheck` 和 `git diff --check` 退出 0；`npm test` 退出 1，失败仍为两个管理员提示词、`mainReplyUnifiedDiagnostics` 和两个既有 Memory V3 用例，主动私聊相关测试全部通过。
- 功能提交 `cd8645d`；本次仅追加文档，未推送远端。

## 运行维护 2026-07-29 18:42 +08:00

- 主动私聊故障修复：`API_PROVIDER=openai_compatible` 未透传时，Gemini 模型名被共享 HTTP 层误判为原生协议，主动请求落到 `:generateContent` 并返回 404；同时将主动决策输出上限提高到 1200 token，并固定低推理开销，避免结构化 JSON 被截断。
- 真实恢复验收：用户 `1960901788` 的漏发机会先复现为 HTTP 200 但 `finish_reason=length`、`invalid_structure`（未发送），修复后于 2026-07-29 18:40 +08:00 真实发送 3 个独立私聊气泡，NapCat 三次 `send_private_msg` 均成功；状态已记为今日 1/2 批，另一名用户未被触发。
- 提交：`46d659a`、`d4dd729`；定向主动私聊测试、`npm run lint`、`npm run typecheck` 和 `git diff --check` 通过；未推送远端。

## 运行维护 2026-07-29 09:48 +08:00

- QQ 群 `direct_chat` 最终回复硬截断上限由 220 字调整为 8000 字；普通用户、管理员和快速回复的模型 token 上限保持不变。
- 验收：群聊风格守卫回归覆盖 8001 字输入精确截为 8000 字，并确认动态提示词同步使用新上限。

## 运行维护 2026-07-29 09:57 +08:00

- 目标5第五批完成：提交 `0144d51` 将 `runtime-v2/context` 的10个共享词法作用域 chunk 迁为15个显式 CommonJS 模块，生产入口不再执行 `runCommonJsChunks`；旧 chunk 保持只读兼容并由 lint 合并语法校验。
- 13项主 API、6组子门面、`promptLayerCache` 单例、记忆输入惰性加载和0循环依赖边界通过；`lintChunkEntrypoints` 已同步合并记录协议。
- Node 24.14.1 下10项 context 聚焦回归、785文件 lint、typecheck、prompt、全仓 secrets 和 diff check 通过。当前环境无 Node 20，未宣称双版本；`TEST_CONCURRENCY=4 npm test` 仍受只读 `prompts/admin.txt` 测试及4项既有基线断言失败影响。
- `prompts/admin.txt` 保持310字节、ReadOnly、SHA-256 `2D42628CF64AB3235F1AB7AE6306081CA0FBCE8114AB344B193F686A7DB7C607`；`npm audit --omit=dev` 仍报告 HEAD 既有 `sharp` 高危和 `body-parser` 低危问题，本批未改依赖。

## 运行维护 2026-07-29 08:42 +08:00

- 新增独立 QQ 私聊主动触达引擎：仅登记上线后成功完成正常私聊回复的用户，按每日两个稳定随机窗口、全局沉默、最小间隔、用户日上限和独立模型预算决定是否发送；群聊主动发送链路保持不变。
- 主动决策严格使用 `API_BASE_URL`、`API_KEY`、`AI_MODEL`，支持 `/主动私聊 关闭|开启|状态` 本地控制、首次角色化告知、活动版本取消、未回应自动暂停、NapCat 离线跳过和重启防重。
- 功能提交 `a1584aa`。定向测试、`npm run lint`、`npm run typecheck`、`git diff --check` 均退出 0；完整 `npm test` 中主动私聊用例通过，但当前并行工作区仍有 5 个非本任务用例失败，详见维护日志；未推送远端。

## 运行维护 2026-07-28 23:49 +08:00

- 修复 Daily Journal 轮数摘要的独立向量化链路：`journal_turn_summary` / `turn_batch` segment 现在统一进入 embedding cache、本地查询候选、CLI 快照和后续 LanceDB 同步；旧 `.segments.jsonl` 切片仍由 `journal-segment:*` 文档负责，不从 episode 投影重复索引。
- 验收：新增 turn-compaction 端到端回归覆盖 embedding cache、查询候选、CLI 快照和 LanceDB 行构建；相关 Daily Journal/embedding/语义召回 5 项测试、`npm run lint`、`npm run typecheck` 和 `npm run diag:memory -- diagnose --skip-probe --json` 均退出 0；真实数据当前没有 `journal_turn_summary` 事件，无需历史回填。
- 只读诊断：投影未过期、`readyButNotSynced=0`，仍有 1 条既存 LanceDB stale row 和 1 条待 embedding，建议后续单独执行 full reconcile；本轮未修改运行数据、未删除文件、未推送远端。

## 运行维护 2026-07-28 10:20 +08:00

- Memory V3 RAG 检索优化已接入：向量化资格统一拒绝原始 turn、模型回复、污染文本、低置信度和 superseded/suspect 节点；LanceDB 行补齐 `scope/user/group/session/category/semanticSlot/lifecycle/versionRoot/sourceTs/confidence/textHash/modelVersion` 元数据。
- `queryMemory()` 现在使用按 facet 的 Recall Plan：连续性/日期走 lexical-first，profile/preference/relationship、task、group/style 使用来源白名单与 source/semantic-slot 配额；远程 rerank 仅在高价值或高歧义候选上启用，并保留 embedding/LanceDB/rerank 降级路径。评估支持 `forbiddenIds`、`allowEmpty` 和 p95 延迟门禁。
- 验收：`memoryV3RecallPlan`、Memory V3 查询/embedding/LanceDB/门禁定向测试通过；`diagnose --skip-probe` 通过。当前数据仍有约 962 条孤立 LanceDB 行、10 条待同步和投影过期，`lancedb-gate --auto-gold --limit 20` 按门禁失败并建议先 full reconcile；本轮未执行 reconcile、删除或远端推送。

> 面向 QQ 的角色 Agent —— 在真实群聊/私聊里稳定运转，而不只是个问答 bot。

MizukiBot 基于 Node.js、LangGraph 和 NapCat，把"晓山瑞希"角色扮演、消息路由、分层记忆、工具调用、后台学习和运行诊断拼成一套可长期跑的本地机器人。一条消息进来，它先判断该不该回、怎么回（直接聊 / 调工具 / 后台处理 / 拒绝），回复后再把有价值的信息沉淀进记忆。

## 运行维护 2026-07-26 11:23 +08:00

- 提交 `2b143a7` 增加 QQ JSON 卡片语义上下文：在保留 `qqCardUrls` 和 `[分享链接]` 的同时，传播新闻、音乐、小程序、邀请卡的类型、标题、简介、来源、预览图与规范化主链接；网易云、B站、小红书继续复用既有 URL 提取、识别和规范化函数。
- normal fast 会显式避开卡片；无 URL 邀请卡只在私聊或群聊门禁通过后以内部 `[分享卡片]` 进入主回复。私聊纯单卡、明确要求查看/总结/评价/比较的单卡可使用 `web_fetch`，2–3 张按卡片顺序并行读取，超过 3 张请求用户收窄；普通分享不联网，被动群聊不注入卡片感知。
- 验收：卡片专项与相邻回归、`npm run check:prompts`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run smoke:napcat-ingress` 全部通过。真实 QQ 客户端中的三平台单卡、卡片附言、双卡比较和群聊无 @ 场景本轮未人工发送，状态保持未验证。

## 运行维护 2026-07-26 11:18 +08:00

- 修复 Anthropic 主回复请求因分享链接工具调用 ID 含冒号而返回 400：提交 `4216032` 在 provider 边界将非法 ID 稳定映射为合规值，并保持 `tool_use` 与 `tool_result` 关联一致，合法 ID 不变。
- 新增非法 ID 与合法 ID 回归测试；聚焦测试、provider 请求测试、`lint`、`typecheck`、prompt、全仓 secrets、暂存区 secrets 与 diff check 通过。全量测试受工作树中并行开发的 QQ 卡片/快速回复未提交改动影响失败，本修复未修改这些文件，未推送远端。

## 运行维护 2026-07-26 10:18 +08:00

- 新增陪伴模式只读工具 `read_shared_link`：私聊或已被现有路由判定需要回复的群聊，可确定性读取每轮第一个小红书、网易云音乐或 B站分享链接；忽略、拒绝和不回复路由不会访问外部网站。
- 第一版读取小红书公开图文及前三张图片理解、网易云单曲/歌词与歌单/专辑前20首、B站公开视频元数据/分P/统计/公开字幕；不下载音视频、不读取评论、不自动登录，结果只做进程内限量缓存。
- 实现提交 `eca646d`。夹具、安全、缓存、规划器、视觉与超时测试，以及 `lint`、`typecheck`、prompt、secrets、全量测试和暂存区检查均通过；网易云与B站公开链接实时探针通过，小红书因无公开样本且未配置 Cookie，外部验收标记为未验证。

## 运行维护 2026-07-25 13:52 +08:00

- 目标5第四批完成：提交 `4d87c55` 将 `memory/vector` 的7个共享词法作用域chunk迁为7个显式CommonJS实现模块，生产入口不再读取或执行旧chunk；`daily-share`、`passive-awareness`、`meme`和`memory/vector`均已迁移，目标5推进至部分完成（4/6），仅余 `message/handler`与`runtime-v2/context`，目标6继续等待。
- 169/169个函数按40/55/28/2/24/14/6对账，23项主入口API、5个门面及legacy身份保持不变；4项可变状态各归唯一owner，未知自由变量为0，依赖图为15条本地边加3条embedding边且0循环，lazy/native加载与singleton边界保持不变。
- Node 20.20.2与Node 24.14.1的九项聚焦回归均为9/9；754文件lint、typecheck、107项prompt清单、全仓secrets和diff check通过，Node 24并发4全量523/523通过，耗时98.992秒。production audit退出1，仅报告HEAD既有 `body-parser`低危项和 `sharp`高危项；当前分支未推送。

## 运行维护 2026-07-24 08:21 +08:00

- 目标5第三批完成：提交 `bc1d10f` 将 `meme` 的9个共享词法作用域chunk迁为10个显式CommonJS模块，生产入口不再读取或执行 `memeManager.*.chunk.js`。
- 93/93个函数完成AST对账，16项主入口API、legacy facade与5个子门面的对象/函数身份保持不变，6项singleton各归唯一模块且本地依赖图为0循环；动态chunk入口由4个降为3个，目标5推进至部分完成（3/6），目标6继续等待全部入口迁移。
- Node 20.20.2与Node 24.14.1的七项聚焦回归、747文件lint、typecheck、prompt、全仓secrets、diff check和Node 24并发4全量521个tracked测试均通过，全量耗时150.957秒；production audit报告HEAD既存的 `sharp@0.33.5` 高危项和 `body-parser@1.20.5` 低危项，本批未修改依赖。

## 运行维护 2026-07-21 21:42 +08:00

- 目标5第二批完成：提交 `b01491d` 将 `passive-awareness` 的6个共享词法作用域chunk迁为显式CommonJS模块；21项主入口API、legacy facade及5个子门面契约保持不变，生产路径不再读取或执行 `passiveGroupAwareness.*.chunk.js`。
- 共享规则、Presence、prompt、模型传输、普通回复和强制插话已按单向依赖拆分，并恢复损坏的中文触发词与机器人发送者名；动态chunk入口由5个降为4个，目标5保持部分完成（2/6）。
- Node 20.20.2的21项定向回归、737文件lint、typecheck、prompt、全仓secrets、diff check和Node 24并发4全量130.4秒通过；production audit仅有既存 `body-parser@1.20.5` 低危项，本批未修改并行中的CI、覆盖率、依赖和安全诊断文件。

## 运行维护 2026-07-21 20:52 +08:00

- 目标5首批完成：提交 `5b36f86` 将 `daily-share` 从共享词法作用域 chunk 迁为显式 CommonJS 依赖，公开入口保持不变，生产路径不再读取或执行 `dailyShareEngine.*.chunk.js`。
- 核心、调度、QZone、记忆预取、窗口和引擎编排已按职责拆分；两个旧 runtime fragment 收口为静态兼容导出，动态 chunk 入口由6个降为5个，目标5保持部分完成。
- Node 20.20.2 的8项定向回归、732文件 lint、typecheck、prompt、全仓 secrets、diff check和 Node 24并发4全量123.4秒通过；production audit报告既有 `body-parser@1.20.5` 低危项，本批未改并行依赖文件。

## 运行维护 2026-07-17 02:58 +08:00

- 目标23已完成：`restartBotScript` 与 `windowsDaemonScript` 不再通过大型源码字符串清单证明安全性，改为dot-source真实PowerShell函数并验证确认门、进程识别/保护、停机标记顺序、WMI命令行、重启结果、期望停机消费、早退冷却、HTTP reverse恢复、锁交接和外置worker策略。
- 生产脚本仅增加dot-source库入口和两处由主流程复用的纯策略函数；默认运行、定时任务和远程重启语义不变。六行 `restart-bot.cmd` 因无参数执行会真实重启，仅保留4项最小结构契约。
- 10项重启/daemon关联测试、730文件lint、typecheck、prompt、全仓secrets、PowerShell AST、production audit（0漏洞）和并发4全量142.5秒通过。

## 运行维护 2026-07-17 01:27 +08:00

- 目标14已完成：正常信号退出与远程重启统一进入单一主进程生命周期协调器，按入口关闭、运行时停止、worker排空、外部资源清理、热存储/SQLite落盘和锁文件释放的顺序收尾。
- 远程重启会等待完整排空后再启动新进程；排空期间收到SIGTERM会复用同一Promise并在收尾完成后退出，避免重复清理和重启命令被进程自然退出截断。
- 10项生命周期回归、730文件lint、typecheck、prompt、全仓secrets、production audit（0漏洞）通过；首次全量受两项公网DNS失败影响，失败测试单独复跑通过，第二次并发4全量125.3秒自然退出0。目标27仍待真实Docker stop grace与OS SIGTERM运行探针。

## 运行维护 2026-07-17 00:19 +08:00

- 目标20已完成：`request-trace.ndjson` 与 `model-calls.ndjson` 不再落盘原始 `userId/groupId/messageId`；统一使用带域分隔的 HMAC-SHA256 摘要，`requestId` 生成也改为 keyed hash。
- 新增 `REQUEST_TRACE_HASH_SECRET` 配置，建议在多进程部署中保持稳定且只存在于本地秘密配置；未显式设置时沿用已有秘密或进程级随机兜底，不把密钥写入日志。
- keyed hash、消息入口和模型调用隐私测试、729文件 lint、typecheck、prompt、全仓 secrets、production audit（0漏洞）及并发4全量104.6秒通过；目标20完成。

## 运行维护 2026-07-16 23:46 +08:00

- 新增 Windows 敏感路径 ACL 工具：必须显式提供服务身份，默认只预览；只有 `-Apply` 才会先导出递归 ACL 快照，再限制 `.env`、`data` 及子项为服务账号、SYSTEM 和 Administrators。
- 已确认本机 Bot 主进程和计划任务身份为 `MIZUKI\Administrator`；真实预览扫描 `data` 49,147项，`.env`/`data` SDDL前后不变。
- ACL行为、安全诊断、PowerShell AST、全部静态门禁及并发4全量通过，全量耗时108.8秒；为保护并行代理，本轮未应用真实ACL，目标4仍为部分完成。

## 运行维护 2026-07-16 22:52 +08:00

- 目标31已完成：仓库继续以 Node 20.x 为唯一运行边界，真实 Node 20.20.2 使用隔离的 ABI 115 `better-sqlite3` 依赖完成原生模块探针，SQLite `quick_check=ok`。
- `TEST_CONCURRENCY=4` 的 tracked 全量测试在 Node 20.20.2 下自然退出0，耗时151.7秒；官方 Windows x64归档此前按 nodejs.org SHA-256 `dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77` 校验。
- 729文件 lint、typecheck、prompt、tracked/staged secrets、production audit和diff check均通过；本轮只补验收文档，不包含并行中的覆盖率改动，未推送远端。

## 运行维护 2026-07-15 12:17 +08:00

- 所有 GitHub workflow外部 `uses:` 已固定为官方 release解引用后的40位 commit SHA，并由结构测试拒绝 tag、短 SHA、未知 Action owner和缺少版本注释的引用。
- 新增独立 Supply Chain workflow：完整 Git历史 gitleaks、生产许可证/CycloneDX SBOM与 OSV依赖扫描分为三个最小权限作业；扫描失败不使用 `continue-on-error`，报告保留7天，PR不读取项目 secrets。
- 可信 Node 20.20.2与当前 Node定向测试、729文件 lint、typecheck、prompt、tracked/staged secrets、production audit（0漏洞）、diff check和 Node 24并发4全量通过，全量耗时105.2秒。实现提交：`a4ce6cc`；目标29继续部分完成，仍缺真实 GitHub Actions扫描、Docker基础镜像 digest和 Trivy运行证据。

## 运行维护 2026-07-14 16:50 +08:00

- 新增生产依赖许可证门禁，覆盖330个 `package-lock.json` 生产条目；`cycletls@2.0.5` 使用带复核日期的精确例外，`json-bignum@0.0.3` 使用版本锁定且来源为 HTTPS 的 MIT override，未知许可证、版本漂移、过期/stale例外和不完整元数据均失败。
- 新增 npm CycloneDX SBOM wrapper，校验根 `bom-ref`/version/purl、直接生产依赖、非空组件/依赖图并输出 SHA-256；真实 SBOM 为 CycloneDX 1.5、275个组件、276条依赖记录。
- 目标测试、729文件 lint、typecheck、prompt、tracked/staged secrets、production audit（0漏洞）和 diff check 通过；串行替代全量515文件中498个通过，17个仅因当前沙箱禁止 Node 创建子进程而失败。实现提交：`c12ec87`；目标29继续部分完成，Node 20、并发4全量、gitleaks/OSV/Trivy、Action SHA 和基础镜像 digest 仍待真实验收。

## 运行维护 2026-07-13 20:54 +08:00

- 主进程新增 `/live` 与 `/ready`，兼容 `/healthz` 改为 readiness 语义；启动完成前和排空期间返回503，Compose 主服务改用 `/ready`。
- 主进程退出会停止入口、等待消息/内联 worker、关闭 HTTP server、flush 热存储并关闭 SQLite；外置 post-reply worker 增加在途作业排空、状态心跳和容器本地 readiness 探针。
- Node 20 定向测试、全部静态门禁及 Node 24 并发4全量93秒通过。实现提交：`fec175e`；目标27继续部分完成，真实 Docker/SIGTERM 探针仍待环境验收。

## 运行维护 2026-07-13 19:09 +08:00

- SQLite 文件连接已统一使用 5 秒 `busy_timeout`、WAL 与外键策略；多进程首次同时切换 WAL 时只重试 `SQLITE_BUSY`，避免共享 `profile_journal.sqlite` 启动竞争直接降级。
- 新增 `node scripts/check-sqlite-integrity.js [db...]`，输出 `quick_check` 与被动 checkpoint 结果；存储优化完成后也会执行完整性检查和截断 checkpoint。
- Node 20/24 的共享库多进程写入、迁移、召回和完整性测试通过，Node 24 并发4全量93.9秒通过。实现提交：`5160912`，目标25已完成。

## 运行维护 2026-07-13 01:57 +08:00

- planner rich context、Runtime host输出、消息入口和NapCat配置四个源码断言已迁为行为/模块契约；新增共享 planner context 模块，消除三处参数拼装重复。
- 消息入口测试通过仅测试模式hook注入无副作用packet处理，生产路径无新增绕过；已有NapCat端点旧token更新与无关端点保留均有行为覆盖。
- 定向回归、724文件lint、prompt、tracked secrets、依赖审计及并发4全量111.4秒通过。实现提交：`6692ced`，目标23继续部分完成。

## 运行维护 2026-07-13 01:27 +08:00

- 慢测中的真实网络和生产等待已改为可注入fixture，视觉文本预算裁剪由重复线性扫描改为等价二分；并发4全量测试连续三轮100.6/97.6/103.6秒通过。
- 3个高价值源码文本断言已迁为真实handler行为测试，继续守卫路由锚点、raw reasoning、fast-path回退、安全标记与历史写入顺序。
- 目标22完成，目标23部分完成；实现提交：`be32669`。

## 运行维护 2026-07-13 00:09 +08:00

- 测试运行器改为 tracked-only 自动发现、默认并发2、显式串行 barrier、进程树超时终止、稳定输出和慢测榜；clean CI所需评估样本已迁入 tracked fixtures。
- 提示词检查新增版本化 allowlist，治理39个 worldbook、7个 runtime 模板、私有prompt边界和4组冲突标签；unknown、stale、expired或成员漂移直接失败，默认检查为0 warning。
- 验收：并发4全量测试147.9秒通过，最终统一验收146.7秒通过；提示词门禁完成，runner性能仍未达到120秒目标。实现提交：`d44d051`。

## 运行维护 2026-07-12 22:32 +08:00

- 小目标：修复 NapCat HTTP Client 真实消息事件上报持续返回 401。
- 根因与修复：当前 NapCat 使用 OneBot `X-Signature: sha1=<HMAC-SHA1(rawBody, token)>`，而反向入口只识别自定义 HMAC-SHA256 与 Bearer token；现已在兼容模式内增加 OneBot SHA1 签名校验，匿名和错误签名仍拒绝。
- 验收：正确 OneBot 签名运行态返回 204，错误签名回归返回 401；NapCat reverse/WS 定向测试、723 文件 lint 和语法检查通过。实现提交：`18015e1`；小目标已完成。

## 运行维护 2026-07-12 22:03 +08:00

- 新增 Windows Node 20 全量 CI 与 Ubuntu Node 20 Linux 策略门禁，执行版本、lint、prompt、tracked secrets、production audit 和测试；工作流使用最小权限、隔离数据目录且不注入项目 secrets。
- Node 运行边界统一为 20.x，`.nvmrc`、package engines、Linux 安装脚本和部署文档使用同一主版本；本机 Node 20 下载超时、远端 Actions 尚未运行，因此 CI/版本目标仍待真实环境验收。
- 会话研究缓存增加每进程全局容量、LRU、主动/惰性 TTL、淘汰指标和可停止的 unref 定时器；10,000 会话测试稳定收敛至配置上限。实现提交：`5e7e168`。

## 运行维护 2026-07-12 21:25 +08:00

- 小目标：恢复 NapCat HTTP reverse 与 Bot 连接。
- 根因与修复：安全加固后 `NAPCAT_HTTP_REVERSE_SECRET` 变为必填，但本机 `.env` 未同步 NapCat 已配置的 HTTP Server/Client token，导致主进程启动即退出；已使用现有配置脚本同步两端 token 并重启 Bot，未修改业务代码。
- 验收：主进程持续运行，NapCat `get_status` 返回 online/good，`127.0.0.1:3000` 与 `127.0.0.1:3002` 均监听，反向入口鉴权有效，`npm run smoke:napcat-ingress` 全部通过；小目标已完成。

## 运行维护 2026-07-12 20:17 +08:00

- 小目标：强化 provider reasoning 的瑞希第一人称沉浸思考要求。
- 最小修复：主回复必选的 `roleplay_inner_protocol` 在提示词头部增加硬性契约，要求 reasoning 只能使用瑞希第一人称简体中文内心独白；技术和工具任务也不得切换为助手、分析员、导演或旁白叙述。
- 边界：仍直接转发 provider 原始 reasoning，不增加二次改写或清洗；提示词只能提高模型遵循率，不能替代 provider 对 reasoning 输出能力的支持。
- 验收：9 项提示词、正文防泄漏和 reasoning 转发回归、`npm run check:prompts`、`npm run lint`、`git diff --check` 通过；小目标已完成。

## 运行维护 2026-07-12 19:21

- 小目标：清理没有 CLI、脚本、测试或运行入口的 OpenViking backfill 分支。
- 最小修复：删除 `utils/openVikingMemory/backfill.js` 和无调用聚合入口 `utils/openVikingMemory/index.js`，移除三个 `OPENVIKING_BACKFILL_*` 孤立配置及文档中的失效回灌章节，共删除 142 行未接入模块代码。
- 验收：backfill 导出和配置 `rg` 零引用、`npm run lint`、`npm run check:agent:static`、7 个 OpenViking/Runtime V2 相关测试、配置构建探针、保留模块 require smoke、`npm pack --dry-run` 和 `git diff --check` 均通过。
- 小目标已完成：OpenViking 仅保留实际可执行的召回、写入、CLI、调度和诊断链路。

## 运行维护 2026-07-12 19:07 +08:00

- 小目标：QQ 正文发送成功后直接合并转发 provider 原始 `reasoningText`，不再使用本地清洗后的 `reasoningForwardText`。
- 最小修复：正式回复和普通快速回复统一把原始 reasoning 交给 NapCat 转发接口；内容只做空白判断和固定长度分块，不再去除标签、改写、截断或角色化过滤。
- 验收：reasoning 解析、Runtime V2、路由、QQ 合并转发和快速回复相关定向测试、`npm run lint`、组合入口加载和 `git diff --check` 通过；小目标已完成。

## 它能做什么

- **QQ 接入**：通过 NapCat / OneBot 收发私聊、群聊、图片、引用、转发、戳一戳等事件。
- **路由分流**：按 `ignore` / `refuse` / `admin` / `direct_chat` 等路线分发，不是每条消息都砸给大模型。
- **角色一致性**：prompt manifest、persona worldbook、运行时协议和回复清洗共同维持瑞希的语气和边界。
- **分层记忆**：短期上下文、会话摘要、用户画像、Memory V3、LanceDB 向量召回、本地知识库协同。Daily Journal 默认只写 Profile Journal SQLite，按用户累计 50 轮安全对话调用独立记忆模型生成 segment 摘要并独立向量化；每日任务只兜底压缩未满 50 轮的历史尾部，不再新增按日文件或多日汇总。
- **工具调用**：本地命令、诊断、知识检索、图片处理、日程、自定义 skill。
- **环境数据**：按需查询 USGS 最新地震事件，并从 JMA Himawari 获取红外、可见光和水汽全圆盘云图发送到当前 QQ 会话。
- **瑞希瑞幸**：独立 `瑞希瑞幸` 命令接入瑞幸官方 MCP/skill，群聊做菜单、推荐、预览，私聊处理个人 Token、订单和支付二维码。
- **后台学习**：post-reply worker 在回复后异步抽取记忆、维护画像、写日记，不卡主回复。
- **回复出口拦截**：群聊和普通用户私聊发送前使用本地政治敏感词库快照，并要求命中现实政治语境后才替换；管理员私聊豁免，角色扮演标记不作为豁免。
- **运维诊断**：重启、健康检查、请求 trace、token 预算、NapCat 状态、记忆质量、运行热点一应俱全。

## 运行维护 2026-07-12 19:03

- 小目标：继续清理已退役 `/cot` 状态、零入口 AI 聚合层和无调用的本地命令桥客户端。
- 最小修复：删除 `utils/cotOnceRuntime.js`、`api/ai.js`、`api/graphPlanning.js`、`utils/localCommandBridgeClient.js` 及孤立的 `cotOnceRuntime` 测试；桥安全测试仅移除客户端断言，保留服务端鉴权和泄密扫描，共删除 254 行生产死代码和 56 行失效测试代码。
- 验收：运行代码 `rg` 零引用、`npm run lint`、`npm run check:agent:static`、13 个 `/cot`/reasoning/桥安全/LangGraph/Qzone/daily-share 相关测试、保留模块 require smoke、`npm pack --dry-run` 和 `git diff --check` 均通过。
- 小目标已完成：第二批死代码已移除，Runtime V2、reasoning 转发、图片生成和本地命令桥服务端保持可用。

## 运行维护 2026-07-12 12:25

- 小目标：清理仓库内已确认零调用的 P0 遗留代码，不触碰动态 chunk、Telegram 和可能对外兼容的 facade。
- 最小修复：删除 `api/legacy/agentGraphV1Runtime.js`、`api/skills.js`、`api/systemCommandProxy.js`、`api/toolAdapter.js`，共移除 2158 行遗留模块代码；同步移除 `@langchain/anthropic`、`@langchain/openai`、`dayjs` 直接依赖、131 行依赖锁内容及两处失效依赖检查。
- 验收：运行代码 `rg` 零引用、`npm run lint`、`npm run check:agent:static`、28 个 LangGraph/native skills/tool/runtime 相关测试、关键模块 require smoke、`npm ls`、`npm pack --dry-run` 和 `git diff --check` 均通过；全量 482 个测试在 10 分钟命令上限内未结束，未记为通过。
- 小目标已完成：P0 死代码和独占依赖已移除，V2 LangGraph、native skills 与 npm 发布清单保持可用。

## 运行维护 2026-07-12 18:32 +08:00

- Web 控制台不再把 `WEB_TOKEN` 长期保存在浏览器或作为 Bearer/header/query 凭据使用；令牌仅用于登录，成功后改用短期、可撤销的 `HttpOnly; SameSite=Strict` 会话。
- 写请求增加严格同源 CSRF 校验，登录失败有限流；CSP 使用逐响应 nonce，并集中设置 frame、MIME、Referrer Policy 和受信 HTTPS 下的 HSTS。
- 验收：真实浏览器完成登录、控制台渲染和注销，控制台无 CSP 错误；6 组 Web 测试、729 文件 lint、提示词检查、密钥扫描、依赖审计和 326.7 秒全量测试全部通过。实现提交：`39b5428`。

## 运行维护 2026-07-12 19:49 +08:00

- 请求追踪改为显式字段契约，保留诊断需要的路由、流式、重试、工具、缓存和耗时元数据，不再自动写入正文、headers、未知嵌套对象或带凭据 URL；错误和 requestId 同样执行限长与脱敏。
- 安全诊断新增 direct/Compose 部署边界、Windows ACL、日志无限保留、Docker 最终用户及每服务容器权限检查；无法可靠解析的配置只 warning，不输出假绿灯。
- 验收：13 组定向/消费者测试、731 文件 lint、提示词检查、密钥扫描、依赖审计和 332.3 秒全量测试全部通过。实现提交：`d20208b`。

## 运行维护 2026-07-12 21:08 +08:00

- 容器两服务已采用 non-root、只读根、能力清空、no-new-privileges、init、资源/PID/停止宽限和 Docker 日志轮转；主服务独占可写 `runtime.env`，worker 不再获得可写配置文件。
- 应用日志治理改为显式 opt-in，状态型 NDJSON 默认不轮转；共享日志的检查、轮转、追加与维护由跨进程锁保护，Windows daemon 只清理明确归档格式。
- 验收：12 组运维测试、723 文件 lint、提示词检查、密钥扫描、依赖审计和 339.7 秒全量测试通过。实现提交：`9e5f0e8`；真实容器启动仍因本机 Docker snapshot 损坏和磁盘约 99% 占用待验收。

## 并发与后台线程

更新 2026-08-24 17:47 +08:00：实现提交 `eeb51ecb` 将私聊入站队列超时从 20 秒调整为 180 秒，避免同一用户前一条图片问答耗时较长时，后续消息在拿到会话锁前被丢弃；多用户并行、同用户串行和队列长度 10 的边界保持不变。验收结果：私聊并发配置、入站并发、私聊并发来源和背压回归通过，测试运行日志确认 `queueTimeoutMs=180000`；`npm run lint`、`npm run typecheck` 和 `git diff --check` 通过。小目标已完成。

更新 2026-07-09 17:48 +08:00：修复主回复 prepare 软超时 fallback 在非召回 `chat/default/direct_chat` 下构造 ambient memory context 并注入 `retrieved_memory_lite/daily_journal` 的问题；非召回普通主回复不再构造 fallback memory context，显式召回保持原记忆 fallback。验收结果：`node scripts/run-tests.js tests/runtimeV2PromptTimeoutMemoryFallback.test.js tests/chatDefaultMemoryLeakDiagnostics.test.js tests/geminiSamplingDegradationPromptGate.test.js` 通过；真实 24h 诊断仍显示修复前日志中 `candidateChatDefaultRequests=49`、`violationRequests=15`。小目标已完成。

更新 2026-07-09 17:45 +08:00：新增最小本地运行时热修复 smoke：`npm run smoke:runtime-hotfixes`。该入口只串今天 5 个运行时热修复的高价值回归，覆盖被动视觉探针 decision 408 兜底、post-reply 495 最终降级收尾、notebook-answer 工具后草稿失败 checkpoint 收口、NapCat 原始包日志/Memory V3 事件写盘降频，以及 post-reply worker 记忆写入和向量巡检不再常驻全量索引。验收结果：新增脚本清单回归先红后绿；`npm run smoke:runtime-hotfixes` 本地通过。小目标已完成。

更新 2026-07-09 09:18 +08:00：修复 post-reply worker 记忆写入和向量巡检的内存常驻增长：写入去重/冲突检查改为按候选实际 shard 冷读，不再触发全量 `memory_items/memory_index` 聚合缓存；Memory V3 LanceDB dry-run plan 不再默认加载全量 embedding cache，watchdog 每轮 summary 后会清理 embedding index 缓存。验收结果：`node tests\memoryWritePipeline.test.js`、`node tests\memoryV3RecallVerificationFilter.test.js`、`node tests\postReplyVectorWatchdog.test.js` 通过；真实数据隔离探针显示写入校验后 `heapUsed≈11.3MB`，LanceDB plan 不加载 embedding cache 时 `heapUsed≈11.5MB`。小目标已完成。

更新 2026-07-09 09:02 +08:00：已收敛运行期写盘风险：NapCat 原始包日志默认关闭，仅在 follower 监控或 `FOLLOWER_PACKET_LOG_ENABLED=true` 时写入；Memory V3 事件从每条同步刷盘改为批量缓冲，同进程读取前会刷待写队列。验收结果：语法检查和 `node scripts\run-tests.js tests\napcatPacketLogConfig.test.js tests\memoryV3EventsDailyFiles.test.js` 通过。小目标已完成。

更新 2026-07-08 13:44 +08:00：定位今天 `data/passive-awareness-decisions.jsonl` 中群 `1092700300`/`597801651` 的图片 `visual-cue-probe` 静默不回复：真实 decision 路由为 `passive-awareness/decision -> catiecli.sukaka.top -> gcli-gemini-3-flash-preview-nothinking`，视觉探针按昨天修复走 3000ms/0 retry，408 被 catch 后只生成 `shouldReply=false`，旧兜底又只覆盖 `bot_direct/bot_presence_check`。最小修复为仅在 `visual-cue-probe` 且本地 addressee 为 `group_bot_topic/group_open_question` 时允许 decision 失败后进入回复模型，不放开纯 `unclear` 图片。验收结果：新增视觉探针 408 兜底回归、原视觉探针、强 cue、bot topic guard、语法检查和 `git diff --check` 通过。小目标完成：图片类 bot 话题/开放问题在 decision 上游 408 抖动时不再被直接静默误杀。

更新 2026-07-07 17:53 +08:00：定位 `queued request timed out after 30000ms` 为 `default/general` lane 同 session 入站锁前排队：`req_0f82466d6ad433cd` 拿到 `qq-group:1092700300:user:1626492260` 锁后在非 @bot 图片消息的 `visual-cue-probe` 被动群感知链路内运行约 66.3s，后续 `req_a9fd34e2f1c9f29b` 只到 `message_ingress` 未拿锁。修复为给视觉探针单独 3000ms/0 retry 短预算，普通被动决策预算不变；验收结果：被动视觉探针、被动回复、入站并发回归和 `git diff --check` 通过。小目标完成：私聊完全开放状态下，群聊非 @bot 视觉探针不再长时间占住主入站锁。

更新 2026-07-07 11:29 +08:00：已完成远端服务器资源清理，卸载 AstrBot 与 SillyTavern，并将 `/www/swap` 从 6M 重建为 2G；systemd journal 限制为 200M，清理 APT 缓存、旧 snap 修订和语言工具缓存。验收结果：`astrbot`/`sillytavern` 服务与进程均不存在，`/` 使用率降至 56%，可用内存约 2.2GiB，swap 可用 2.0GiB。小目标已完成：释放磁盘和内存压力，且未改动其他业务服务。

更新 2026-07-07 11:10 +08:00：新增统一外发来源诊断，主回复/流式回复、被动群感知、tickEngine、dailyShare、lifeScheduler 和 schedulerRuntime 最终发消息时会在 outbound perf 事件或现有日志里带出 `source`、`routePolicyKey`、`triggerReason`。验收结果：`node tests\outboundMessageDiagnostics.test.js`、`node tests\messageHandlerCreateCommand.test.js`、`node tests\passiveAwarenessDecisionEmptyOutput.test.js`、`node tests\passiveAwarenessBotTopicGuard.test.js` 通过。

更新 2026-07-07 10:50 +08:00：普通用户私聊回复出口也会经过敏感词库拦截，管理员用户私聊不走该词库拦截；群聊出口保持原逻辑。验收结果：普通私聊非流式/流式命中测试词均替换为固定提示，管理员私聊同样文本原样发送。

更新 2026-07-07 10:49 +08:00：普通用户 `prompts/defaut.txt` 注入范围收敛为只在群聊主回复相关入口生效：普通私聊主回复不注入，被动群感知回复不注入，普通群聊主回复和仍可能启用的群聊 `normal_fast_reply` 继续注入；stable prompt 缓存键加入聊天 surface，避免同一用户私聊/群聊串用缓存。验收结果：发送链路回归、主回复 stable prompt、被动回复 prompt、快回复和 prepare fallback 定向测试通过。

更新 2026-07-07 10:33 +08:00：群聊出口敏感词 guard 不再把“角色扮演/设定”等虚构语境当作政治敏感命中的豁免；强政治词仍直接拦，词库命中且出现现实政治语境时仍拦，普通架空设定短词不拦。验收结果：角色扮演设定叠加现实政治样例仍会拦截，普通架空设定样例不拦截。

更新 2026-07-07 10:22 +08:00：私聊并发默认收口为多用户并行、同用户串行：`PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY=3`、`PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY=3`、`PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT=1`；当前本地 `.env` 也按该策略调整。发送成功后的后台持久化现在按 `sessionKey` 串行，避免同一私聊下一轮读到上一轮尚未落盘的短期记忆。小目标完成：私聊多用户并发不再靠放开同用户并发实现。

更新 2026-07-07 10:29 +08:00：定位今天新出现的 `memoryReranker` 1500ms timeout 来源：本地 7/7 窗口 `data/model-calls.ndjson` 只有 5 条 `memory_rerank`，均为成功，`memory_v3` 4 条最大 1009ms、`memory_write` 1 条 484ms；`data/bot-runtime.err.log` 的 1500ms warning 对应主回复 `chat/default -> runtime_v2_memoryCliTurn -> memory_v3` 召回外层硬预算，不是昨天的 persona worldbook 700ms 路径，也不是新 provider 调用链。现共享 rerank 默认 floor 从 1500ms 收敛到 2000ms，显式短 timeout 保持不变。验收结果：`node tests\memoryReranker.test.js`、`node tests\lowResourceConfig.test.js`、`node tests\personaModules.test.js`、`git diff --check` 通过；配置探针显示 `resolvedDefault=2000`、`explicit120=120`。小目标完成：主回复 Memory V3 rerank 不再贴着 1500ms 外层预算运行。

更新 2026-07-07 10:28 +08:00：已核对并归档历史 LangGraph V2 stale checkpoint 残留；诊断原先只展示 20 条样本，真实审计为 25 个，均已到 `direct_reply` 的 `final_output/node_complete` 终态且 30 分钟内无活跃写入。验收结果：25 个 checkpoint 已移动到 `data/langgraph_v2_checkpoints_archive/stale-history-20260707-langgraph-v2` 并保留 manifest/原事件文件，`npm run diag:runtime -- --json` 返回 `overallStatus=ok`、`signals=[]`、`activeCheckpoints=0`、`staleRunningCheckpoints=0`。

更新 2026-07-07 10:24 +08:00：新增群聊主动外发总开关 `PROACTIVE_GROUP_OUTBOUND_ENABLED`，默认 `true`，用于统一控制 tick touch / fallback greeting / daily share 群发送 / life scheduler 群广播；设为 `false` 时这些主动群发会跳过并在诊断中显示 `proactive-group-outbound-disabled`，明确 @bot 的主回复不受影响。验收结果：新增总闸、主动入口和运行态诊断回归通过；`npm run diag:runtime -- --json` 可查看 `summary.proactiveGroupOutbound` 当前状态。

更新 2026-07-07 10:15 +08:00：复查当前 `prompts/defaut.txt` 未提交删减的真实发送影响面：该块仍进入普通用户主回复 stable system、被动群感知回复 system message 和仍可能启用的 `normal_fast_reply` system prompt；管理员链路、被动决策模型和 user prompt 正文不注入。验收结果：新增发送链路回归、既有主回复/被动/快回复回归、`npm run check:prompts` 和 `git diff --check` 通过。小目标完成：未恢复旧 prompt 文案，但当前普通用户边界块不会在三类真实回复入口里被绕过。

更新 2026-07-06 20:10 +08:00：关闭 `normal_fast_reply` 后仍异常主动外发的根因已定位为两条链路：群聊主回复入口把 `reply_to_bot_recent` 当正式点名放行，以及被动群感知把裸 `bot/机器人` 话题升为 `bot_direct/strong-bot-cue`。现群聊正式主回复只接受私聊或明确 @ bot，裸 bot 话题只进入话题观察；被动 follow-up 仅允许明确强点名续接。验收结果：新增主回复入口、bot cue、被动话题 guard 回归及相关旧测试通过，已重启本地 bot。小目标完成：普通群聊消息不会再因近期 bot 回复或裸 bot 话题误判而主动外发。

更新 2026-07-06 15:10 +08:00：定位普通群聊 `normal_fast_reply` 的 `response_parse_empty`：`req_f1759e115a4b8739` 及同日同类样本均为 `gcli.ggchan.dev / gemini-3-flash-preview-search` 非流式 HTTP 200 后 `finish_reason=length` 且无可用正文；不是网关结构兼容问题，也不是 prompt 超长。现快回复可用 `NORMAL_FAST_REPLY_*` 独立配置，未配置时会把继承主模型的 `-search/_search` 后缀降为非 search 变体；同时 `model-calls` 对 JSON 字符串响应补记 `usage/finish_reason`。验收结果：定向快回复模型选择、字符串响应记录和 COT/参数回归通过。小目标完成：普通快回复默认不再继承 search 变体导致空正文。

更新 2026-06-23 09:42 +08:00：主 bot 仍保持 OneBot 单入口单实例；本地 CPU/同步文件型后台重活通过受控 `worker_threads` 池处理，默认 `BOT_WORKER_THREADS_MAX=2`。后台学习 worker 默认并发提升到 `POST_REPLY_WORKER_CONCURRENCY=2`，资源压力态会按 `POST_REPLY_WORKER_PRESSURE_MAX_CONCURRENCY=1` 回落；embedding backfill 与图片视觉摘要默认并发为 2。验收结果：7 个定向并发/线程池测试均通过；`npm run diag:runtime -- --json` 返回 warning，但主进程 `processCount=1` 且 post-reply 队列 `queued=0/processing=0`；`npm run diag:main-reply-lag -- --json --no-provider-diagnostic --window=24h` 仍判定瓶颈为 `main_model`，hotspots 已输出 `workerThreads.enabled=true/maxWorkers=2/active=0/queued=0`。小目标完成：默认受控多线程与后台并发扩容已落地。

更新 2026-06-24 01:31 +08:00：主回复和图片总结上下文收到 HTTP 408 时不再自动重试；这类网关超时可能只是上游生成慢，服务端仍会完成，自动重试会造成重复主模型调用。普通网络错误、5xx、409/425/429 和非主回复 408 的既有重试策略保持不变。验收结果：新增 408 重试策略回归通过，相关 HTTP client 与图片总结定向测试通过；`git diff --check` 通过。小目标完成：管理员主模型慢成功 408 不再被本地重试放大。

更新 2026-06-24 09:40 +08:00：新增最小诊断入口 `npm run diag:main-model-retry-duplicates -- --around "2026-06-24T00:47:59+08:00" --window 5m --admin-only`，可直接交叉扫描 `data/request-trace.ndjson` 和 `data/model-calls.ndjson`，识别同一 requestId 因 HTTP 408 且 retryable 后继续发起主模型调用的疑似重复样本。验收结果：新增回归 `node scripts/run-tests.js mainModelRetryDuplicateDiagnostics.test.js` 通过；本地现场样本命中 `req_a82a87717e2f479f`，显示 attempt 1/2 为 408、attempt 3 成功。小目标完成：408 重试重复主模型调用排查闭环已落地。

更新 2026-06-24 10:21 +08:00：`memoryReranker` 召回退化闭环复查今天 `data/bot-runtime.err.log` 的 `800ms/1200ms` 超时样本；`data/model-calls.ndjson` 中 6/23-6/24 共 71 条 `memory_rerank` 底层调用全部成功，p95/p99 为 `732/996ms`，只 2 条超过 800ms、无超过 1200ms，瓶颈判定为本地 800ms 预算贴近尾延迟而非调用链阻塞或无门禁重复触发。现运行配置来源的 rerank timeout 会受 `MEMORY_RERANK_TIMEOUT_FLOOR_MS=1500` 下限保护，显式测试/特殊调用的短 timeout 仍原样生效。验收结果：`node tests\memoryReranker.test.js` 覆盖默认预算下限和显式超时分支。小目标完成：热路径不再因 800ms 尾延迟误伤频繁回退到 base recall。

更新 2026-06-24 10:25 +08:00：图片视觉摘要长期记忆链路补齐 400 诊断。HTTP 失败进入 cooldown 时会在 `image_memory_index` 的 `visualSummaryState` 留下脱敏 `errorDiagnostic/requestDiagnostic`，用于区分请求体、模型参数或上游约束；目标测试和语法检查通过。

更新 2026-06-24 10:28 +08:00：被动群感知决策模型空正文不再混记为 `invalid-json`，会记录为 `empty-output` 并输出 `finishReason/hasReasoning` 诊断；本地决策模型从 `opencode.ai + mimo-v2.5-free` 切回已验证可返回 JSON 的 `。验收结果：最小 JSON 探针返回可解析 `should_reply=false`；决策空正文回归、强 cue 兜底回归和语法检查通过。小目标完成：群  的 `group-awareness decision model returned non-json output` 已定位为模型选择导致的空正文，而非提示词或响应解析。

更新 2026-06-24 18:01 +08:00：新增 `npm run diag:memory-rag-explain -- --user-id <id> --query "<text>"` 最小本地诊断入口，复用现有 Memory V3 / diagnosis 链路，直接输出一次主回复记忆召回的候选来源、journal segment 命中、long-term/profile 命中、rank fusion / rerank、journal-vs-long-term 去重和最终保留结果。验收结果：`node tests/memoryV3RagExplainDiagnostic.test.js`、`node tests/memoryV3RagExplainDedupStage.test.js` 通过。小目标完成：真实 `userId + query` 的 RAG explain 闭环已可本地直接跑通。

更新 2026-06-25 13:45 +08:00：`npm test` 挂住根因已定位为测试子进程继承本机 `.env` 后误开 CycleTLS/Memory CLI rerank，导致本地型单测断言结束后残留 `::1:9119` Socket；另有股票高级测试真实访问外网导致 TCP 等待。验收结果：原 33 个超时文件按小分片全部通过，新增 runner 默认环境回归和股票测试网络 stub 回归通过；未跑全量。

更新 2026-06-25 13:36 +08:00：主回复最终组装层不再把已进入 canonical segments 的 retrieved memory / daily journal / short-term continuity 再作为 dynamic system blocks 注入，recent history 也会剔除与当前 user turn 完全相同的副本。验收结果：`node tests/conversationContextClaudeCacheMarkers.test.js`、`node tests/runtimeStreamingCoordinator.test.js`、`node -e "require('./tests/runtimeV2MainReplyMemoryOrder.test.js')().catch((error)=>{ console.error(error); process.exit(1); })"` 通过。小目标完成：主回复慢样本里的重复上下文拼装点已收口。

更新 2026-07-06 14:58 +08:00：Anthropic prompt cache 保持默认 `5m`，稳定 system 已有缓存断点时不再额外保留工具断点，避免第三方网关按最后断点写入导致稳定前缀复用变差。验收结果：`node tests\httpClientAnthropicPromptCache.test.js`、`node tests\openAIMainPromptCacheDualProtocol.test.js`、`node tests\providerRequestDiagnostics.test.js`、`node scripts\diagnose-provider-request.js --scenario admin_reply` 通过，诊断显示 `anthropicCacheBreakpoints=1`、`anthropicPromptCacheTtl=5m`。小目标完成：Anthropic 主回复缓存断点收敛到稳定 system 前缀。

更新 2026-07-06 15:05 +08:00：定位 `memoryReranker` 仍出现 `700ms` 回退的根因是 persona worldbook rerank 把 `PERSONA_WORLDBOOK_RERANK_TIMEOUT_MS=700` 当显式 timeout 传入共享 reranker，从而绕过 `MEMORY_RERANK_TIMEOUT_FLOOR_MS=1500`；今天 `data/model-calls.ndjson` 中 32 条 `memoryReranker` 全部成功，p95/max 为 `549/611ms`，不是并发挤压或网关尾延迟。现 worldbook 配置型 rerank timeout 也会吃共享 floor，调用方显式 `rerankTimeoutMs` 仍保持原样。验收结果：`node --check utils\personaWorldbookSearch\rerank.js`、`node tests\personaModules.test.js`、`node tests\memoryReranker.test.js` 通过。小目标完成：worldbook rerank 不再因配置型 700ms 绕过 timeout floor。

更新 2026-07-06 15:10 +08:00：群聊 `normal_fast_reply` 门禁新增 bot 指向检查，普通群聊 `direct_chat` 不再绕过被动感知链路误触发回复；只有 `address_bot` / `reply_to_bot` 等明确指向 bot 的群消息才允许走 fast path。验收结果：`node tests\normalFastReplyGate.test.js`、`node tests\normalFastReplyHandlerSource.test.js`、`node tests\messageHandlerNormalFastReplyRateLimit.test.js` 通过。小目标完成：普通群聊消息不会因 fast reply 误判导致 bot 错误回复。

更新 2026-07-06 18:17 +08:00：按运行要求关闭 `normal_fast_reply`，本地 `.env` 已将 `NORMAL_FAST_REPLY_ENABLED=false`，代码默认和 `.env.example` 原本也保持关闭。验收结果：配置加载探针返回 `false`，gate 回归通过。小目标完成：当前本地运行配置不会再进入普通快速回复链路。

更新 2026-07-06 15:37 +08:00：定位 `1960901788` 连续缺 daily journal summary 的根因是 `TICK_ENGINE_ENABLED=false` 时 summary runner 没有独立调度；现 tick 关闭时会启动 daily journal summary scheduler，诊断按已到期日统计缺口且不误报当前日。验收结果：目标用户 `2026-06-23` 至 `2026-07-05` dry-run 全部 `skipped_existing`，`npm run diag:runtime -- --json` 显示 `summaryDueDay=2026-07-05`、`standaloneEnabled=true`。小目标完成：指定窗口已补齐，`2026-07-06` 等次日调度安全汇总。

更新 2026-06-25 23:19 +08:00：`scripts/console.js` 新增 `rag` / `memory-rag-explain` 子命令，复用既有 `diag:memory-rag-explain` 实现，可用 `npm run console -- rag <userId> "<query>"` 更快按真实用户和问题跑 Memory RAG explain。验收结果：`node scripts/run-tests.js consoleMemoryRagExplainEntry.test.js`、`node scripts/run-tests.js memoryV3RagExplainDiagnostic.test.js memoryV3RagExplainDedupStage.test.js`、`node --check scripts/console.js`、`node --check tests/consoleMemoryRagExplainEntry.test.js`、`git diff --check` 通过；隔离空数据目录 smoke 在关闭 embedding/rerank 后也可输出 `memory_v3_rag_explain_diagnostic_v1`。小目标完成：真实 `userId + query` 的本地 explain 入口已收口到 console 快捷命令。

更新 2026-06-26 22:13 +08:00：`SHORT_TERM_MEMORY_MAX_TOKENS` 和 `ADMIN_SHORT_TERM_MEMORY_MAX_TOKENS` 从 `120000` 收敛到 `9200`，让普通主回复与管理员主回复短期历史压缩阈值从约 `84000` tokens 降到约 `6440` tokens，避免长会话继续堆到 2 万级输入。验收结果：`node -e "const config=require('./config'); const {getShortTermCompressionSettings}=require('./utils/shortTermMemory'); console.log(JSON.stringify({shortTermMemoryMaxTokens:config.SHORT_TERM_MEMORY_MAX_TOKENS,adminShortTermMemoryMaxTokens:config.ADMIN_SHORT_TERM_MEMORY_MAX_TOKENS,normalTriggerTokens:getShortTermCompressionSettings({}, {userId:'normal-user'}).triggerTokens,adminTriggerTokens:getShortTermCompressionSettings({}, {userId:'1960901788'}).triggerTokens}))"` 输出 `{"shortTermMemoryMaxTokens":9200,"adminShortTermMemoryMaxTokens":9200,"normalTriggerTokens":6440,"adminTriggerTokens":6440}`。小目标完成：普通用户与管理员短期历史压缩阈值已按 9200 配置生效。

更新 2026-06-27 00:08 +08:00：新增 NapCat WebSocket 入站最小 smoke，使用本地假 WS 服务验证 `NAPCAT_WS_URL` 收到 OneBot 消息后会以 `source=napcat_ws` 投递到 `messageIngressDispatcher`，与 HTTP reverse 入站共用同一投递收口。验收结果：`node scripts\run-tests.js tests\napcatWsIngressSmoke.test.js tests\napcatHttpReverseServer.test.js tests\messageIngressDispatcher.test.js tests\messageIngressAsyncEntrypointSource.test.js` 通过；相关 `node --check` 通过。

更新 2026-06-27 00:26 +08:00：复跑 NapCat WebSocket 入站 smoke，并补强静态入口断言，确认共用收口仍调用 `acceptIncomingMessage(msg, source)` 后进入 `messageIngressDispatcher`；同一组 run-tests 和 `node --check` 均通过。

更新 2026-06-27 11:05 +08:00：复查 `SHORT_TERM_MEMORY_MAX_TOKENS=9200` 生效后的真实运行日志。未过滤时间的 `diag:main-reply-token-budget` 仍能看到修复前旧峰值 `24353`；按 `2026-06-26 22:13 +08:00` 后交叉扫描 `data/model-calls.ndjson` 与 `data/request-trace.ndjson`，主回复样本 `19` 条、最大输入 `17876`、`>20k=0`，最新样本 `req_e249a020c5b84e63` 为 `13466`。小目标完成：修复后窗口没有 2 万以上主回复输入，本轮无需改代码。

更新 2026-06-27 22:10 +08:00：新增最小本地入口 `npm run smoke:napcat-ingress`，只复用既有 NapCat WebSocket smoke、HTTP reverse server 回归、`messageIngressDispatcher` 回归和入口静态断言，统一验证 `NAPCAT_WS_URL` 与 HTTP reverse 入站都会投递到 `messageIngressDispatcher`。验收结果：`npm run smoke:napcat-ingress`、相关 `node --check` 和 `git diff --check` 通过。

更新 2026-06-27 22:20 +08:00：新增 `npm run verify:main-reply-token-budget`，把 `SHORT_TERM_MEMORY_MAX_TOKENS=9200` 生效后的主回复输入收口条件固化为本地 smoke：默认读取 `data/model-calls.ndjson` 与 `data/request-trace.ndjson`，统计 `2026-06-26T22:13:00+08:00` 后非图片主回复样本，阈值 `20000`，失败时列出超阈值 requestId。验收结果：`node scripts\run-tests.js mainReplyTokenRegressionCheck.test.js` 通过；`npm run verify:main-reply-token-budget -- --limit=5` 通过，真实样本 `36` 条、最大 `17876`、超阈值 `0`。小目标完成：主回复输入 token 回归检查已可复跑。

## 技术栈

| 层 | 选型 |
| --- | --- |
| Runtime | Node.js 20.x、CommonJS、LangGraph |
| 模型适配 | Anthropic Messages、OpenAI 兼容、Gemini 风格 provider |
| QQ 接入 | NapCat、OneBot WebSocket / HTTP action |
| 存储 | JSONL、SQLite、LanceDB、本地分片文件 |
| Web | Express 本地管理入口 |
| 测试与诊断 | 自研 `scripts/run-tests.js`、prompt 检查、运行态诊断脚本 |

## 主链路

```text
NapCat / OneBot
  → core/messageHandler.js
  → core/messageIngress.js
  → core/router/index.js
  → core/routeExecution.js
  → core/messageRouteFlow/index.js
  → api/runtimeV2/host/index.js
  → Runtime V2 nodes / tools / memory
  → QQ 回复发送
  → post-reply worker / memory / diagnostics
```

## 快速开始

### 环境要求

- Node.js 20.x（以项目根目录 `.nvmrc` 为准）
- npm
- NapCat / OneBot
- 可用的模型 API Key

### 安装

```bash
npm install
```

### 最小 `.env`

```env
API_KEY=你的模型 API Key
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_WS_TOKEN=
DATA_DIR=./data
```

### 启动

```bash
npm start                 # 主 bot
npm run console           # 交互控制台
npm run start:post-reply-worker   # 单独跑后台学习 worker
```

### NapCat HTTP reverse 鉴权

HTTP reverse 入口必须配置 `NAPCAT_HTTP_REVERSE_SECRET`。原生 NapCat HTTP client 按 OneBot 11 标准发送 `X-Signature: sha1=<hex>`，该签名不受 `NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER` 开关影响；旧式 Bearer/token 仅在显式开启兼容模式时接受。反向代理或自定义客户端应发送 `X-NapCat-Timestamp`、`X-NapCat-Nonce` 和 `X-NapCat-Signature: sha256=<hex>`，签名正文为 `timestamp.nonce.rawBody`。签名请求会校验时间窗并拒绝 nonce 重放，静态 Bearer 兼容模式不具备防重放能力。

```bash
npm run smoke:napcat-ingress
node scripts/run-tests.js tests/napcatHttpReverseServer.test.js
```

Compose 默认只把 3002 发布到宿主 loopback；跨主机接入必须经过受控代理，并在所有调用方支持签名后关闭 `NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER`。

## 常用命令

```bash
# 测试与检查
npm test
npm run lint
npm run check:prompts
node scripts/run-tests.js tests/napcatWsIngressSmoke.test.js

# 诊断
npm run diag:napcat-health -- --text
npm run diag:main-reply
npm run diag:memory -- audit --limit 5
npm run console -- rag <userId> "<query>"
```

### 瑞希瑞幸

`瑞希瑞幸` 是独立命令入口，不会因普通聊天提到瑞幸或咖啡触发。配置 `LUCKIN_MCP_GLOBAL_TOKEN` 后可在群里预览门店商品；创建订单、查单、取消订单需要用户在私聊临时提供个人 Token。

```env
LUCKIN_MCP_GLOBAL_TOKEN=
LUCKIN_MCP_ENDPOINT=https://gwmcp.lkcoffee.com/order/user/mcp
LUCKIN_MINIAPP_CARD_PAYLOAD=
```

详细边界见 [`docs/luckin-command.md`](docs/luckin-command.md)。

### Windows 本地运维

更新 2026-06-26 09:56 +08:00：修复确认重启在 stale pid + 空进程列表下的 PowerShell `Process` 参数绑定错误；验收结果见 `docs/windows-restart-diagnosis.md`。

```bash
restart-bot.cmd status
restart-bot.cmd restart confirm
npm run win:daemon:status
```

### Linux 运维

```bash
npm run linux:install
npm run linux:start
npm run linux:status
npm run linux:logs
```

### Docker 运维

```bash
docker compose up -d --build
docker compose logs -f mizukibot
docker compose logs -f post-reply-worker
```

Docker 部署说明见 [`deploy/docker/README.md`](deploy/docker/README.md)；第一次用容器部署先看 [`deploy/docker-beginner-guide.md`](deploy/docker-beginner-guide.md)。

更新 2026-06-25 13:00 +08:00：`amia/dev` 的 Docker 构建只复制运行白名单；真实 `.env`、运行数据、密钥文件、本地 MCP 配置和私有 prompt 不进入镜像，私有 prompt 由 Compose 运行时只读挂载。

更新 2026-06-26 01:52 +08:00：本地 WSL/Docker 链路已用国内镜像源完成真实 smoke：DaoCloud 拉取基础镜像，Dockerfile 依赖安装默认走 `registry.npmmirror.com`，临时端口 `49105/49106` 下 `docker-compose build`、`docker-compose up -d`、Web security status 200、NapCat reverse 鉴权请求 204 和容器内 Node 语法检查均通过；当前探针必须携带兼容 token 或签名头，空对象 POST 不再是有效探针。

更新 2026-06-26 02:30 +08:00：复查 Git、忽略规则和 `mizukibot:local` 镜像，未发现真实 `.env`、密钥文件、本地 MCP 配置、私有 prompt 或运行数据进入仓库/镜像；新增初学者容器化部署文档。

### NPM 发布

发布包使用 `package.json` 的 `files` 白名单，不包含真实 `.env`、运行数据、测试、MCP 本地配置、本地私有 prompt 或本地 `skills/` 目录。发布前检查见 [`docs/npm-publish.md`](docs/npm-publish.md)。

更新 2026-06-23 12:38 +08:00：`npm publish` 会先执行 `prepublishOnly` / `npm run publish:check`，登录后真实发布命令为 `npm publish --access public`。

## 目录结构

```text
api/        模型调用、工具注册、Runtime V2、Agent 能力
core/       QQ 消息入口、路由、调度、被动感知和主动任务
utils/      记忆、prompt、诊断、存储和工具策略
config/     环境变量解析和运行时配置
prompts/    人格、系统提示词、worldbook 和 prompt manifest
scripts/    启动、测试、诊断、部署和维护脚本
tests/      单元测试和回归测试
web/        本地管理 Web 服务
docs/       架构说明、维护记录和排障文档
data/       本地运行数据，默认不提交
```

## 项目演进

这个项目从一个 QQ 角色聊天机器人，一步步长成能长期运行的 Agent Runtime。早期先打通 NapCat 接入、主回复链路和基础 prompt，随后补上路由、工具、记忆、主动任务和后台学习，形成"消息进入 → 路由判断 → Runtime 执行 → 回复发送 → 持久化/学习"的闭环。

一路下来的主要工程动作：

- **Runtime V2**：把准备上下文、路由、planner、工具 dispatch、回复草稿、润色、校验、持久化拆成可测试节点，压低单文件主流程复杂度。
- **记忆重构**：从全量 JSON 常驻内存改成磁盘优先、按用户/群组分片召回，减轻启动和回复路径的内存压力。
- **延迟治理**：定位连续消息聚合、入站锁、流式生成和 QQ 发送阶段的耗时，给普通群文本、图片、引用分别设等待策略。
- **安全与角色边界**：普通用户、管理员、被动群感知、fast reply 各自接入安全 prompt、回复标记和 emoji 反馈，不让安全规则只卡在单一路径。
- **清理历史隐私**：从 Git 历史移除本地截图、运行数据、评估样本、备份包和代理本地配置，`.gitignore` 阻止再次入库。
- **Anthropic prompt cache**：统一最终请求里的缓存断点、TTL 和网关 header，避免动态历史消息破坏缓存命中。
- **Windows 运行加固**：修双击重启、远程重启、旧进程清理、worker 残留、锁文件和成功反馈，让本地长期跑更可控。
- **复杂度治理**：拆大文件、补诊断脚本、沉淀维护日志，README 也从维护流水账收回到项目入口该有的样子。

## 文档入口

- [`docs/development/README.md`](docs/development/README.md) — 开发者源码阅读、架构、功能开发、测试与排障指南
- [`docs/maintenance-log.md`](docs/maintenance-log.md) — 近期维护记录和验收结果
- [`docs/repository-structure.md`](docs/repository-structure.md) — 目录边界和清理规则
- [`docs/main-reply-context.md`](docs/main-reply-context.md) — 主回复上下文设计
- [`docs/post-reply-worker.md`](docs/post-reply-worker.md) — 回复后学习 worker 说明
- [`docs/luckin-command.md`](docs/luckin-command.md) — 瑞希瑞幸命令、Token 策略和验收命令
- [`docs/project-development-history.md`](docs/project-development-history.md) — 基于 Git 历史整理的开发过程
- [`docs/npm-publish.md`](docs/npm-publish.md) — npm 发布边界和检查命令
- [`deploy/beginner-guide.md`](deploy/beginner-guide.md) — 面向初学者的部署指南
- [`deploy/docker-beginner-guide.md`](deploy/docker-beginner-guide.md) — 面向初学者的容器化部署指南
- [`scripts/README.md`](scripts/README.md) — 脚本说明
- [`deploy/README.md`](deploy/README.md) — 部署说明

---

更新时间：2026-08-16 10:50 +08:00
维护记录：2026-07-31 02:15 +08:00，提交 `1674530` 新增 8 篇独立开发者源码文档及完整性回归；Node 20.20.2 下文档链接/路径/npm 脚本检查、测试运行器回归、lint、typecheck、Agent 静态检查、prompt 检查和全仓 secrets 检查均通过，小目标已完成，未推送远端。
维护记录：2026-07-24 08:21 +08:00，提交 `bc1d10f` 将 `meme` 的9个chunk迁为显式CommonJS模块，93/93函数、16项API、legacy与5个子门面身份、6项singleton和0本地循环均已验收；Node 20/24聚焦、静态门禁及Node 24并发4全量521个tracked测试通过，目标5推进至3/6。
维护记录：2026-07-21 21:42 +08:00，`passive-awareness` 已完成显式CommonJS迁移，21项API和5个子门面契约保持不变；静态门禁和并发4全量通过，目标5推进至2/6。
维护记录：2026-07-21 20:52 +08:00，`daily-share` 已完成显式CommonJS迁移，生产路径不再执行对应chunk；Node 20定向、静态门禁和Node 24并发4全量通过，目标5推进至1/6。
维护记录：2026-07-17 02:58 +08:00，重启与Windows daemon大型源码断言已迁为真实PowerShell行为验证；静态门禁、依赖审计和并发4全量142.5秒通过，目标23完成。
维护记录：2026-07-17 01:27 +08:00，正常停机与远程重启已统一到单一生命周期协调器，远程重启等待完整排空；静态门禁、依赖审计和并发4全量125.3秒通过，目标14完成，目标27保留真实Docker/SIGTERM探针。
维护记录：2026-07-17 00:19 +08:00，目标20完成请求追踪标识 keyed hash 迁移；request-trace/model-calls 隐私测试、全量静态门禁和并发4全量104.6秒通过。
维护记录：2026-07-16 23:46 +08:00，新增默认预览、显式Apply、递归快照的Windows敏感路径ACL工具；真实服务身份、49,147项数据预览及并发4全量108.8秒已验收，实际ACL因并行工作未应用，目标4保持部分完成。
维护记录：2026-07-16 22:52 +08:00，真实 Node 20.20.2 通过隔离 ABI 115原生依赖探针与并发4 tracked全量测试，SQLite `quick_check=ok`，全量耗时151.7秒；目标31完成。
维护记录：2026-07-15 12:17 +08:00，提交 `a4ce6cc` 固定全部 workflow Action SHA并新增 gitleaks、许可证/SBOM与 OSV三作业门禁；Node 20定向、静态门禁和 Node 24并发4全量105.2秒通过，目标29仍待真实远端扫描、Docker digest和 Trivy验收。
维护记录：2026-07-14 16:50 +08:00，提交 `c12ec87` 新增精确生产许可证策略与 npm CycloneDX SBOM wrapper；330个生产 lock 条目和真实275组件/276依赖 SBOM 已验收，目标29保持部分完成，外部扫描、不可变摘要、Node 20 与并发4全量仍待真实证据。
维护记录：2026-07-13 20:54 +08:00，提交 `fec175e` 增加主进程 `/live`/`/ready`、HTTP 有界关闭、热存储/SQLite 收尾和 post-reply worker 在途作业排空/状态探针；Node 20 定向、静态门禁和并发4全量93秒通过，目标27保持部分完成等待真实 Docker/SIGTERM 验收。
维护记录：2026-07-13 18:20 +08:00，提交 `0b89296` 将 `Intl` 在 Node 20 午夜返回的小时 `24` 统一归一化为 `0`，修复凌晨图片记忆跨日召回；Node 20/24 定向测试及并发 4 全量测试 90.6 秒通过。
维护记录：2026-07-13 05:44 +08:00，提交 `289035a` 将质量工具策略测试从 ESLint 配置源码正则迁为 ESLint API 的最终配置、忽略范围与真实规则诊断验证；静态门禁、定向测试及并发 4 全量测试 105.2 秒通过。
维护记录：2026-07-13 05:32 +08:00，提交 `9e11252` 将日志保留调用点测试从源码字符串迁为 8 个真实 writer 行为探针，并修复 `/dailyshare status` 未定义容量常量导致的异常；静态门禁、邻接测试及并发 4 全量测试 96.4 秒通过。
维护记录：2026-07-13 05:04 +08:00，提交 `a2ccc94` 将周期重启与计划任务安装守卫迁为真实无副作用 `-ValidateOnly` 行为测试，真实执行与验证共用同一启动计划/XML；定向行为、PowerShell AST、静态门禁及并发 4 全量测试通过。
维护记录：2026-07-13 04:44 +08:00，提交 `cc5cccb` 将测试子进程的临时目录统一重定向到工作树外的同盘目录，支持显式覆盖且不改变 tracked-only/fallback 发现语义；默认与自定义路径定向测试、静态门禁及并发 4 全量测试 93 秒通过。
维护记录：2026-07-13 04:23 +08:00，提交 `c973fe2` 为 chunk lint 增加可解析的完整覆盖报告，并将 facade/executable plan 测试迁为公开契约、canonical 接线和代表性行为验证；静态门禁、4 项定向测试及串行全量测试 264 秒通过，并发 4 全量受既有 `runTestsRunner.test.js` 时序竞争阻断。
维护记录：2026-07-13 03:32 +08:00，提交 `f2cd4b8` 将 GitHub Actions 与 Compose 安全守卫改为 YAML 结构断言，并对 15 个受 Git 跟踪 PowerShell 脚本新增零执行 AST 语法门禁；并发 4 全量测试 97.2 秒通过。
维护记录：2026-07-13 03:19 +08:00，提交 `269078f` 将主进程早退诊断和启动热路径守卫迁为真实行为测试，并修复 Memory V3 查询启动时提前载入 embeddingIndex 与完整 LanceDB store 的问题；并发 4 全量测试 98.7 秒通过。
维护记录：2026-07-13 02:57 +08:00，提交 `f0e472d` 将外部进程技能、Runtime persist 批处理接线和管理员重启命令的源码断言迁为真实行为测试，并修复 `/restart confirm` 引用未定义请求 ID 导致无法触发重启的问题；并发 4 全量测试 92.2 秒通过。
维护记录：2026-07-13 02:33 +08:00，提交 `fe80591` 引入 ESLint 9 flat config、10 个核心边界的渐进式 JavaScript 类型检查，并将 typecheck 接入 CI；并发 4 全量测试 108.2 秒通过。目标 10 已完成，目标 9 因全仓 unused、Promise executor 返回值和复杂度基线仍保持部分完成。
维护记录：2026-07-09 19:09 +08:00，新增独立 `瑞希瑞幸` 命令：仅命令前缀触发，群聊菜单/推荐/预览，私聊使用临时个人 Token 创建订单、查单、取消订单并只展示支付二维码链接；接入官方 `my-coffee` skill 和瑞幸 streamable HTTP MCP 配置。验收结果：瑞希瑞幸定向测试、消息入口回归、MCP lazy discovery 回归、`.mcp.json` 解析、message handler 加载和 `git diff --check` 均通过。小目标已完成。
维护记录：2026-07-09 17:45 +08:00，新增 `npm run smoke:runtime-hotfixes` 最小本地 smoke，固定今天 5 个运行时热修复的目标回归清单。验收结果：脚本清单回归先红后绿，`npm run smoke:runtime-hotfixes` 通过。
维护记录：2026-07-09 09:18 +08:00，已修复 post-reply worker 记忆写入/向量巡检内存常驻增长；写入管线只读候选 scope shard，LanceDB plan 不再默认加载全量 embedding cache，watchdog summary 后清理 embedding 缓存。验收结果：三项定向测试通过，隔离内存探针显示 heap 未再进入数百 MB 常驻。
维护记录：2026-07-09 09:01 +08:00，已修复 post-reply worker 对上游 495 的收尾路径：495 归类为 transient，模型型后台任务在相位最后一次重试仍失败时降级为 `skipped/upstream_495_degraded` 并继续收尾。验收结果：两个 2026-07-08 failed post-reply job 已转为 done；定向 post-reply 测试通过，`npm run diag:runtime -- --json` 显示 post-reply 队列 `queued=0/processing=0/failed=0`。小目标已完成。
维护记录：2026-07-09 09:02 +08:00，已完成运行期写盘降频：NapCat 原始包日志默认关闭且显式开关可控，Memory V3 事件写入改为批量缓冲；残留 embedding tmp 复查时已不存在，未执行删除。验收结果：相关语法检查与 `node scripts\run-tests.js tests\napcatPacketLogConfig.test.js tests\memoryV3EventsDailyFiles.test.js` 通过。
维护记录：2026-07-06 15:15 +08:00，群聊出口敏感词库保持启用，并新增默认政治语境门槛；单独命中词库不再直接替换，明确现实政治语境仍会拦截。验收结果：角色扮演样例不拦截，现实政治样例仍拦截，群聊发送路径回归通过。
维护记录：2026-07-05 09:28 +08:00，已将群聊出口敏感词库默认范围收窄到政治相关分类，仅加载 `反动词库.txt` 和 `政治类型.txt`；色情、枪爆、暴恐不再作为默认群聊出口词库拦截来源。验收结果：默认配置探针确认词量降到政治相关词库集合，非政治样例不再拦截，政治相关样例仍拦截；相关敏感词 guard 回归通过。
维护记录：2026-07-05 20:12 +08:00，已将图片理解 direct reply 超时显式设为 `IMAGE_MODEL_TIMEOUT_MS=75000`，避免图片总结请求继续按默认 18 秒过早失败。验收结果：本地配置加载探针确认图片模型超时为 75000ms；bot 已重启并完成运行状态检查。
维护记录：2026-06-28 10:20 +08:00，已按审阅优先级完成安全与诊断收口：Web 无 token 本地模式会识别本机反代转发的远程 `X-Forwarded-For`，MCP 配置不再使用 `@latest`，`npm run lint` 改为跳过独立 chunk 并验证组合入口，post-reply worker 诊断不再把 Windows `cmd.exe` 包装进程算成重复 worker。验收结果：相关定向测试、`npm run lint`、`npm run diag:security -- --json`、`npm run diag:runtime -- --json` 均已复跑；运行数据中仍有 failed post-reply jobs 和 stale LangGraph checkpoints，因涉及 `data/` 清理，本轮未擅自删除。
维护记录：2026-06-26 10:38 +08:00，`npm test` 已从“分片通过、未跑全量”收口到“本地完整全量通过”：本轮只修全量执行暴露的真实失败点，完整命令自然结束、退出码 0、用时约 292.5s，日志见 `D:\waifu\tmp\npm-test-full-20260626-103103.log`。
维护记录：2026-06-26 01:52 +08:00，Docker/Compose 链路已在 WSL 本地真实跑通：已处理历史 `wg0` 全流量路由、Docker bridge DNS 和官方源访问慢的问题；`docker-compose build --progress plain mizukibot` 成功生成 `mizukibot:local`，临时 `.env` 端口 `49105/49106` 下两个服务启动为 Up，`/api/security-status` 返回 200 且 `ok=true`，NapCat HTTP reverse 空 JSON POST 返回 204，容器内 `node --check` 三项通过，最后已 `docker-compose down` 清理。
维护记录：2026-06-25 23:45 +08:00，Docker/Compose 链路已做本地复核：`docker-compose config` 在 WSL 临时最小 `.env` 下通过，白名单文件集和私有 prompt 只读挂载检查通过，主进程按 Dockerfile 等价文件集可启动并通过 Web/NapCat reverse 基础探针；真实镜像构建被 `node:20-bookworm-slim` 从 Docker Hub 拉取元数据超时阻塞，且本机默认 3002/3005 正被当前宿主 bot 占用。小目标完成状态：已定位当前最可能启动断点和环境缺口，真实 `docker compose up -d --build` 需在镜像源可达且端口空闲环境复跑。
维护记录：2026-06-25 23:19 +08:00，`scripts/console.js` 已接入 `rag` / `memory-rag-explain` 快捷子命令，委托既有 `diag:memory-rag-explain`，可用 `npm run console -- rag <userId> "<query>"` 直接对真实用户问题跑 Memory RAG explain；最小入口回归、既有 RAG explain 回归、语法检查、隔离空数据目录 smoke 和 diff 检查均通过。小目标已完成：本地真实 `userId + query` explain 入口更顺手。
维护记录：2026-06-25 13:45 +08:00，已定位并修复 `npm test` 挂住的测试环境外部传输泄漏：runner 子进程默认关闭 CycleTLS 和 Memory CLI rerank，股票高级单测改为 stub 外网行情源；原超时集合小分片验收通过，未跑全量。
维护记录：2026-06-24 18:01 +08:00，已新增 `diag:memory-rag-explain` 最小本地诊断脚本，复用现有 Memory V3 / diagnosis 链路，直接按真实 `userId + query` 输出候选来源、journal segment 命中、long-term/profile 命中、rerank、journal-vs-long-term 去重和最终保留结果；并补齐两条最小回归覆盖真实链路与去重诊断。小目标已完成：主回复记忆召回 explain/diagnostic 已可本地直接验收。
维护记录：2026-06-24 15:53 +08:00，已定位 `tests/memoryV3PreferenceFacet.test.js` 和 `tests/memoryV3Query.test.js` 直接运行卡住的根因是默认 `MEMORY_RERANK_ENABLED=true` 会让本地型 Memory V3 测试误走 CycleTLS rerank 传输并留下 `::1:9119` 句柄；现仅对这两个测试关闭 rerank/embedding/LanceDB/CycleTLS 路径并新增非 stdio 句柄断言，直接运行可自然退出。小目标已完成：这两个 Memory V3 定向测试不再依赖 `process.exit(0)` 包装收尾。
维护记录：2026-06-24 12:08 +08:00，Memory V3 查询阶段新增 journal-vs-long-term 语义去重，重复候选只在本次召回结果中折叠并保留 duplicateEvidence 诊断。
维护记录：2026-06-24 12:01 +08:00，日记 segment 已按 session/topic 聚类后分别摘要和向量化，避免同一向量文档混入无关主题。
维护记录：2026-06-24 11:32 +08:00，日记 segment 默认批量从 10 条降到 6 条，降低混合话题摘要带来的无关召回风险。
维护记录：2026-06-23 23:36 +08:00，已收窄 QQ 群聊敏感词默认分类，并放行一批日常高频误伤词。
维护记录：2026-06-23 08:00 +08:00，本地 persona 与 admin prompt 已从 Git 跟踪中移除，并通过 `.gitignore` 保持本地私有。
维护记录：2026-06-23 09:00 +08:00，已重写 `master` 历史，`prompts/persona/` 和 `prompts/admin.txt` 不再出现在本地 Git 历史或对象列表中。
维护记录：2026-06-23 08:58 +08:00，已为 npm 发布增加白名单、dry-run 验收和敏感内容扫描记录，真实发布等待 npm 登录。
维护记录：2026-06-23 09:17 +08:00，已新增面向初学者的部署指南，覆盖 `.env`、私有 prompt、NapCat、启动和排障。
维护记录：2026-06-23 12:38 +08:00，已为 npm 发布增加 `prepublishOnly` 硬门禁，登录后可执行 `npm publish --access public`。
维护记录：2026-06-27 00:26 +08:00，已复跑 NapCat WebSocket 入站 smoke，并补强 `messageIngressAsyncEntrypointSource` 对共用收口投递 dispatcher 的静态断言；定向 run-tests 与相关 `node --check` 通过。
维护记录：2026-07-05 09:06 +08:00，已定位并隔离 `langgraph_v2_event_file_invalid` 的全 NUL 坏事件文件，诊断 JSON 现在会列出 `invalidEventFiles` 明细；`npm run diag:runtime -- --json` 复跑后该告警消失，剩余仅为既有 failed post-reply jobs 和 stale LangGraph checkpoints。
维护记录：2026-07-05 09:11 +08:00，已将 `data/post_reply_jobs/failed` 中 21 个历史 failed post-reply jobs 按错误原因分型后归档到 `data/post_reply_jobs/archive/failed-post-reply-jobs/failed-history-20260705-post-reply`：14 个 enrich HTTP 400 判为永久失败，6 个 429/503/timeout 属可重试错误但因 5 月历史任务不重新入队，1 个 stale-processing 恢复标记归档忽略。验收结果：归档脚本 dry-run/apply 均命中 21 件，`node scripts\run-tests.js tests\postReplyFailedArchive.test.js tests\postReplyFailureRequeue.test.js tests\postReplyQueueRepair.test.js` 通过，`npm run diag:runtime -- --json` 显示 post-reply 队列 `queued=0/processing=0/failed=0` 且 `post_reply_failed_jobs` 告警消失；未处理其他 `data/`。
维护记录：2026-07-05 09:14 +08:00，已修复图片 direct reply deferred persist 丢失 `_image` threadId 的收尾问题：后台持久化重算 threadId 时纳入 `imageUrl/imageUrls[0]`，并把实际 threadId 写回后台事件。验收结果：`node tests\messageTelemetry.test.js` 在临时 store 中确认 `transform_vision-summary_image` checkpoint 从 running 收尾为 `completed/persist`，相关定向测试、`npm run lint` 和 `npm run diag:runtime -- --json` 已复跑；真实诊断剩余 20 个 stale checkpoint 均按历史遗留处理，未删除运行数据。
维护记录：2026-07-07 10:28 +08:00，已核对 `langgraph_v2_checkpoint_stale`：诊断旧列表最多展示 20 条，真实历史残留为 25 个 stale running checkpoint，均已有 final output/finalReply 且无近期活跃写入。已归档到 `data/langgraph_v2_checkpoints_archive/stale-history-20260707-langgraph-v2` 并保留事件文件；`npm run diag:runtime -- --json` 复跑为 `overallStatus=ok`、`signals=[]`。
维护记录：2026-07-06 15:44 +08:00，已完成短期记忆上下文五项优化：session 写盘批处理、回复后 session summary 门禁、跨 session 合并上限、summary/raw turns 去重和无正文诊断脚本；新增阈值配置写入 `.env.example`。验收结果：定向语法检查、短期记忆/主回复上下文回归和 `diag:short-term-context` smoke 通过。小目标完成：短期记忆仍保留最近上下文，但默认不再把普通短聊每轮摘要化或无限合并 sibling session。
维护记录：2026-07-12 12:20 +08:00，已移除 JSON 热存储对 SIGINT/SIGTERM 的进程退出控制，由主入口完成运行时关闭后统一同步落盘；新增信号所有权回归测试，相关 4 项定向测试通过。
维护记录：2026-07-12 12:25 +08:00，主进程陈旧锁替换已增加原子获取门闩，退出时直接删除自有锁；双进程竞争连续 20 轮均仅一个实例成功启动。
维护记录：2026-07-12 12:40 +08:00，NapCat HTTP 反向入口已强制使用 timing-safe 共享密钥鉴权，缺少密钥拒绝启动；Docker 端口 3002 默认仅发布到宿主 loopback，匿名管理员伪造回归测试通过。
维护记录：2026-07-12 13:00 +08:00，`web_fetch` 与 RSS 已统一使用逐跳 DNS/重定向安全校验并固定连接到已验证公网 IP；私网 DNS 和 302 跳内网回归测试通过。
维护记录：2026-07-12 13:15 +08:00，NapCat 动作重试已按送达确定性分类：仅明确的连接前失败可重试，超时或响应丢失不再重发非幂等消息；相关 4 组定向测试通过。
维护记录：2026-07-12 13:30 +08:00，研究任务超时已接入 AbortController 并传递到 web fetch；runner 真正停止前不释放并发槽，取消任务不会写入迟到的 completed brief。
维护记录：2026-07-12 13:50 +08:00，定时任务执行前后均同步落盘，使用稳定执行键记录 executing claim；崩溃恢复时 once 不重发、cron 跳过不确定旧周期，真实文件重启回归通过。
维护记录：2026-07-12 14:00 +08:00，profile journal 诊断 GET 已固定为只读并忽略 auto_clean 参数；数据清洗仅保留在鉴权 POST，路由及鉴权回归测试通过。
维护记录：2026-07-12 14:15 +08:00，Docker 运行阶段已切换为 node 非 root 用户，3002/3005 均默认只发布到宿主 loopback；静态回归和 Compose YAML 解析通过，真实容器 UID/卷写入验收等待 Docker daemon。
维护记录：2026-07-12 14:25 +08:00，新增最小 /healthz 探针，Compose 主服务配置 healthcheck，post-reply worker 等待 service_healthy；处理器和 YAML 验收通过，真实容器门控等待 Docker daemon。
维护记录：2026-07-12 14:40 +08:00，本地私有 admin prompt 已移除异常双响应指令并恢复 QQ 当前消息契约；过期的 120000 token 测试断言同步为现行 9200，四组 prompt 回归通过。
维护记录：2026-07-12 15:20 +08:00，lint 已覆盖 727 个 JS 与全部 71 个 chunk，完整 npm test 在 307.5 秒内全部通过，依赖审计 0 漏洞且安全/密钥诊断通过；Docker daemon 已启动，但真实镜像构建仍阻塞于基础镜像获取。
维护记录：2026-07-12 16:51 +08:00，已建立 32 项仓库改进总路线与第一阶段安全边界执行计划，并将 README、Docker 部署文档中的 NapCat reverse 说明更新为签名/显式兼容模式；本轮只改文档，验收为计划文件存在、旧空对象/Bearer-only 探针已明确标注失效且 `git diff --check` 通过。
维护记录：2026-08-04 14:43 +08:00，实现提交 `de13971` 已修复 PR #5 的供应链漏洞：根项目与嵌套技能 audit 均为 0，476 个锁定版本实时 OSV 查询为 0 漏洞，Node 20 关键门禁及 177 秒完整测试通过；当前分支未推送远端。
维护记录：2026-08-04 23:41 +08:00，实现提交 `f18ae99` 已在 Anthropic Messages 请求边界处理尾部 assistant prefill：保留原消息并追加 user 续写指令，避免不支持预填充的模型返回 HTTP 400；定向测试、812 文件 lint、typecheck、diff check 和 213.3 秒完整测试全部通过，当前分支未推送远端。
维护记录：2026-08-13 23:56 +08:00，实现提交 `aeab4a2a` 已修复私聊“查看思维链”请求被正常拒绝句误判为不安全回复的问题：用户出口与记忆污染两层规则均改为只识别带明确内容分隔符的实际泄漏格式。验收结果：真实日志 `req_f5da852772869f3d` 确认此前为固定回退文案误发；两组守卫、私聊流式链路及相邻 reasoning 回归通过，`npm run lint`、`npm run typecheck`、`git diff --check` 通过。完整 `npm test` 运行 166.8 秒后仅有既有 `weatherAlertProvider.test.js:65` 失败，原因是固定 `2026-08-07` 到期时间相对当前日期已过期，单独复跑可复现，本轮未修改天气模块。小目标已完成。
维护记录：2026-08-16 10:50 +08:00，实现提交 `05ddbead` 已在 OpenAI-compatible 请求边界把内联、缓存和远程 GIF 首帧转为 JPEG，原始缓存不改写；图片专项、892 文件 lint、typecheck、diff check 和 188.9 秒完整测试均通过。目标模型两次实时验收均因上游超时未取得 200，但未再返回原 `#sym:500`，当前分支未推送远端。
维护记录：2026-08-17 10:27 +08:00，请求 `req_a38fbfa5d6c77f9` 的上游流式调用连续三次返回 HTTP 502，状态码随后被 `generic_model_failure` 通用兜底抹掉并发送固定文案；提交 `c0bad30c` 已改为在私聊与主回复失败时直接回复 `HTTP XXX`，非 HTTP 错误保持原行为，`replyFailure` 与 Runtime V2 两项聚焦测试均通过，小目标已完成。
