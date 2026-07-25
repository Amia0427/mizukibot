const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const { createJsonHotStore } = require('../../../utils/jsonHotStore');
const {
  normalizeTier,
  tierToRepresentativeImportance,
  importanceToTier
} = require('../../../utils/memoryTier');
const {
  MAX_METADATA_LIST,
  STATUS_ACTIVE,
  STATUS_CANDIDATE,
  STATUS_ARCHIVED,
  nowTs,
  clamp,
  normalizeType,
  sanitizeText,
  sanitizeOptionalText,
  normalizeScopeType,
  normalizeScope,
  normalizeMemoryKind,
  normalizeStyleRole,
  normalizeJargonRole,
  normalizeStatus,
  normalizeEpisodeRollupLevel,
  normalizeEpisodeDay,
  normalizeStringArray,
  extractParticipants,
  extractNamedEntities,
  inferRelationsFromText,
  normalizeConflictKey,
  shouldStartAsCandidate,
  shouldDeactivateStaleCandidate,
  getItemMemoryKind,
  canonicalizeText,
  tokenize,
  getTypeRule,
  generateId
} = require('./normalization');

const ITEMS_FILE = path.join(config.DATA_DIR, 'memory_items.json');
const LEGACY_LIB_FILE = path.join(config.DATA_DIR, 'memory_library.json');
const IDX_FILE = path.join(config.DATA_DIR, 'memory_index.json');
const SHARD_ROOT = path.join(config.DATA_DIR, 'memory-shards');
const SHARD_MANIFEST_FILE = path.join(SHARD_ROOT, 'manifest.json');
const LIBRARY_VERSION = 3;
const INDEX_VERSION = 4;
const SHARD_MANIFEST_VERSION = 1;
const hotStoreRegistry = {
  manifest: null,
  compatItems: null,
  compatIndex: null,
  shardItems: new Map(),
  shardIndexes: new Map()
};
let shardStateHydrated = false;
const memoryShardState = {
  shards: new Map(),
  aggregateLibrary: null,
  aggregateIndex: null,
  aggregateDirty: true
};
function atomicWriteJson(file, obj) {
  const tempFile = path.join(path.dirname(file), `${path.basename(file)}.${process.pid}.tmp`);
  const text = JSON.stringify(obj, null, 2);

  try {
    fs.writeFileSync(tempFile, text, 'utf-8');
    fs.renameSync(tempFile, file);
  } catch (e) {
    try {
      fs.writeFileSync(file, text, 'utf-8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }

    if (e && e.code !== 'EPERM' && e.code !== 'EXDEV') throw e;
  }
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf-8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[vectorMemory] failed to read json:', file, e.message);
    return fallback;
  }
}

function safeWriteJson(file, obj) {
  try {
    atomicWriteJson(file, obj);
  } catch (e) {
    console.error('[vectorMemory] failed to write json:', file, e.message);
  }
}

function getCompatItemsStore() {
  if (!hotStoreRegistry.compatItems) {
    hotStoreRegistry.compatItems = createJsonHotStore(ITEMS_FILE, {
      fallback: () => defaultLibrary()
    });
  }
  return hotStoreRegistry.compatItems;
}

function getCompatIndexStore() {
  if (!hotStoreRegistry.compatIndex) {
    hotStoreRegistry.compatIndex = createJsonHotStore(IDX_FILE, {
      fallback: () => defaultIndex()
    });
  }
  return hotStoreRegistry.compatIndex;
}

function defaultShardManifest() {
  return {
    version: SHARD_MANIFEST_VERSION,
    updatedAt: 0,
    migratedAt: 0,
    shards: {}
  };
}

function getManifestStore() {
  if (!hotStoreRegistry.manifest) {
    hotStoreRegistry.manifest = createJsonHotStore(SHARD_MANIFEST_FILE, {
      fallback: () => defaultShardManifest()
    });
  }
  return hotStoreRegistry.manifest;
}

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
  const memoryCategoryMetadata = (() => {
    try {
      return require('../../../utils/memory-v3/categoryMetadata').deriveMemoryMetadata({
        ...raw,
        type,
        memoryKind,
        fieldKey: raw.fieldKey ?? raw.field_key ?? raw.semanticSlot ?? raw.semantic_slot ?? rawMeta.fieldKey,
        sourceKind,
        scopeType: scope.scopeType,
        source: raw.source || rawMeta.source || 'unknown',
        tags: raw.tags ?? rawMeta.tags,
        intent: raw.intent ?? rawMeta.intent,
        privacyLevel: raw.privacyLevel ?? raw.privacy_level ?? rawMeta.privacyLevel ?? rawMeta.privacy_level,
        meta: rawMeta
      });
    } catch (_) {
      return { category: '', tags: [], intent: '', privacyLevel: 'private' };
    }
  })();
  const meta = {
    ...rawMeta,
    ...(memoryCategoryMetadata.category ? { category: memoryCategoryMetadata.category } : {}),
    ...(memoryCategoryMetadata.tags.length > 0 ? { tags: memoryCategoryMetadata.tags } : {}),
    ...(memoryCategoryMetadata.intent ? { intent: memoryCategoryMetadata.intent } : {}),
    ...(memoryCategoryMetadata.privacyLevel ? { privacyLevel: memoryCategoryMetadata.privacyLevel } : {}),
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

function listManifestShardMetas() {
  const manifest = getManifestStore().read();
  const shardEntries = manifest && manifest.shards && typeof manifest.shards === 'object'
    ? Object.values(manifest.shards)
    : [];
  return shardEntries.map((entry) => normalizeShardMeta(entry)).filter((entry) => entry.shardKey);
}

function hydrateAllShardEntries() {
  ensureShardStateHydrated();
  for (const shardEntry of listManifestShardMetas()) {
    ensureShardEntry(shardEntry);
  }
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
  hydrateAllShardEntries();
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
      category: item.meta?.category || '',
      tags: Array.isArray(item.meta?.tags) ? item.meta.tags : [],
      intent: item.meta?.intent || '',
      privacyLevel: item.meta?.privacyLevel || 'private',
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
  hydrateAllShardEntries();
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
  if (manifest?.shards && Object.keys(manifest.shards).length > 0) return;
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
  hydrateAllShardEntries();
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

function getShardEntriesForMetas(metas = []) {
  ensureShardStateHydrated();
  const seen = new Set();
  const entries = [];
  for (const meta of Array.isArray(metas) ? metas : []) {
    const normalized = normalizeShardMeta(meta);
    if (!normalized.shardKey || seen.has(normalized.shardKey)) continue;
    seen.add(normalized.shardKey);
    entries.push(ensureShardEntry(normalized));
  }
  return entries;
}

function getMemoryItemsFromShards(metas = []) {
  return getShardEntriesForMetas(metas)
    .flatMap((entry) => Array.isArray(entry.items.items) ? entry.items.items : []);
}

function readMemoryItemsFromShards(metas = []) {
  ensureShardStateHydrated();
  const seen = new Set();
  const items = [];
  for (const meta of Array.isArray(metas) ? metas : []) {
    const normalized = normalizeShardMeta(meta);
    if (!normalized.shardKey || seen.has(normalized.shardKey)) continue;
    seen.add(normalized.shardKey);
    const loaded = memoryShardState.shards.get(normalized.shardKey);
    if (loaded && Array.isArray(loaded.items?.items)) {
      items.push(...loaded.items.items);
      continue;
    }
    const payload = safeReadJson(normalized.itemsFile, null);
    if (!Array.isArray(payload?.items)) continue;
    items.push(...payload.items.map((item) => normalizeMemoryItem(item)).filter(Boolean));
  }
  return items;
}

function getMemoryDocsFromShards(metas = []) {
  const docs = {};
  const df = {};
  let totalDocs = 0;
  for (const entry of getShardEntriesForMetas(metas)) {
    const index = entry.index || defaultShardIndexPayload(entry.meta);
    Object.assign(docs, index.docs || {});
    for (const [token, count] of Object.entries(index.df || {})) {
      df[token] = (df[token] || 0) + Number(count || 0);
    }
    totalDocs += Number(index.totalDocs || Object.keys(index.docs || {}).length || 0);
  }
  return {
    version: INDEX_VERSION,
    librarySize: Object.keys(docs).length,
    updatedAt: nowTs(),
    df,
    docs,
    totalDocs
  };
}

function saveIndex(index) {
  const normalized = index && typeof index === 'object' ? index : defaultIndex();
  getCompatIndexStore().replace(normalized);
  memoryShardState.aggregateIndex = normalized;
  memoryShardState.aggregateDirty = false;
}

function isExpired(item, now = nowTs()) {
  if (!item) return true;
  if (normalizeStatus(item.status) === STATUS_ARCHIVED) return true;
  if (!item.expiresAt) return false;
  return now >= item.expiresAt;
}

function pruneLibrary(library) {
  const now = nowTs();
  let changed = false;

  for (const item of library.items) {
    if (normalizeStatus(item.status) === STATUS_ACTIVE && isExpired(item, now)) {
      item.status = STATUS_ARCHIVED;
      item.updatedAt = now;
      changed = true;
      continue;
    }

    if (shouldDeactivateStaleCandidate(item, now)) {
      item.status = STATUS_ARCHIVED;
      item.updatedAt = now;
      changed = true;
    }
  }

  if (archiveRolledUpEpisodes(library, now)) {
    changed = true;
  }

  return changed;
}

function getEpisodeArchiveAgeDays(item = {}, now = nowTs()) {
  const ts = Number(item.updatedAt || item.createdAt || 0) || 0;
  if (!ts) return 0;
  return Math.max(0, (now - ts) / (24 * 3600 * 1000));
}

function isEpisodeMemory(item = {}) {
  return normalizeType(item.type) === 'episode' || getItemMemoryKind(item) === 'episode';
}

function getCoveredRollupLevels(item = {}) {
  const meta = item && typeof item.meta === 'object' ? item.meta : {};
  const values = normalizeStringArray([
    ...(Array.isArray(item.coveredByRollups) ? item.coveredByRollups : []),
    ...(Array.isArray(meta.coveredByRollups) ? meta.coveredByRollups : []),
    ...(Array.isArray(meta.covered_rollups) ? meta.covered_rollups : [])
  ], 6).map((value) => normalizeEpisodeRollupLevel(value)).filter(Boolean);
  return Array.from(new Set(values));
}

function archiveRolledUpEpisodes(library, now = nowTs()) {
  if (!config.MEMORY_DISTILLATION_ENABLED) return false;
  const items = Array.isArray(library?.items) ? library.items : [];
  const byUser = new Map();
  for (const item of items) {
    if (!item) continue;
    const userId = String(item.userId || '').trim();
    if (!userId) continue;
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push(item);
  }

  let changed = false;
  const fourDayArchiveAfter = Math.max(0, Number(config.MEMORY_EPISODE_ARCHIVE_AFTER_4DAY_DAYS) || 10);
  const monthlyArchiveAfter = Math.max(0, Number(config.MEMORY_EPISODE_ARCHIVE_AFTER_MONTHLY_DAYS) || 45);

  for (const userItems of byUser.values()) {
    const activeEpisodes = userItems.filter((item) => isEpisodeMemory(item) && normalizeStatus(item.status, STATUS_ACTIVE) === STATUS_ACTIVE);
    const activeFourDayCoveredKeys = new Set(
      activeEpisodes
        .filter((item) => item.rollupLevel === '4day')
        .flatMap((item) => normalizeStringArray([
          ...(Array.isArray(item.conflictKeys) ? item.conflictKeys : []),
          String(item.conflictKey || '').trim()
        ], 32))
        .filter(Boolean)
    );
    const activeMonthlyCoveredKeys = new Set(
      activeEpisodes
        .filter((item) => item.rollupLevel === 'monthly')
        .flatMap((item) => normalizeStringArray([
          ...(Array.isArray(item.conflictKeys) ? item.conflictKeys : []),
          String(item.conflictKey || '').trim()
        ], 64))
        .filter(Boolean)
    );

    for (const item of activeEpisodes) {
      if (item.rollupLevel !== 'daily') continue;
      const ageDays = getEpisodeArchiveAgeDays(item, now);
      const coveredRollups = getCoveredRollupLevels(item);
      const dailyConflictKey = String(item.conflictKey || '').trim();
      const coveredByFourDay = (dailyConflictKey && activeFourDayCoveredKeys.has(dailyConflictKey)) || coveredRollups.includes('4day');
      const coveredByMonthly = (dailyConflictKey && activeMonthlyCoveredKeys.has(dailyConflictKey)) || coveredRollups.includes('monthly');
      const shouldArchive = (coveredByFourDay && ageDays >= fourDayArchiveAfter)
        || (coveredByMonthly && ageDays >= monthlyArchiveAfter);
      if (!shouldArchive) continue;
      item.status = STATUS_ARCHIVED;
      item.updatedAt = now;
      item.meta = mergeMeta(item.meta, {
        archivedReason: coveredByMonthly ? 'covered_by_monthly_rollup' : 'covered_by_4day_rollup',
        archivedByRollupAt: now
      });
      changed = true;
    }

    for (const item of activeEpisodes) {
      if (item.rollupLevel !== '4day') continue;
      const ageDays = getEpisodeArchiveAgeDays(item, now);
      const coveredRollups = getCoveredRollupLevels(item);
      const fourDayConflictKey = String(item.conflictKey || '').trim();
      const coveredByMonthly = (fourDayConflictKey && activeMonthlyCoveredKeys.has(fourDayConflictKey)) || coveredRollups.includes('monthly');
      if (!coveredByMonthly || ageDays < monthlyArchiveAfter) continue;
      item.status = STATUS_ARCHIVED;
      item.updatedAt = now;
      item.meta = mergeMeta(item.meta, {
        archivedReason: 'covered_by_monthly_rollup',
        archivedByRollupAt: now
      });
      changed = true;
    }
  }

  return changed;
}

function buildDocTokens(item) {
  return tokenize([item.text, item.canonicalText, item.type].filter(Boolean).join(' '));
}

function rebuildMemoryIndex(existingLibrary = null) {
  ensureShardStateHydrated();
  if (existingLibrary && Array.isArray(existingLibrary.items)) {
    saveLibrary(existingLibrary);
  } else {
    for (const entry of listAllShardEntries()) {
      entry.index = materializeShardIndex(entry.items.items, entry.meta);
      getShardIndexStore(entry.meta).replace(entry.index);
      updateManifestForShard(entry);
    }
    syncCompatSnapshots();
  }
  return { ok: true, docs: Object.keys(loadIndex().docs || {}).length };
}

function ensureIndexFresh(library) {
  ensureShardStateHydrated();
  const expectedSize = Array.isArray(library?.items) ? library.items.length : loadLibrary().items.length;
  const index = loadIndex();
  if (
    index.version === INDEX_VERSION
    && Number(index.librarySize || 0) === expectedSize
    && (Number(index.totalDocs || 0) > 0 || expectedSize === 0)
  ) {
    return index;
  }
  rebuildMemoryIndex(library);
  return loadIndex();
}

function mergeMeta(a, b) {
  return {
    ...(a && typeof a === 'object' ? a : {}),
    ...(b && typeof b === 'object' ? b : {})
  };
}

function resolveShardMetasForRecall(userId = '', options = {}) {
  const uid = sanitizeOptionalText(userId);
  if (!uid) return [];
  const metas = [
    { category: 'personal', ownerId: uid },
    { category: 'journal', ownerId: uid },
    { category: 'style', ownerId: uid },
    { category: 'task', ownerId: uid }
  ];
  const groupIds = normalizeStringArray(options.groupIds || (options.groupId ? [options.groupId] : []), MAX_METADATA_LIST);
  for (const groupId of groupIds) {
    metas.push({ category: 'group', ownerId: groupId });
    metas.push({ category: 'group', ownerId: `group:${groupId}` });
    metas.push({ category: 'jargon', ownerId: groupId });
    metas.push({ category: 'jargon', ownerId: `group:${groupId}` });
  }
  if (uid.startsWith('group:')) {
    metas.push({ category: 'group', ownerId: uid });
    metas.push({ category: 'jargon', ownerId: uid });
  }
  return metas.map((meta) => normalizeShardMeta(meta));
}

function getMemoryItems(userId = null) {
  if (userId) {
    const items = getMemoryItemsFromShards(resolveShardMetasForRecall(userId, {}));
    return items.filter((item) => String(item.userId) === String(userId) || String(userId).startsWith('group:'));
  }
  const library = loadLibrary();
  if (pruneLibrary(library)) saveLibrary(library);
  return library.items.slice();
}

function getMemoryItemsByFilter(filters = {}) {
  const userId = sanitizeOptionalText(filters.userId);
  const status = filters.status ? normalizeStatus(filters.status, STATUS_ACTIVE) : '';
  const sourceKind = sanitizeOptionalText(filters.sourceKind).toLowerCase();
  const memoryKind = normalizeMemoryKind(filters.memoryKind);
  const scopeType = filters.scopeType ? normalizeScopeType(filters.scopeType) : '';
  const groupId = sanitizeOptionalText(filters.groupId);
  const rawLimit = Number(filters.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.max(1, Math.min(5000, rawLimit))
    : 0;
  const strictScope = filters.strictScope === true;
  const shardMetas = strictScope && (userId || groupId)
    ? [createShardMetaForItem({
        userId: userId || `group:${groupId}`,
        groupId,
        scopeType: scopeType || (groupId && !userId ? 'group' : 'personal'),
        memoryKind,
        sourceKind,
        type: filters.type
      })]
    : userId
      ? resolveShardMetasForRecall(userId, groupId ? { groupId } : {})
      : groupId
        ? resolveShardMetasForRecall(`group:${groupId}`, {})
        : [];
  const sourceItems = shardMetas.length > 0
    ? (filters.cache === false ? readMemoryItemsFromShards(shardMetas) : getMemoryItemsFromShards(shardMetas))
    : getMemoryItems(null);

  return sourceItems
    .filter((item) => (userId ? String(item.userId || '') === userId : true))
    .filter((item) => (status ? normalizeStatus(item.status, STATUS_ACTIVE) === status : true))
    .filter((item) => (sourceKind ? String(item.sourceKind || '').toLowerCase() === sourceKind : true))
    .filter((item) => (memoryKind ? getItemMemoryKind(item) === memoryKind : true))
    .filter((item) => (scopeType ? normalizeScopeType(item.scopeType) === scopeType : true))
    .filter((item) => (groupId ? String(item.groupId || '') === groupId : true))
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
    .slice(0, limit || undefined);
}

module.exports = {
  atomicWriteJson,
  safeReadJson,
  safeWriteJson,
  getCompatItemsStore,
  getCompatIndexStore,
  defaultShardManifest,
  getManifestStore,
  normalizeMemoryItem,
  defaultLibrary,
  encodeShardOwnerId,
  normalizeShardCategory,
  normalizeShardOwnerId,
  buildShardKey,
  buildShardPaths,
  defaultShardItemsPayload,
  defaultShardIndexPayload,
  normalizeShardMeta,
  resolveShardCategoryForItem,
  resolveShardOwnerIdForItem,
  createShardMetaForItem,
  getShardItemsStore,
  getShardIndexStore,
  listAllShardEntries,
  listManifestShardMetas,
  hydrateAllShardEntries,
  saveLibrary,
  migrateLegacyLibrary,
  loadLibrary,
  defaultIndex,
  materializeShardIndex,
  markAggregateDirty,
  updateManifestForShard,
  syncCompatSnapshots,
  ensureShardEntry,
  migrateLibraryItemsToShards,
  ensureShardStateHydrated,
  loadIndex,
  getShardEntriesForMetas,
  getMemoryItemsFromShards,
  readMemoryItemsFromShards,
  getMemoryDocsFromShards,
  saveIndex,
  isExpired,
  pruneLibrary,
  getEpisodeArchiveAgeDays,
  isEpisodeMemory,
  getCoveredRollupLevels,
  archiveRolledUpEpisodes,
  buildDocTokens,
  rebuildMemoryIndex,
  ensureIndexFresh,
  mergeMeta,
  resolveShardMetasForRecall,
  getMemoryItems,
  getMemoryItemsByFilter,
};
