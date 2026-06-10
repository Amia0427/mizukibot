# 主回复输入Token优化实施总结

**执行时间**: 2026-06-08 18:42  
**执行人**: Claude Code  
**分支**: next-

## ✅ 已完成的优化

### 1. 配置优化（.env文件）

| 配置项 | 原值 | 新值 | 减少幅度 |
|--------|------|------|----------|
| SHORT_TERM_MEMORY_RECENT_MESSAGES | 240 | 64 | -73% |
| MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS | 3500 | 2500 | -29% |
| MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES | 16 | 8 | -50% |
| MAIN_PROMPT_MEMORY_CONTEXT_MAX_TOKENS | (无限制) | 2000 | 新增限制 |

**修改位置**: `D:\waifu\.env` (文件被.gitignore，不会提交到git)

### 2. 文档更新

- ✅ 创建详细分析报告: `docs/token-usage-analysis-2026-06-08.md`
- ✅ 更新 README.md 添加更新记录
- ✅ 提交到 git (commit: f63103d, 9f11ac5)

### 3. 诊断工具

- ✅ 创建 `scripts/analyze-token-usage.js` - 主回复token占用分析脚本
- ✅ 创建 `scripts/analyze-token-detailed.js` - 详细token分析脚本

## 📊 优化效果预期

### 优化前（实测数据）
- 平均输入tokens: **11,192**
- 最高可达: **34,681** (包含图像)
- Token分布:
  - Memory Context (索引3): 5,044 tokens (45%)
  - System Prompt (索引0): 2,907 tokens (26%)
  - Short Term Continuity (索引8): 1,368 tokens (12%)

### 优化后（预期）
- 平均输入tokens: **7,500 - 8,500** (减少25-35%)
- Token分布预期:
  - Memory Context: ~2,000 tokens (限制生效)
  - System Prompt: ~2,900 tokens (保持不变)
  - Short Term Continuity: ~800-1,000 tokens (减少约40%)

### 关键改进
1. **Memory Context**: 5,044 → ~2,000 tokens (减少60%)
2. **Short Term Continuity**: 1,368 → ~900 tokens (减少34%)
3. **整体输入**: 11,192 → ~7,500 tokens (减少33%)

## 🔧 技术细节

### Memory Context限制机制

**代码位置**: `utils/memoryContext/budget.js`

```javascript
function limitMemoryForPrompt(text = '', options = {}) {
  const tokenBudget = getPromptTokenLimit(
    'MAIN_PROMPT_MEMORY_CONTEXT_MAX_TOKENS',
    2500,  // 默认值
    options.config
  );
  return limitPromptText(text, tokenBudget, options.strategy || 'head');
}
```

**工作原理**:
1. 读取 `MAIN_PROMPT_MEMORY_CONTEXT_MAX_TOKENS` 配置（现在是2000）
2. 使用 `trimTextByTokenBudget` 按token预算裁剪
3. 策略为 `head`（保留开头，这样最相关的记忆会被保留）

### Short Term Continuity优化

**影响的代码区域**:
- `utils/shortTermMemory/contextProfile.js`
- `api/runtimeV2/context/base-dynamic-prompt.chunk.js`

**工作原理**:
1. `SHORT_TERM_MEMORY_RECENT_MESSAGES=64` 限制加载的最近消息数
2. `MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES=8` 限制必须保留的最新消息
3. `MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS=2500` 限制总token预算

## ⚠️ 潜在影响评估

### 可能的负面影响

1. **记忆召回减少**
   - Memory Context从5k降到2k，可能丢失部分历史记忆
   - 缓解措施: 使用`head`策略保留最相关的记忆

2. **短期上下文窗口缩短**
   - 从240条消息降到64条，可能丢失较远的对话上下文
   - 缓解措施: 保留最新8条完整消息

3. **角色表现可能变化**
   - 记忆注入减少可能影响角色连贯性
   - 需要观察实际使用效果

### 建议的监控方案

1. **定期检查token占用**
   ```bash
   npm run diag:main-reply-prompt -- --limit 10
   node scripts/analyze-token-usage.js
   ```

2. **观察用户反馈**
   - 角色表现是否退化
   - 记忆能力是否受损
   - 对话连贯性是否下降

3. **根据实际效果调整**
   - 如果效果不佳，可以适当提高限制
   - 如果效果良好，可以进一步优化

## 🎯 下一步优化方向

### 中期优化（1-2周内）

1. **精简System Prompt** (目标: 2,907 → 1,500-2,000 tokens)
   - 清理 `prompts/SYSTEM.txt`
   - 精简 `prompts/persona/*.txt` 文件
   - 删除冗余描述和重复指令

2. **优化Memory召回策略**
   - 改进relevance排序算法
   - 实施更智能的记忆选择

3. **Dynamic Prompt Budget**
   - 根据查询复杂度动态调整token预算
   - 简单查询用更少token，复杂查询用更多token

### 长期优化（1个月+）

1. **Memory压缩技术**
   - 实现记忆摘要和压缩
   - 使用更高效的记忆表示

2. **Prompt Caching**
   - 利用API的prompt caching功能
   - 缓存固定的System Prompt部分

3. **模型升级**
   - 考虑使用更大context window的模型
   - 或使用更高效的token处理模型

## 📝 变更记录

- `2026-06-08 18:42`: 完成配置优化
- `2026-06-08 18:45`: 提交文档和脚本到git
- `.env` 文件已手动修改（不在git追踪中）

## 🔗 相关文档

- [详细分析报告](./token-usage-analysis-2026-06-08.md)
- [Memory Context架构](./main-reply-context.md)
- [Memory质量治理](./memory-quality-governance.md)

---

**注意**: 本次优化不需要重启bot，配置会在下次bot重启时自动生效。建议在用户活跃度较低的时段重启并观察效果。
