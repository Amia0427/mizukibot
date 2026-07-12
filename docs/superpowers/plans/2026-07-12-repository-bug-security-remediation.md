# Repository Bug And Security Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复仓库审计确认的 12 个并发、鉴权、SSRF、幂等、容器和质量基线问题，并为每项保留可重复验收证据。

**Architecture:** 按风险和依赖顺序逐项修复，优先收紧进程生命周期与外部攻击面，再处理异步副作用一致性，最后恢复测试、容器与静态检查基线。每项采用失败测试、最小实现、定向测试、维护日志和独立提交的闭环，不重构无关模块。

**Tech Stack:** Node.js CommonJS、Express、Axios、Docker Compose、自定义测试运行器。

---

## Chunk 1: 进程生命周期与入口安全

### Task 1: 统一信号处理所有权

**Files:**
- Modify: `utils/jsonHotStore.js`
- Modify: `index.js`
- Test: `tests/jsonHotStoreSignalOwnership.test.js`

- [x] 写测试证明 jsonHotStore 不注册会提前退出进程的 SIGINT/SIGTERM 监听器。
- [x] 运行测试并确认当前实现失败。
- [x] 将 store 的退出职责收口为只提供同步 flush，由主入口统一编排停机。
- [x] 验证定向测试和现有 jsonHotStore 测试通过。
- [x] 更新维护日志并提交。

### Task 2: 原子化主进程单实例锁

**Files:**
- Modify: `index.js`
- Test: `tests/mainBotSingleInstanceLock.test.js`

- [x] 增加两个进程竞争陈旧锁的失败测试。
- [x] 使用独占创建/原子认领替代非原子覆盖，并只允许锁所有者释放。
- [x] 验证并发测试中仅一个进程成功。
- [x] 更新维护日志并提交。

### Task 3: 保护 NapCat HTTP 反向入口

**Files:**
- Modify: `config/index.js`
- Modify: `core/napcatHttpReverseServer.js`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Test: `tests/napcatHttpReverseServer.test.js`

- [x] 增加匿名、错误密钥、正确密钥和伪造管理员事件测试。
- [x] 使用 timing-safe 共享密钥校验，缺少密钥直接拒绝启动。
- [x] Compose 默认只向宿主 loopback 发布 3002，示例配置说明受控转发方式。
- [x] 验证未授权请求不会进入消息处理器。
- [x] 更新文档并提交。

### Task 4: 修复 Web Fetch 与 RSS SSRF

**Files:**
- Modify: `utils/networkSafety.js`
- Modify: `api/toolExecutors/index.js`
- Modify: `api/tools_extra.js`
- Test: `tests/networkSafety.test.js`
- Test: `tests/toolExecutorsWebFetch.test.js`

- [x] 增加私网 DNS、混合地址和重定向到私网的失败测试。
- [x] 请求前解析并校验全部地址，禁用 Axios 自动重定向并逐跳校验。
- [x] 复用统一安全请求边界，避免两套判断漂移。
- [x] 验证公网请求兼容性与所有绕过测试。
- [x] 更新维护日志并提交。

## Chunk 2: 异步任务与副作用一致性

### Task 5: 限制 NapCat 非幂等发送重试

**Files:**
- Modify: `index.js`
- Modify: `api/napcatHttpActionClient.js`
- Test: `tests/napcatActionRetry.test.js`

- [x] 增加已产生副作用但响应超时的重复发送测试。
- [x] 仅对明确未送达且可安全重试的错误重试；保留错误分类。
- [x] 验证逻辑消息最多发送一次。
- [x] 更新维护日志并提交。

### Task 6: 取消超时研究任务

**Files:**
- Modify: `core/researchTaskQueue.js`
- Modify: `core/researchSubagent.js`
- Test: `tests/researchTaskQueue.test.js`

- [x] 增加超时后真实 runner 仍存活和并发突破测试。
- [x] 通过 AbortController 将取消信号传递到网络执行层。
- [x] 只在 runner 真正结束后释放并发槽，忽略迟到完成写入。
- [x] 验证最大真实并发不超过配置。
- [x] 更新维护日志并提交。

### Task 7: 定时任务 claim 与幂等执行

**Files:**
- Modify: `core/schedulerRuntime.js`
- Modify: `utils/scheduledTaskStore/index.js`
- Test: `tests/schedulerRuntime.test.js`

- [x] 增加发送后落盘前崩溃的重复执行测试。
- [x] 执行前同步持久化 claim，完成后同步更新结果；启动时恢复中断 claim。
- [x] 对 once 与 cron 使用稳定执行键去重。
- [x] 验证重启后不重复不可逆副作用。
- [x] 更新维护日志并提交。

## Chunk 3: Web、容器与质量基线

### Task 8: 移除 GET 诊断写副作用

**Files:**
- Modify: `web/memoryV3NocturneRoute.js`
- Test: `tests/memoryV3NocturneRoute.test.js`

- [x] 增加 GET 强制只读测试。
- [x] GET 固定 autoClean false，清洗仅允许鉴权 POST。
- [x] 验证查询参数无法重新开启 GET 清洗。
- [x] 更新维护日志并提交。

### Task 9: Docker 非 root 与最小暴露

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker/README.md`

- [x] 使用镜像内置 node 用户运行并修正运行目录权限。
- [x] Web 与 NapCat 端口默认仅绑定宿主 loopback。
- [ ] 验证容器 UID 非 0、数据卷可写、端口绑定正确。
- [x] 更新部署文档并提交。

### Task 10: 容器健康检查和依赖门控

**Files:**
- Modify: `docker-compose.yml`
- Modify: `web/server/index.js`
- Test: `tests/webHealthRoute.test.js`

- [x] 增加不泄露状态的健康检查接口。
- [x] Compose 增加 healthcheck，worker 使用 service_healthy。
- [ ] 验证主服务未就绪时 worker 不启动。
- [x] 更新部署文档并提交。

### Task 11: 恢复提示词契约测试

**Files:**
- Modify: `prompts/admin.txt`
- Test: `tests/configPersonaPrompt.test.js`

- [x] 删除异常双响应指令，恢复当前消息、无第三人称叙述等既有契约。
- [x] 单跑提示词测试并确认通过。
- [x] 更新维护日志并提交。

### Task 12: 扩大 lint 覆盖并完成全量验收

**Files:**
- Modify: `scripts/lint.js`
- Modify: `docs/maintenance-log.md`
- Modify: `README.md`

- [x] 统计 chunk 文件并将真实运行代码纳入语法检查。
- [x] 运行 npm run lint、npm audit --omit=dev、npm run diag:security。
- [x] 运行全部定向测试和完整 npm test，保留退出码与时间戳。
- [x] 检查 git diff 仅包含 12 项修复相关改动。
- [x] 更新 README 与维护日志并提交最终验收记录。
