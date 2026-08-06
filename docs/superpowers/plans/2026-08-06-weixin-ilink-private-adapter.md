# 微信 iLink 私聊适配实施记录

**状态：** 实现与自动化验收完成，等待真实 iLink 测试账号验收。

**Goal:** 在 Node.js 20 项目内增加腾讯 iLink 微信私聊通道，以 QQ 号作为唯一用户身份，共享全部用户数据并在业务入口前绝对禁用微信群聊。

**Architecture:** 独立微信 worker 负责 iLink 登录、长轮询和媒体传输，通过 WAL SQLite inbox/outbox 与主进程通信。主进程把 QQ 与微信输入归一化为统一消息信封，业务层只看到 canonical QQ 用户 ID，平台路由只负责投递。

**Tech Stack:** Node.js 20 CommonJS、better-sqlite3、AES-256-GCM、腾讯 iLink HTTP API、现有消息处理与授权系统。

---

## Chunk 1: 协议、安全存储与私聊门禁

### Task 1: 微信 SQLite 存储

**Files:**
- Create: `src/platforms/weixin/crypto.js`
- Create: `src/platforms/weixin/store.js`
- Test: `tests/weixinStore.test.js`

- [x] 先写凭据加密、一对一绑定、上下文令牌、游标、inbox/outbox 去重和审计测试。
- [x] 运行 `node scripts/run-tests.js tests/weixinStore.test.js`，确认测试先失败。
- [x] 使用现有 `openSqliteDatabase()` 和 AES-256-GCM 实现最小存储接口。
- [x] 重跑测试，确认数据库 `quick_check=ok` 且明文凭据不出现在文件和返回对象中。

### Task 2: iLink API 与媒体

**Files:**
- Create: `src/platforms/weixin/ilink-client.js`
- Create: `src/platforms/weixin/media.js`
- Test: `tests/weixinIlinkClient.test.js`
- Test: `tests/weixinMedia.test.js`

- [x] 先写二维码登录、状态轮询、getupdates、sendmessage、getuploadurl、notifystop 和错误映射测试。
- [x] 实现官方 API 请求、CDN AES-128-ECB 下载/上传及 20 MiB 边界。
- [x] 文本附件只读取 `txt/md/json/csv/log` UTF-8 内容，最多 32,000 字符；其他文件只返回元数据。
- [x] 语音只使用 `voice_item.text`；缺失转写时不下载 SILK。

### Task 3: 入站硬门禁与批次游标

**Files:**
- Create: `src/platforms/weixin/inbound.js`
- Test: `tests/weixinPrivateIngress.test.js`

- [x] 先写群消息、非 USER、目标 bot 不匹配、非绑定发送者和重复消息测试。
- [x] 门禁顺序固定为 `group_id -> message_type -> to_user_id -> from_user_id -> inbox`。
- [x] 群和非绑定消息只写无正文审计，禁止下载媒体、保存 token 或进入业务队列。
- [x] 将允许消息入队、拒绝审计和整批游标推进放在同一事务；纯拒绝批次也必须推进游标。
- [x] 对缺少官方 `message_id` 的消息生成稳定后备去重键。

## Chunk 2: Worker 与绑定流程

### Task 4: 独立微信 Worker

**Files:**
- Create: `src/platforms/weixin/worker-runtime.js`
- Create: `scripts/weixin-worker.js`
- Create: `utils/weixinWorkerSupervisor.js`
- Test: `tests/weixinWorkerRuntime.test.js`
- Test: `tests/weixinWorkerSupervisor.test.js`

- [x] 先写单实例、账号长轮询、退避、心跳、游标恢复、outbox 重试和排空测试。
- [x] 实现单 worker 管理几十个账号，每个账号最多一条在途长轮询。
- [x] inbox 成功提交后才更新游标；outbox 使用稳定 client ID。
- [x] 接入启动监督、ready/draining/stopped 状态与主进程关闭流程。

### Task 5: QQ 私聊绑定命令

**Files:**
- Create: `src/platforms/weixin/commands.js`
- Create: `src/platforms/weixin/runtime.js`
- Test: `tests/weixinCommands.test.js`

- [x] 覆盖 `/微信 绑定|状态|换绑|解绑|通知 QQ|通知 微信` 的私聊、群聊和过期行为。
- [x] 使用二维码图片发送首次绑定；同一 QQ 只保留一个有效尝试。
- [x] 解绑和换绑复用 `/工具确认 <ticket>`，新绑定成功前保留旧绑定。
- [x] 非绑定者和抢绑均静默拒绝并审计。
- [x] 覆盖 `need_verifycode`、`scaned_but_redirect`、`binded_redirect` 状态，二维码转换成 QQ 可发送的 PNG。

## Chunk 3: 主消息链与投递

### Task 6: 复用统一消息信封与身份主干

**Files:**
- Modify: `src/platforms/contracts.js`
- Modify: `src/platforms/identityStore.js`
- Modify: `src/platforms/registry.js`
- Test: `tests/multiPlatformMessageContracts.test.js`

- [x] 增加 platform、canonicalUserId、platformUserId、accountId、peerId、attachments、deliveryRoute 和 capabilities。
- [x] QQ 信封保持现有行为；微信身份只能只读解析已绑定 QQ 主体，未知微信身份不得自动创建主体。
- [x] 确认微信平台 ID 不会作为记忆、权限、好感度或短期会话键。
- [x] 文件附件必须完整进入旧业务主链，不能只转发图片。

### Task 7: 回复与后台结果路由

**Files:**
- Create: `src/platforms/weixin/adapter.js`
- Create: `src/platforms/weixin/main-runtime.js`
- Modify: `core/messageHandler.runtime.js`
- Modify: `index.js`
- Test: `tests/weixinAdapter.test.js`
- Test: `tests/weixinMainRuntime.test.js`

- [x] 普通回复和后台任务结果回到来源平台；主动消息默认 QQ，用户可切换微信。
- [x] 微信回复过滤 QQ CQ/富文本，仅发送官方支持的文本、图片和文件。
- [x] 同一 canonical 用户跨 QQ/微信共用现有并发槽和数据存储。
- [x] QQ 专属动作从微信发起时，票据指定 QQ 私聊审批者并保留微信 origin route。
- [x] 微信适配器和 outbox 消费端二次断言私聊、绑定者 peer 与绑定 bot，伪造 group target 一律拒绝。
- [x] 来源回复使用请求级 delivery context；异步结果持久化目标；主动消息按绑定偏好投递且默认 QQ。

### Task 8: 跨平台工具授权

**Files:**
- Modify: `utils/toolAuthorizationStore.js`
- Modify: `api/toolAuthorization.js`
- Modify: `api/legacy/aiHost.js`
- Modify: `core/messageHandler.runtime.js`
- Test: `tests/toolAuthorizationStore.test.js`
- Test: `tests/toolAuthorizationExecution.test.js`
- Test: `tests/messageToolAuthorizationIngress.test.js`

- [x] 先写微信 `/工具确认` 无法批准 QQ 私聊票据的失败测试。
- [x] 非破坏性迁移旧 SQLite 表，为请求平台、审批者和来源路由增加字段；旧票据默认平台为 `qq`。
- [x] 微信发起 QQ 专属操作时，请求 actor 保留微信平台，审批 actor 固定为绑定 QQ 私聊。
- [x] 换绑和解绑使用可恢复的内部审批动作，确认后执行且结果回到持久化微信来源路由。

### Task 9: 配置与诊断

**Files:**
- Modify: `config/platformRuntime.js`
- Modify: `.env.example`
- Modify: `package.json`
- Test: `tests/platformConfig.test.js`

- [x] 默认 `WEIXIN_ENABLED=false`，启用但缺少 32 字节主密钥时拒绝就绪。
- [x] 不增加任何微信群聊开关或群发送配置。
- [x] 增加 worker readiness、队列和绑定数量诊断，不泄露 token、二维码或正文。
- [x] 微信沿用绑定 QQ 用户的现有私聊白名单；绑定命令只在 QQ 私聊白名单检查通过后处理。

## Chunk 4: 验收、文档与提交

- [x] 运行微信定向测试、`npm run lint`、`npm test`、SQLite quick check 和 `git diff --check`。
- [x] 在无真实 iLink 测试账号时明确记录未执行的真实扫码验收，不伪造结果。
- [x] 断言未知微信身份不创建主体、微信映射后的 `user_id` 等于 QQ 号、微信端确认 QQ 票据失败。
- [x] 断言伪造微信群入站/出站均无媒体下载和业务调用，纯拒绝批次仍推进游标。
- [x] 断言异步结果严格按持久化目标投递，出站文件通过 `realpath` 限制在工具输出或微信媒体缓存目录。
- [x] 更新 `README.md` 和微信适配文档，追加实际时间戳与验收输出。
- [x] 只暂存本功能文件，确认 `.belt/`、`AGENT.md`、`tests/maimaiAgentIntegration.test.js` 未进入提交。
- [ ] 提交当前分支，不推送远端。

## 自动化验收 2026-08-06 10:47 +08:00

- Node 20.20.2、ABI 115：39 个微信、平台和授权定向测试文件全部通过；`TEST_CONCURRENCY=4 npm test` 用时 110.6 秒并退出 0。
- SQLite：隔离微信存储探针返回 `quick_check={"ok":true,"messages":["ok"]}`。
- 静态检查：系统 Node 24.14.1 下 `npm run lint` 检查 855 个文件，`npm run typecheck` 与 `git diff --check` 均退出 0。
- 安全覆盖：群入站/出站、非绑定者、未知身份、跨平台审批、媒体路径、重复投递、worker 重启和 SQLite 完整性均有自动化测试。
- 真实账号：当前没有可用 iLink 测试账号，真实扫码、QQ/微信连续对话、微信主动通知和真实解绑未执行，待账号准备后补验收时间戳。
