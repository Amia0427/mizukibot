# 测试与质量门禁

更新：2026-08-01 +08:00

本项目没有统一测试框架包装所有用例。`tests/*.test.js` 大多是直接使用 Node `assert` 的可执行 CommonJS 脚本，仓库用 `scripts/run-tests.js` 负责发现、隔离、并发、超时和结果汇总。

## 1. 测试是怎样执行的

### 1.1 发现规则

无参数运行时，测试运行器优先执行：

```bash
git ls-files -z -- tests/*.test.js
```

也就是说，`npm test` 只发现 Git 已跟踪且实际存在的 `*.test.js`。刚创建但未加入 Git 的测试不会进入默认全量套件；开发阶段必须显式传入路径执行它。

```bash
node scripts/run-tests.js tests/mainReplyContextPreviewRoute.test.js
node scripts/run-tests.js mainReplyContextPreviewRoute.test.js
```

两种形式都有效。传入多个文件时只运行指定集合；路径不存在会直接失败，不会静默跳过。

### 1.2 隔离、并发和超时

每个测试文件由独立 Node 子进程运行，并启用 `--unhandled-rejections=strict`。运行器会：

- 把测试临时根目录默认放到仓库同级的 `waifu-test-temp`，避免污染生产 `data/`；
- 设置 `TEST_TEMP_ROOT`、`TEMP`、`TMP` 和 `TMPDIR`；
- 测试未显式指定时关闭资源压力、TLS impersonation 和 memory rerank 等不稳定外部能力；
- 默认并发 2，`TEST_CONCURRENCY` 可调，硬上限为 8；
- 单文件默认超时 60 秒，超时后终止完整进程树；
- 按输入顺序输出结果，并列出最慢的测试文件。

涉及进程锁、跨进程日志轮转、worker PID、嵌套测试运行器或 PowerShell 进程检查的用例由 `SERIAL_TEST_REASONS` 强制串行。新增此类测试时，先消除共享状态；确实无法并行后再把文件和原因加入串行表，并补 `tests/runTestsRunner.test.js`。

### 1.3 测试文件约定

测试文件使用 `featureOrBoundary.test.js` 命名。同步用例可直接执行断言；异步用例应导出可等待的 Promise，并在失败时设置非零退出码。推荐结构：

```js
const assert = require('assert');

module.exports = (async () => {
  const result = await runSubject();
  assert.strictEqual(result.ok, true);
  console.log('subject.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

不要用固定 sleep 等待并发结果；注入 clock、回调或可观察状态。不要访问真实模型、QQ、MCP、用户数据或外网。

## 2. 测试隔离规则

### 2.1 环境必须先于模块加载

`config/index.js` 在首次加载时读取环境并构建目录、prompt 和运行时配置。测试配置或存储时按以下顺序：

1. 保存相关 `process.env` 快照。
2. 用 `fs.mkdtempSync()` 创建临时根目录。
3. 设置 `DATA_DIR` 及当前测试专用配置。
4. 再 `require()` 被测模块。
5. `finally` 中关闭连接、移除监听器、恢复环境和模块缓存。

不要把测试值写进仓库 `.env`。不要依赖开发机当前 `.env` 恰好包含某个开关。

### 2.2 文件和数据库

- JSON/JSONL 测试写入临时目录，并验证 flush 后的磁盘状态。
- SQLite 测试使用独立数据库，结束前关闭连接；并发用例应通过真实子进程验证 WAL 和锁行为。
- LanceDB、向量索引和物化结果属于派生状态，测试同时验证权威事件或结构化记录。
- 测试不得读取或删除默认 `DATA_DIR`。

可参考 `tests/diskFirstMemoryStores.test.js`、`tests/sqliteConcurrency.test.js` 和 `tests/logRotationCrossProcess.test.js`。

### 2.3 全局状态

修改 `require.cache`、process signal listener、全局单例或定时器的测试，必须在 `finally` 恢复。底层 store 不应拥有进程退出信号，相关回归见 `tests/jsonHotStoreSignalOwnership.test.js`。测试结束后仍有活动 timer、server 或 child process，通常意味着产品代码的生命周期边界不完整，不要用强制 `process.exit(0)` 掩盖。

## 3. 按风险选择测试

### 3.1 配置与启动

```bash
node scripts/run-tests.js tests/envFile.test.js tests/nodeVersionPolicy.test.js tests/lowResourceConfig.test.js
node scripts/run-tests.js tests/mainProcessLifecycle.test.js tests/serverLifecycle.test.js
```

验证默认值、回退、环境优先级、启动失败信息和优雅关闭。改配置默认值时至少包含缺省、显式启用、显式禁用和非法值四类。

### 3.2 消息、路由和 Runtime V2

```bash
node scripts/run-tests.js tests/messageIngressDispatcher.test.js tests/routeExecution.test.js
node scripts/run-tests.js tests/langgraphV2.test.js tests/directToolLoop.test.js tests/runtimeStreamingCoordinator.test.js
```

路由规则还要覆盖相近语句不误命中、权限差异、route meta 和最终 executor；节点改动要覆盖成功、可重试失败、终止事件和持久化状态。

### 3.3 模块边界与 facade

```bash
node scripts/run-tests.js tests/messageHandlerModuleBoundary.test.js
node scripts/run-tests.js tests/runtimeContextModuleBoundary.test.js tests/memoryVectorModuleBoundary.test.js
node scripts/run-tests.js tests/refactorSrcFacades.test.js tests/hotpathRequireGuard.test.js tests/lintChunkEntrypoints.test.js
```

这些测试不是普通行为测试的替代品。它们保护唯一实现所有者、静态依赖图、导出键、对象身份、冷启动惰性和旧 chunk 不执行。修改 facade、目录入口、require 位置或导出形状时必须运行。

### 3.4 工具和外部协议

```bash
node scripts/run-tests.js tests/toolContractsValidation.test.js tests/toolExecutionValidation.test.js
node scripts/run-tests.js tests/toolPolicyCoverage.test.js tests/toolPolicyRuntimeEffects.test.js tests/capabilityPolicyParity.test.js tests/toolUnknownCapabilityGate.test.js
node scripts/run-tests.js tests/httpClientSecurity.test.js tests/networkSafetyHttpIntegration.test.js
```

工具测试同时检查 schema/executor/policy manifest 全覆盖、参数化 action 的副作用、并行与缓存行为、未知能力默认阻断、参数拒绝、权限过滤和失败文本。动态 MCP 测试必须使用受控 registry 精确注册，不能用 `mcp_*` 名称前缀伪造已注册能力；HTTP 测试应使用本地受控 server 或 fake request，覆盖重定向和 SSRF 边界。

### 3.5 记忆、Prompt 与 Web

```bash
node scripts/run-tests.js tests/memoryWritePipeline.test.js tests/memoryV3Query.test.js tests/memoryV3ScopeBoundary.test.js
node scripts/run-tests.js tests/promptCompiler.test.js tests/promptSecurity.test.js tests/promptGoldenSnapshots.test.js
node scripts/run-tests.js tests/webAuthSecurity.test.js tests/webSessionSecurity.test.js tests/webHealthRoute.test.js
```

记忆用例优先验证证据、namespace、版本、冲突和召回原因；prompt 用例验证块来源、权限、顺序和预算；Web 用例验证未鉴权、登录限流、cookie、同源写入和安全响应头。

### 3.6 Worker、并发和运维脚本

```bash
node scripts/run-tests.js tests/postReplyWorkerRuntime.test.js tests/postReplyWorkerDrain.test.js
node scripts/run-tests.js tests/foregroundConcurrency.test.js tests/messageHandlerInboundConcurrency.test.js
node scripts/run-tests.js tests/restartBotScript.test.js tests/windowsDaemonScript.test.js
```

并发测试要断言资源上限、每会话顺序、取消、超时和恢复；运维脚本测试以源码/临时进程验证目标识别，不能真的重启开发机上的 bot。

## 4. 本地质量命令

### 4.1 开发循环

按从快到慢执行：

```bash
node scripts/run-tests.js tests/<closest>.test.js
npm run lint
npm run typecheck
```

`npm run lint` 包含两层：ESLint 以零 warning 为门禁；随后 `scripts/lint.js` 对生产 JavaScript 做语法检查，并验证 chunk 是否由声明入口覆盖。ESLint 有意忽略 `.chunk.js`，不代表 chunk 不受检查，也不应单独执行它们。

`npm run typecheck` 只检查 `tsconfig.check.json` 中列出的稳定 JavaScript 边界，不是整个仓库的 TypeScript 严格检查。这些文件使用 `// @ts-check`，禁止 `@ts-ignore`、`@ts-nocheck` 和 JSDoc `any` 绕过类型问题；对应策略由 `tests/qualityToolingPolicy.test.js` 保护。

### 4.2 Prompt、密钥和 Agent 静态检查

```bash
npm run check:prompts
npm run check:secrets:all
npm run check:agent:static
```

- prompt 或上下文组装变化必须跑 `check:prompts`；
- 任意配置、日志、文档、测试夹具或发布边界变化必须跑 `check:secrets:all`；
- tool schema、executor、Runtime 图或 Agent 入口变化必须跑 `check:agent:static`。

`check:agent:static` 设置 `CHECK_RUN=0`，只验证构造和契约；它会输出 schema、executor、policy 数量，并在映射缺失、过期 policy、非法字段或公开/internal 暴露不一致时退出 1。需要真实 provider 的动态自检不属于普通提交门禁，不能用个人密钥在 CI 中代替。

### 4.3 全量测试和覆盖率

```bash
npm test
npm run coverage
npm run coverage:check
```

`npm run coverage` 使用 c8 执行全量测试，生成 `artifacts/coverage/coverage-summary.json`、`baseline-check.json` 和 `lcov.info`，随后立即检查 `config/coverage-baseline.json`。当前最低覆盖率：

| 范围 | Lines/Statements | Functions | Branches |
| --- | ---: | ---: | ---: |
| 全部生产代码 | 69% | 79% | 61% |
| `web/` | 78% | 83% | 79% |
| Runtime V2 非 chunk | 74% | 69% | 58% |
| 稳定安全边界 | 84% | 80% | 70% |

不要通过排除新文件、下调基线或只测 getter 来“修复”覆盖率。新增公共分支应由行为断言覆盖。

### 4.4 版本化 Harness 评估

```bash
npm run eval:harness:ci
```

`tests/fixtures/harness-eval-manifest.json` 固定 suite schema、case 数量和规范化 SHA-256。`scripts/check-harness-eval-fixtures.js` 会拒绝空集、重复 ID、越界路径和非 synthetic 数据；真实对话导出仍只能留在被忽略的 `artifacts/`，不能混入 CI fixture。

该命令依次验证 memory routing stability、synthetic auto-gold 真实召回指标和 post-reply learning。routing suite 只证明是否应召回及 facet 分类，Recall/MRR、wrong-hit、scope/lifecycle leakage 由 auto-gold suite 单独证明，二者不能互相替代。

Memory recall CLI 必须显式选择输入：

```bash
node scripts/eval-memory-recall.js --auto-gold --limit 20
node scripts/eval-memory-recall.js --cases tests/fixtures/<compatible-recall-cases>.jsonl
```

无 `--cases`、`--auto-gold` 或 `--build-cases` 会直接失败，避免静默读取本地 `artifacts/`。Post-reply eval 默认使用 tracked fixture，也可通过 `--cases <path>` 显式覆盖。

### 4.5 冒烟入口

```bash
npm run smoke:napcat-ingress
npm run smoke:runtime-hotfixes
npm run smoke:pre-release
```

- `smoke:napcat-ingress` 覆盖 WebSocket/HTTP reverse 和异步入站；
- `smoke:runtime-hotfixes` 覆盖近期关键回归组合；
- `smoke:pre-release` 覆盖 Windows restart/daemon、fallback 恢复、连续消息和并发配置。

冒烟集是发布前的快速风险样本，不代表全量测试或覆盖率已通过。

## 5. CI 和供应链门禁

`.github/workflows/ci.yml` 的 Windows quality job 依次执行：

1. `npm ci`
2. `npm run check:node`
3. `npm run lint`
4. `npm run typecheck`
5. `npm run check:prompts`
6. `npm run check:secrets:all`
7. `npm audit --omit=dev`
8. `npm run eval:harness:ci`
9. `npm run coverage`

Linux policy job另外检查 Node 版本、shell 脚本语法和仓库策略测试。`.github/workflows/supply-chain.yml` 还执行 Git 历史 Gitleaks、生产许可证策略、CycloneDX SBOM 和 OSV 依赖漏洞扫描。

本地通过不保证供应链 job 通过。修改依赖、lockfile、Docker、workflow 或发布白名单时，要额外运行：

```bash
node scripts/run-tests.js tests/ciWorkflow.test.js tests/supplyChainPolicy.test.js tests/dockerSecurityConfig.test.js
npm audit --omit=dev
```

## 6. 变更类型与最低证据

| 变更 | 最低测试 | 额外门禁/验收 |
| --- | --- | --- |
| 纯业务函数 | 新增窄测试 + 相邻回归 | `npm run lint` |
| 路由/Runtime 节点 | 路由或节点测试 + facade/边界测试 | `check:agent:static`，必要时 route 诊断 |
| 配置默认值 | config 测试 + 对应功能测试 | static check，文档说明 |
| Prompt | compiler/security/stage 测试 | `check:prompts`，实际 prompt 诊断 |
| 工具/外部 HTTP | contract/execution/security 测试 | `check:agent:static`，无真实密钥 |
| 存储/记忆 | 临时目录行为测试 + 并发/恢复测试 | SQLite/记忆只读诊断 |
| Web API | route 注入测试 + auth/session/header 测试 | Web coverage 门槛，本地 HTTP smoke |
| Worker/进程脚本 | 生命周期、锁、drain 测试 | 状态诊断，不直接重启生产 |
| 依赖/发布 | policy 测试 | audit、license、SBOM/OSV CI |

风险跨越多个边界时取并集，不选最轻的一项。

## 7. 失败时怎样定位

- 单文件失败：直接用 `node scripts/run-tests.js tests/<name>.test.js` 重跑，保留完整 stderr。
- 全量才失败：用输出中的 slowest/失败文件构造最小集合，检查共享环境、缓存、端口、文件和进程泄漏。
- 并发才失败：临时将 `TEST_CONCURRENCY` 设为 1 验证是否存在共享所有权问题；不要直接把普通测试加入串行表。
- 超时：先找未关闭的 server、timer、worker 或 child process，再评估 `TEST_FILE_TIMEOUT_MS`；不要先扩大超时。
- CI 才失败：复现 CI 的 Node 20、`npm ci`、临时 `DATA_DIR` 和无个人 `.env` 条件。
- coverage 失败：查看 `artifacts/coverage/baseline-check.json` 的具体 scope/metric，不只看 total。

同一思路连续三次仍不能解释失败时，停止重复执行，重新检查测试前提、模块所有权和是否在错误边界修补。

## 8. 验收记录

完成结论必须来自实际命令。提交或维护文档至少记录：

```text
时间：2026-07-31 00:00 +08:00
范围：修改的行为和文件
命令：node scripts/run-tests.js tests/<example>.test.js
结果：PASS；断言了什么
命令：npm run lint
结果：PASS
未运行：npm run coverage；原因和剩余风险
```

不要写“应该通过”“未发现明显问题”或只贴退出码。说明命令覆盖的行为，以及没有验证的部分。
