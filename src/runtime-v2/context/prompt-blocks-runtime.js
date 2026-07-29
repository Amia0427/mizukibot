'use strict';

const { getConfig } = require('./config');
const { normalizeArray, normalizeObject, normalizeText } = require('./normalization');
const { estimateTokens, trimTextByTokenBudget } = require('../../../utils/contextBudget');

function createPromptBlock(id, label, content, options = {}) {
  const text = String(content || '').trim();
  if (!text) return null;
  return {
    id: String(id || label || 'block').trim() || 'block',
    label: String(label || id || 'block').trim() || 'block',
    content: text,
    stage: String(options.stage || 'main').trim() || 'main',
    priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : 100,
    authority: String(options.authority || 'runtime').trim() || 'runtime',
    budgetTokens: Math.max(0, Number(options.budgetTokens || 0) || 0),
    conflictTags: Array.isArray(options.conflictTags) ? options.conflictTags.map((item) => String(item || '').trim()).filter(Boolean) : [],
    kind: String(options.kind || 'runtime').trim() || 'runtime',
    source: String(options.source || 'runtime').trim() || 'runtime',
    lane: String(options.lane || options.cacheLane || 'dynamic_context').trim() || 'dynamic_context',
    meta: options.meta && typeof options.meta === 'object' ? { ...options.meta } : {}
  };
}

function createLiveStatePromptBlock(liveStateContext = '', liveStateMeta = {}) {
  const text = normalizeText(liveStateContext);
  if (!text) return null;
  return createPromptBlock('live_state_dynamic', 'Live State Dynamic', text, {
    stage: 'main',
    priority: 500,
    authority: 'runtime_dynamic',
    kind: 'runtime_context',
    source: 'live_state',
    lane: 'dynamic_context',
    budgetTokens: 800,
    meta: {
      optional: true,
      blockId: 'live_state_dynamic',
      liveState: normalizeObject(liveStateMeta, {})
    }
  });
}

function estimateLineBlockTokens(lines = []) {
  return estimateTokens(normalizeArray(lines).join('\n'));
}

function trimLineSectionFromTail(label = '', lines = [], tokenBudget = 0) {
  const sectionLabel = normalizeText(label);
  const candidates = normalizeArray(lines).map((line) => normalizeText(line)).filter(Boolean);
  const budget = Math.max(0, Math.floor(Number(tokenBudget || 0) || 0));
  if (!sectionLabel || candidates.length === 0 || budget <= estimateTokens(sectionLabel)) return [];

  const kept = [];
  let used = estimateTokens(sectionLabel);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const line = candidates[index];
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) {
      if (kept.length === 0) {
        const trimmed = trimTextByTokenBudget(line, Math.max(24, budget - used - 1), 'tail');
        if (trimmed) kept.unshift(trimmed);
      }
      break;
    }
    kept.unshift(line);
    used += cost;
  }

  return kept.length > 0 ? [sectionLabel, ...kept] : [];
}

function trimLineBlock(lines = [], tokenBudget = 0, strategy = 'head') {
  const text = normalizeArray(lines).map((line) => normalizeText(line)).filter(Boolean).join('\n');
  if (!text) return [];
  return trimTextByTokenBudget(text, tokenBudget, strategy)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function blocksToMessages(blocks = [], role = 'system') {
  return normalizeArray(blocks)
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ role, content: String(item.content || '').trim() }))
    .filter((item) => item.content);
}

function serializePromptBlocks(blocks = []) {
  return normalizeArray(blocks)
    .map((item) => String(item?.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

module.exports = {
  blocksToMessages,
  createLiveStatePromptBlock,
  createPromptBlock,
  estimateLineBlockTokens,
  serializePromptBlocks,
  trimLineBlock,
  trimLineSectionFromTail
};
