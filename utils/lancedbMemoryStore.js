const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const {
  ensureDir,
  normalizeText,
  clampText,
  canonicalizeText,
  uniqueBy,
  stableSortByScore
} = require('./memory-v3/helpers');

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
  'model',
  'vector',
  'preview'
];
const LANCEDB_SELECT_COLUMNS = LANCEDB_ROW_COLUMNS.filter((column) => column !== 'vector').concat('_distance');

let lancedbModulePromise = null;
let connectionPromise = null;
let connectionDir = '';

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
  const allowedGroups = uniqueBy([
    ...(Array.isArray(input.allowedGroupIds) ? input.allowedGroupIds : []),
    ...(Array.isArray(input.groupIds) ? input.groupIds : []),
    currentGroup
  ].map(normalizeText).filter(Boolean), (item) => item);
  const sessionKey = normalizeText(input.sessionKey || input.sessionId);
  const clauses = ["status != 'archived'"];
  if (source !== 'all') {
    if (source === 'personal') {
      clauses.push("(source = 'personal' OR source = 'profile')");
    } else {
      clauses.push(`source = ${quoteSql(source)}`);
    }
  }
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
    allowedGroupIds: allowedGroups,
    sessionKey
  };
}

function rowPassesMemoryFilter(row = {}, filter = {}) {
  const status = normalizeText(row.status || 'active').toLowerCase();
  if (status === 'archived') return false;
  const source = normalizeSourceFilter(filter.source);
  const rowSource = normalizeText(row.source).toLowerCase();
  if (source !== 'all') {
    if (source === 'personal') {
      if (rowSource !== 'personal' && rowSource !== 'profile') return false;
    } else if (rowSource !== source) {
      return false;
    }
  }
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
      const contribution = 1 / (rrfK + index + 1);
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
      score: Number(entry.item.score || 0) + entry.rrfScore,
      rrfScore: entry.rrfScore,
      rrfSources: Array.from(entry.sources),
      localRank: entry.localRank,
      vectorRank: entry.vectorRank,
      matchMode: entry.sources.size > 1 ? 'hybrid_rrf' : entry.item.matchMode
    }))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.id || '').localeCompare(String(b.id || '')));
}

function withTimeout(promiseFactory, timeoutMs, fallbackFactory) {
  const budget = Math.max(0, Number(timeoutMs || config.MEMORY_LANCEDB_TIMEOUT_MS || 800) || 800);
  if (!budget) return Promise.resolve().then(promiseFactory);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(typeof fallbackFactory === 'function' ? fallbackFactory(new Error('timeout')) : fallbackFactory);
    }, budget);
    Promise.resolve()
      .then(promiseFactory)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(typeof fallbackFactory === 'function' ? fallbackFactory(error) : fallbackFactory);
      });
  });
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

async function loadLanceDbModule() {
  if (!lancedbModulePromise) {
    lancedbModulePromise = Promise.resolve()
      .then(() => require('@lancedb/lancedb'))
      .catch(async () => import('@lancedb/lancedb'));
  }
  return lancedbModulePromise;
}

async function openLanceDb(options = {}) {
  const dir = normalizeText(options.dir || config.MEMORY_LANCEDB_DIR) || path.join(config.DATA_DIR, 'lancedb');
  try {
    ensureDir(dir);
    if (!connectionPromise || connectionDir !== dir || options.fresh === true) {
      connectionDir = dir;
      connectionPromise = loadLanceDbModule().then((lancedb) => lancedb.connect(dir));
    }
    const db = await connectionPromise;
    return { ok: true, db, dir };
  } catch (error) {
    connectionPromise = null;
    return { ok: false, skipped: true, reason: `open_failed:${error.message}` };
  }
}

async function openTable(db, tableName = '') {
  const names = await db.tableNames();
  if (!names.includes(tableName)) return null;
  return db.openTable(tableName);
}

async function createVectorIndex(table, rowCount = 0) {
  if (!table || typeof table.createIndex !== 'function' || rowCount < 256) return false;
  try {
    const lancedb = await loadLanceDbModule();
    const indexConfig = lancedb.Index && typeof lancedb.Index.ivfFlat === 'function'
      ? { config: lancedb.Index.ivfFlat({ distanceType: 'cosine' }), replace: true, waitTimeoutSeconds: 60 }
      : { replace: true, waitTimeoutSeconds: 60 };
    await table.createIndex('vector', indexConfig);
    return true;
  } catch (_) {
    return false;
  }
}

async function replaceTableRows(tableName = '', rows = [], options = {}) {
  const cleanRows = dedupeVectorRows(rows);
  if (options.dryRun === true) {
    const tableStats = await listTableIds(tableName, options);
    const staleIds = diffStaleTableIds(tableStats.ids || [], cleanRows);
    return {
      ok: true,
      dryRun: true,
      table: tableName,
      rows: cleanRows.length,
      mode: 'overwrite',
      staleRows: staleIds.length,
      staleIdsSample: staleIds.slice(0, 20),
      tableRowsBefore: Number(tableStats.rows || 0) || 0
    };
  }
  if (cleanRows.length === 0) {
    return { ok: false, skipped: true, reason: 'no_rows', rows: 0 };
  }
  const openResult = await openLanceDb(options);
  if (!openResult.ok) return openResult;
  try {
    const table = await openResult.db.createTable(tableName, cleanRows, { mode: 'overwrite' });
    if (options.createIndex !== false) {
      await createVectorIndex(table, cleanRows.length);
    }
    return { ok: true, table: tableName, rows: cleanRows.length, mode: 'overwrite' };
  } catch (error) {
    return { ok: false, skipped: true, reason: `replace_failed:${error.message}`, rows: cleanRows.length };
  }
}

async function upsertTableRows(tableName = '', rows = [], options = {}) {
  const cleanRows = dedupeVectorRows(rows);
  if (options.dryRun === true) {
    const tableStats = await listTableIds(tableName, options);
    const staleIds = options.fullReconcile || options.deleteStaleRows
      ? diffStaleTableIds(tableStats.ids || [], cleanRows)
      : [];
    return {
      ok: true,
      dryRun: true,
      table: tableName,
      rows: cleanRows.length,
      mode: options.fullReconcile ? 'merge_reconcile' : 'upsert',
      staleRows: staleIds.length,
      staleIdsSample: staleIds.slice(0, 20),
      tableRowsBefore: Number(tableStats.rows || 0) || 0
    };
  }
  if (cleanRows.length === 0) {
    return { ok: false, skipped: true, reason: 'no_rows', rows: 0 };
  }
  const openResult = await openLanceDb(options);
  if (!openResult.ok) return openResult;
  try {
    let table = await openTable(openResult.db, tableName);
    if (!table) {
      table = await openResult.db.createTable(tableName, cleanRows, { mode: 'create', existOk: true });
      return { ok: true, table: tableName, rows: cleanRows.length, mode: 'create' };
    }
    let mode = 'append';
    if (typeof table.mergeInsert === 'function') {
      await table
        .mergeInsert('id')
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(cleanRows, { timeoutMs: Math.max(1000, Number(options.timeoutMs || config.MEMORY_LANCEDB_TIMEOUT_MS || 800) || 800) });
      mode = options.fullReconcile || options.deleteStaleRows ? 'merge_reconcile' : 'merge_insert';
    } else {
      await table.add(cleanRows);
      mode = options.fullReconcile || options.deleteStaleRows ? 'append_reconcile' : 'append';
    }
    let staleDelete = { deleted: 0, skipped: true, reason: 'not_requested' };
    if (options.fullReconcile || options.deleteStaleRows) {
      staleDelete = await deleteStaleTableRows(table, tableName, cleanRows, options);
    }
    return { ok: true, table: tableName, rows: cleanRows.length, mode, staleDelete };
  } catch (error) {
    return { ok: false, skipped: true, reason: `upsert_failed:${error.message}`, rows: cleanRows.length };
  }
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

async function deleteStaleTableRows(table, tableName = '', desiredRows = [], options = {}) {
  if (!table || typeof table.delete !== 'function') {
    return { deleted: 0, skipped: true, reason: 'delete_unavailable' };
  }
  const tableStats = await listTableIds(tableName, options);
  const staleIds = diffStaleTableIds(tableStats.ids || [], desiredRows);
  if (staleIds.length === 0) return { deleted: 0, skipped: false, reason: '' };
  const chunkSize = Math.max(1, Math.min(200, Number(options.deleteChunkSize || 100) || 100));
  let deleted = 0;
  for (const chunk of chunkList(staleIds, chunkSize)) {
    const predicate = `id IN (${chunk.map(quoteSql).join(', ')})`;
    await table.delete(predicate);
    deleted += chunk.length;
  }
  return {
    deleted,
    skipped: false,
    reason: '',
    staleIdsSample: staleIds.slice(0, 20)
  };
}

async function syncMemoryRows(rows = [], options = {}) {
  if (!isLanceDbSyncEnabled(options.config || config)) {
    return { ok: false, skipped: true, reason: 'sync_disabled', rows: 0 };
  }
  const tableName = normalizeText(options.tableName || config.MEMORY_LANCEDB_MEMORY_TABLE || 'memory_v3_vectors');
  return options.full
    ? replaceTableRows(tableName, rows, options)
    : upsertTableRows(tableName, rows, options);
}

async function syncWorldbookRows(rows = [], options = {}) {
  if (!isLanceDbSyncEnabled(options.config || config)) {
    return { ok: false, skipped: true, reason: 'sync_disabled', rows: 0 };
  }
  const tableName = normalizeText(options.tableName || config.MEMORY_LANCEDB_WORLDBOOK_TABLE || 'persona_worldbook_vectors');
  return options.full
    ? replaceTableRows(tableName, rows, options)
    : upsertTableRows(tableName, rows, options);
}

function safeSearchFailure(reason = 'unavailable') {
  return { ok: false, skipped: true, reason, results: [], rows: [] };
}

async function countTableRows(tableName = '', options = {}) {
  const normalizedTable = normalizeText(tableName);
  if (!normalizedTable) return { ok: false, skipped: true, reason: 'empty_table', rows: 0 };
  const openResult = await openLanceDb(options);
  if (!openResult.ok) return { ...openResult, rows: 0 };
  try {
    const table = await openTable(openResult.db, normalizedTable);
    if (!table) return { ok: false, skipped: true, reason: 'table_missing', rows: 0 };
    if (typeof table.countRows === 'function') {
      const rows = await table.countRows();
      return { ok: true, table: normalizedTable, rows: Number(rows || 0) || 0 };
    }
    const rows = await table.query().select(['id']).limit(1000000).toArray();
    return { ok: true, table: normalizedTable, rows: Array.isArray(rows) ? rows.length : 0 };
  } catch (error) {
    return { ok: false, skipped: true, table: normalizedTable, reason: `count_failed:${error.message}`, rows: 0 };
  }
}

async function listTableIds(tableName = '', options = {}) {
  const normalizedTable = normalizeText(tableName);
  if (!normalizedTable) return { ok: false, skipped: true, reason: 'empty_table', rows: 0, ids: [] };
  const openResult = await openLanceDb(options);
  if (!openResult.ok) return { ...openResult, rows: 0, ids: [] };
  try {
    const table = await openTable(openResult.db, normalizedTable);
    if (!table) return { ok: false, skipped: true, reason: 'table_missing', rows: 0, ids: [] };
    const maxIds = Math.max(1, Math.floor(Number(options.maxIds || 1000000) || 1000000));
    const idRows = await table.query().select(['id']).limit(maxIds).toArray();
    const ids = (Array.isArray(idRows) ? idRows : [])
      .map((row) => normalizeText(row.id))
      .filter(Boolean);
    const rowCount = typeof table.countRows === 'function'
      ? Number(await table.countRows() || 0) || ids.length
      : ids.length;
    return {
      ok: true,
      table: normalizedTable,
      rows: rowCount,
      ids,
      truncated: ids.length < rowCount
    };
  } catch (error) {
    return { ok: false, skipped: true, table: normalizedTable, reason: `list_ids_failed:${error.message}`, rows: 0, ids: [] };
  }
}

async function searchTableVectors(tableName = '', queryEmbedding = [], filterSql = '', options = {}) {
  const vector = normalizeVector(queryEmbedding);
  if (vector.length === 0) return safeSearchFailure('empty_query_embedding');
  const openResult = await openLanceDb(options);
  if (!openResult.ok) return { ...safeSearchFailure(openResult.reason), ...openResult };
  try {
    const table = await openTable(openResult.db, tableName);
    if (!table) return safeSearchFailure('table_missing');
    const limit = Math.max(1, Math.floor(Number(options.limit || config.MEMORY_LANCEDB_CANDIDATE_LIMIT || 32) || 32));
    let query = table
      .vectorSearch(vector)
      .distanceType('cosine')
      .select(LANCEDB_SELECT_COLUMNS)
      .limit(limit);
    if (filterSql) query = query.where(filterSql);
    const rows = await query.toArray();
    return { ok: true, rows: Array.isArray(rows) ? rows : [], results: Array.isArray(rows) ? rows : [], reason: '' };
  } catch (error) {
    return safeSearchFailure(`search_failed:${error.message}`);
  }
}

async function searchMemoryVectors(queryEmbedding = [], context = {}, options = {}) {
  if (!isLanceDbReadEnabled(options.config || config)) {
    return safeSearchFailure('read_disabled');
  }
  const filter = buildMemoryFilter(context);
  const tableName = normalizeText(options.tableName || config.MEMORY_LANCEDB_MEMORY_TABLE || 'memory_v3_vectors');
  return withTimeout(
    () => searchTableVectors(tableName, queryEmbedding, filter.sql, options),
    options.timeoutMs || config.MEMORY_LANCEDB_TIMEOUT_MS,
    (error) => safeSearchFailure(error && error.message === 'timeout' ? 'timeout' : `failed:${error.message}`)
  ).then((result) => ({
    ...result,
    filter
  }));
}

async function searchWorldbookVectors(queryEmbedding = [], context = {}, options = {}) {
  if (!isLanceDbReadEnabled(options.config || config)) {
    return safeSearchFailure('read_disabled');
  }
  const tableName = normalizeText(options.tableName || config.MEMORY_LANCEDB_WORLDBOOK_TABLE || 'persona_worldbook_vectors');
  return withTimeout(
    () => searchTableVectors(tableName, queryEmbedding, "status != 'archived'", options),
    options.timeoutMs || config.MEMORY_LANCEDB_TIMEOUT_MS,
    (error) => safeSearchFailure(error && error.message === 'timeout' ? 'timeout' : `failed:${error.message}`)
  );
}

async function compactLanceDbTables(options = {}) {
  const openResult = await openLanceDb(options);
  if (!openResult.ok) return openResult;
  const targets = [
    normalizeText(options.memoryTable || config.MEMORY_LANCEDB_MEMORY_TABLE || 'memory_v3_vectors'),
    normalizeText(options.worldbookTable || config.MEMORY_LANCEDB_WORLDBOOK_TABLE || 'persona_worldbook_vectors')
  ].filter(Boolean);
  const results = [];
  for (const tableName of targets) {
    try {
      const table = await openTable(openResult.db, tableName);
      if (!table || typeof table.optimize !== 'function') {
        results.push({ table: tableName, ok: false, skipped: true, reason: 'table_missing' });
        continue;
      }
      const stats = await table.optimize();
      results.push({ table: tableName, ok: true, stats });
    } catch (error) {
      results.push({ table: tableName, ok: false, skipped: true, reason: error.message });
    }
  }
  return { ok: true, results };
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
  buildMemoryFilter,
  buildMemoryVectorRow,
  buildWorldbookVectorRow,
  compactLanceDbTables,
  countTableRows,
  dedupeVectorRows,
  deleteStaleTableRows,
  diffStaleTableIds,
  fuseRecallCandidates,
  isLanceDbReadEnabled,
  isLanceDbSyncEnabled,
  lancedbDistanceToScore,
  listTableIds,
  normalizeVectorStoreMode,
  openLanceDb,
  resolveVectorCandidates,
  rowPassesMemoryFilter,
  searchMemoryVectors,
  searchWorldbookVectors,
  syncMemoryRows,
  syncWorldbookRows
};
