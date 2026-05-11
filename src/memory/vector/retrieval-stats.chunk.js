function selectDiverseHits(scored, topK, options = {}) {
  const maxPerType = Math.max(1, Number(config.MEMORY_RAG_MAX_PER_TYPE) || 2);
  // Avoid flooding the prompt with low-importance (tier C) memories.
  const maxLowTier = Math.max(0, Math.floor(Number(config.MEMORY_RAG_MAX_LOW_TIER ?? 2) || 2));
  const facet = resolveSelectionFacet(scored, options);
  const facetPriorityEnabled = isFacetPriorityEnabled(facet);
  const ranked = (Array.isArray(scored) ? scored : []).slice().sort((a, b) => {
    if (Number(b.score || 0) !== Number(a.score || 0)) return Number(b.score || 0) - Number(a.score || 0);
    const tierDelta = (TIER_RANK[normalizeTier(b.tier) || 'C'] || 0) - (TIER_RANK[normalizeTier(a.tier) || 'C'] || 0);
    if (tierDelta !== 0) return tierDelta;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  const selected = [];
  const perType = new Map();
  const perKind = new Map();
  const perEpisode = new Map();
  const seenCanonical = new Set();
  let lowTierUsed = 0;

  function isLowTier(tier) {
    return (normalizeTier(tier) || 'B') === 'C';
  }

  function isHighTier(tier) {
    const t = normalizeTier(tier) || 'B';
    return t === 'S' || t === 'A';
  }

  function canTake(hit, { enforceLowTierCap = true } = {}) {
    if (!hit) return false;
    if (seenCanonical.has(hit.canonicalText)) return false;

    const count = perType.get(hit.type) || 0;
    const perTypeCap = hit.type === 'impression' ? Math.max(1, maxPerType) : maxPerType;
    if (count >= perTypeCap) return false;

    const memoryKind = normalizeMemoryKind(hit.memoryKind);
    if (isSignalMemoryKind(memoryKind)) {
      const kindCount = perKind.get(memoryKind) || 0;
      const signalCap = memoryKind === 'style' ? 1 : 1;
      if (kindCount >= signalCap) return false;
    }

    if (hit.type === 'episode') {
      const episodeCap = 2;
      const key = String(hit.rollupLevel || 'daily');
      if ((perEpisode.get(key) || 0) >= episodeCap) return false;
    }

    if (enforceLowTierCap && maxLowTier > 0 && isLowTier(hit.tier) && lowTierUsed >= maxLowTier) {
      return false;
    }

    return true;
  }

  function take(hit) {
    selected.push(hit);
    perType.set(hit.type, (perType.get(hit.type) || 0) + 1);
    const memoryKind = normalizeMemoryKind(hit.memoryKind);
    if (memoryKind) perKind.set(memoryKind, (perKind.get(memoryKind) || 0) + 1);
    if (hit.type === 'episode') {
      const key = String(hit.rollupLevel || 'daily');
      perEpisode.set(key, (perEpisode.get(key) || 0) + 1);
    }
    seenCanonical.add(hit.canonicalText);
    if (isLowTier(hit.tier)) lowTierUsed += 1;
  }

  // Pass 1: try to include one high-tier memory when available.
  if (!['continuity', 'task', 'journal'].includes(facet)) {
    for (const hit of ranked) {
      if (selected.length >= topK) break;
      if (hit.type !== 'impression') continue;
      if (!canTake(hit, { enforceLowTierCap: true })) continue;
      take({ ...hit, selectionReason: appendReason(hit.selectionReason, 'facet_profile_anchor') });
      break;
    }
  }

  // Pass 2: try to include one other high-tier memory when available.
  for (const hit of ranked) {
    if (selected.length >= topK) break;
    if (!isHighTier(hit.tier)) continue;
    if (facetPriorityEnabled && !isFacetPreferredHit(hit, facet) && !isStrongSemanticHit(hit, options)) continue;
    if (!canTake(hit, { enforceLowTierCap: true })) continue;
    take({ ...hit, selectionReason: appendReason(hit.selectionReason, 'facet_high_tier') });
    break;
  }

  if (facetPriorityEnabled) {
    for (const hit of ranked) {
      if (selected.length >= topK) break;
      if (!isFacetPreferredHit(hit, facet) && !isStrongSemanticHit(hit, options)) continue;
      if (!canTake(hit, { enforceLowTierCap: true })) continue;
      take({ ...hit, selectionReason: appendReason(hit.selectionReason, 'facet_priority') });
    }
  }

  for (const hit of ranked) {
    if (selected.length >= topK) break;
    if (!canTake(hit, { enforceLowTierCap: true })) continue;
    take(hit);
  }

  if (selected.length >= topK) return selected;

  for (const hit of ranked) {
    if (selected.length >= topK) break;
    if (selected.find((row) => row.id === hit.id)) continue;
    // Backfill without low-tier/type caps, but still avoid repeating identical canonical memories.
    if (seenCanonical.has(hit.canonicalText)) continue;
    selected.push(hit);
    seenCanonical.add(hit.canonicalText);
  }

  return selected;
}

// Retrieval uses lexical similarity plus direct-match and recency boosts.
function retrieveRelevantMemories(userId, query, topK = 8, options = {}) {
  const question = sanitizeText(query);
  if (!question) return [];

  const library = loadLibrary();
  if (pruneLibrary(library)) {
    saveLibrary(library);
    rebuildMemoryIndex(library);
  }

  const index = ensureIndexFresh(library);
  const docs = index.docs || {};
  const ids = filterDocIdsByOptions(docs, userId, options);
  if (!ids.length) return [];
  return scoreDocs(userId, ids, docs, index, question, topK, options, null);
}

async function retrieveRelevantMemoriesAsync(userId, query, topK = 8, options = {}) {
  const question = sanitizeText(query);
  if (!question) return [];

  const library = loadLibrary();
  if (pruneLibrary(library)) {
    saveLibrary(library);
    rebuildMemoryIndex(library);
  }

  const index = ensureIndexFresh(library);
  const docs = index.docs || {};
  const ids = filterDocIdsByOptions(docs, userId, options);
  if (!ids.length) return [];

  const embeddingQueryVec = Array.isArray(options.queryEmbedding)
    ? options.queryEmbedding
    : (shouldUseRemoteEmbedding() ? await embedQueryText(question, options) : null);

  return scoreDocsAsync(userId, ids, docs, index, question, topK, options, embeddingQueryVec);
}

function getMemoryItems(userId = null) {
  const library = loadLibrary();
  if (pruneLibrary(library)) saveLibrary(library);
  if (!userId) return library.items.slice();
  return library.items.filter((item) => String(item.userId) === String(userId));
}

function getMemoryItemsByFilter(filters = {}) {
  const userId = sanitizeOptionalText(filters.userId);
  const status = filters.status ? normalizeStatus(filters.status, STATUS_ACTIVE) : '';
  const sourceKind = sanitizeOptionalText(filters.sourceKind).toLowerCase();
  const memoryKind = normalizeMemoryKind(filters.memoryKind);
  const scopeType = filters.scopeType ? normalizeScopeType(filters.scopeType) : '';
  const groupId = sanitizeOptionalText(filters.groupId);
  const limit = Math.max(1, Math.min(500, Number(filters.limit) || 100));

  return getMemoryItems(userId || null)
    .filter((item) => (status ? normalizeStatus(item.status, STATUS_ACTIVE) === status : true))
    .filter((item) => (sourceKind ? String(item.sourceKind || '').toLowerCase() === sourceKind : true))
    .filter((item) => (memoryKind ? getItemMemoryKind(item) === memoryKind : true))
    .filter((item) => (scopeType ? normalizeScopeType(item.scopeType) === scopeType : true))
    .filter((item) => (groupId ? String(item.groupId || '') === groupId : true))
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
    .slice(0, limit);
}

function rememberExplicitMemory(userId, text, options = {}) {
  const scopeType = normalizeScopeType(options.scopeType);
  const groupId = sanitizeOptionalText(options.groupId);
  const uid = scopeType === 'group' && groupId
    ? `group:${groupId}`
    : sanitizeOptionalText(userId);
  const content = sanitizeText(text);
  if (!uid || !content) return null;
  return addMemoryItem(uid, content, options.type || 'fact', {
    ...options,
    source: options.source || 'explicit',
    status: STATUS_ACTIVE,
    sourceKind: 'explicit',
    confidence: options.confidence ?? 1.0,
    evidenceCount: Math.max(1, Number(options.evidenceCount || 1) || 1),
    lastConfirmedAt: options.lastConfirmedAt || nowTs()
  }, options.weight || 1.1);
}

function addEpisodeMemory(userId, text, options = {}) {
  if (!config.MEMORY_EPISODIC_INDEX_ENABLED) return null;
  const uid = sanitizeOptionalText(userId);
  const content = sanitizeText(text);
  if (!uid || !content) return null;
  return addMemoryItem(uid, content, 'episode', {
    ...options,
    source: options.source || 'daily_journal',
    status: STATUS_ACTIVE,
    sourceKind: 'journal',
    memoryKind: 'episode',
    rollupLevel: options.rollupLevel || 'daily',
    episodeDay: options.episodeDay || '',
    confidence: options.confidence ?? 0.92
  }, options.weight || 1.04);
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

  const library = loadLibrary();
  if (pruneLibrary(library)) {
    saveLibrary(library);
    rebuildMemoryIndex(library);
  }

  const index = ensureIndexFresh(library);
  const docs = collectDocsFromShardCategories(resolveUnifiedShardCategories(options));
  const unifiedOptions = buildUnifiedMemoryOptions(options);
  const ids = filterUnifiedDocIds(docs, userId, unifiedOptions);
  if (!ids.length) return [];
  return scoreDocs(userId, ids, docs, { ...index, docs }, question, topK, unifiedOptions, null);
}

async function retrieveUnifiedMemoriesAsync(userId, query, topK = 8, options = {}) {
  const question = sanitizeText(query);
  if (!question) return [];

  const library = loadLibrary();
  if (pruneLibrary(library)) {
    saveLibrary(library);
    rebuildMemoryIndex(library);
  }

  const index = ensureIndexFresh(library);
  const docs = collectDocsFromShardCategories(resolveUnifiedShardCategories(options));
  const unifiedOptions = buildUnifiedMemoryOptions(options);
  const ids = filterUnifiedDocIds(docs, userId, unifiedOptions);
  if (!ids.length) return [];

  const embeddingQueryVec = Array.isArray(unifiedOptions.queryEmbedding)
    ? unifiedOptions.queryEmbedding
    : (shouldUseRemoteEmbedding() ? await embedQueryText(question, unifiedOptions) : null);

  return scoreDocsAsync(userId, ids, docs, { ...index, docs }, question, topK, unifiedOptions, embeddingQueryVec);
}

function getMemoryStats(userId = null) {
  const items = getMemoryItems(userId).filter((item) => normalizeStatus(item.status, STATUS_ACTIVE) !== STATUS_ARCHIVED && !isExpired(item));
  const byType = {};
  const byTier = {};
  const byMemoryKind = {};
  const byStatus = {};
  const bySourceKind = {};
  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    const tier = normalizeTier(item.tier) || importanceToTier(item.importance, item.confidence, item.type);
    byTier[tier] = (byTier[tier] || 0) + 1;
    const memoryKind = getItemMemoryKind(item);
    if (memoryKind) byMemoryKind[memoryKind] = (byMemoryKind[memoryKind] || 0) + 1;
    const status = normalizeStatus(item.status, STATUS_ACTIVE);
    byStatus[status] = (byStatus[status] || 0) + 1;
    const sourceKind = String(item.sourceKind || 'legacy').toLowerCase();
    bySourceKind[sourceKind] = (bySourceKind[sourceKind] || 0) + 1;
  }
  return { total: items.length, byType, byTier, byMemoryKind, byStatus, bySourceKind };
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

  const library = loadLibrary();
  if (pruneLibrary(library)) saveLibrary(library);

  const items = library.items
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
  addMemoryItem,
  addMemoryItemsBatch,
  addMemoryItemsBatchAsync,
  addMemoryItemsBatchWithVectorBackfill,
  addEpisodeMemory,
  loadIndex,
  loadLibrary,
  rebuildMemoryIndex,
  retrieveRelevantMemories,
  retrieveRelevantMemoriesAsync,
  retrieveUnifiedMemories,
  retrieveUnifiedMemoriesAsync,
  rememberExplicitMemory,
  saveIndex,
  saveLibrary,
  getCoreMemories,
  getMemoryItems,
  getMemoryItemsByFilter,
  getMemoryStats,
  touchAccessStats,
  shouldUseRemoteEmbedding,
  requestEmbedding,
  cosineArray
};






