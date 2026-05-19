function normalizeMemoryItem(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const userId = String(raw.userId || raw.user_id || '').trim();
  const text = sanitizeText(raw.text || raw.content || '');
  if (!userId || !text) return null;

  const type = normalizeType(raw.type);
  const rule = getTypeRule(type);
  const createdAt = Number(raw.createdAt || raw.created_at || raw.ts) || nowTs();
  const updatedAt = Number(raw.updatedAt || raw.updated_at || createdAt) || createdAt;
  const weight = clamp(raw.weight || 1, 0.2, 3);
  const confidence = clamp(raw.confidence ?? raw.meta?.confidence ?? 0.8, 0.01, 1);
  // Importance is a smooth numeric score; "tier" is a discrete label derived from it.
  // Callers may provide either (or both) via top-level fields or meta hints.
  const tierHint = normalizeTier(raw.tier ?? raw.meta?.tier ?? raw.meta?.tierHint ?? raw.meta?.importanceTier);
  const importance = clamp(
    raw.importance ?? raw.meta?.importance ?? (tierHint ? tierToRepresentativeImportance(tierHint) : (rule.importance * weight)),
    0.2,
    3
  );
  const tier = tierHint || importanceToTier(importance, confidence, type);
  const ttlDays = raw.ttlDays ?? raw.ttl_days ?? rule.ttlDays;
  const expiresAt = Number(raw.expiresAt || raw.expires_at)
    || (ttlDays ? createdAt + (Number(ttlDays) * 24 * 3600 * 1000) : null);
  const scope = normalizeScope(raw);
  const memoryKind = normalizeMemoryKind(raw.memoryKind ?? raw.memory_kind ?? raw.meta?.memoryKind ?? raw.meta?.memory_kind);
  const supersedes = Array.isArray(raw.supersedes ?? raw.meta?.supersedes)
    ? (raw.supersedes ?? raw.meta?.supersedes).map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const notRecallable = raw.notRecallable === true
    || raw.not_recallable === true
    || raw.meta?.notRecallable === true
    || raw.meta?.not_recallable === true
    || String(raw.meta?.recallVerification?.status || '').toLowerCase() === 'not_recallable';
  const conflictKeys = Array.isArray(raw.conflictKeys ?? raw.conflict_keys ?? raw.meta?.conflictKeys)
    ? (raw.conflictKeys ?? raw.conflict_keys ?? raw.meta?.conflictKeys)
      .map((key) => sanitizeOptionalText(key))
      .filter(Boolean)
    : [];
  const styleRole = normalizeStyleRole(raw.styleRole ?? raw.style_role ?? raw.meta?.styleRole ?? raw.meta?.style_role);
  const jargonRole = normalizeJargonRole(raw.jargonRole ?? raw.jargon_role ?? raw.meta?.jargonRole ?? raw.meta?.jargon_role);
  const sourceKind = sanitizeOptionalText(raw.sourceKind ?? raw.source_kind ?? raw.meta?.sourceKind ?? raw.meta?.source_kind) || 'legacy';
  const participants = extractParticipants(raw, raw.meta && typeof raw.meta === 'object' ? raw.meta : {});
  const entities = normalizeStringArray(raw.entities ?? raw.meta?.entities ?? extractNamedEntities(text));
  const relations = normalizeStringArray(raw.relations ?? raw.meta?.relations ?? inferRelationsFromText(text, entities, participants));
  const conflictKey = normalizeConflictKey({
    ...raw,
    userId,
    type,
    canonicalText: raw.canonicalText || raw.canonical_text || canonicalizeText(text)
  });
  const rawStatus = normalizeStatus(raw.status, '');
  const status = rawStatus === STATUS_ARCHIVED
    ? STATUS_ARCHIVED
    : shouldStartAsCandidate(type, memoryKind, sourceKind, raw.status, confidence)
    ? STATUS_CANDIDATE
    : normalizeStatus(raw.status, STATUS_ACTIVE);
  const evidenceCount = Math.max(1, Math.floor(Number(raw.evidenceCount ?? raw.evidence_count ?? raw.meta?.evidenceCount ?? 1) || 1));
  const lastConfirmedAt = Number(raw.lastConfirmedAt ?? raw.last_confirmed_at ?? raw.meta?.lastConfirmedAt ?? updatedAt) || updatedAt;
  const sourceSessionId = sanitizeOptionalText(raw.sourceSessionId ?? raw.source_session_id ?? raw.meta?.sourceSessionId ?? raw.meta?.source_session_id ?? scope.sessionId);
  const turnId = sanitizeOptionalText(raw.turnId ?? raw.turn_id ?? raw.meta?.turnId ?? raw.meta?.turn_id ?? raw.meta?.learningDecision?.turnId);
  const turnIds = normalizeStringArray(raw.turnIds ?? raw.turn_ids ?? raw.meta?.turnIds ?? raw.meta?.turn_ids ?? raw.meta?.learningDecision?.turnIds);
  const rollupLevel = normalizeEpisodeRollupLevel(raw.rollupLevel ?? raw.rollup_level ?? raw.meta?.rollupLevel ?? raw.meta?.rollup_level);
  const episodeDay = normalizeEpisodeDay(raw.episodeDay ?? raw.episode_day ?? raw.meta?.episodeDay ?? raw.meta?.episode_day);
  const rawMeta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const meta = {
    ...rawMeta,
    ...(memoryKind ? { memoryKind } : {}),
    ...(styleRole ? { styleRole } : {}),
    ...(jargonRole ? { jargonRole } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(participants.length > 0 ? { participants } : {}),
    ...(entities.length > 0 ? { entities } : {}),
    ...(relations.length > 0 ? { relations } : {}),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(turnIds.length > 0 ? { turnIds } : {}),
    ...(rollupLevel ? { rollupLevel } : {}),
    ...(episodeDay ? { episodeDay } : {})
  };

  return {
    id: String(raw.id || generateId(userId)),
    userId,
    text,
    canonicalText: sanitizeText(raw.canonicalText || raw.canonical_text || canonicalizeText(text)),
    type,
    source: String(raw.source || raw.meta?.source || 'unknown').trim() || 'unknown',
    confidence,
    importance,
    tier,
    weight,
    status,
    sourceKind,
    createdAt,
    updatedAt,
    lastAccessAt: Number(raw.lastAccessAt || raw.last_access_at || 0) || 0,
    lastRecalledAt: Number(raw.lastRecalledAt || raw.last_recalled_at || raw.meta?.lastRecalledAt || 0) || 0,
    accessCount: Math.max(0, Math.floor(Number(raw.accessCount || raw.access_count || 0) || 0)),
    recallCount: Math.max(0, Math.floor(Number(raw.recallCount || raw.recall_count || raw.meta?.recallCount || 0) || 0)),
    stabilityScore: clamp(raw.stabilityScore ?? raw.stability_score ?? raw.meta?.stabilityScore ?? 0, 0, 1),
    memoryStrength: clamp(raw.memoryStrength ?? raw.memory_strength ?? raw.meta?.memoryStrength ?? 0, 0, 1.5),
    nextReviewAt: Number(raw.nextReviewAt || raw.next_review_at || raw.meta?.nextReviewAt || 0) || 0,
    mentionCount: Math.max(1, Math.floor(Number(raw.mentionCount || raw.mention_count || 1) || 1)),
    evidenceCount,
    lastConfirmedAt,
    expiresAt,
    scopeType: scope.scopeType,
    groupId: scope.groupId,
    sessionId: scope.sessionId,
    routePolicyKey: scope.routePolicyKey,
    topRouteType: scope.topRouteType,
    agentName: scope.agentName,
    taskType: scope.taskType,
    toolName: scope.toolName,
    channelId: scope.channelId,
    sourceSessionId,
    turnId,
    turnIds,
    participants,
    entities,
    relations,
    conflictKey,
    supersedes,
    notRecallable,
    conflictKeys,
    memoryKind,
    rollupLevel,
    episodeDay,
    meta
  };
}

function defaultLibrary() {
  return { version: LIBRARY_VERSION, items: [] };
}

const memoryShardState = {
  shards: new Map(),
  aggregateLibrary: null,
  aggregateIndex: null,
  aggregateDirty: true
};

function encodeShardOwnerId(value = '') {
  return encodeURIComponent(String(value || '').trim() || 'default');
}

function normalizeShardCategory(value = '') {
  const category = String(value || '').trim().toLowerCase();
  if (['personal', 'journal', 'style', 'task', 'group', 'jargon'].includes(category)) return category;
  return 'personal';
}

function normalizeShardOwnerId(value = '') {
  return sanitizeOptionalText(value) || 'default';
}

function buildShardKey(category = '', ownerId = '') {
  return `${normalizeShardCategory(category)}:${normalizeShardOwnerId(ownerId)}`;
}

function buildShardPaths(category = '', ownerId = '') {
  const normalizedCategory = normalizeShardCategory(category);
  const normalizedOwnerId = normalizeShardOwnerId(ownerId);
  const fileName = encodeShardOwnerId(normalizedOwnerId);
  return {
    itemsFile: path.join(SHARD_ROOT, normalizedCategory, `${fileName}.items.json`),
    indexFile: path.join(SHARD_ROOT, normalizedCategory, `${fileName}.index.json`)
  };
}

function defaultShardItemsPayload(meta = {}) {
  return {
    version: LIBRARY_VERSION,
    shardKey: String(meta.shardKey || ''),
    category: normalizeShardCategory(meta.category),
    ownerId: normalizeShardOwnerId(meta.ownerId),
    items: []
  };
}

function defaultShardIndexPayload(meta = {}) {
  return {
    version: INDEX_VERSION,
    shardKey: String(meta.shardKey || ''),
    category: normalizeShardCategory(meta.category),
    ownerId: normalizeShardOwnerId(meta.ownerId),
    librarySize: 0,
    updatedAt: 0,
    df: {},
    docs: {},
    totalDocs: 0
  };
}

function normalizeShardMeta(raw = {}) {
  const category = normalizeShardCategory(raw.category || raw.scopeCategory || raw.scope || raw.kind);
  const ownerId = normalizeShardOwnerId(raw.ownerId || raw.userId || raw.groupId || raw.owner || '');
  const shardKey = buildShardKey(category, ownerId);
  return {
    shardKey,
    category,
    ownerId,
    ...buildShardPaths(category, ownerId),
    itemCount: Math.max(0, Number(raw.itemCount || 0) || 0),
    updatedAt: Number(raw.updatedAt || 0) || 0
  };
}

function resolveShardCategoryForItem(item = {}) {
  const memoryKind = getItemMemoryKind(item);
  if (memoryKind === 'style') return 'style';
  if (memoryKind === 'jargon') return 'jargon';
  if (
    memoryKind === 'episode'
    || normalizeType(item.type) === 'episode'
    || String(item.sourceKind || '').toLowerCase() === 'journal'
  ) {
    return 'journal';
  }
  const scopeType = normalizeScopeType(item.scopeType);
  if (scopeType === 'task') return 'task';
  if (scopeType === 'group') return 'group';
  return 'personal';
}

function resolveShardOwnerIdForItem(item = {}, category = '') {
  const normalizedCategory = normalizeShardCategory(category || resolveShardCategoryForItem(item));
  if (normalizedCategory === 'group' || normalizedCategory === 'jargon') {
    return normalizeShardOwnerId(item.groupId || item.userId || '');
  }
  return normalizeShardOwnerId(item.userId || '');
}

function createShardMetaForItem(item = {}) {
  const category = resolveShardCategoryForItem(item);
  const ownerId = resolveShardOwnerIdForItem(item, category);
  return normalizeShardMeta({ category, ownerId });
}

function getShardItemsStore(meta = {}) {
  const normalizedMeta = normalizeShardMeta(meta);
  if (!hotStoreRegistry.shardItems.has(normalizedMeta.shardKey)) {
    hotStoreRegistry.shardItems.set(normalizedMeta.shardKey, createJsonHotStore(normalizedMeta.itemsFile, {
      fallback: () => defaultShardItemsPayload(normalizedMeta)
    }));
  }
  return hotStoreRegistry.shardItems.get(normalizedMeta.shardKey);
}

function getShardIndexStore(meta = {}) {
  const normalizedMeta = normalizeShardMeta(meta);
  if (!hotStoreRegistry.shardIndexes.has(normalizedMeta.shardKey)) {
    hotStoreRegistry.shardIndexes.set(normalizedMeta.shardKey, createJsonHotStore(normalizedMeta.indexFile, {
      fallback: () => defaultShardIndexPayload(normalizedMeta)
    }));
  }
  return hotStoreRegistry.shardIndexes.get(normalizedMeta.shardKey);
}

function listAllShardEntries() {
  return Array.from(memoryShardState.shards.values());
}

function saveLibrary(library) {
  ensureShardStateHydrated();
  const nextGroups = new Map();
  const items = Array.isArray(library?.items) ? library.items : [];
  for (const rawItem of items) {
    const item = normalizeMemoryItem(rawItem);
    if (!item) continue;
    const shardMeta = createShardMetaForItem(item);
    const grouped = nextGroups.get(shardMeta.shardKey);
    const list = grouped && Array.isArray(grouped.items) ? grouped.items : [];
    list.push(item);
    nextGroups.set(shardMeta.shardKey, {
      meta: grouped?.meta || shardMeta,
      items: list
    });
  }

  for (const [shardKey, entry] of Array.from(memoryShardState.shards.entries())) {
    if (!nextGroups.has(shardKey)) {
      const nextEntry = ensureShardEntry(entry.meta);
      nextEntry.items.items = [];
      nextEntry.index = materializeShardIndex([], nextEntry.meta);
      getShardItemsStore(nextEntry.meta).replace(nextEntry.items);
      getShardIndexStore(nextEntry.meta).replace(nextEntry.index);
      updateManifestForShard(nextEntry);
    }
  }

  for (const grouped of nextGroups.values()) {
    const entry = ensureShardEntry(grouped.meta);
    entry.items = {
      version: LIBRARY_VERSION,
      shardKey: entry.meta.shardKey,
      category: entry.meta.category,
      ownerId: entry.meta.ownerId,
      items: grouped.items
    };
    entry.index = materializeShardIndex(entry.items.items, entry.meta);
    getShardItemsStore(entry.meta).replace(entry.items);
    getShardIndexStore(entry.meta).replace(entry.index);
    updateManifestForShard(entry);
  }

  syncCompatSnapshots();
}

function migrateLegacyLibrary() {
  ensureShardStateHydrated();
  return loadLibrary();
}

function loadLibrary() {
  ensureShardStateHydrated();
  if (!memoryShardState.aggregateDirty && memoryShardState.aggregateLibrary) {
    return {
      version: LIBRARY_VERSION,
      items: memoryShardState.aggregateLibrary.items.slice()
    };
  }
  syncCompatSnapshots();
  return {
    version: LIBRARY_VERSION,
    items: Array.isArray(memoryShardState.aggregateLibrary?.items)
      ? memoryShardState.aggregateLibrary.items.slice()
      : []
  };
}

function defaultIndex() {
  return {
    version: INDEX_VERSION,
    librarySize: 0,
    updatedAt: 0,
    df: {},
    docs: {}
  };
}

function materializeShardIndex(items = [], meta = {}) {
  const index = {
    version: INDEX_VERSION,
    shardKey: String(meta.shardKey || ''),
    category: normalizeShardCategory(meta.category),
    ownerId: normalizeShardOwnerId(meta.ownerId),
    librarySize: items.length,
    updatedAt: nowTs(),
    df: {},
    docs: {},
    totalDocs: 0
  };
  for (const item of Array.isArray(items) ? items : []) {
    if (normalizeStatus(item.status) === STATUS_ARCHIVED || isExpired(item)) continue;
    if (item.notRecallable === true || item.meta?.notRecallable === true || String(item.meta?.recallVerification?.status || '').toLowerCase() === 'not_recallable') continue;
    const tokens = buildDocTokens(item);
    if (!tokens.length) continue;
    const tf = {};
    for (const token of tokens) tf[token] = (tf[token] || 0) + 1;
    for (const token of new Set(tokens)) {
      index.df[token] = (index.df[token] || 0) + 1;
    }
    index.docs[item.id] = {
      id: item.id,
      userId: item.userId,
      tf,
      len: tokens.length,
      ts: item.updatedAt || item.createdAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      type: item.type,
      text: item.text,
      canonicalText: item.canonicalText,
      source: item.source,
      sourceKind: item.sourceKind || 'legacy',
      confidence: item.confidence,
      importance: item.importance,
      tier: item.tier,
      weight: item.weight,
      status: normalizeStatus(item.status, STATUS_ACTIVE),
      evidenceCount: Number(item.evidenceCount || 1) || 1,
      lastConfirmedAt: Number(item.lastConfirmedAt || item.updatedAt || item.createdAt || 0) || 0,
      lastRecalledAt: item.lastRecalledAt || 0,
      accessCount: item.accessCount,
      recallCount: item.recallCount || 0,
      stabilityScore: item.stabilityScore || 0,
      memoryStrength: item.memoryStrength || 0,
      nextReviewAt: item.nextReviewAt || 0,
      scopeType: item.scopeType,
      groupId: item.groupId,
      sessionId: item.sessionId,
      routePolicyKey: item.routePolicyKey,
      topRouteType: item.topRouteType,
      agentName: item.agentName,
      taskType: item.taskType,
      toolName: item.toolName,
      channelId: item.channelId,
      sourceSessionId: item.sourceSessionId || '',
      participants: Array.isArray(item.participants) ? item.participants : [],
      entities: Array.isArray(item.entities) ? item.entities : [],
      relations: Array.isArray(item.relations) ? item.relations : [],
      conflictKey: item.conflictKey || '',
      supersedes: Array.isArray(item.supersedes) ? item.supersedes : [],
      notRecallable: item.notRecallable === true,
      memoryKind: getItemMemoryKind(item),
      rollupLevel: item.rollupLevel || '',
      episodeDay: item.episodeDay || '',
      styleRole: normalizeStyleRole(item.meta?.styleRole),
      jargonRole: normalizeJargonRole(item.meta?.jargonRole),
      meta: item.meta || {}
    };
  }
  index.totalDocs = Object.keys(index.docs).length;
  return index;
}

function markAggregateDirty() {
  memoryShardState.aggregateDirty = true;
  memoryShardState.aggregateLibrary = null;
  memoryShardState.aggregateIndex = null;
}

function updateManifestForShard(entry = null) {
  const manifestStore = getManifestStore();
  manifestStore.update((manifest) => {
    const next = manifest && typeof manifest === 'object' ? manifest : defaultShardManifest();
    next.version = SHARD_MANIFEST_VERSION;
    next.updatedAt = nowTs();
    if (!next.shards || typeof next.shards !== 'object') next.shards = {};
    if (entry) {
      next.shards[entry.meta.shardKey] = {
        shardKey: entry.meta.shardKey,
        category: entry.meta.category,
        ownerId: entry.meta.ownerId,
        itemCount: Array.isArray(entry.items.items) ? entry.items.items.length : 0,
        updatedAt: nowTs()
      };
    }
    return next;
  });
  manifestStore.flushSync();
}

function syncCompatSnapshots() {
  const aggregateLibrary = {
    version: LIBRARY_VERSION,
    items: listAllShardEntries().flatMap((entry) => Array.isArray(entry.items.items) ? entry.items.items : [])
  };
  const aggregateIndex = {
    version: INDEX_VERSION,
    librarySize: aggregateLibrary.items.length,
    updatedAt: nowTs(),
    df: {},
    docs: {},
    totalDocs: 0
  };
  for (const entry of listAllShardEntries()) {
    const shardIndex = entry.index;
    if (!shardIndex || typeof shardIndex !== 'object') continue;
    for (const [token, count] of Object.entries(shardIndex.df || {})) {
      aggregateIndex.df[token] = (aggregateIndex.df[token] || 0) + Number(count || 0);
    }
    Object.assign(aggregateIndex.docs, shardIndex.docs || {});
  }
  aggregateIndex.totalDocs = Object.keys(aggregateIndex.docs).length;
  getCompatItemsStore().replace(aggregateLibrary);
  getCompatIndexStore().replace(aggregateIndex);
  getCompatItemsStore().flushSync();
  getCompatIndexStore().flushSync();
  memoryShardState.aggregateLibrary = aggregateLibrary;
  memoryShardState.aggregateIndex = aggregateIndex;
  memoryShardState.aggregateDirty = false;
}

function ensureShardEntry(meta = {}) {
  const normalizedMeta = normalizeShardMeta(meta);
  const existing = memoryShardState.shards.get(normalizedMeta.shardKey);
  if (existing) return existing;
  const itemsStore = getShardItemsStore(normalizedMeta);
  const indexStore = getShardIndexStore(normalizedMeta);
  const itemsPayload = itemsStore.read();
  const itemList = Array.isArray(itemsPayload?.items)
    ? itemsPayload.items.map((item) => normalizeMemoryItem(item)).filter(Boolean)
    : [];
  const nextItemsPayload = {
    version: LIBRARY_VERSION,
    shardKey: normalizedMeta.shardKey,
    category: normalizedMeta.category,
    ownerId: normalizedMeta.ownerId,
    items: itemList
  };
  if (!itemsPayload || !Array.isArray(itemsPayload.items)) {
    itemsStore.replace(nextItemsPayload);
  }
  const loadedIndex = indexStore.read();
  const index =
    loadedIndex
    && loadedIndex.version === INDEX_VERSION
    && String(loadedIndex.shardKey || '') === normalizedMeta.shardKey
    ? loadedIndex
    : materializeShardIndex(itemList, normalizedMeta);
  if (!loadedIndex || loadedIndex.version !== INDEX_VERSION || String(loadedIndex.shardKey || '') !== normalizedMeta.shardKey) {
    indexStore.replace(index);
  }
  const entry = {
    meta: normalizedMeta,
    items: nextItemsPayload,
    index
  };
  memoryShardState.shards.set(normalizedMeta.shardKey, entry);
  updateManifestForShard(entry);
  markAggregateDirty();
  return entry;
}

function migrateLibraryItemsToShards(items = []) {
  for (const rawItem of Array.isArray(items) ? items : []) {
    const item = normalizeMemoryItem(rawItem);
    if (!item) continue;
    const shardMeta = createShardMetaForItem(item);
    const entry = ensureShardEntry(shardMeta);
    entry.items.items.push(item);
    entry.index = materializeShardIndex(entry.items.items, entry.meta);
    getShardItemsStore(entry.meta).replace(entry.items);
    getShardIndexStore(entry.meta).replace(entry.index);
    updateManifestForShard(entry);
  }
  syncCompatSnapshots();
}

function ensureShardStateHydrated() {
  if (shardStateHydrated) return;
  shardStateHydrated = true;
  const manifestStore = getManifestStore();
  const manifest = manifestStore.read();
  const shardEntries = manifest && manifest.shards && typeof manifest.shards === 'object'
    ? Object.values(manifest.shards)
    : [];
  for (const shardEntry of shardEntries) {
    ensureShardEntry(shardEntry);
  }
  if (memoryShardState.shards.size > 0) {
    syncCompatSnapshots();
    return;
  }
  const current = safeReadJson(ITEMS_FILE, null);
  if (current && Array.isArray(current.items) && current.items.length > 0) {
    migrateLibraryItemsToShards(current.items);
    manifestStore.update((snapshot) => {
      const next = snapshot && typeof snapshot === 'object' ? snapshot : defaultShardManifest();
      next.migratedAt = next.migratedAt || nowTs();
      return next;
    });
    return;
  }
  const legacy = safeReadJson(LEGACY_LIB_FILE, null);
  if (legacy && Array.isArray(legacy.items) && legacy.items.length > 0) {
    migrateLibraryItemsToShards(legacy.items);
    manifestStore.update((snapshot) => {
      const next = snapshot && typeof snapshot === 'object' ? snapshot : defaultShardManifest();
      next.migratedAt = next.migratedAt || nowTs();
      return next;
    });
    return;
  }
  syncCompatSnapshots();
}

function loadIndex() {
  ensureShardStateHydrated();
  if (!memoryShardState.aggregateDirty && memoryShardState.aggregateIndex) {
    return {
      ...memoryShardState.aggregateIndex,
      df: { ...(memoryShardState.aggregateIndex.df || {}) },
      docs: { ...(memoryShardState.aggregateIndex.docs || {}) }
    };
  }
  syncCompatSnapshots();
  return {
    ...memoryShardState.aggregateIndex,
    df: { ...(memoryShardState.aggregateIndex?.df || {}) },
    docs: { ...(memoryShardState.aggregateIndex?.docs || {}) }
  };
}

function saveIndex(index) {
  const normalized = index && typeof index === 'object' ? index : defaultIndex();
  getCompatIndexStore().replace(normalized);
  memoryShardState.aggregateIndex = normalized;
  memoryShardState.aggregateDirty = false;
}

