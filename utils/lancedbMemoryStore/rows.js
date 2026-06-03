const crypto = require('crypto');
const config = require('../../config');
const {
  normalizeText,
  clampText,
  canonicalizeText,
  stableSortByScore
} = require('../memory-v3/helpers');
const { deriveMemoryMetadata } = require('../memory-v3/categoryMetadata');
const { lifecycleStatusOf } = require('../memory-v3/recallFilter');
const { isBadRoleplayRefusalText } = require('../recallPollutionGuard');

const VECTOR_STORE_MODES = new Set(['local_jsonl', 'lancedb', 'shadow']);
const LANCEDB_ROW_COLUMNS = [
  'id',
  'nodeId',
  'userId',
  'source',
  'scopeType',
  'groupId',
  'sessionKey',
  'fieldKey',
  'type',
  'status',
  'evidenceTier',
  'updatedAt',
  'canonicalKey',
  'textHash',
  'category',
  'tagsText',
  'intent',
  'privacyLevel',
  'model',
  'vector',
  'preview'
];
const LANCEDB_SELECT_COLUMNS = LANCEDB_ROW_COLUMNS.filter((column) => column !== 'vector').concat('_distance');

function normalizeVectorStoreMode(value) {
  const mode = normalizeText(value || config.MEMORY_VECTOR_STORE || 'local_jsonl').toLowerCase();
  return VECTOR_STORE_MODES.has(mode) ? mode : 'local_jsonl';
}

function isLanceDbReadEnabled(configLike = config) {
  const mode = normalizeVectorStoreMode(configLike.MEMORY_VECTOR_STORE);
  return (mode === 'lancedb' || mode === 'shadow') && configLike.MEMORY_LANCEDB_READ_ENABLED === true;
}

function isLanceDbSyncEnabled(configLike = config) {
  return configLike.MEMORY_LANCEDB_SYNC_ENABLED !== false;
}

function sha1(value = '') {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeVector(vector) {
  if (!Array.isArray(vector)) return [];
  return vector.map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

function buildTextHash(text = '', fallback = '') {
  const normalized = normalizeText(text || fallback);
  return normalized ? sha1(normalized) : normalizeText(fallback);
}

function buildRowId(prefix = 'memory', id = '') {
  return `${prefix}:${normalizeText(id)}`;
}

function deriveMemorySource(node = {}) {
  const source = normalizeText(node.source).toLowerCase();
  if (['recent', 'profile', 'personal', 'group', 'task', 'style', 'jargon', 'journal'].includes(source)) return source;
  const scopeType = normalizeText(node.scopeType).toLowerCase();
  if (scopeType === 'task') return 'task';
  if (scopeType === 'group') return normalizeText(node.memoryKind).toLowerCase() === 'jargon' ? 'jargon' : 'group';
  const type = normalizeText(node.type || node.memoryKind).toLowerCase();
  if (source === 'journal' || type === 'episode' || type === 'daily_journal' || type === 'daily_journal_segment') return 'journal';
  if (normalizeText(node.memoryKind).toLowerCase() === 'style') return 'style';
  return 'personal';
}

function buildMemoryVectorRow(node = {}, embeddingRow = {}, options = {}) {
  const vector = normalizeVector(embeddingRow.embedding || embeddingRow.vector);
  const nodeId = normalizeText(node.id || node.nodeId || embeddingRow.nodeId || embeddingRow.id);
  if (!nodeId || vector.length === 0) return null;
  const text = normalizeText(node.text);
  const canonicalKey = normalizeText(node.canonicalKey || embeddingRow.canonicalKey || canonicalizeText(text)).toLowerCase();
  const model = normalizeText(embeddingRow.model || options.model || config.MEMORY_EMBEDDING_MODEL);
  const textHash = normalizeText(embeddingRow.textHash) || buildTextHash(text, canonicalKey);
  const metadata = deriveMemoryMetadata(node);
  return {
    id: buildRowId('memory', nodeId),
    nodeId,
    userId: normalizeText(node.userId),
    source: deriveMemorySource(node),
    scopeType: normalizeText(node.scopeType || 'personal').toLowerCase(),
    groupId: normalizeText(node.groupId),
    sessionKey: normalizeText(node.sessionKey || node.sessionId),
    fieldKey: normalizeText(node.fieldKey || node.semanticSlot || node.memoryKind),
    type: normalizeText(node.type || node.memoryKind),
    status: normalizeText(node.status || 'active').toLowerCase(),
    evidenceTier: normalizeText(node.evidenceTier),
    updatedAt: Number(node.updatedAt || node.createdAt || embeddingRow.updatedAt || 0) || 0,
    canonicalKey,
    textHash,
    category: metadata.category,
    tagsText: metadata.tagsText,
    intent: metadata.intent,
    privacyLevel: metadata.privacyLevel,
    model,
    vector,
    preview: clampText(text, Number(options.previewChars || 160) || 160)
  };
}

function buildWorldbookVectorRow(doc = {}, embeddingRow = {}, options = {}) {
  const vector = normalizeVector(embeddingRow.embedding || embeddingRow.vector);
  const moduleId = normalizeText(doc.moduleId || doc.id || embeddingRow.moduleId || embeddingRow.id);
  if (!moduleId || vector.length === 0) return null;
  const text = normalizeText(doc.text || doc.purpose);
  const model = normalizeText(embeddingRow.model || options.model || config.MEMORY_EMBEDDING_MODEL);
  const textHash = normalizeText(embeddingRow.textHash) || buildTextHash(text, moduleId);
  const metadata = deriveMemoryMetadata({
    ...doc,
    source: 'persona_worldbook',
    type: 'worldbook',
    category: doc.category || 'persona_worldbook',
    tags: [doc.slot, doc.phase, doc.moduleId].filter(Boolean),
    intent: 'persona_worldbook_recall',
    privacyLevel: 'private'
  });
  return {
    id: buildRowId('worldbook', moduleId),
    nodeId: moduleId,
    userId: '',
    source: 'persona_worldbook',
    scopeType: 'global',
    groupId: '',
    sessionKey: '',
    fieldKey: normalizeText(doc.slot || doc.phase),
    type: 'worldbook',
    status: 'active',
    evidenceTier: 'strict',
    updatedAt: Number(doc.fileMtimeMs || embeddingRow.updatedAt || embeddingRow.lastEmbeddedAt || 0) || 0,
    canonicalKey: normalizeText(doc.moduleId || doc.id || moduleId).toLowerCase(),
    textHash,
    category: metadata.category,
    tagsText: metadata.tagsText,
    intent: metadata.intent,
    privacyLevel: metadata.privacyLevel,
    model,
    vector,
    preview: clampText([doc.purpose, text].filter(Boolean).join('\n'), Number(options.previewChars || 160) || 160)
  };
}

function quoteSql(value = '') {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function normalizeSourceFilter(source = 'all') {
  const wanted = normalizeText(source).toLowerCase();
  return wanted || 'all';
}

function buildMemoryFilter(input = {}) {
  const userId = normalizeText(input.userId);
  const source = normalizeSourceFilter(input.source);
  const currentGroup = normalizeText(input.groupId);
  const allowedGroups = Array.from(new Set([
    ...(Array.isArray(input.allowedGroupIds) ? input.allowedGroupIds : []),
    ...(Array.isArray(input.groupIds) ? input.groupIds : []),
    currentGroup
  ].map(normalizeText).filter(Boolean))).sort();
  const sessionKey = normalizeText(input.sessionKey || input.sessionId);
  const clauses = ["status != 'archived'"];
  if (source !== 'all') {
    if (source === 'personal') {
      clauses.push("(source = 'personal' OR source = 'profile')");
    } else {
      clauses.push(`source = ${quoteSql(source)}`);
    }
  }
  const category = normalizeText(input.category || input.memoryCategory).toLowerCase();
  if (category) clauses.push(`category = ${quoteSql(category)}`);
  const intent = normalizeText(input.intentFilter || input.memoryIntent).toLowerCase();
  if (intent) clauses.push(`intent = ${quoteSql(intent)}`);
  const privacyLevel = normalizeText(input.privacyLevel || input.memoryPrivacyLevel).toLowerCase();
  if (privacyLevel) clauses.push(`privacyLevel = ${quoteSql(privacyLevel)}`);
  const visibility = [];
  if (userId) visibility.push(`(scopeType != 'group' AND userId = ${quoteSql(userId)})`);
  if (allowedGroups.length > 0) {
    visibility.push(`(scopeType = 'group' AND groupId IN (${allowedGroups.map(quoteSql).join(', ')}))`);
  }
  if (sessionKey) {
    visibility.push(`(scopeType = 'session' AND userId = ${quoteSql(userId)} AND sessionKey = ${quoteSql(sessionKey)})`);
  }
  if (visibility.length > 0) clauses.push(`(${visibility.join(' OR ')})`);
  if (visibility.length === 0) clauses.push('1 = 0');
  return {
    sql: clauses.join(' AND '),
    userId,
    source,
    category,
    intentFilter: intent,
    privacyLevel,
    allowedGroupIds: allowedGroups,
    sessionKey
  };
}

function rowPassesMemoryFilter(row = {}, filter = {}) {
  const status = normalizeText(row.status || 'active').toLowerCase();
  if (status === 'archived') return false;
  if (isBadRoleplayRefusalText(row.preview || row.text || row.canonicalKey, { allowBenignContext: true })) return false;
  const lifecycleStatus = lifecycleStatusOf(row);
  if (lifecycleStatus === 'stale' || lifecycleStatus === 'suspect' || lifecycleStatus === 'superseded') return false;
  const source = normalizeSourceFilter(filter.source);
  const rowSource = normalizeText(row.source).toLowerCase();
  if (source !== 'all') {
    if (source === 'personal') {
      if (rowSource !== 'personal' && rowSource !== 'profile') return false;
    } else if (rowSource !== source) {
      return false;
    }
  }
  const category = normalizeText(filter.category || filter.memoryCategory).toLowerCase();
  if (category && normalizeText(row.category).toLowerCase() !== category) return false;
  const intent = normalizeText(filter.intentFilter || filter.memoryIntent).toLowerCase();
  if (intent && normalizeText(row.intent).toLowerCase() !== intent) return false;
  const privacyLevel = normalizeText(filter.privacyLevel || filter.memoryPrivacyLevel).toLowerCase();
  if (privacyLevel && normalizeText(row.privacyLevel).toLowerCase() !== privacyLevel) return false;
  const scopeType = normalizeText(row.scopeType || 'personal').toLowerCase();
  if (scopeType === 'group') {
    const allowed = Array.isArray(filter.allowedGroupIds) ? filter.allowedGroupIds.map(normalizeText) : [];
    return Boolean(normalizeText(row.groupId) && allowed.includes(normalizeText(row.groupId)));
  }
  if (scopeType === 'session') {
    return normalizeText(row.userId) === normalizeText(filter.userId)
      && (!filter.sessionKey || normalizeText(row.sessionKey) === normalizeText(filter.sessionKey));
  }
  return normalizeText(row.userId) === normalizeText(filter.userId);
}

function lancedbDistanceToScore(row = {}) {
  const distance = Number(row._distance);
  if (!Number.isFinite(distance)) return Number(row.score || 0) || 0;
  return 1 / (1 + Math.max(0, distance));
}

function normalizeVectorCandidate(row = {}, localById = new Map()) {
  const nodeId = normalizeText(row.nodeId || row.id);
  if (!nodeId) return null;
  const local = localById.get(nodeId);
  if (!local) return null;
  const score = lancedbDistanceToScore(row);
  return {
    ...local,
    score: Math.max(Number(local.score || 0) || 0, 0.02 + (score * Math.max(0.1, Number(config.MEMORY_SEMANTIC_RECALL_WEIGHT || 0.3) || 0.3))),
    embedding: Math.max(Number(local.embedding || 0) || 0, score),
    vectorScore: score,
    matchMode: local.matchMode && local.matchMode !== 'lexical' ? local.matchMode : 'lancedb',
    scoreParts: {
      ...(local.scoreParts || {}),
      lancedb: score
    }
  };
}

function candidateKey(item = {}) {
  return normalizeText(item.id || item.nodeId)
    || normalizeText(`${item.scopeType || ''}|${item.userId || ''}|${item.groupId || ''}|${item.canonicalKey || canonicalizeText(item.text)}`);
}

function fuseRecallCandidates(localCandidates = [], vectorCandidates = [], options = {}) {
  const rrfK = Math.max(1, Number(options.rrfK || config.MEMORY_V3_RRF_K || 50) || 50);
  const localWeight = Math.max(0, Number(options.localWeight || config.MEMORY_LANCEDB_RRF_LOCAL_WEIGHT || 1) || 1);
  const vectorWeight = Math.max(0, Number(options.vectorWeight || config.MEMORY_LANCEDB_RRF_VECTOR_WEIGHT || 1.18) || 1.18);
  const strongVectorThreshold = Math.max(0, Math.min(1, Number(options.strongVectorThreshold || config.MEMORY_LANCEDB_STRONG_VECTOR_THRESHOLD || 0.72) || 0.72));
  const strongVectorBoost = Math.max(0, Number(options.strongVectorBoost || config.MEMORY_LANCEDB_STRONG_VECTOR_BOOST || 0.08) || 0.08);
  const local = stableSortByScore(localCandidates);
  const vector = stableSortByScore(vectorCandidates);
  const slots = new Map();

  function addGroup(items, groupName) {
    items.forEach((item, index) => {
      const key = candidateKey(item);
      if (!key) return;
      const current = slots.get(key) || {
        item,
        rrfScore: 0,
        localRank: null,
        vectorRank: null,
        sources: new Set()
      };
      const contribution = (groupName === 'lancedb' ? vectorWeight : localWeight) / (rrfK + index + 1);
      current.rrfScore += contribution;
      current.sources.add(groupName);
      current.item = Number(item.score || 0) > Number(current.item.score || 0)
        ? { ...current.item, ...item }
        : { ...item, ...current.item };
      if (groupName === 'local') current.localRank = current.localRank ?? (index + 1);
      if (groupName === 'lancedb') current.vectorRank = current.vectorRank ?? (index + 1);
      slots.set(key, current);
    });
  }

  addGroup(local, 'local');
  addGroup(vector, 'lancedb');

  return Array.from(slots.values())
    .map((entry) => ({
      ...entry.item,
      score: Number(entry.item.score || 0)
        + entry.rrfScore
        + (Number(entry.item.vectorScore || entry.item.embedding || 0) >= strongVectorThreshold ? strongVectorBoost : 0),
      rrfScore: entry.rrfScore,
      rrfSources: Array.from(entry.sources),
      localRank: entry.localRank,
      vectorRank: entry.vectorRank,
      matchMode: entry.sources.size > 1 ? 'hybrid_rrf' : entry.item.matchMode
    }))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.id || '').localeCompare(String(b.id || '')));
}

function dedupeVectorRows(rows = []) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = normalizeText(row?.id);
    if (!id || !Array.isArray(row.vector) || row.vector.length === 0) continue;
    const existing = byId.get(id);
    if (!existing || Number(row.updatedAt || 0) >= Number(existing.updatedAt || 0)) {
      byId.set(id, row);
    }
  }
  return Array.from(byId.values());
}

function diffStaleTableIds(tableIds = [], desiredRows = []) {
  const desired = new Set((Array.isArray(desiredRows) ? desiredRows : [])
    .map((row) => normalizeText(row?.id))
    .filter(Boolean));
  return (Array.isArray(tableIds) ? tableIds : [])
    .map(normalizeText)
    .filter(Boolean)
    .filter((id) => !desired.has(id));
}

function chunkList(values = [], size = 100) {
  const chunkSize = Math.max(1, Math.floor(Number(size) || 100));
  const out = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    out.push(values.slice(index, index + chunkSize));
  }
  return out;
}

function resolveVectorCandidates(rows = [], localCandidates = [], context = {}) {
  const filter = context.filter || buildMemoryFilter(context);
  const localById = new Map((Array.isArray(localCandidates) ? localCandidates : [])
    .map((item) => [normalizeText(item.id || item.nodeId), item])
    .filter(([key]) => key));
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => rowPassesMemoryFilter(row, filter))
    .map((row) => normalizeVectorCandidate(row, localById))
    .filter(Boolean);
}

module.exports = {
  LANCEDB_ROW_COLUMNS,
  LANCEDB_SELECT_COLUMNS,
  buildMemoryFilter,
  buildMemoryVectorRow,
  buildWorldbookVectorRow,
  chunkList,
  dedupeVectorRows,
  diffStaleTableIds,
  fuseRecallCandidates,
  isLanceDbReadEnabled,
  isLanceDbSyncEnabled,
  lancedbDistanceToScore,
  normalizeVector,
  normalizeVectorStoreMode,
  quoteSql,
  resolveVectorCandidates,
  rowPassesMemoryFilter
};
