'use strict';

const config = require('../../config');
const { isMemoryNotRecallable } = require('./recallFilter');
const {
  canonicalizeText,
  cosineFromTokenSets,
  normalizeText,
  tokenize
} = require('./helpers');
const { loadMemoryNodes } = require('./storage');

function isLegacyPrimary() {
  return config.MEMORY_V3_ENABLED === false || config.MEMORY_STORAGE_MODE === 'legacy_compat';
}

function nodeId(node = {}) {
  return normalizeText(node.id || node.nodeId);
}

function nodeMemoryKind(node = {}) {
  return normalizeText(node.memoryKind || node.type).toLowerCase();
}

function sourceForNode(node = {}) {
  const scopeType = normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal';
  const memoryKind = nodeMemoryKind(node);
  if (memoryKind === 'style') return 'style';
  if (memoryKind === 'jargon') return 'jargon';
  if (memoryKind === 'episode' || normalizeText(node.type).toLowerCase() === 'episode') return 'journal';
  if (scopeType === 'group') return 'group';
  if (scopeType === 'task' || scopeType === 'working') return 'task';
  return 'personal';
}

function visibleNodes() {
  return loadMemoryNodes().filter((node) => {
    if (!node) return false;
    if (normalizeText(node.status || 'active').toLowerCase() === 'archived') return false;
    return !isMemoryNotRecallable(node);
  });
}

function normalizeGroupIds(options = {}) {
  const values = [
    ...(Array.isArray(options.groupIds) ? options.groupIds : []),
    options.groupId
  ];
  return new Set(values.map(normalizeText).filter(Boolean));
}

function matchesUserScope(node = {}, userId = '', options = {}) {
  const uid = normalizeText(userId);
  const scopeType = normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal';
  const requestedScope = normalizeText(options.scopeType).toLowerCase();
  if (requestedScope && scopeType !== requestedScope) return false;
  if (scopeType === 'group') {
    const groupIds = normalizeGroupIds(options);
    if (groupIds.size === 0 && uid.startsWith('group:')) groupIds.add(uid.slice('group:'.length));
    return groupIds.has(normalizeText(node.groupId));
  }
  return Boolean(uid && normalizeText(node.userId) === uid);
}

function matchesOptions(node = {}, options = {}) {
  if (options.status && normalizeText(node.status).toLowerCase() !== normalizeText(options.status).toLowerCase()) return false;
  if (options.type && normalizeText(node.type).toLowerCase() !== normalizeText(options.type).toLowerCase()) return false;
  if (options.memoryKind && nodeMemoryKind(node) !== normalizeText(options.memoryKind).toLowerCase()) return false;
  if (options.taskType && normalizeText(node.taskType) !== normalizeText(options.taskType)) return false;
  if (options.routePolicyKey && normalizeText(node.routePolicyKey) !== normalizeText(options.routePolicyKey)) return false;
  if (options.topRouteType && normalizeText(node.topRouteType) !== normalizeText(options.topRouteType)) return false;
  const sourceFilter = normalizeText(options.sourceFilter || options.source).toLowerCase();
  return !sourceFilter || sourceFilter === 'all' || sourceForNode(node) === sourceFilter;
}

function scoreNode(query = '', node = {}) {
  const normalizedQuery = canonicalizeText(query);
  const normalizedText = canonicalizeText(node.canonicalKey || node.text);
  if (!normalizedQuery) {
    return Number(node.importance || 0) + Number(node.confidence || 0);
  }
  if (!normalizedText) return 0;
  if (normalizedText === normalizedQuery) return 2;
  const containment = normalizedText.includes(normalizedQuery) || normalizedQuery.includes(normalizedText) ? 0.5 : 0;
  return cosineFromTokenSets(tokenize(normalizedQuery), tokenize(normalizedText)) + containment;
}

function normalizeCompatNode(node = {}, score = 0) {
  const memoryKind = nodeMemoryKind(node);
  return {
    ...node,
    id: nodeId(node),
    canonicalText: normalizeText(node.canonicalKey || canonicalizeText(node.text)),
    score,
    finalScore: score,
    source: sourceForNode(node),
    memoryKind,
    meta: {
      memoryKind,
      fieldKey: normalizeText(node.fieldKey || node.semanticSlot),
      styleRole: normalizeText(node.styleRole),
      jargonRole: normalizeText(node.jargonRole)
    }
  };
}

function retrieveRelevantMemories(userId, query, topK = 8, options = {}) {
  const limit = Math.max(1, Number(topK || 8) || 8);
  return visibleNodes()
    .filter((node) => matchesUserScope(node, userId, options))
    .filter((node) => matchesOptions(node, options))
    .map((node) => normalizeCompatNode(node, scoreNode(query, node)))
    .filter((node) => !normalizeText(query) || node.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (Number(right.updatedAt || 0) !== Number(left.updatedAt || 0)) return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
      return left.id.localeCompare(right.id);
    })
    .slice(0, limit);
}

function retrieveUnifiedMemories(userId, query, topK = 8, options = {}) {
  if (isLegacyPrimary()) {
    return require('./legacyCompat').retrieveLegacyMemories(userId, query, topK, options);
  }
  const groupIds = normalizeGroupIds(options);
  const nodes = visibleNodes().filter((node) => {
    const scopeType = normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal';
    if (scopeType === 'group') {
      return options.includeGroup !== false && groupIds.has(normalizeText(node.groupId));
    }
    if (normalizeText(node.userId) !== normalizeText(userId)) return false;
    if ((scopeType === 'task' || scopeType === 'working') && options.includeTask === false) return false;
    const kind = nodeMemoryKind(node);
    if ((kind === 'style' || kind === 'jargon') && options.includeSignals === false) return false;
    if (kind === 'episode' && options.includeEpisodes === false) return false;
    return matchesOptions(node, options);
  });
  return nodes
    .map((node) => normalizeCompatNode(node, scoreNode(query, node)))
    .filter((node) => !normalizeText(query) || node.score > 0)
    .sort((left, right) => right.score - left.score || Number(right.updatedAt || 0) - Number(left.updatedAt || 0) || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Number(topK || 8) || 8));
}

async function retrieveUnifiedMemoriesAsync(userId, query, topK = 8, options = {}) {
  if (isLegacyPrimary()) {
    return require('./legacyCompat').retrieveLegacyMemoriesAsync(userId, query, topK, options);
  }
  const { queryMemory } = require('./repository');
  const result = await queryMemory({
    ...options,
    userId,
    query,
    topK,
    groupIds: Array.isArray(options.groupIds) ? options.groupIds : [],
    groupId: options.groupId
  });
  return Array.isArray(result.results) ? result.results : [];
}

function getCoreMemories(userId, topK = 6, options = {}) {
  return retrieveRelevantMemories(userId, '', topK, {
    ...options,
    scopeType: 'personal'
  });
}

function getMemoryItems(userId = '') {
  const uid = normalizeText(userId);
  return visibleNodes()
    .filter((node) => !uid || normalizeText(node.userId) === uid)
    .map((node) => normalizeCompatNode(node));
}

function getMemoryItemsByFilter(filters = {}) {
  const limit = Math.max(0, Number(filters.limit || 0) || 0);
  const items = visibleNodes()
    .filter((node) => (!filters.userId || normalizeText(node.userId) === normalizeText(filters.userId)))
    .filter((node) => (!filters.groupId || normalizeText(node.groupId) === normalizeText(filters.groupId)))
    .filter((node) => matchesOptions(node, filters))
    .map((node) => normalizeCompatNode(node));
  return limit > 0 ? items.slice(0, limit) : items;
}

function getMemoryStats(userId = '') {
  const items = getMemoryItems(userId);
  const countBy = (selector) => items.reduce((counts, item) => {
    const key = selector(item) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  return {
    total: items.length,
    byType: countBy((item) => item.type),
    byTier: {},
    byMemoryKind: countBy((item) => item.memoryKind),
    byStatus: countBy((item) => item.status),
    bySourceKind: countBy((item) => item.sourceKind)
  };
}

module.exports = {
  getCoreMemories,
  getMemoryItems,
  getMemoryItemsByFilter,
  getMemoryStats,
  retrieveRelevantMemories,
  retrieveUnifiedMemories,
  retrieveUnifiedMemoriesAsync
};
