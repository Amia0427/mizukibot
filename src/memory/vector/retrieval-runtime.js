const {
  STATUS_ACTIVE,
  nowTs,
  sanitizeText,
  normalizeScopeType,
  normalizeStatus,
  getRequestedMemoryKinds,
  isStyleOrJargonMemory,
  getItemMemoryKind
} = require('./normalization');
const {
  isExpired,
  getMemoryDocsFromShards,
  resolveShardMetasForRecall,
  getMemoryItems
} = require('./store-runtime');
const {
  filterDocIdsByOptions,
  filterUnifiedDocIds
} = require('./scoring-core');
const {
  scoreDocs,
  scoreDocsAsync
} = require('./scoring-selection');
const { shouldUseRemoteEmbedding } = require('./embedding');
const { embedQueryText } = require('../../../utils/memorySemanticIndex');
const {
  normalizeTier,
  importanceToTier,
  TIER_RANK
} = require('../../../utils/memoryTier');

function retrieveRelevantMemories(userId, query, topK = 8, options = {}) {
  const question = sanitizeText(query);
  if (!question) return [];

  const index = getMemoryDocsFromShards(resolveShardMetasForRecall(userId, options));
  const docs = index.docs || {};
  const ids = filterDocIdsByOptions(docs, userId, options);
  if (!ids.length) return [];
  return scoreDocs(userId, ids, docs, index, question, topK, options, null);
}

async function retrieveRelevantMemoriesAsync(userId, query, topK = 8, options = {}) {
  const question = sanitizeText(query);
  if (!question) return [];

  const index = getMemoryDocsFromShards(resolveShardMetasForRecall(userId, options));
  const docs = index.docs || {};
  const ids = filterDocIdsByOptions(docs, userId, options);
  if (!ids.length) return [];

  const embeddingQueryVec = Array.isArray(options.queryEmbedding)
    ? options.queryEmbedding
    : (shouldUseRemoteEmbedding() ? await embedQueryText(question, options) : null);

  return scoreDocsAsync(userId, ids, docs, index, question, topK, options, embeddingQueryVec);
}

function buildUnifiedMemoryOptions(options = {}) {
  const requestedKinds = getRequestedMemoryKinds(options);
  return {
    ...options,
    memoryKinds: requestedKinds.length > 0 ? requestedKinds : options.memoryKinds
  };
}

function retrieveUnifiedMemories(userId, query, topK = 8, options = {}) {
  const question = sanitizeText(query);
  if (!question) return [];

  const index = getMemoryDocsFromShards(resolveShardMetasForRecall(userId, options));
  const docs = index.docs || {};
  const unifiedOptions = buildUnifiedMemoryOptions(options);
  const ids = filterUnifiedDocIds(docs, userId, unifiedOptions);
  if (!ids.length) return [];
  return scoreDocs(userId, ids, docs, { ...index, docs }, question, topK, unifiedOptions, null);
}

async function retrieveUnifiedMemoriesAsync(userId, query, topK = 8, options = {}) {
  const question = sanitizeText(query);
  if (!question) return [];

  const index = getMemoryDocsFromShards(resolveShardMetasForRecall(userId, options));
  const docs = index.docs || {};
  const unifiedOptions = buildUnifiedMemoryOptions(options);
  const ids = filterUnifiedDocIds(docs, userId, unifiedOptions);
  if (!ids.length) return [];

  const embeddingQueryVec = Array.isArray(unifiedOptions.queryEmbedding)
    ? unifiedOptions.queryEmbedding
    : (shouldUseRemoteEmbedding() ? await embedQueryText(question, unifiedOptions) : null);

  return scoreDocsAsync(userId, ids, docs, { ...index, docs }, question, topK, unifiedOptions, embeddingQueryVec);
}

// "Core memories" are high-importance, stable items that we want the model to keep in mind.
// We surface them separately from RAG hits so they are less likely to be drowned by topics.
function getCoreMemories(userId, limit = 6, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];

  const cap = Math.max(1, Math.min(30, Number(limit) || 6));
  const minTier = normalizeTier(options.minTier || 'A') || 'A';
  const minRank = TIER_RANK[minTier] ?? 2;
  const now = nowTs();

  const items = getMemoryItems(uid)
    .filter((item) => String(item.userId) === uid)
    .filter((item) => normalizeStatus(item.status, STATUS_ACTIVE) === STATUS_ACTIVE && !isExpired(item, now))
    .filter((item) => !isStyleOrJargonMemory(item))
    .map((item) => {
      const tier = normalizeTier(item.tier) || importanceToTier(item.importance, item.confidence, item.type);
      return { ...item, tier };
    })
    .filter((item) => (TIER_RANK[item.tier] ?? 0) >= minRank);

  items.sort((a, b) => {
    if (a.type === 'impression' && b.type !== 'impression') return -1;
    if (b.type === 'impression' && a.type !== 'impression') return 1;
    const trA = TIER_RANK[a.tier] ?? 0;
    const trB = TIER_RANK[b.tier] ?? 0;
    if (trA !== trB) return trB - trA;
    const impA = Number(a.importance || 0);
    const impB = Number(b.importance || 0);
    if (impA !== impB) return impB - impA;
    const confA = Number(a.confidence || 0);
    const confB = Number(b.confidence || 0);
    if (confA !== confB) return confB - confA;
    const mentionA = Number(a.mentionCount || 0);
    const mentionB = Number(b.mentionCount || 0);
    if (mentionA !== mentionB) return mentionB - mentionA;
    return Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0);
  });

  return items.slice(0, cap).map((item) => ({
    id: item.id,
    type: item.type,
    text: item.text,
    canonicalText: item.canonicalText,
    confidence: item.confidence,
    importance: item.importance,
    tier: item.tier,
    ts: item.updatedAt || item.createdAt,
    scopeType: normalizeScopeType(item.scopeType),
    groupId: String(item.groupId || ''),
    taskType: String(item.taskType || ''),
    routePolicyKey: String(item.routePolicyKey || ''),
    topRouteType: String(item.topRouteType || ''),
    memoryKind: getItemMemoryKind(item),
    sourceKind: String(item.sourceKind || 'legacy'),
    status: normalizeStatus(item.status, STATUS_ACTIVE),
    meta: item.meta || {}
  }));
}

module.exports = {
  retrieveRelevantMemories,
  retrieveRelevantMemoriesAsync,
  buildUnifiedMemoryOptions,
  retrieveUnifiedMemories,
  retrieveUnifiedMemoriesAsync,
  getCoreMemories
};
