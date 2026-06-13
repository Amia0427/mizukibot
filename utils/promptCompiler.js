const { splitPromptBlocksByTrust } = require('./promptSecurity');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeStage(value, fallback = 'main') {
  const text = normalizeText(value).toLowerCase();
  return text || fallback;
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

function normalizeBlock(block = {}, index = 0) {
  const content = normalizeText(block.content);
  return {
    id: normalizeText(block.id, `block_${index + 1}`),
    label: normalizeText(block.label, normalizeText(block.id, `block_${index + 1}`)),
    content,
    stage: normalizeStage(block.stage, 'main'),
    priority: Number.isFinite(Number(block.priority)) ? Number(block.priority) : 100 + index,
    authority: normalizeText(block.authority, 'runtime'),
    budgetTokens: Math.max(0, Number(block.budgetTokens || block.budget_tokens || 0) || 0),
    required: block.required !== false,
    conflictTags: normalizeArray(block.conflictTags || block.conflict_tags).map((item) => normalizeText(item)).filter(Boolean),
    appliesWhen: normalizeObject(block.appliesWhen || block.applies_when, {}),
    source: normalizeText(block.source, 'runtime'),
    kind: normalizeText(block.kind, 'runtime'),
    lane: normalizeText(block.lane || block.cacheLane, 'dynamic_context'),
    meta: normalizeObject(block.meta, {}),
    estimatedTokens: Math.max(0, Number(block.estimatedTokens || estimateTextTokens(content)) || 0)
  };
}

function shouldIncludeBlockForStage(block = {}, stage = 'main') {
  const blockStage = normalizeStage(block.stage, 'main');
  if (blockStage === 'shared') return true;
  return blockStage === normalizeStage(stage, 'main');
}

function checkAppliesWhen(block = {}, env = {}) {
  const appliesWhen = normalizeObject(block.appliesWhen, {});
  const stage = normalizeStage(env.stage, 'main');
  if (appliesWhen.stage) {
    const allowedStages = normalizeArray(appliesWhen.stage).map((item) => normalizeStage(item));
    if (allowedStages.length > 0 && !allowedStages.includes(stage)) return false;
  }
  const adminOnly = appliesWhen.adminOnly === true || appliesWhen.admin_only === true;
  if (
    adminOnly
    && env.isAdmin !== true
    && env.admin !== true
    && normalizeText(env.userRole).toLowerCase() !== 'admin'
  ) {
    return false;
  }
  if (appliesWhen.modelPattern || appliesWhen.model_pattern) {
    const pattern = normalizeText(appliesWhen.modelPattern || appliesWhen.model_pattern);
    const modelName = normalizeText(env.modelName || env.model_name || env.model || '');
    if (pattern) {
      if (!modelName) return false;
      if (!modelName.toLowerCase().includes(pattern.toLowerCase())) return false;
    }
  }
  return true;
}

function compilePromptBlocks(blocks = [], options = {}) {
  const stage = normalizeStage(options.stage, 'main');
  const baseBudget = Math.max(0, Number(options.budgetTokens || 0) || 0);
  const sorted = normalizeArray(blocks)
    .map((block, index) => normalizeBlock(block, index))
    .filter((block) => block.content)
    .filter((block) => shouldIncludeBlockForStage(block, stage))
    .filter((block) => checkAppliesWhen(block, { ...options, stage }))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const assembledBlocks = [];
  const trimDecisions = [];
  const conflictOwners = new Map();
  let usedBudget = 0;

  for (const block of sorted) {
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

    const effectiveBudget = block.budgetTokens > 0 ? block.budgetTokens : 0;
    if (effectiveBudget > 0 && block.estimatedTokens > effectiveBudget) {
      trimDecisions.push({
        type: 'block_budget_exceeded',
        blockId: block.id,
        estimatedTokens: block.estimatedTokens,
        budgetTokens: effectiveBudget
      });
    }

    if (baseBudget > 0 && (usedBudget + block.estimatedTokens) > baseBudget) {
      trimDecisions.push({
        type: 'stage_budget_skip',
        blockId: block.id,
        estimatedTokens: block.estimatedTokens,
        usedTokens: usedBudget,
        budgetTokens: baseBudget
      });
      continue;
    }

    assembledBlocks.push(block);
    usedBudget += block.estimatedTokens;
    for (const tag of block.conflictTags) {
      conflictOwners.set(tag, block.id);
    }
  }

  const renderedSystemMessages = assembledBlocks.map((block) => ({
    role: 'system',
    content: block.content
  }));
  const trustSplit = splitPromptBlocksByTrust(assembledBlocks);

  return {
    stage,
    policyKey: normalizeText(options.policyKey),
    assembledBlocks,
    renderedSystemMessages,
    trustedBlocks: trustSplit.trustedBlocks,
    untrustedBlocks: trustSplit.untrustedBlocks,
    tokenUsageByBlock: assembledBlocks.map((block) => ({
      id: block.id,
      label: block.label,
      tokens: block.estimatedTokens
    })),
    trimDecisions
  };
}

function buildPromptSnapshot(blocks = [], options = {}) {
  return compilePromptBlocks(blocks, options);
}

module.exports = {
  buildPromptSnapshot,
  compilePromptBlocks,
  normalizeBlock,
  shouldIncludeBlockForStage
};
