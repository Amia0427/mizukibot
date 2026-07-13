# Repository 32 Goals Roadmap Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按风险、依赖和可验收性完成仓库审计提出的 32 个改进目标，并为每一项保留当前代码、测试、命令输出或运行态探针作为完成证据。

**Architecture:** 将跨安全、质量、运行时架构、数据运维和供应链的目标拆成五个可独立验收的阶段。先关闭外部攻击面和数据泄露风险，再建立质量门禁，随后处理模块边界和依赖，最后完成存储运维与供应链治理；已有实现只复核和补齐，不重复重写。

**Tech Stack:** Node.js 20、CommonJS、Express、Axios、SQLite、Docker Compose、PowerShell、项目自定义测试运行器。

---

## 运行维护 2026-07-13 19:09 +08:00

- 实现提交 `5160912`：SQLite 生产/维护连接统一到单一工厂，启用 5 秒 `busy_timeout`、WAL、外键和首次 WAL 切换的定向 `SQLITE_BUSY` 重试；新增 `quick_check`、checkpoint 与结构化完整性 CLI。
- 验收：四进程同时写共享 `profile_journal.sqlite` 无丢写，最终 `quick_check=ok`、TRUNCATE checkpoint 无 busy；Node 20/24 定向测试、全部静态门禁和 Node 24并发4全量通过，全量耗时93.9秒。
- 路线图状态：目标25完成；一致性备份/恢复演练和进程退出时统一关闭数据库仍由目标26、27继续处理。

## 运行维护 2026-07-13 04:23 +08:00

- 实现提交 `c973fe2`：chunk lint 新增结构化完整覆盖报告；消息与 src facade 测试由旧/新函数引用恒等迁为公开导出、canonical 接线和代表性纯行为；executable plan 测试改为 canonical planning sanitize 契约。
- 验收：独立审查 Approve；4 项定向测试、lint、typecheck、prompt、全仓 secrets、production audit（0 漏洞）和 diff check 通过；串行全量 264 秒通过。并发4仅剩既有 `runTestsRunner.test.js` 时序竞争，单测独立通过，本轮未扩大范围修改。
- 路线图状态：目标23继续部分完成；chunk lint 映射与少量 facade identity 测试已完成迁移，剩余危险重启/daemon 策略守卫待处理。

## 运行维护 2026-07-13 04:44 +08:00

- 实现提交 `cc5cccb`：测试临时目录统一定向到 Git 工作树外的同盘目录，并支持显式覆盖；空白覆盖、父进程环境隔离、tracked-only 与 fallback 发现语义均由行为测试锁定。
- 验收：独立审查 Approve；默认/自定义路径定向测试、全部静态门禁和并发4全量复跑通过，全量耗时93秒，临时数据实际写入 `D:\waifu-test-temp`。
- 路线图状态：目标22保持已完成；该修复只避免测试继续占用系统盘，未删除历史临时文件，也不替代目标19剩余的事务级目录总配额。

## 运行维护 2026-07-13 05:04 +08:00

- 实现提交 `a2ccc94`：周期重启和计划任务安装脚本提供真实无副作用 ValidateOnly，验证与执行共用同一启动计划/XML；行为测试用命令 trap 证明不会停止/启动进程、注册任务或写测试日志。
- 验收：独立审查 Approve；定向行为、全仓 PowerShell AST、全部静态门禁和并发4全量测试通过，全量耗时94.2秒。
- 路线图状态：目标23继续部分完成，periodic restart 守卫已行为化；危险 restart/daemon 策略与日志保留调用点仍待迁移。

## 运行维护 2026-07-13 05:32 +08:00

- 实现提交 `9e11252`：8 个日志保留调用点由源码文本断言迁为公开写入行为与 writer 元数据探针，遥测日志明确参与保留策略，Memory/Journal/Self-improvement 状态源明确不参与。
- 行为测试发现并修复 `/dailyshare status` 的未定义容量常量；群组状态显示每窗口上限1，QZone显示上限2，测试不写 request-trace 或状态文件。
- 验收：独立审查 Approve；邻接测试、全部静态门禁及并发4全量通过，全量耗时96.4秒。目标23继续部分完成，剩余 restart/daemon 大型守卫需先抽取安全策略边界。

## 运行维护 2026-07-13 05:44 +08:00

- 实现提交 `289035a`：质量工具策略由 ESLint 配置源码正则迁为 `findConfigFile`、`calculateConfigForFile`、`isPathIgnored` 与 `lintText` 的真实行为验证，覆盖 common rules、unused 边界和 chunk/目录忽略策略。
- 验收：两次独立审查 Approve；quality/chunk 定向测试、全部静态门禁和并发4全量通过，全量耗时105.2秒。
- 路线图状态：目标23继续部分完成；可独立迁移的质量工具源码断言已收口，剩余 restart/daemon 大型守卫转入生命周期边界抽取阶段。

## 运行维护 2026-07-13 18:20 +08:00

- 实现提交 `0b89296`：修复 Node 20 在午夜将小时格式化为24导致的早晨跨日图片记忆召回失败，统一归一化为0并新增时区行为测试。
- 验收：Node 20.20.2 与 Node 24.14.1 的 time/image memory/memory CLI 定向测试通过；Node 24全部静态门禁和并发4全量通过，全量耗时90.6秒。
- 路线图状态：目标31继续部分完成；真实 Node 20 定向行为已验证，完整 Node 20 全量仍需在覆盖率临时目录清理获批后复跑。

## 当前证据快照

更新时间：2026-07-13 19:09 +08:00。

- 当前分支 `amia/dev` 已领先 `origin/amia/dev` 64 个提交。
- 本计划创建时，安全相关实现仍在共享工作区中并行修改；未提交代码不能标记为完成，必须以最终 diff 和测试结果重新验收。
- 已确认的完整基线：`npm run lint` 覆盖 724 个文件；`TEST_CONCURRENCY=4 node scripts/run-tests.js` 最近一次自然结束用时 93 秒。
- 当前 `.env` 与 `data` ACL 仍允许 `Authenticated Users` 修改、`Users` 读取，数据保护目标未完成。

## 32 项状态

- [ ] **1. NapCat HTTP 入口认证与防重放** — 部分完成。提交 `c3ca711` 已加入 HMAC、时间戳、nonce、防重放、事件校验、请求体限制、鉴权后限流和真实配置链测试；NapCat 原生客户端仍需静态 token 兼容模式，安全诊断会将该模式标为 warning，后续需通过受控签名代理完成 signed-only 收口。
- [x] **2. 图片缓存 SSRF** — 已完成。提交 `c3ca711` 已接入逐跳 DNS/重定向校验、固定解析地址、IPv4-mapped IPv6 拒绝和 8 MiB 响应限制，并有本地真实 HTTP 集成测试。
- [x] **3. `skill_summarize` SSRF** — 已完成。提交 `c3ca711` 已统一使用安全请求边界并限制 2 MiB 响应，覆盖私网、重定向和固定 DNS 行为测试。
- [ ] **4. `.env` 与 `data` ACL** — 未完成。当前 ACL 仍对普通认证用户开放修改或读取。
- [ ] **5. 取消源码拼接式模块加载** — 未完成。`src/shared/chunkedModule.js` 仍通过 `new Function` 执行共享作用域 chunk，至少 6 个入口依赖。
- [ ] **6. 消除生产依赖环** — 未完成。必须在 chunk 模块化后重新生成权威依赖图并将循环数降为 0。
- [ ] **7. 拆除 `legacy/aiHost` 上帝模块** — 未完成。`api/legacy/aiHost.js` 仍约 2096 行，并被 planning、image generation 和测试引用。
- [ ] **8. 建立最小 CI 门禁** — 部分完成。提交 `5e7e168` 已新增 Windows Node 20 全量门禁和 Ubuntu Node 20 Linux 策略门禁，覆盖安装、版本、lint、prompt、tracked secrets、production audit 与测试，并隔离 `.env`、`data` 和本地 prompt roots；尚未在远端 GitHub Actions 真实运行，不能标记完成。
- [ ] **9. 使用 ESLint 取代语法解析器** — 部分完成。提交 `fe80591` 已用 ESLint 9 flat config 覆盖 724 个普通 JS 文件，并启用未定义变量、不可达代码、重复键、异步 Promise executor 等 correctness 规则；71 个共享作用域 chunk 仍由组合入口/语法解析器校验，全仓 unused、Promise executor 返回值和复杂度基线尚未清零。
- [x] **10. 核心边界类型检查** — 已完成。提交 `fe80591` 为 Web 会话安全、网络安全、请求追踪、安全诊断、工具参数和 Runtime V2 契约/状态/路由共 10 个稳定边界启用 `@ts-check`，无 `any`、`@ts-ignore` 或 `@ts-nocheck` 绕过，并接入 CI。
- [x] **11. 删除未使用的 Runtime V1** — 已完成。`api/legacy/agentGraphV1Runtime.js` 已删除，依赖与失效检查已清理。
- [ ] **12. 拆分高扇出编排器** — 未完成。Runtime host、router、prepare 仍分别约 1447、1325、1313 行。
- [ ] **13. 按领域拆分配置并集中校验环境变量** — 未完成。`config/index.js` 约 1258 行，生产域仍有约 186 处 `process.env` 读取。
- [ ] **14. 统一正常停机与远程重启** — 部分完成。JSON 热存储已移交信号所有权，仍需统一 server、worker、数据库和远程重启的 lifecycle coordinator。
- [x] **15. 重构 Web 控制台认证** — 已完成。提交 `39b5428` 将 `WEB_TOKEN` 收口为常量时间登录校验，使用短期可撤销 HttpOnly 会话、登录限流、严格同源 CSRF 和受控代理链；旧 Bearer/header/query/localStorage 认证已移除。
- [x] **16. 增加 Web 安全响应头** — 已完成。提交 `39b5428` 集中设置逐响应 nonce CSP、`frame-ancestors 'none'`、nosniff、Referrer Policy、Cache-Control，并仅在可信 HTTPS 链路发送 HSTS/Secure cookie。
- [ ] **17. 容器最小权限运行** — 部分完成。提交 `9e5f0e8` 已实现 non-root、只读根、cap_drop ALL、no-new-privileges、init、资源/PID/停止限制、角色锁目录和 Docker 日志轮转；真实 UID、旧命名卷权限、只读根写路径、SIGTERM 与资源上限仍因 Docker snapshot 损坏未完成运行验收，env秘密也尚未按角色拆分。
- [x] **18. 收缩 Compose 网络暴露面** — 已完成默认 loopback 绑定；跨主机部署仍需受控代理和鉴权说明。
- [ ] **19. 日志脱敏、保留和容量限制** — 部分完成。提交 `9e5f0e8` 已实现默认10份/30天、显式日志注册、同目录 active+archive 容量、85/95%水位告警、共享日志跨进程轮转锁和Windows daemon allowlist；不同进程写不同target时的目录硬上限尚非事务级一致，当前磁盘约99%占用仍需运维处理。
- [ ] **20. 限制请求追踪日志内容** — 部分完成。提交 `d20208b` 已使用真实消费者契约收口字段，正文、headers、未知嵌套和 URL 凭据不再落盘；`userId/groupId/messageId` 的 keyed hash 迁移仍未完成。
- [ ] **21. 覆盖率基线与不倒退门禁** — 未完成。无 line/branch/function 覆盖率报告和关键域阈值。
- [x] **22. 测试运行器并发和超时** — 已完成。提交 `d44d051`、`be32669` 完成tracked-only发现、有限并发、串行barrier、进程树终止、慢测榜和慢测网络/生产等待治理；视觉文本预算裁剪改为等价二分查找，`TEST_CONCURRENCY=4`全量连续三轮100.6/97.6/103.6秒自然通过。
- [ ] **23. 减少源码文本断言测试** — 部分完成。提交 `be32669`、`6692ced`、`f0e472d`、`269078f`、`f2cd4b8`、`c973fe2`、`a2ccc94`、`9e11252`、`289035a` 已迁移 DirectAnchor、ReasoningForward、NormalFastReplyHandler、plannerRichContext、runtimeHostCot、messageIngress、configureNapcat、noExternalProcessSkills、runtimeHostShortTermBatchWiring、messageAdminCommands、mainBotEarlyExitDiagnostics、hotpathRequireGuard、CI Workflow、Docker Compose、chunk lint 映射、主要 facade identity、周期重启、日志保留调用点和质量工具配置守卫；15 个 PowerShell 脚本已由 AST 统一校验语法。剩余危险 restart/daemon 大型策略守卫待先结合目标14/27抽取安全生命周期边界后行为化。
- [x] **24. 强化提示词清单检查** — 已完成。提交 `d44d051` 已建立版本化exact allowlist，覆盖tracked/package/private边界、39个worldbook、7个runtime模板和4组冲突标签；新增、删除、过期、未知字段或标签成员漂移均失败，默认warning为0。
- [x] **25. SQLite 多进程并发与完整性检查** — 已完成。提交 `5160912` 将全部生产和维护 SQLite 打开路径收口到统一连接工厂，启用 5 秒 `busy_timeout`、WAL、外键及首次 WAL 切换的 `SQLITE_BUSY` 定向重试；结构化 CLI、存储优化流程和四进程共享库压测覆盖 PASSIVE/TRUNCATE checkpoint、`quick_check`、损坏库失败和无丢写门禁。
- [ ] **26. 可恢复备份体系** — 未完成。无统一 RPO/RTO、加密异地副本和恢复演练证据。
- [ ] **27. 健康、就绪和优雅退出** — 部分完成。已有 `/healthz` 与 `service_healthy`，仍缺 `/live`、`/ready`、排空和完整资源关闭。
- [x] **28. 扩展安全诊断** — 已完成。提交 `c3ca711`、`d20208b` 已覆盖鉴权/监听组合、direct 与 Compose 宿主边界、Windows ACL、日志无限保留、Docker 最终用户和每服务权限基线；error 状态返回非零退出码，无法可靠解析时降级为 warning。
- [ ] **29. 供应链安全门禁** — 未完成。无固定镜像 digest、SBOM、gitleaks、OSV/Trivy/Grype 和许可证门禁。
- [x] **30. 会话研究缓存全局容量限制** — 已完成。提交 `5e7e168` 已加入每进程全局会话上限、确定性 LRU、主动/惰性 TTL、size/eviction/expired 指标和可停止的 unref 定时器；10,000 会话压力测试稳定回落到配置上限。
- [ ] **31. 统一 Node 版本** — 部分完成。提交 `5e7e168` 已将 `.nvmrc`、`package.json`/lock、Docker、CI、Linux 安装检查脚本和用户部署文档统一为 Node 20.x；提交 `0b89296` 已在真实 Node 20.20.2 下修复并验证午夜 hour=24 的跨版本行为差异，time/image memory/memory CLI 定向测试通过。完整 Node 20 全量与原生依赖隔离安装仍需最终复验后标记完成。
- [ ] **32. 建立依赖升级节奏** — 未完成。无自动补丁升级、月度窗口和大版本 smoke 流程。

## 阶段与计划文件

### Phase 1: 安全边界与数据保护

计划：`docs/superpowers/plans/2026-07-12-security-boundaries-data-protection.md`

- [ ] 完成目标 1、2、3、4、15、16、20、28。
- [ ] 复核目标 18 的跨主机接入文档和签名探针。
- [ ] 每个安全边界使用行为测试和真实配置探针验收。

### Phase 2: 质量门禁

建议计划：`docs/superpowers/plans/2026-07-12-quality-gates.md`

- [ ] 先统一 Node 20，再建立执行现有 lint、测试、prompt、audit 的最小 CI。
- [ ] 将测试运行器改为有限并发和慢测统计，再接覆盖率门禁。
- [ ] 用行为测试替换妨碍重构的源码文本断言。
- [ ] 分阶段引入 ESLint 和核心边界类型检查，避免一次性制造不可审查的大 diff。
- [ ] 完成目标 8、9、10、21、22、23、24、31。

### Phase 3: 运行时模块化

建议计划：`docs/superpowers/plans/2026-07-12-runtime-modularization.md`

- [ ] 按 message、runtime context、memory vector、passive awareness、meme、daily share 六个入口逐个替换共享作用域 chunk。
- [ ] 共享作用域消失后生成依赖图，逐个消除生产循环。
- [ ] 抽取 planning、image generation、model request 和 memory 接口，再删除 `legacy/aiHost`。
- [ ] 在稳定接口上拆分 host、router、prepare 和领域配置。
- [ ] 用单一 lifecycle coordinator 收口退出、重启和资源关闭。
- [ ] 完成目标 5、6、7、12、13、14。

### Phase 4: 数据与运行运维

建议计划：`docs/superpowers/plans/2026-07-12-storage-operations.md`

- [ ] 统一日志保留、脱敏、容量和水位告警。
- [ ] 先建立 SQLite 连接工厂与完整性检查，再实现一致性快照和恢复演练。
- [ ] 完成 readiness、排空、数据库关闭和容器真实验收。
- [ ] 为研究缓存增加全局容量、主动过期和 eviction 指标。
- [ ] 完成目标 17、19、25、26、27、30。

### Phase 5: 供应链与依赖维护

建议计划：`docs/superpowers/plans/2026-07-12-supply-chain-maintenance.md`

- [ ] 在 CI 稳定后固定基础镜像 digest，加入 secrets、漏洞、SBOM 和许可证检查。
- [ ] 建立补丁自动验证、月度升级窗口和大版本独立 smoke。
- [ ] 完成目标 29、32。

## 关键依赖与冲突

- [ ] 目标 23 应在目标 5、7、12 前完成；否则源码断言会把正常拆分误报为失败。
- [ ] 目标 5 是目标 6、9 全覆盖、10 和 12 的强前置；共享作用域 chunk 会让静态依赖和类型结果失真。
- [ ] 目标 7 与 12 必须在同一架构边界下推进，不能直接删除 `aiHost` 后把职责重新堆入另一个大文件。
- [ ] 目标 22 应先于 21；测试进程模型稳定后再建立覆盖率基线。
- [ ] 目标 8 可先执行当前门禁，随后逐步加入 ESLint、typecheck、coverage 和供应链检查。
- [ ] 目标 25 应先于 26；没有统一 SQLite 连接与 checkpoint 策略，备份一致性无法证明。
- [ ] 目标 14 与 27 共用 lifecycle coordinator，必须一起设计退出顺序和 readiness 状态。
- [ ] 目标 29 依赖目标 8，目标 32 依赖稳定 CI 和可靠 smoke。
- [ ] 目标 4 会改变共享工作区访问权，必须在阶段末执行：先识别真实服务账号、保存 ACL 快照、完成代码和文档提交，再应用 ACL。
- [ ] 目标 15 会同时影响服务端鉴权、内嵌管理页和现有测试，相关文件必须原子修改，不能拆到互相不可用的提交。

## 总体验收

- [ ] `npm run lint`
- [ ] `npm run check:prompts`
- [ ] `npm run check:secrets`
- [ ] `npm audit --omit=dev`
- [ ] `npm run diag:security -- --json`
- [ ] `npm test`
- [ ] `git diff --check`
- [ ] 每个目标在 `docs/maintenance-log.md` 保留命令、退出码、时间戳和未完成项。
- [ ] 仅在 32 项均有权威完成证据后，将本计划全部勾选。
