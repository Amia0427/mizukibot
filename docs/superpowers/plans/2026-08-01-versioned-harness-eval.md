# Versioned Harness Eval Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让核心 Harness 评估样本在干净检出和 CI 中可复现，并阻止空样本或真实用户数据被误当成通过。

**Architecture:** 使用 tracked manifest 固定 synthetic fixture 的 schema、数量和规范化 SHA-256；独立校验脚本只负责 manifest、JSONL 完整性和隐私边界。现有评估器保留业务断言，CLI 通过 `--cases` 显式选择输入，CI 用一个 npm 入口串联校验与两个稳定评估集。

**Tech Stack:** Node.js CommonJS、JSON/JSONL、GitHub Actions、现有 `scripts/run-tests.js`

---

## Chunk 1: Fixture Contract

### Task 1: Versioned manifest and privacy validator

**Files:**
- Create: `tests/fixtures/harness-eval-manifest.json`
- Create: `scripts/check-harness-eval-fixtures.js`
- Create: `tests/harnessEvalFixtures.test.js`

- [x] **Step 1: Write failing validator tests**

覆盖有效 manifest、SHA/数量不一致、空 JSONL、重复 case ID、数字账号、邮箱、URL 和非占位密钥；断言错误包含 suite ID 和原因。

- [x] **Step 2: Run the test and verify it fails**

Run: `node scripts/run-tests.js tests/harnessEvalFixtures.test.js`
Expected: FAIL because the validator module and manifest do not exist.

- [x] **Step 3: Add the manifest and minimal validator**

manifest 使用 `harness_eval_manifest_v1`、版本 `1.0.0`、`synthetic_only`，登记 `memory-recall-routing-stability` 30 条与 `post-reply-learning` 22 条；前者明确是路由分类集，不冒充 Recall/MRR 召回集。摘要对去空行后的 JSONL 使用 LF 拼接后计算，避免 Windows/Linux 行尾差异。

- [x] **Step 4: Run the validator tests**

Run: `node scripts/run-tests.js tests/harnessEvalFixtures.test.js`
Expected: PASS, and invalid fixtures fail closed.

## Chunk 2: Explicit Eval Inputs

### Task 2: Add `--cases` and empty-set failure

**Files:**
- Modify: `scripts/eval-memory-recall.js`
- Modify: `scripts/eval-post-reply-learning.js`
- Modify: `tests/memoryRecallAutoGoldEval.test.js`
- Modify: `tests/postReplyLearningEval.test.js`

- [x] **Step 1: Add failing contract tests**

断言两个参数解析器保留显式路径；Memory 显式 cases 不自动混入本地 auto-gold，CLI 无 `--cases`、`--auto-gold` 或 `--build-cases` 时失败；Post-reply 默认使用 tracked fixture；空文件和不存在的 case ID 必须抛错。

- [x] **Step 2: Run focused tests and verify failure**

Run: `node scripts/run-tests.js tests/memoryRecallAutoGoldEval.test.js tests/postReplyLearningEval.test.js`
Expected: FAIL on missing explicit-input contracts.

- [x] **Step 3: Implement minimal input selection**

Memory `loadCases()` 在 `casesFile` 存在时只读取该文件并拒绝空集，CLI 入口取消隐式 `artifacts` 回落；Post-reply 增加 tracked 默认路径、`--cases` 和统一 selection helper，拒绝空集与未知 `--case`。诊断 API 的兼容读取行为保持不变。

- [x] **Step 4: Run focused tests**

Run: `node scripts/run-tests.js tests/memoryRecallAutoGoldEval.test.js tests/postReplyLearningEval.test.js`
Expected: PASS.

## Chunk 3: CI Gate and Documentation

### Task 3: Wire an explicit harness gate

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/ciWorkflow.test.js`
- Modify: `docs/development/06-testing-and-quality.md`
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`

- [x] **Step 1: Add a failing CI workflow assertion**

要求 quality job 在 coverage 前执行 `npm run eval:harness:ci`。

- [x] **Step 2: Add the npm command and workflow step**

`eval:harness:ci` 先运行 fixture validator，再运行 memory routing stability、Memory synthetic auto-gold 召回与 post-reply learning 三个评估测试；auto-gold 测试提供 Recall/MRR、scope/lifecycle 和错误命中证据，CI 使用完全相同入口。

- [x] **Step 3: Run acceptance**

Run: `npm run eval:harness:ci`
Expected: manifest 2 suites / 52 cases passed; three eval suites passed.

Run: `node scripts/run-tests.js tests/harnessEvalFixtures.test.js tests/memoryRecallAutoGoldEval.test.js tests/postReplyLearningEval.test.js tests/ciWorkflow.test.js`
Expected: PASS.

Run: `npm test`
Expected: all tracked tests pass.

Run: `npm run lint && npm run typecheck && npm run check:secrets:all && git diff --check`
Expected: all exit 0.

- [x] **Step 4: Commit implementation, then append its hash and completion record**

Commit implementation and this plan with `feat: version harness eval fixtures`; after that, update README and maintenance log with the implementation hash and create a separate documentation commit. Do not push.

完成记录（2026-08-01 00:51 +08:00）：实现提交 `85f421b`，版本化 Harness eval、CI 门禁、文档与验收证据均已落地；未推送远端。
