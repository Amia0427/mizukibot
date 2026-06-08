# 主回复输入Token占用分析报告

## 概况

**分析时间**: 2026-06-08  
**修复更新时间**: 2026-06-08 21:05 +08:00  
**样本**: 最近的主回复请求  
**平均输入tokens**: 10,000-12,000  
**最高可达**: 34,000+ (包含图像时)

## 已落地修复（2026-06-08 21:05 +08:00）

1. `memoryForPrompt` 加总预算：新增 `MAIN_PROMPT_MEMORY_CONTEXT_MAX_TOKENS=2500`，legacy 和 Memory V3 两条 `memoryContext` 输出都会在最终注入前裁剪。
2. Memory V3 拼装改用已分段预算后的 packet 文本，避免未裁剪的 `sessionContinuityText` / evidence 原文重新撑大 `retrieved_memory_lite`。
3. 普通聊天 short-term continuity 收敛到 64 条 raw 上限、至少保留最新 8 条、token multiplier 0.65，并新增 normal cap 覆盖旧 `.env` 高值：`MAIN_REPLY_CONTEXT_NORMAL_*_CAP` 和 `MAIN_REPLY_CONTEXT_NORMAL_SHORT_TERM_MAX_TOKENS=3000`。
4. 新增可复跑诊断入口：`npm run diag:main-reply-token-budget -- --limit 20 --json`。

## Token占用分布（典型11,192 tokens案例）

### Top 5 Token消耗来源

| 排名 | 消息索引 | 角色 | Token占用 | 占比 | 内容推测 |
|------|---------|------|-----------|------|----------|
| 1 | 索引3 | system | **5,044** | **45.1%** | **Retrieved Memory + Daily Journal** |
| 2 | 索引0 | system | **2,907** | **26.0%** | **System Prompt（角色设定）** |
| 3 | 索引8 | system | **1,368** | **12.2%** | **Short Term Continuity（短期对话上下文）** |
| 4 | 索引6 | system | 413 | 3.7% | Persona Module / Style Signals |
| 5 | 索引5 | system | 379 | 3.4% | Tool Guidance / Runtime Block |

**前3项合计**: 9,319 tokens (83.3%)

## 问题分析

### 🔴 【严重】问题1: Memory Context过大 (5,044 tokens, 45%)

**位置**: 消息索引3  
**内容**:
- Retrieved Memory（召回记忆）
- Daily Journal（每日日志）

**影响**: 单个消息占用接近一半的输入token

**原因**:
1. 召回的记忆条目可能过多或过长
2. Daily Journal包含大量历史对话摘要
3. Memory V3的projections可能返回过多数据

---

### 🔴 【严重】问题2: System Prompt过大 (2,907 tokens, 26%)

**位置**: 消息索引0  
**内容**:
- prompts/SYSTEM.txt
- prompts/persona/*.txt（角色设定文件）
- 核心persona描述

**影响**: 每次请求都必须发送，无法跳过

**原因**:
1. 角色设定文件可能包含过多描述
2. 重复的指令和例子
3. 冗余的行为规范

---

### 🟡 【中等】问题3: Short Term Continuity过大 (1,368 tokens, 12%)

**位置**: 消息索引8  
**内容**:
- 最近的对话上下文
- 短期记忆摘要

**影响**: 随着对话进行会持续增长

**原因**:
1. `SHORT_TERM_MEMORY_RECENT_MESSAGES` 可能设置过大（默认128条）
2. `MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES` 可能设置过大（默认128条）
3. 没有有效的摘要压缩

---

### 🟢 【低优先级】其他system消息 (792 tokens, 7%)

包括：
- Persona Modules（当前已限制为最多2个）
- Tool Guidance
- Style Signals
- Runtime Blocks

这部分已经通过 `MAIN_REPLY_PROMPT_MODE=balanced` 优化过了。

---

## 优化建议

### 方案1: 快速优化（已落地为默认/cap）

当前代码默认/上限：

```bash
MAIN_PROMPT_MEMORY_CONTEXT_MAX_TOKENS=2500
MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS=3000
MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES=64
MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES=8
MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER=0.65
MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES_CAP=64
MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES_CAP=8
MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER_CAP=0.65
MAIN_REPLY_CONTEXT_NORMAL_SHORT_TERM_MAX_TOKENS=3000
```

**预期效果**: 11,192 tokens → **~7,500-8,500 tokens** (减少25-35%)

---

### 方案2: 深度优化（需要代码修改）

#### 2.1 优化Memory Context召回（问题1，已完成最小修复）

**目标**: 将5,044 tokens降到2,000-2,500 tokens

**修改位置**: `utils/memoryContext/index.js`、`utils/memoryContext/v3Payload.js`、`utils/memoryContext/budget.js`

**结果**: 最终 `memoryForPrompt` 被 `MAIN_PROMPT_MEMORY_CONTEXT_MAX_TOKENS` 限制；V3 不再把未裁剪 packet 原文拼回 prompt。

#### 2.2 精简System Prompt（问题2）

**目标**: 将2,907 tokens降到1,500-2,000 tokens

**修改位置**: 
- `prompts/SYSTEM.txt`
- `prompts/persona/*.txt`

**方法**:
1. 删除冗余的角色描述
2. 合并重复的指令
3. 移除不必要的例子
4. 精简行为规范（保留核心即可）

**示例**:
```txt
❌ 删除前:
你是晓山瑞希，一个25岁的日本女孩...（长达300字的详细描述）

✓ 删除后:
你是晓山瑞希，25岁，日本人。性格特点：...（精简到100字）
```

#### 2.3 启用摘要压缩（问题3）

**修改位置**: `api/runtimeV2/context/base-dynamic-prompt.chunk.js`

在构建 Short Term Continuity 时使用更激进的压缩策略。

---

### 方案3: 激进优化（会影响角色表现）

```bash
# 使用minimal模式
MAIN_REPLY_PROMPT_MODE=minimal

# 禁用可选的memory注入
# （不推荐，会严重影响记忆能力）
```

**预期效果**: 11,192 tokens → **~5,000-6,000 tokens** (减少50%)  
**副作用**: 角色表现会明显变差，记忆能力下降

---

## 实施路线图

### 第一阶段（立即执行）
1. ✅ 添加默认/cap 配置（方案1）
2. ✅ 修改 Memory Context 最终预算（方案2.1）
3. ✅ 添加可复跑诊断入口
4. ⏳ 等下一批主回复样本验证均值趋势

### 第二阶段（1周内）
1. 🔧 如均值仍高，再精简 System Prompt（方案2.2）
2. 🔧 按真实样本微调 `MAIN_PROMPT_MEMORY_CONTEXT_MAX_TOKENS` / normal cap

### 第三阶段（持续优化）
1. 📊 监控token占用趋势
2. 📊 收集用户反馈（是否影响体验）
3. 📊 调整参数达到最佳平衡

---

## 监控指标

执行优化后，使用以下命令监控效果：

```bash
# 查看最近的token占用
npm run diag:main-reply-prompt -- --limit 10

# 聚合输入 token 趋势
npm run diag:main-reply-token-budget -- --limit 20 --json
```

**目标值**:
- 平均输入tokens: < 8,000
- 峰值输入tokens: < 12,000
- Memory Context占比: < 30%
- System Prompt占比: < 25%

---

## 附录：配置文件对照

### 修复前配置（典型/推测）

```bash
SHORT_TERM_MEMORY_RECENT_MESSAGES=128
MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES=128
MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES=16
MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS=5200
MAIN_REPLY_PROMPT_MODE=balanced
```

### 优化后配置（推荐）

```bash
MAIN_PROMPT_MEMORY_CONTEXT_MAX_TOKENS=2500
MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS=3000
MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES=64
MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES=8
MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER=0.65
MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES_CAP=64
MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES_CAP=8
MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER_CAP=0.65
MAIN_REPLY_CONTEXT_NORMAL_SHORT_TERM_MAX_TOKENS=3000
MAIN_REPLY_PROMPT_MODE=balanced
```

---

生成时间: 2026-06-08 18:37
更新时间: 2026-06-08 21:05 +08:00
分析工具: scripts/analyze-token-usage.js / scripts/diagnose-main-reply-token-budget.js
