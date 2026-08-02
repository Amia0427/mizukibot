# Manifest-Driven Harness Eval Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一个版本化 manifest 成为 Harness 评估的唯一执行契约，统一声明 profile、runner、case schema、阈值和可上传 JSON 报告，并为真实模型与脱敏回放结果建立有 producer 元数据、最小覆盖量且缺失输入即失败的 nightly 验证边界。

**Architecture:** 将 manifest 升级为 v2，每个 suite 使用结构化 runner 描述本地 Node 执行器或外部结果输入；确定性 runner 仍复用现有三个评估测试，但必须发布统一 suite result。独立 contract 模块验证 suite result 并按 manifest 阈值判定，顶层 runner 只负责编排 profile、隔离子进程和汇总报告；`nightly:verify` 只验证显式指定、未过期且带 producer 自报元数据的外部结果，不冒充真实模型/脱敏回放 producer，也不声称提供签名或可信身份认证。

**Tech Stack:** Node.js 20 CommonJS、JSON/JSONL、现有 `scripts/run-tests.js`、GitHub Actions

---

## Chunk 1: Versioned Execution Contract

### Task 1: Lock the v2 manifest shape with failing tests

**Files:**
- Modify: `tests/harnessEvalFixtures.test.js`
- Modify: `tests/fixtures/harness-eval-manifest.json`
- Modify: `scripts/check-harness-eval-fixtures.js`
- Create: `scripts/harness-eval-contract.js`

- [x] **Step 1: Add failing manifest assertions**

要求 tracked manifest 使用 `harness_eval_manifest_v2`，包含 `ci` 与 `nightly:verify` profile；`ci` 精确选择三个本地 suite，`nightly:verify` 在此基础上要求 `live-model-tasks` 与 `redacted-replay` 两个外部结果 suite。每个 suite 必须声明结构化 `runner`、已知 `caseSchemaVersion`、与 schema 固定一致的 `dataPolicy`、合法 metrics 白名单和完整的必需 `thresholds` 集合。

- [x] **Step 2: Add fail-closed validation cases**

覆盖未知 runner 类型、逃逸项目根目录或不存在的 Node runner、未知 case schema、fixture case 缺字段、阈值使用未知运算符、profile 引用未知 suite、external result 环境变量名非法或重复。Post-reply case 按 `job`、`enrich`、`budget`、`rollback`、`recovery` 五类判别联合验证：必须且只能出现一个主字段，只有 `enrich` 可同时出现可选 `context`，每类分别覆盖有效样本和混合形状失败。现有数量、摘要、唯一 ID、路径和 synthetic 隐私测试继续保留。

- [x] **Step 3: Run the test and verify it fails**

Run: `node scripts/run-tests.js tests/harnessEvalFixtures.test.js`

Expected: FAIL because v1 has no profiles, auto-gold suite, structured runners or thresholds.

- [x] **Step 4: Implement the minimal contract**

`scripts/harness-eval-contract.js` 只负责共享 schema 常量、suite result 结构校验和 `min`/`max`/`eq` 阈值判定。`scripts/check-harness-eval-fixtures.js` 负责 manifest、runner 路径、profile 引用、fixture JSONL 和具体 case schema；支持以下五个 schema：

```text
memory_recall_stability_v1: id, class, query, shouldUseMemory, expectedFacet
memory_recall_eval_v2: generated synthetic cases, result-side schema evidence
post_reply_learning_v1: id, expected, one of job/enrich/budget/rollback/recovery; context only with enrich
live_model_task_v1: external result summary with synthetic_only data policy
redacted_replay_v1: external result summary with redacted_only data policy
```

指标与阈值按 schema 固定，不允许 suite 自行删减：

```text
memory_recall_stability_v1: passRate [0,1] min=1; failedCases integer >=0 max=0
memory_recall_eval_v2: recallAt5/mrrAt5 [0,1] min=0.5; wrongHitRate [0,1] max=0; leakage/lifecycleLeakage/forbiddenHits integer >=0 max=0
post_reply_learning_v1: passRate [0,1] min=1; failedCases integer >=0 max=0
live_model_task_v1: passRate [0,1] min=1; failedCases integer >=0 max=0
redacted_replay_v1: passRate [0,1] min=1; failedCases/privacyViolations integer >=0 max=0
```

外部 suite 只接受结果摘要，不接收原始对话内容；`resultFileEnv` 必须是 `HARNESS_EVAL_*_RESULT_FILE` 形式，并声明结果最大字节数、最大时效和正整数 `minCaseCount`。Tracked manifest 要求 live-model 至少 20 条、redacted-replay 至少 50 条；`invocationCount >= caseCount`，`replayCaseCount === caseCount`。Live-model producer 元数据使用通用字段加 `model/invocationCount`；redacted-replay 使用通用字段加 `replayCaseCount/redactionPolicyVersion`，两个分支互不接受对方字段。`inputDigest/configHash` 只作为可审计的 producer 自报元数据，不作为真实性证明；签名、可信 producer 身份和固定 case-set digest 必须在实际 producer 接入时另行定义。所有未知 schema、runner、profile 引用和 threshold 形状都直接失败。

- [x] **Step 5: Run the contract tests**

Run: `node scripts/run-tests.js tests/harnessEvalFixtures.test.js`

Expected: PASS, reporting 5 registered suites, 3 CI suites and 5 `nightly:verify` suites.

## Chunk 2: Unified Suite Results

### Task 2: Make the three deterministic suites publish one result schema

**Files:**
- Modify: `tests/memoryRecallStabilityCases.test.js`
- Modify: `tests/memoryRecallAutoGoldEval.test.js`
- Modify: `tests/postReplyLearningEval.test.js`
- Modify: `tests/harnessEvalFixtures.test.js`
- Modify: `scripts/harness-eval-contract.js`

- [x] **Step 1: Add failing suite-result assertions**

构造有效和无效 `harness_eval_suite_result_v1`，验证 suite ID、case schema、data policy、正整数 `caseCount`、`completedCaseCount === caseCount` 和有限数值 metrics。Fixture suite 的 `caseCount` 必须与 manifest 完全一致；每种 case schema 只接受显式 metrics 白名单，未知顶层字段和未知 metric 均失败。比例指标必须位于 `[0,1]`，计数指标必须是非负整数；验证负比例、大于 1 的比例、零完成样本、阈值缺少必需指标、指标为 `null`/非有限数、结果声称不同 suite 或不同 data policy 时均失败。

对包含 `passRate/failedCases` 的 schema，要求 `passRate === (caseCount - failedCases) / caseCount`；overall status 只能由全部必需阈值的合取产生，runner 或外部结果不能自报通过。Auto-gold 不伪造逐 case 通过语义，只要求所有 case 已完成，并由 Recall/MRR 与污染指标的完整阈值集合决定 overall status。

外部结果额外要求严格 `producer` 白名单：通用字段为 `producerVersion`、`runId`、`generatedAt`、`inputDigest`、`configHash`；live-model 还要求非空 `model` 与正整数 `invocationCount`，redacted-replay 还要求 `replayCaseCount === caseCount` 与非空 `redactionPolicyVersion`。摘要/hash 固定为 64 位小写 SHA-256，未来时间超过 5 分钟时钟偏差、结果过期、低于 manifest `minCaseCount`、超过字节上限的文件均失败。

- [x] **Step 2: Verify the assertions fail**

Run: `node scripts/run-tests.js tests/harnessEvalFixtures.test.js tests/memoryRecallAutoGoldEval.test.js`

Expected: FAIL because no suite result contract exists and auto-gold thresholds remain hard-coded in the test.

- [x] **Step 3: Publish results from existing tests**

三个评估测试只保留输入构造、结果字段和分支覆盖等结构断言，case 正确性统一收集为 metrics，不再在发布 suite result 前逐 case 硬失败。执行协议为 `HARNESS_EVAL_MANIFEST_FILE`、`HARNESS_EVAL_SUITE_ID`、`HARNESS_EVAL_RESULT_FILE` 三者必须全部存在或全部不存在；存在时 helper 只读取指定 manifest 和 suite，不存在时才读取 tracked manifest 中测试自身的固定 suite。增加临时 manifest 使用不同阈值且包含失败 case 的测试，证明子 runner 不会静默回退 tracked manifest，放宽阈值时确实可由 manifest 决定通过。结果文件原子写入。Auto-gold 删除测试内 `0.5` 和 `0` 硬编码，改由 manifest 的 `recallAt5`、`mrrAt5`、`wrongHitRate`、`leakage`、`lifecycleLeakage`、`forbiddenHits` 阈值驱动。

- [x] **Step 4: Run the deterministic suites directly**

Run: `node scripts/run-tests.js tests/memoryRecallStabilityCases.test.js tests/memoryRecallAutoGoldEval.test.js tests/postReplyLearningEval.test.js`

Expected: PASS; direct execution and future profile execution use the same manifest thresholds.

## Chunk 3: Profile Runner and Reports

### Task 3: Execute local and external suites through one profile runner

**Files:**
- Create: `scripts/run-harness-eval.js`
- Create: `tests/harnessEvalRunner.test.js`
- Modify: `package.json`

- [x] **Step 1: Write failing orchestration tests**

用临时 manifest 和极小 Node runner 验证：只执行 profile 选择的 suite；子 runner 未写结果、退出非零、超时、输出超限、结果 schema 不匹配或阈值失败时整体失败；成功时报告包含 manifest/profile/version、起止时间、suite 状态、metrics 和逐阈值判定。外部 runner 必须从声明的环境变量读取现存 JSON 文件，缺失变量、文件不存在、文件过大、结果过期、低于最小样本量、producer 元数据不完整或 data policy 不匹配时失败。

子进程环境使用显式 OS 白名单，只保留 Node 启动需要的 `PATH`、`PATHEXT`、`SYSTEMROOT`、`WINDIR`、`COMSPEC`、`TEMP`/`TMP` 系列和基础 locale；重新设置临时 `DATA_DIR`、空 `AGENT_PROMPT_EXTRA_ROOTS` 与指向不存在文件的 `MIZUKIBOT_ENV_FILE`，再加入三项 Harness 协议变量。Node runner 必须声明 `timeoutMs` 与 `maxOutputBytes`；达到任一限制时终止完整进程树，并以稳定错误码写报告。测试在父进程放入 sentinel API key、模型端点和生产数据路径，断言子 runner 全部不可见；另用挂起 runner 与持续输出 runner 验证两个资源边界。

- [x] **Step 2: Verify the runner test fails**

Run: `node scripts/run-tests.js tests/harnessEvalRunner.test.js`

Expected: FAIL because `scripts/run-harness-eval.js` does not exist.

- [x] **Step 3: Implement sequential profile execution**

顶层 runner 参数为 `--manifest`、`--profile` 和 `--report`。本地 suite 逐个以隔离子进程执行，传入 suite ID、manifest path 和唯一临时 result path；只捕获有上限的执行输出，不解析控制台文本。外部 suite 只读取结果文件。Manifest/profile 验证成功后，即使某个 suite 失败也继续收集其余 suite，保证两个缺失 external 输入都进入报告。

最终报告使用严格 `harness_eval_report_v1`：顶层固定为 `schemaVersion/status/profile/manifest/startedAt/finishedAt/suites/error`，`manifest.version` 在解析失败时可为 `null`；入口错误使用 `{ code, message }`，suites 为空。Suite 项固定为 `id/status/caseSchemaVersion/dataPolicy/caseCount/completedCaseCount/metrics/thresholds/error`，成功时 `error=null`，失败时使用稳定错误码且不可伪造 `status`。报告原子写入目标路径；manifest JSON 损坏、contract 失败、未知 profile 和任一 suite 失败都必须落结构化失败报告并退出 1。若报告目录本身不可创建，则无法承诺报告文件，必须把原始 I/O 错误写到 stderr 并退出 1；测试覆盖成功、manifest 损坏、未知 profile、suite 失败、多 suite 继续收集和 I/O 失败边界。临时文件在 `finally` 中清理。

- [x] **Step 4: Replace the hard-coded npm chain**

```json
{
  "eval:harness:ci": "node scripts/run-harness-eval.js --profile ci --report artifacts/harness-eval/ci.json",
  "eval:harness:nightly:verify": "node scripts/run-harness-eval.js --profile nightly:verify --report artifacts/harness-eval/nightly-verify.json"
}
```

`ci` 不读取任何真实用户数据。`nightly:verify` 必须显式获得 `HARNESS_EVAL_LIVE_MODEL_RESULT_FILE` 与 `HARNESS_EVAL_REDACTED_REPLAY_RESULT_FILE`；未配置时失败，不以跳过冒充通过。该命令只验证 producer 结果、元数据、时效、覆盖量和阈值，不声称自己调用了真实模型、生成了脱敏回放或认证了 producer 身份。

- [x] **Step 5: Run the profile runner tests**

Run: `node scripts/run-tests.js tests/harnessEvalRunner.test.js tests/harnessEvalFixtures.test.js`

Expected: PASS, including failure cases for missing external inputs, incomplete producer metadata, expired results, insufficient cases, timeout and output overflow.

## Chunk 4: CI Artifact and Acceptance

### Task 4: Upload the deterministic report and close the change

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/ciWorkflow.test.js`
- Modify: `docs/development/06-testing-and-quality.md`
- Modify after implementation commit: `README.md`
- Modify after implementation commit: `docs/maintenance-log.md`
- Modify after implementation commit: `docs/memory-quality-governance.md`
- Modify after implementation commit: `docs/superpowers/plans/2026-08-02-manifest-driven-harness-eval.md`

- [x] **Step 1: Add failing workflow assertions**

要求 quality job 在 Harness step 后使用固定 SHA 的 `actions/upload-artifact`，`always()` 上传 `artifacts/harness-eval/ci.json`，不存在时视为错误，并保留 7 天；coverage gate 顺序保持不变。

- [x] **Step 2: Wire the report artifact**

只修改现有 PR/push CI，不添加无法生成真实输入的伪 nightly schedule。真实模型与脱敏回放 producer、密钥和数据来源必须由后续部署配置明确提供；当前仓库仅提供可调用、可测试、有 producer 元数据与时效校验且 fail-closed 的 `eval:harness:nightly:verify` 契约。

- [x] **Step 3: Run focused acceptance**

Run: `npm run eval:harness:ci`

Expected: PASS and create `artifacts/harness-eval/ci.json` with 3 passing suites.

Run: `node scripts/run-tests.js tests/harnessEvalFixtures.test.js tests/harnessEvalRunner.test.js tests/memoryRecallStabilityCases.test.js tests/memoryRecallAutoGoldEval.test.js tests/postReplyLearningEval.test.js tests/ciWorkflow.test.js`

Expected: PASS.

Run: `npm run eval:harness:nightly:verify`

Expected: FAIL with both missing external result environment variables named; `artifacts/harness-eval/nightly-verify.json` must still record the failed suites.

- [ ] **Step 4: Run repository acceptance**

Run: `npm run lint && npm run typecheck && npm run check:secrets:all && git diff --check`

Expected: all exit 0.

Run: `npm test && npm run coverage`

Expected: all tracked tests and coverage gates pass.

- [ ] **Step 5: Commit implementation and append timestamped evidence**

先提交代码、测试、计划和稳定开发文档，提交信息为 `feat: drive harness eval from manifest`。随后在 README、维护日志、Memory 治理文档和本计划追加简短 `2026-08-02` 时间戳、实现提交哈希与实际验收结果，再创建独立文档提交；不暂存 `AGENT.md`，不推送远端。
