const {
  addMemoryItem,
  addMemoryItemsBatchWithVectorBackfill,
  retrieveRelevantMemories,
  retrieveRelevantMemoriesAsync
} = require('./vectorMemory');

function sanitizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function addGroupMemory(groupId, text, type = 'fact', meta = {}, weight = 1.0) {
  const gid = sanitizeText(groupId);
  const content = sanitizeText(text);
  if (!gid || !content) return null;

  return addMemoryItem(
    `group:${gid}`,
    content,
    type,
    {
      ...meta,
      scopeType: 'group',
      groupId: gid,
      source: meta?.source || 'group_extractor'
    },
    weight
  );
}

function buildGroupMemoryCandidate(groupId, text, type = 'fact', meta = {}, weight = 1.0) {
  const gid = sanitizeText(groupId);
  const content = sanitizeText(text);
  if (!gid || !content) return null;
  const nextMeta = {
    ...meta,
    scopeType: 'group',
    groupId: gid,
    source: meta?.source || 'group_extractor'
  };
  return {
    userId: `group:${gid}`,
    text: content,
    type,
    weight,
    source: nextMeta.source,
    confidence: nextMeta.confidence,
    scopeType: 'group',
    groupId: gid,
    routePolicyKey: nextMeta.routePolicyKey,
    topRouteType: nextMeta.topRouteType,
    sessionId: nextMeta.sessionId,
    channelId: nextMeta.channelId,
    status: nextMeta.status,
    sourceKind: nextMeta.sourceKind,
    sourceSessionId: nextMeta.sourceSessionId,
    turnId: nextMeta.turnId,
    turnIds: Array.isArray(nextMeta.turnIds) ? nextMeta.turnIds : [],
    evidence: Array.isArray(nextMeta.evidence) ? nextMeta.evidence : [],
    participants: Array.isArray(nextMeta.participants) ? nextMeta.participants : [],
    entities: Array.isArray(nextMeta.entities) ? nextMeta.entities : [],
    relations: Array.isArray(nextMeta.relations) ? nextMeta.relations : [],
    meta: nextMeta
  };
}

async function addGroupMemoryWithVectorBackfill(groupId, text, type = 'fact', meta = {}, weight = 1.0, options = {}) {
  const candidate = buildGroupMemoryCandidate(groupId, text, type, meta, weight);
  if (!candidate) return { ids: [], accepted: [], rejected: [] };
  return addMemoryItemsBatchWithVectorBackfill([candidate], {
    ...options,
    phase: 'group_memory_write'
  });
}

function retrieveRelevantGroupMemoriesSync(groupId, query, topK = 4, options = {}) {
  const gid = sanitizeText(groupId);
  if (!gid) return [];

  return retrieveRelevantMemories(`group:${gid}`, query, topK, {
    ...options,
    scopeType: 'group',
    groupId: gid
  });
}

async function retrieveRelevantGroupMemories(groupId, query, topK = 4, options = {}) {
  const gid = sanitizeText(groupId);
  if (!gid) return [];

  return retrieveRelevantMemoriesAsync(`group:${gid}`, query, topK, {
    ...options,
    scopeType: 'group',
    groupId: gid
  });
}

function formatGroupMemories(hits = [], options = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0) return String(options.emptyText || '暂无相关群共享记忆');

  return list
    .map((item, index) => `${index + 1}. [group|${item.type}] ${item.text}`)
    .join('\n');
}

function formatGroupMemoriesCompat(hits = [], options = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0 && Object.prototype.hasOwnProperty.call(options, 'emptyText')) {
    return String(options.emptyText || '');
  }
  return formatGroupMemories(hits, options);
}

module.exports = {
  addGroupMemory,
  addGroupMemoryWithVectorBackfill,
  retrieveRelevantGroupMemoriesSync,
  retrieveRelevantGroupMemories,
  formatGroupMemories: formatGroupMemoriesCompat
};
