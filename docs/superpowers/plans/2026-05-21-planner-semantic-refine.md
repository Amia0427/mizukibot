# Planner Semantic Refine Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强 direct chat planner 的语义理解能力，并允许 planner 模型在低置信/无效/请求 refinement 时进行多次调用。

**Architecture:** 保持 planner v2 单一决策协议不变，在模型调用层加入受限的 semantic refinement loop。第一轮输出仍走现有 normalizer；仅当输出无效、语义置信度低、或 planner 显式要求 refinement 时，追加一轮带上一轮摘要和改进指令的 planner 调用。

**Tech Stack:** Node.js CommonJS, existing planner v2 modules, `node:assert` tests.

**Update 2026-05-21 22:00 +08:00:** 默认禁止 planner endpoint/key 兜底到主回复模型配置；只有显式 `PLANNER_ALLOW_MAIN_MODEL_FALLBACK=true` 才允许共用主 `API_BASE_URL/API_KEY`。

---

## Chunk 1: Planner Multi-Call

### Task 1: 配置与调用循环

**Files:**
- Modify: `config.js`
- Modify: `src/runtime-v2/planning/caller.chunk.js`
- Modify: `src/runtime-v2/planning/tool-gating.chunk.js`

- [x] **Step 1: 增加保守配置**

更新 2026-05-23 22:10 +08:00：当前运行策略已关闭多轮 planner；`PLANNER_MAX_MODEL_CALLS` 固定为 1，`PLANNER_SEMANTIC_REFINE_ENABLED` 默认 false。语义 refine 字段仅用于诊断，不再触发第二轮 planner 请求。

原计划新增 `PLANNER_MAX_MODEL_CALLS`、`PLANNER_SEMANTIC_REFINE_ENABLED`、`PLANNER_SEMANTIC_CONFIDENCE_THRESHOLD`，当时默认最多 2 次调用、硬上限 3 次；该策略已被上面的单轮约束替代。

- [x] **Step 2: 模型请求支持 refinement 上下文**

第二轮 payload 带 `semanticRefinement`，包含上一轮结果摘要、问题点、调用序号和要求。

- [x] **Step 3: 调用层根据语义自评决定是否继续**

接受 planner 输出中的 `plannerMeta.semanticConfidence`、`plannerMeta.semanticAssessment`、`plannerMeta.needsSemanticRefinement`。无效 JSON 或空对象可触发第二轮；单次失败仍不做 HTTP retry。

### Task 2: Prompt 协议增强

**Files:**
- Modify: `src/runtime-v2/planning/prompt-normalizer.chunk.js`

- [x] **Step 1: 让 planner 输出语义理解自评**

在系统 prompt 中要求提取意图、约束、上下文依赖、歧义和置信度。

- [x] **Step 2: 用户 payload 暴露语义上下文**

把近期 summary、directed context、continuity、memory availability、动态 prompt catalog 作为明确的 semantic context 输入。

### Task 3: 测试与文档

**Files:**
- Modify: `tests/plannerV2Protocol.test.js`
- Modify: `tests/plannerNoRetry.test.js`
- Modify: `README.md`

- [x] **Step 1: 覆盖多轮 refinement**

模拟第一轮低置信输出，第二轮产出正确工具计划，断言 HTTP 调用次数、payload refinement 字段和 planner meta。

- [x] **Step 2: 保留失败降级语义**

上游错误时仍为每轮单次 `postWithRetry(..., 0, ...)`，最终 fallback。

- [x] **Step 3: 更新 README**

写入带简短时间戳的 planner semantic refinement 配置说明。

### Task 4: 主回复模型兜底隔离

**Files:**
- Modify: `config.js`
- Modify: `src/runtime-v2/planning/tool-gating.chunk.js`
- Modify: `src/runtime-v2/planning/legacy.chunk.js`
- Modify: `tests/plannerV2Protocol.test.js`
- Modify: `tests/plannerNoRetry.test.js`
- Modify: `README.md`

- [x] **Step 1: 增加显式开关**

新增 `PLANNER_ALLOW_MAIN_MODEL_FALLBACK=false`，默认禁止 planner 使用主回复 `API_BASE_URL/API_KEY`。

- [x] **Step 2: 隔离 planner endpoint/key 解析**

v2 和 legacy planner 解析只在显式开启时才落到主回复配置；`PLAN_*`、router、passive 配置继续可用。

- [x] **Step 3: 补回归测试和文档**

覆盖无独立 planner 配置时不会调用主 API，并更新 README 时间戳说明。
