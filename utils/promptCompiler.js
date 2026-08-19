const {
  mapPromptBlockToMessage,
  splitPromptBlocksByTrust
} = require('./promptSecurity');
const { resolvePromptPlan } = require('./promptPlan');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function estimateTextTokens(value) {
  const text = normalizeText(value);
  if (!text) return 0;
  let cjkChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3400 && code <= 0x9fff) cjkChars += 1;
  }
  const latinChars = text.length - cjkChars;
  return cjkChars + Math.ceil(Math.max(0, latinChars) / 4);
}

function normalizeRenderedModule(module = {}, rendered = {}, index = 0) {
  const value = typeof rendered === 'string' ? { content: rendered } : rendered;
  const content = normalizeText(value?.content);
  return {
    ...module,
    ...(value && typeof value === 'object' ? value : {}),
    id: normalizeText(module.id, `block_${index + 1}`),
    label: normalizeText(value?.label || module.label, normalizeText(module.id, `block_${index + 1}`)),
    content,
    stage: module.stage,
    tier: module.tier,
    priority: module.priority,
    registrationOrder: module.registrationOrder,
    authority: normalizeText(value?.authority || module.authority, 'runtime'),
    budgetTokens: module.maxTokens,
    maxTokens: module.maxTokens,
    conflictTags: normalizeArray(value?.conflictTags || value?.conflict_tags || module.conflictTags || module.conflict_tags)
      .map((item) => normalizeText(item)).filter(Boolean),
    source: normalizeText(value?.source || module.source, 'runtime'),
    kind: normalizeText(value?.kind || module.kind, 'runtime'),
    lane: module.cacheScope,
    cacheScope: module.cacheScope,
    meta: value?.meta && typeof value.meta === 'object'
      ? { ...value.meta }
      : (module.meta && typeof module.meta === 'object' ? { ...module.meta } : {}),
    estimatedTokens: Math.max(0, Number(value?.estimatedTokens || estimateTextTokens(content)) || 0)
  };
}

function compareByPriorityAndRegistration(a, b) {
  return a.priority - b.priority || a.registrationOrder - b.registrationOrder;
}

function isProtectedModule(block = {}) {
  if (block.tier === 'core' || block.tier === 'contract' || block.tier === 'capability') return true;
  return block.required === true || block.meta?.required === true || block.meta?.criticality === 'critical';
}

function trimRank(block = {}) {
  if (block.tier === 'example') return 0;
  if (block.tier === 'context') return 1;
  if (block.tier === 'persona') return 2;
  return 3;
}

function trimToBudget(blocks = [], budgetTokens = 0) {
  const budget = Math.max(0, Number(budgetTokens || 0) || 0);
  const total = blocks.reduce((sum, block) => sum + block.estimatedTokens, 0);
  if (!budget || total <= budget) {
    return { blocks, trimmedModules: [], estimatedTokens: total, exceededByProtectedModules: false };
  }

  const candidates = blocks
    .filter((block) => !isProtectedModule(block))
    .sort((a, b) => trimRank(a) - trimRank(b) || b.priority - a.priority || b.registrationOrder - a.registrationOrder);
  const removed = new Set();
  const trimmedModules = [];
  let used = total;
  for (const block of candidates) {
    if (used <= budget) break;
    removed.add(block.id);
    used -= block.estimatedTokens;
    trimmedModules.push({
      id: block.id,
      tier: block.tier,
      estimatedTokens: block.estimatedTokens,
      reason: `budget_trim_${block.tier}`
    });
  }
  return {
    blocks: blocks.filter((block) => !removed.has(block.id)),
    trimmedModules,
    estimatedTokens: used,
    exceededByProtectedModules: used > budget
  };
}

function compilePromptPlan(plan = {}, context = {}) {
  if (!plan || plan.schemaVersion !== 'prompt_plan_v1' || !Array.isArray(plan.modules)) {
    throw new Error('compilePromptPlan requires a resolved PromptPlan');
  }
  const rendered = plan.modules
    .map((module, index) => normalizeRenderedModule(module, module.render(context), index))
    .filter((block) => block.content)
    .sort(compareByPriorityAndRegistration);
  const conflictFreeBlocks = [];
  const trimDecisions = [];
  const conflictOwners = new Map();

  for (const block of rendered) {
    const conflictingTag = block.conflictTags.find((tag) => conflictOwners.has(tag));
    if (conflictingTag) {
      trimDecisions.push({
        type: 'conflict_skip',
        blockId: block.id,
        conflictTag: conflictingTag,
        keptBy: conflictOwners.get(conflictingTag)
      });
      continue;
    }
    if (block.maxTokens > 0 && block.estimatedTokens > block.maxTokens) {
      trimDecisions.push({
        type: 'block_budget_exceeded',
        blockId: block.id,
        estimatedTokens: block.estimatedTokens,
        budgetTokens: block.maxTokens
      });
    }
    conflictFreeBlocks.push(block);
    for (const tag of block.conflictTags) {
      conflictOwners.set(tag, block.id);
    }
  }

  const budgetResult = trimToBudget(conflictFreeBlocks, plan.budgetTokens);
  const assembledBlocks = budgetResult.blocks;
  for (const item of budgetResult.trimmedModules) {
    trimDecisions.push({
      type: 'stage_budget_skip',
      blockId: item.id,
      estimatedTokens: item.estimatedTokens,
      budgetTokens: plan.budgetTokens,
      tier: item.tier,
      reason: item.reason
    });
  }
  const renderedSystemMessages = assembledBlocks.map(mapPromptBlockToMessage);
  const trustSplit = splitPromptBlocksByTrust(assembledBlocks);
  const tokenUsageByBlock = assembledBlocks.map((block) => ({
    id: block.id,
    label: block.label,
    tier: block.tier,
    tokens: block.estimatedTokens
  }));
  const decisionById = new Map(normalizeArray(plan.decisions).map((item) => [item.id, item]));
  const diagnostics = {
    schemaVersion: 'prompt_compilation_diagnostics_v1',
    version: plan.version,
    stage: plan.stage,
    policyKey: plan.policyKey,
    enabledModules: assembledBlocks.map((block) => ({
      id: block.id,
      version: block.version,
      tier: block.tier,
      reason: decisionById.get(block.id)?.reason || 'enabled'
    })),
    selectionDecisions: normalizeArray(plan.decisions).map((item) => ({ ...item })),
    estimatedTokens: budgetResult.estimatedTokens,
    trimmedModules: budgetResult.trimmedModules,
    finalOrder: assembledBlocks.map((block) => block.id),
    budget: {
      limitTokens: plan.budgetTokens,
      usedTokens: budgetResult.estimatedTokens,
      exceededByProtectedModules: budgetResult.exceededByProtectedModules
    },
    renderedSystemMessages,
    trustedBlocks: trustSplit.trustedBlocks,
    untrustedBlocks: trustSplit.untrustedBlocks,
    tokenUsageByBlock,
    trimDecisions
  };
  return {
    systemPrompt: renderedSystemMessages.map((message) => normalizeText(message.content)).filter(Boolean).join('\n'),
    sections: assembledBlocks,
    diagnostics,
    stage: plan.stage,
    policyKey: plan.policyKey,
    assembledBlocks,
    renderedSystemMessages,
    trustedBlocks: trustSplit.trustedBlocks,
    untrustedBlocks: trustSplit.untrustedBlocks,
    tokenUsageByBlock,
    trimDecisions,
    promptRuntimeDiagnostics: diagnostics
  };
}

function buildPromptSnapshot(blocks = [], options = {}) {
  const context = { ...options, blocks };
  return compilePromptPlan(resolvePromptPlan(context), context);
}

module.exports = {
  buildPromptSnapshot,
  compilePromptPlan,
  estimateTextTokens,
  normalizeRenderedModule
};
