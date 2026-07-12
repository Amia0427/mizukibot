# Security Boundaries And Data Protection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成外部请求入口、Web 管理台、追踪日志和本地敏感数据的安全收口，使伪造事件、SSRF、长期令牌泄露、日志扩散和宽松 ACL 都有可重复的阻断证据。

**Architecture:** 复用 `utils/networkSafety.js` 作为所有远程抓取的唯一网络边界；NapCat 使用签名请求并保留显式可关闭的原生客户端兼容模式；Web 控制台使用短期服务端会话和集中安全头；日志与诊断采用字段白名单；Windows ACL 在确认真实服务身份后最后应用。

**Tech Stack:** Node.js 20、CommonJS、Express、Axios、PowerShell、项目自定义测试运行器。

---

## Chunk 1: 收口当前并行安全改动

### Task 1: 验收 NapCat 签名入口

**Files:**
- Modify: `core/napcatHttpReverseServer.js`
- Modify: `config/index.js`
- Modify: `scripts/configure-napcat-onebot.js`
- Modify: `.env.example`
- Test: `tests/napcatHttpReverseServer.test.js`
- Test: `tests/configureNapcatOnebotSource.test.js`

- [ ] **Step 1: 审查当前共享工作区 diff**

确认签名串严格为 `timestamp + "." + nonce + "." + rawBody`，认证发生在消息分发前，nonce 只在签名校验成功后写入缓存。

- [ ] **Step 2: 运行现有测试并确认基线**

Run: `node scripts/run-tests.js tests/napcatHttpReverseServer.test.js tests/configureNapcatOnebotSource.test.js`

Expected: PASS；匿名、错误签名、过期时间戳、重放、非法事件、超大请求和限流场景均被拒绝，正确签名只分发一次。

- [ ] **Step 3: 补齐原生 NapCat 兼容边界**

保留 `NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER` 作为显式兼容开关；默认只允许 loopback/受控网络使用兼容 token，外部代理或自定义客户端使用签名头。不得把静态 Bearer 描述为具备防重放能力。

- [ ] **Step 4: 验证配置脚本**

Run: `node scripts/configure-napcat-onebot.js --dry-run`

Expected: 如果脚本支持 dry-run，则输出待写配置且不改文件；如果当前脚本不支持，先补测试和 dry-run，再执行真实配置。

- [ ] **Step 5: 提交实现**

```bash
git add core/napcatHttpReverseServer.js config/index.js scripts/configure-napcat-onebot.js .env.example tests/napcatHttpReverseServer.test.js tests/configureNapcatOnebotSource.test.js
git commit -m "fix: enforce signed napcat ingress"
```

### Task 2: 验收图片缓存与 summarize SSRF

**Files:**
- Modify: `utils/networkSafety.js`
- Modify: `utils/imageInputCache.js`
- Modify: `api/skills_native/summarize.js`
- Test: `tests/networkSafety.test.js`
- Test: `tests/networkSafetyHttpIntegration.test.js`
- Test: `tests/imageInputCacheSecurity.test.js`
- Test: `tests/nativeSummarizeSecurity.test.js`
- Test: `tests/httpClientQqImageInlining.test.js`
- Test: `tests/nativeSummarizeStock.test.js`

- [ ] **Step 1: 运行 SSRF 测试并确认失败点或现有通过证据**

Run: `node scripts/run-tests.js tests/networkSafety.test.js tests/networkSafetyHttpIntegration.test.js tests/imageInputCacheSecurity.test.js tests/nativeSummarizeSecurity.test.js`

Expected: 私网 DNS、混合公网/私网解析、重定向到私网、IPv6 本地地址均被拒绝；安全公网地址使用已验证 IP 的 pinned lookup。

- [ ] **Step 2: 最小化统一请求边界**

`ensureCachedImageRef` 和 `summarizeInput` 只通过 `requestSafeHttpUrl` 发起远程请求，不保留第二套 URL 判断。每一跳关闭自动重定向并重新解析；图片与文本分别限制最大响应字节。

- [ ] **Step 3: 验证内容约束**

图片缓存只接受非空、未超过上限且响应类型为 `image/*` 的内容；summarize 在解析 HTML 前检查字节上限。失败只返回稳定原因，不把完整 URL 凭据或响应正文写入日志。

- [ ] **Step 4: 运行兼容回归**

Run: `node scripts/run-tests.js tests/httpClientQqImageInlining.test.js tests/nativeSummarizeStock.test.js tests/webFetchFallback.test.js`

Expected: PASS；正常图片内联、文件总结和现有 web fetch 行为不回退。

- [ ] **Step 5: 提交实现**

```bash
git add utils/networkSafety.js utils/imageInputCache.js api/skills_native/summarize.js tests/networkSafety.test.js tests/networkSafetyHttpIntegration.test.js tests/imageInputCacheSecurity.test.js tests/nativeSummarizeSecurity.test.js tests/httpClientQqImageInlining.test.js tests/nativeSummarizeStock.test.js
git commit -m "fix: secure remote image and summarize fetches"
```

## Chunk 2: Web 管理台认证与浏览器边界

### Task 3: 使用短期服务端会话替代长期浏览器 token

**Files:**
- Create: `web/sessionManager.js`
- Modify: `web/auth.js`
- Modify: `web/server/index.js`
- Modify: `config/index.js`
- Modify: `.env.example`
- Test: `tests/webAuthSecurity.test.js`
- Create: `tests/webSessionSecurity.test.js`

- [x] **Step 1: 写失败测试**

覆盖 timing-safe token 校验、登录失败限流、成功登录返回 `HttpOnly; SameSite=Strict` cookie、会话过期、撤销、重启失效和非登录 API 不接受 query/localStorage token。

- [x] **Step 2: 运行测试并确认失败**

Run: `node scripts/run-tests.js tests/webAuthSecurity.test.js tests/webSessionSecurity.test.js`

Expected: FAIL，当前实现没有服务端会话且管理页仍读取 `localStorage.WEB_TOKEN`。

- [x] **Step 3: 实现最小会话管理器**

`sessionManager` 只负责创建、校验、撤销和过期清理随机不透明 session id；`WEB_TOKEN` 只用于登录时的 timing-safe 比较，不写入 cookie、HTML 或日志。

- [x] **Step 4: 修改管理页登录流**

增加 `/api/session` 登录和删除端点，内嵌脚本只发送凭据一次并依赖 cookie；删除 `localStorage.getItem('WEB_TOKEN')` 和 query token 传播。

- [x] **Step 5: 运行测试并确认通过**

Run: `node scripts/run-tests.js tests/webAuthSecurity.test.js tests/webSessionSecurity.test.js tests/webHealthRoute.test.js`

Expected: PASS；`/healthz` 保持无敏感信息，其他管理 API 必须有有效会话。

- [x] **Step 6: 提交实现**

```bash
git add web/sessionManager.js web/auth.js web/server/index.js config/index.js .env.example tests/webAuthSecurity.test.js tests/webSessionSecurity.test.js
git commit -m "fix: use short lived web sessions"
```

### Task 4: 集中设置 Web 安全响应头

**Files:**
- Create: `web/securityHeaders.js`
- Modify: `web/server/index.js`
- Create: `tests/webSecurityHeaders.test.js`

- [x] **Step 1: 写失败测试**

验证所有管理页和 API 响应包含 CSP、`frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`、Referrer Policy；HTTPS 请求包含 HSTS，HTTP localhost 不错误宣称 HSTS。

- [x] **Step 2: 运行测试并确认失败**

Run: `node scripts/run-tests.js tests/webSecurityHeaders.test.js`

Expected: FAIL，当前没有集中安全头中间件。

- [x] **Step 3: 实现单一中间件**

安全头策略集中在 `web/securityHeaders.js`，由 `web/server/index.js` 在路由前安装；CSP 必须与当前内嵌脚本实际加载方式一致，不使用宽泛 `*`。

- [x] **Step 4: 运行测试并确认通过**

Run: `node scripts/run-tests.js tests/webSecurityHeaders.test.js tests/webAuthSecurity.test.js tests/webHealthRoute.test.js`

Expected: PASS。

- [x] **Step 5: 提交实现**

```bash
git add web/securityHeaders.js web/server/index.js tests/webSecurityHeaders.test.js
git commit -m "fix: add web security headers"
```

## Chunk 3: 日志、诊断与本地数据

### Task 5: 将 request trace 收口为字段白名单

**Files:**
- Modify: `utils/requestTrace.js`
- Modify: `tests/requestTrace.test.js`
- Modify: `tests/requestTracePreflightDiagnostics.test.js`

- [ ] **Step 1: 写失败测试**

传入 `apiKey`、`authorization`、`token`、消息正文、任意嵌套对象和 Error，断言落盘事件只保留明确允许的标识、阶段、耗时、布尔状态、稳定错误码和已清洗短摘要。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node scripts/run-tests.js tests/requestTrace.test.js tests/requestTracePreflightDiagnostics.test.js`

Expected: FAIL，当前 `appendRequestTraceEvent` 会展开调用方 payload。

- [ ] **Step 3: 实现字段白名单**

在 `utils/requestTrace.js` 内建立唯一 serializer；调用方新增字段不会自动进入日志。错误对象只提取状态码、错误码和截断清洗后的消息，不记录 headers、request config、response body 或凭据。

- [ ] **Step 4: 运行测试并确认通过**

Run: `node scripts/run-tests.js tests/requestTrace.test.js tests/requestTracePreflightDiagnostics.test.js tests/messageHandlerRequestTrace.test.js`

Expected: PASS。

- [ ] **Step 5: 提交实现**

```bash
git add utils/requestTrace.js tests/requestTrace.test.js tests/requestTracePreflightDiagnostics.test.js tests/messageHandlerRequestTrace.test.js
git commit -m "fix: whitelist request trace fields"
```

### Task 6: 扩展安全诊断并返回失败退出码

**Files:**
- Modify: `utils/securityDiagnostics.js`
- Modify: `scripts/diagnose-security.js`
- Modify: `tests/securityDiagnostics.test.js`
- Create: `tests/securityDiagnosticsCli.test.js`

- [ ] **Step 1: 写失败测试**

覆盖公开监听缺少鉴权、NapCat 兼容 token、无限日志保留、宽松 `.env`/`data` ACL、容器缺少安全基线，以及 `status=error` 时 CLI 退出码非 0。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node scripts/run-tests.js tests/securityDiagnostics.test.js tests/securityDiagnosticsCli.test.js`

Expected: FAIL，当前诊断覆盖面不足且 CLI 不根据 error 设置退出码。

- [ ] **Step 3: 实现可注入检查器**

文件 ACL、Compose 文本和配置读取通过 options 注入，单元测试不依赖当前机器状态；诊断不得输出真实 token、URL 凭据或文件内容。

- [ ] **Step 4: 运行测试和真实诊断**

Run: `node scripts/run-tests.js tests/securityDiagnostics.test.js tests/securityDiagnosticsCli.test.js`

Run: `npm run diag:security -- --json`

Expected: 测试 PASS；真实诊断在 ACL 未收紧前明确返回 error，且 JSON 指出可执行修复，不泄露秘密。

- [ ] **Step 5: 提交实现**

```bash
git add utils/securityDiagnostics.js scripts/diagnose-security.js tests/securityDiagnostics.test.js tests/securityDiagnosticsCli.test.js
git commit -m "fix: expand security diagnostics"
```

### Task 7: 收紧 Windows 敏感路径 ACL

**Files:**
- Create: `scripts/harden-local-acl.ps1`
- Create: `tests/localAclScriptSource.test.js`
- Modify: `scripts/README.md`

- [ ] **Step 1: 写脚本安全约束测试**

测试脚本必须显式接收 `-ServiceIdentity`，默认只预览；应用前导出 `.env` 和 `data` ACL 快照，不接受空路径或工作区外路径，不删除文件。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node scripts/run-tests.js tests/localAclScriptSource.test.js`

Expected: FAIL，脚本尚不存在。

- [ ] **Step 3: 实现幂等 ACL 脚本**

保留服务账号、`NT AUTHORITY\SYSTEM` 和 `BUILTIN\Administrators`；移除 `Authenticated Users`、`BUILTIN\Users` 和无关 SID 的继承访问。脚本先输出差异，只有显式 `-Apply` 才修改。

- [ ] **Step 4: 识别真实服务身份**

Run: `npm run win:daemon:status`

Run: `Get-CimInstance Win32_Service | Where-Object { $_.PathName -match 'D:\\waifu|node' } | Select-Object Name,StartName,State,PathName`

Expected: 得到实际运行 bot 服务的 `StartName`；如果 bot 不是 Windows service，再对目标 `Win32_Process` 调用 `GetOwner`，不能根据当前交互用户猜测。

- [ ] **Step 5: 保存快照并应用**

Run: `powershell -ExecutionPolicy Bypass -File scripts/harden-local-acl.ps1 -ServiceIdentity '<actual-account>'`

Expected: 只输出计划和快照路径，不修改 ACL。

Run: `powershell -ExecutionPolicy Bypass -File scripts/harden-local-acl.ps1 -ServiceIdentity '<actual-account>' -Apply`

Expected: `.env` 和 `data` 仅保留服务账号、SYSTEM 和 Administrators 所需权限。

- [ ] **Step 6: 验证 ACL 与运行状态**

Run: `(Get-Acl -LiteralPath .env).Access | Format-Table IdentityReference,FileSystemRights,AccessControlType,IsInherited`

Run: `(Get-Acl -LiteralPath data).Access | Format-Table IdentityReference,FileSystemRights,AccessControlType,IsInherited`

Run: `npm run win:daemon:status`

Expected: 普通认证用户不再具有读取或修改权限；bot 仍能读取 `.env` 并写入 `data`。

- [ ] **Step 7: 轮换秘密并验证旧秘密失效**

轮换 API、Web、NapCat 和本地 bridge 凭据；使用新凭据完成健康探针，使用旧凭据必须返回 401 或连接失败。凭据值不得写入 Git 或维护日志。

- [ ] **Step 8: 提交脚本和文档**

```bash
git add scripts/harden-local-acl.ps1 tests/localAclScriptSource.test.js scripts/README.md
git commit -m "ops: harden local sensitive path acl"
```

## Chunk 4: 阶段验收与记录

### Task 8: 完成安全阶段验收

**Files:**
- Modify: `README.md`
- Modify: `deploy/docker/README.md`
- Modify: `docs/maintenance-log.md`
- Modify: `docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md`
- Modify: `docs/superpowers/plans/2026-07-12-security-boundaries-data-protection.md`

- [ ] **Step 1: 运行安全定向测试**

Run: `node scripts/run-tests.js tests/napcatHttpReverseServer.test.js tests/configureNapcatOnebotSource.test.js tests/networkSafety.test.js tests/networkSafetyHttpIntegration.test.js tests/imageInputCacheSecurity.test.js tests/nativeSummarizeSecurity.test.js tests/webAuthSecurity.test.js tests/webSessionSecurity.test.js tests/webSecurityHeaders.test.js tests/requestTrace.test.js tests/requestTracePreflightDiagnostics.test.js tests/securityDiagnostics.test.js tests/securityDiagnosticsCli.test.js tests/localAclScriptSource.test.js`

Expected: PASS。

- [ ] **Step 2: 运行仓库门禁**

Run: `npm run lint`

Run: `npm run check:prompts`

Run: `npm run check:secrets`

Run: `npm audit --omit=dev`

Run: `npm run diag:security -- --json`

Expected: 所有命令自然结束；安全诊断没有未解释的 error。

- [ ] **Step 3: 运行完整测试**

Run: `npm test`

Expected: `[test] all tests passed`；记录总耗时和慢测，不使用窄测试替代全量结论。

- [ ] **Step 4: 检查差异**

Run: `git diff --check`

Run: `git status --short`

Expected: 无空白错误；只包含本阶段和明确保留的并行改动。

- [ ] **Step 5: 更新文档并提交**

在 README 和维护日志追加带 `+08:00` 的简短验收记录，勾选总路线已完成目标并链接命令证据。

```bash
git add README.md deploy/docker/README.md docs/maintenance-log.md docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md docs/superpowers/plans/2026-07-12-security-boundaries-data-protection.md
git commit -m "docs: record security boundary verification"
```
