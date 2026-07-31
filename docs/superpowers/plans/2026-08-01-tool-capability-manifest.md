# Tool Capability Manifest Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Runtime V2 的所有公开静态工具和动态 MCP 都有完整、可验证且默认拒绝未知能力的副作用契约，为后续统一确认票据与幂等协议提供可信输入。

**Architecture:** 将能力分类从参数规范化器中拆到独立 manifest，`getPolicy(toolName, args)` 只负责解析静态或动态策略；Runtime V2 capability registry 直接消费同一策略生成 `readOnly`、`sideEffect` 和 `parallelSafe`。动态 action 工具按规范化参数区分读写；两个执行入口只接受 manifest 静态工具或 registry 中真实存在的动态 MCP，任意未知名称和未知 action 都 fail closed，且不进入并行或只读缓存。

**Tech Stack:** Node.js CommonJS、现有 Runtime V2 capability registry、`scripts/run-tests.js`

---

## Chunk 1: Complete Policy Contract

### Task 1: Add a versioned, exhaustive manifest

**Files:**
- Create: `utils/toolPolicy/manifest.js`
- Modify: `utils/toolPolicy/index.js`
- Create: `tests/toolPolicyCoverage.test.js`

- [x] **Step 1: Write failing manifest tests**

断言每个静态 schema 和 executor 都有显式 policy；每条 policy 都包含 `version`、`risk`、`capability`、`effect`、`confirmation`、`scope`、`idempotency`、`replay` 和 `exposure`。schema 工具必须为 `public`；唯一 executor-only 的 `local_howtocook_recipe_search` 明确标为 `internal`，不能被误当成遗漏 schema 的公开工具。未知工具必须返回 `risk=high`、`effect=unknown`、`confirmation=explicit`，不能回退到 `low/general`。

- [x] **Step 2: Run the test and verify it fails**

Run: `node scripts/run-tests.js tests/toolPolicyCoverage.test.js`
Expected: FAIL because 76 schema names and 77 executor names have no explicit policy, and unknown tools are fail-open.

- [x] **Step 3: Implement the minimal manifest**

使用冻结的共享 policy 模板按行为分组声明全部静态工具，导出的 `TOOL_POLICIES` 仍保留按工具名直接索引的兼容形状。`getPolicy(toolName, args)` 返回新对象，未知工具和 `mcp_*` 使用 unknown policy；原有 `risk/capability` 字段保持兼容。

- [x] **Step 4: Run the manifest tests**

Run: `node scripts/run-tests.js tests/toolPolicyCoverage.test.js tests/toolPolicyQzone.test.js tests/toolContractsValidation.test.js`
Expected: PASS, with schema/executor/policy coverage at 100%.

## Chunk 2: Argument-Aware Effects

### Task 2: Classify mixed read/write tools by action

**Files:**
- Modify: `utils/toolPolicy/manifest.js`
- Modify: `utils/toolPolicy/index.js`
- Modify: `api/runtimeV2/runtime/toolExecution.js`
- Modify: `api/runtimeV2/runtime/directToolLoop.js`
- Modify: `api/runtimeV2/capabilities/scheduler.js`
- Modify: `api/runtimeV2/nodes/dispatch.js`
- Modify: `core/executablePlan.js`
- Modify: `tests/toolPolicyCoverage.test.js`
- Create: `tests/toolPolicyRuntimeEffects.test.js`

- [x] **Step 1: Add failing dynamic-effect assertions**

覆盖 `skill_stock_watchlist` 的 `list/check` 与 `add/remove`、`skill_stock_portfolio` 的 `list/show` 与修改操作、`skill_ontology_graph` 的读写/删除，以及 `create_scheduled_command` 的 `group_message/qzone_post`。`skill_ontology_graph:validate` 在 schema 缺失时会初始化文件，因此按 `local_write` 处理；未知 action 必须是 unknown effect，删除类 action 必须是 destructive。

- [x] **Step 2: Verify the assertions fail**

Run: `node scripts/run-tests.js tests/toolPolicyCoverage.test.js`
Expected: FAIL because `getPolicy` currently ignores args and the stock tools have no policies.

- [x] **Step 3: Add focused resolvers**

只为混合行为工具增加 resolver：读 action 返回 `effect=none`，本地修改返回 `local_write`，删除返回 `destructive`，定时外发创建返回 `external_send`。scheduler 的 batch/cache、dispatch 的 checkpoint、direct tool loop 和 execution envelope 都必须把 `step.inputs` 或规范化参数传给 `getPolicy`；resolver 不做通用参数校验，但必须返回明确的 `unknown_action` resolution，两个执行入口在 executor 前阻断。未携带 action 时返回该工具的保守写入策略，避免 catalog 或旧调用点误判为只读。

- [x] **Step 4: Add runtime effect parity assertions**

使用受控 executor 和内存 cache 验证：stock/ontology 读 action 可参与只读并行与缓存；写入/删除 action 强制串行、不写只读 cache；并发相同写 action 不被 inflight dedupe 合并；direct 与 scheduler envelope 的 `side_effect` 一致；dispatch 只为写入/删除 action产生 `before_side_effect/after_side_effect` checkpoint。direct 与 scheduler 对未知 action 都返回 `blockedReason=unknown_action` 且 executor 调用次数为 0。

- [x] **Step 5: Run focused policy tests**

Run: `node scripts/run-tests.js tests/toolPolicyCoverage.test.js tests/toolPolicyRuntimeEffects.test.js tests/toolPolicyQzone.test.js`
Expected: PASS.

## Chunk 3: Runtime Descriptor Parity

### Task 3: Make descriptors consume the manifest

**Files:**
- Modify: `api/runtimeV2/contracts.js`
- Modify: `api/runtimeV2/capabilities/registry.js`
- Create: `tests/capabilityPolicyParity.test.js`

- [x] **Step 1: Write failing descriptor parity tests**

断言静态 descriptor 的 policy/effect 与 manifest 一致；`readOnly:false` 即使未显式传 `sideEffect` 也必须得到 `sideEffect:true`；registry 实际返回的动态 MCP 固定为 unknown side effect、不可并行、不可恢复，任意 `mcp_*` 前缀本身不构成注册证明。

- [x] **Step 2: Verify the tests fail**

Run: `node scripts/run-tests.js tests/capabilityPolicyParity.test.js`
Expected: FAIL because static descriptors do not consume policy and MCP loses the side-effect flag.

- [x] **Step 3: Implement descriptor parity**

`createCapabilityDescriptor` 统一推导 `readOnly/sideEffect/parallelSafe`；静态 registry 在构造 descriptor 时注入 manifest 基础 policy，混合工具 descriptor 保持保守副作用属性，实际 step 再按 args 解析。动态 MCP 显式注入 unknown policy。descriptor metadata 只记录 policy version，不复制或记录工具参数。

- [x] **Step 4: Run scheduler and runtime regressions**

Run: `node scripts/run-tests.js tests/capabilityPolicyParity.test.js tests/agentSchedulerOptimization.test.js tests/readonlyToolInflightDedup.test.js tests/schedulerRuntimeCrashRecovery.test.js`
Expected: PASS; unknown/write-like capabilities are serial and never cached as read-only.

### Task 4: Block unregistered capabilities at both execution entries

**Files:**
- Modify: `api/runtimeV2/runtime/toolExecution.js`
- Modify: `api/runtimeV2/capabilities/scheduler.js`
- Create: `tests/toolUnknownCapabilityGate.test.js`

- [x] **Step 1: Write failing executor-injection tests**

在 allowlist 包含未知名且调用方注入同名 executor 的情况下，分别断言 direct `runToolStep` 与 capability scheduler 返回 `blockedReason=unknown_capability`，executor 调用次数保持 0；`exposure=internal` 的 executor-only 工具也不得从普通 allowlist 或 admin raw bypass 直调。只有真实 dynamic registry 精确名称集合中的 MCP 保持可解析，但仍按 unknown side effect 串行执行。

- [x] **Step 2: Verify the tests fail**

Run: `node scripts/run-tests.js tests/toolUnknownCapabilityGate.test.js`
Expected: FAIL because both entry points currently execute allowlisted injected executors without a registered policy/descriptor.

- [x] **Step 3: Add the shared registration boundary**

静态入口要求 manifest 显式成员且 `exposure=public`；`local_howtocook_recipe_search` 只供 MCP static replacement owner 内部调用。动态入口只认 `api/toolRegistry` 返回的真实 dynamic registry 精确名称集合，不接受名称前缀或调用方伪造的 descriptor metadata。阻断沿用标准 execution envelope，不抛出到图外。

- [x] **Step 4: Run execution regressions**

Run: `node scripts/run-tests.js tests/toolUnknownCapabilityGate.test.js tests/localToolRuntimeAllowlist.test.js tests/toolExecutionValidation.test.js tests/agentSchedulerOptimization.test.js`
Expected: PASS; test-only custom capability 必须显式提供 policy/descriptor registration evidence。

## Chunk 4: Static Gate and Documentation

### Task 5: Prevent future registry drift

**Files:**
- Modify: `scripts/check-agent.js`
- Modify: `tests/toolPolicyCoverage.test.js`
- Modify: `docs/development/03-message-and-agent-runtime.md`
- Modify: `docs/development/06-testing-and-quality.md`
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`

- [x] **Step 1: Make Agent static check enforce the mapping**

`check:agent:static` 必须校验 schema/executor 名称集合与 manifest 覆盖，输出计数；发现遗漏或非法 policy 字段时退出 1。

- [x] **Step 2: Run acceptance**

Run: `node scripts/run-tests.js tests/toolPolicyCoverage.test.js tests/toolPolicyRuntimeEffects.test.js tests/capabilityPolicyParity.test.js tests/toolUnknownCapabilityGate.test.js tests/toolPolicyQzone.test.js tests/toolContractsValidation.test.js tests/toolExecutionValidation.test.js tests/agentSchedulerOptimization.test.js tests/readonlyToolInflightDedup.test.js tests/schedulerRuntimeCrashRecovery.test.js`
Expected: PASS.

Run: `npm run check:agent:static && npm run lint && npm run typecheck && npm run check:secrets:all && git diff --check`
Expected: all exit 0.

Run: `npm test && npm run coverage`
Expected: all tracked tests and four coverage scopes pass.

- [x] **Step 3: Commit implementation, then append its hash and completion record**

Commit code, tests, the plan and stable development documentation with `feat: enforce tool capability manifest`; after that, update README, maintenance log and this plan with the implementation hash and a short `2026-08-01` timestamp, then create a separate documentation commit. Do not push.

完成记录（2026-08-01 02:28 +08:00）：实现提交 `2d1afad` 已创建；`npm test`、`npm run coverage`、lint、typecheck、Agent 静态检查、Prompt 清单、全仓 secrets 与 `git diff --check` 均退出 0，四个 coverage scope 全部通过。README、维护日志和本计划已记录实现哈希，文档提交单独创建且不推送。

## Deferred Follow-up: Confirmation and Replay Protocol

确认票据、一次性消费、持久化幂等账本和 `tool_authorization_decision` 事件不在本计划内。它们需要先定义 QQ 二次确认的跨消息状态机及可信授权来源；在该交互契约完成前，不把模型参数或单轮 allowlist 伪装成用户确认。

`api/legacy/aiHost.js` 的兼容执行入口也不在本计划内；生产 Runtime V2 完成后，下一阶段应在抽取共享 `executeAuthorizedToolCall` 内核时一并收口，而不是在 legacy 文件复制第三套 gate。
