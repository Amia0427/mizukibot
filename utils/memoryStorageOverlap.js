const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const {
  canonicalizeText,
  normalizeText
} = require('./memory-v3/helpers');
const { isMemoryNotRecallable, lifecycleStatusOf } = require('./memory-v3/recallFilter');

const SCHEMA_VERSION = 'memory_storage_overlap_v1';
const DEFAULT_SAMPLE_LIMIT = 10;
const SOURCE_ONLY_KIND = 'source_only';

function sha1(value = '') {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeId(value = '') {
  return normalizeText(value);
}

function normalizeStatus(value = '', fallback = 'active') {
  return normalizeText(value || fallback).toLowerCase() || fallback;
}

function normalizeCanonicalKey(value = '') {
  return normalizeText(value).toLowerCase();
}

function buildMemoryRowId(nodeId = '') {
  const id = normalizeId(nodeId);
  return id ? `memory:${id}` : '';
}

function sampleList(values = [], limit = DEFAULT_SAMPLE_LIMIT) {
  const max = Math.max(0, Math.floor(Number(limit || DEFAULT_SAMPLE_LIMIT) || DEFAULT_SAMPLE_LIMIT));
  return (Array.isArray(values) ? values : []).slice(0, max);
}

function hashMaybe(value = '') {
  const text = normalizeText(value);
  return text ? sha1(text).slice(0, 16) : '';
}

function safeSampleRow(row = {}) {
  const id = normalizeId(row.id);
  const nodeId = normalizeId(row.nodeId || String(id).replace(/^memory:/, ''));
  const canonicalKey = normalizeCanonicalKey(row.canonicalKey);
  const textHash = normalizeText(row.textHash);
  const preview = normalizeText(row.preview || row.text || row.value);
  return {
    id,
    nodeId,
    source: normalizeText(row.source).toLowerCase(),
    scopeType: normalizeText(row.scopeType).toLowerCase(),
    userId: normalizeText(row.userId),
    groupId: normalizeText(row.groupId),
    fieldKey: normalizeText(row.fieldKey || row.semanticSlot),
    type: normalizeText(row.type || row.memoryKind).toLowerCase(),
    status: normalizeStatus(row.status),
    rollupLevel: normalizeText(row.rollupLevel).toLowerCase(),
    canonicalKeyHash: hashMaybe(canonicalKey),
    textHash: textHash || hashMaybe(preview),
    table: normalizeText(row.table)
  };
}

function countBy(values = [], selector = (item) => item) {
  const counts = {};
  for (const item of Array.isArray(values) ? values : []) {
    const key = normalizeText(selector(item)) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function isInactiveVectorRow(row = {}) {
  const status = normalizeStatus(row.status);
  if (['archived', 'stale', 'suspect', 'superseded', 'rejected', 'unsafe', 'not_recallable'].includes(status)) return true;
  const lifecycleStatus = lifecycleStatusOf(row);
  return ['stale', 'suspect', 'superseded'].includes(lifecycleStatus);
}

function isRawJournalVectorLike(row = {}) {
  const id = normalizeId(row.id).toLowerCase();
  const nodeId = normalizeId(row.nodeId || String(id).replace(/^memory:/, '')).toLowerCase();
  const source = normalizeText(row.source).toLowerCase();
  const sourceKind = normalizeText(row.sourceKind).toLowerCase();
  const type = normalizeText(row.type || row.memoryKind).toLowerCase();
  const fieldKey = normalizeText(row.fieldKey || row.semanticSlot).toLowerCase();
  const textKind = normalizeText(row.textKind).toLowerCase();
  const rawSignals = [id, nodeId, sourceKind, type, fieldKey, textKind];
  if (rawSignals.some((value) => /(^|[:_\-])journal[-_]entry($|[:_\-])/.test(value))) return true;
  if (rawSignals.some((value) => /(^|[:_\-])raw[-_]journal($|[:_\-])/.test(value))) return true;
  if (rawSignals.some((value) => /(^|[:_\-])journal[-_]raw($|[:_\-])/.test(value))) return true;
  if (source === 'journal' && ['turn', 'raw_turn', 'journal_turn', 'turn_received', 'turn_replied'].includes(type)) return true;
  if (source === 'journal' && ['turn', 'raw_turn', 'journal_entry'].includes(fieldKey)) return true;
  return false;
}

function isExpectedHotNode(node = {}) {
  const status = normalizeStatus(node.status);
  if (status === 'archived') return false;
  if (isMemoryNotRecallable(node)) return false;
  const lifecycleStatus = lifecycleStatusOf(node);
  if (['stale', 'suspect', 'superseded'].includes(lifecycleStatus)) return false;
  if (isRawJournalVectorLike(node)) return false;
  return true;
}

function normalizeVectorRows(input = {}) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.vectorRows) && input.vectorRows.length > 0) return input.vectorRows;
  if (Array.isArray(input.rows)) return input.rows;
  if (Array.isArray(input.ids)) return input.ids.map((id) => ({ id }));
  return [];
}

function buildExpectedIndexCopies({ embeddingRows = [], embeddingNodes = [] } = {}) {
  const hotNodesById = new Map();
  for (const node of Array.isArray(embeddingNodes) ? embeddingNodes : []) {
    const nodeId = normalizeId(node.id || node.nodeId);
    if (!nodeId || !isExpectedHotNode(node)) continue;
    hotNodesById.set(nodeId, node);
  }

  const expectedById = new Map();
  for (const embeddingRow of Array.isArray(embeddingRows) ? embeddingRows : []) {
    const nodeId = normalizeId(embeddingRow.nodeId || embeddingRow.id);
    const node = hotNodesById.get(nodeId);
    if (!node) continue;
    const rowId = buildMemoryRowId(nodeId);
    if (!rowId) continue;
    const expected = {
      id: rowId,
      nodeId,
      source: normalizeText(node.source).toLowerCase(),
      scopeType: normalizeText(node.scopeType || 'personal').toLowerCase(),
      userId: normalizeText(node.userId || node.ownerUserId),
      groupId: normalizeText(node.groupId),
      fieldKey: normalizeText(node.fieldKey || node.semanticSlot || node.memoryKind),
      type: normalizeText(node.type || node.memoryKind).toLowerCase(),
      status: normalizeStatus(node.status),
      rollupLevel: normalizeText(node.rollupLevel).toLowerCase(),
      canonicalKey: normalizeCanonicalKey(embeddingRow.canonicalKey || node.canonicalKey || canonicalizeText(node.text)),
      textHash: normalizeText(embeddingRow.textHash),
      updatedAt: Number(node.updatedAt || node.createdAt || embeddingRow.updatedAt || 0) || 0
    };
    const existing = expectedById.get(rowId);
    if (!existing || Number(expected.updatedAt || 0) >= Number(existing.updatedAt || 0)) {
      expectedById.set(rowId, expected);
    }
  }
  return Array.from(expectedById.values());
}

function vectorDuplicateSlot(row = {}) {
  const status = normalizeStatus(row.status);
  if (status !== 'active') return '';
  const canonicalKey = normalizeCanonicalKey(row.canonicalKey);
  const textHash = normalizeText(row.textHash);
  if (!canonicalKey && !textHash) return '';
  return [
    normalizeText(row.source).toLowerCase(),
    normalizeText(row.scopeType).toLowerCase(),
    normalizeText(row.userId),
    normalizeText(row.groupId),
    normalizeText(row.fieldKey || row.semanticSlot),
    canonicalKey || `hash:${textHash}`
  ].join('|');
}

function findDuplicateActiveVectorRows(vectorRows = []) {
  const groups = new Map();
  for (const row of Array.isArray(vectorRows) ? vectorRows : []) {
    const slot = vectorDuplicateSlot(row);
    if (!slot) continue;
    const list = groups.get(slot) || [];
    list.push(row);
    groups.set(slot, list);
  }
  const duplicateRows = [];
  const duplicateGroups = [];
  for (const [slot, rows] of groups.entries()) {
    if (rows.length <= 1) continue;
    const sorted = rows.slice().sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    duplicateRows.push(...sorted.slice(1));
    duplicateGroups.push({
      slotHash: hashMaybe(slot),
      count: rows.length,
      ids: rows.map((row) => normalizeId(row.id)).filter(Boolean).slice(0, DEFAULT_SAMPLE_LIMIT)
    });
  }
  return { duplicateRows, duplicateGroups };
}

function normalizeSqliteSnapshot(snapshot = {}) {
  const profileFacts = Array.isArray(snapshot.profileFacts) ? snapshot.profileFacts : [];
  const journalRollups = Array.isArray(snapshot.journalRollups) ? snapshot.journalRollups : [];
  const journalEntries = Array.isArray(snapshot.journalEntries) ? snapshot.journalEntries : [];
  const counts = snapshot.counts || {};
  return {
    ok: snapshot.ok !== false,
    dbFile: normalizeText(snapshot.dbFile),
    reason: normalizeText(snapshot.reason),
    truncated: snapshot.truncated === true,
    profileFacts,
    journalRollups,
    journalEntries,
    counts: {
      profileFacts: Math.max(profileFacts.length, Number(counts.profileFacts || 0) || 0),
      journalRollups: Math.max(journalRollups.length, Number(counts.journalRollups || 0) || 0),
      journalEntries: Math.max(journalEntries.length, Number(counts.journalEntries || 0) || 0)
    }
  };
}

function loadSqliteSnapshot(options = {}, deps = {}) {
  if (deps.sqliteSnapshot) return normalizeSqliteSnapshot(deps.sqliteSnapshot);
  const profileJournalDb = deps.profileJournalDb || require('./profileJournalDb');
  const getDbFile = deps.getDbFile || profileJournalDb.getDbFile;
  const getDb = deps.getDb;
  const maxRows = Math.max(1, Math.min(100000, Number(options.maxSqliteRows || 100000) || 100000));
  const dbFile = typeof getDbFile === 'function' ? getDbFile() : '';
  let db;
  let shouldClose = false;
  try {
    if (typeof getDb === 'function') {
      db = getDb();
    } else {
      if (!dbFile || !fs.existsSync(dbFile)) {
        return normalizeSqliteSnapshot({ ok: false, dbFile, reason: 'sqlite_file_missing' });
      }
      const Database = require('better-sqlite3');
      db = new Database(dbFile, { readonly: true, fileMustExist: true });
      shouldClose = true;
    }
  } catch (error) {
    return normalizeSqliteSnapshot({ ok: false, dbFile, reason: `sqlite_open_failed:${error.message}` });
  }
  if (!db) return normalizeSqliteSnapshot({ ok: false, dbFile, reason: 'profile_journal_db_unavailable' });

  const scalar = (sql) => {
    try {
      const row = db.prepare(sql).get();
      return Number(Object.values(row || {})[0] || 0) || 0;
    } catch (_) {
      return 0;
    }
  };
  const selectAll = (sql) => {
    try {
      return db.prepare(sql).all(maxRows);
    } catch (_) {
      return [];
    }
  };

  const profileFacts = selectAll(`
    SELECT id, user_id AS userId, field_key AS fieldKey, value, conflict_key AS conflictKey, status, updated_at AS updatedAt
    FROM profile_facts
    WHERE status = 'active'
    ORDER BY updated_at DESC, id ASC
    LIMIT ?
  `).map((row) => ({
    id: normalizeId(row.id),
    userId: normalizeText(row.userId),
    fieldKey: normalizeText(row.fieldKey),
    status: normalizeStatus(row.status),
    canonicalKey: normalizeCanonicalKey(row.conflictKey || canonicalizeText(row.value)),
    textHash: hashMaybe(row.value),
    updatedAt: Number(row.updatedAt || 0) || 0
  }));
  const journalRollups = selectAll(`
    SELECT id, user_id AS userId, level, day, start_day AS startDay, end_day AS endDay, text, status
    FROM journal_rollups
    WHERE status = 'active'
    ORDER BY day DESC, start_day DESC, id ASC
    LIMIT ?
  `).map((row) => ({
    id: normalizeId(row.id),
    userId: normalizeText(row.userId),
    level: normalizeText(row.level).toLowerCase(),
    day: normalizeText(row.day),
    startDay: normalizeText(row.startDay),
    endDay: normalizeText(row.endDay),
    status: normalizeStatus(row.status),
    textHash: hashMaybe(row.text)
  }));
  const journalEntries = selectAll(`
    SELECT id, user_id AS userId, day, turn_id AS turnId, status
    FROM journal_entries
    WHERE status = 'active'
    ORDER BY ts DESC, id ASC
    LIMIT ?
  `).map((row) => ({
    id: normalizeId(row.id),
    userId: normalizeText(row.userId),
    day: normalizeText(row.day),
    turnId: normalizeText(row.turnId),
    status: normalizeStatus(row.status),
    kind: SOURCE_ONLY_KIND
  }));

  const counts = {
    profileFacts: scalar("SELECT COUNT(*) AS c FROM profile_facts WHERE status = 'active'"),
    journalRollups: scalar("SELECT COUNT(*) AS c FROM journal_rollups WHERE status = 'active'"),
    journalEntries: scalar("SELECT COUNT(*) AS c FROM journal_entries WHERE status = 'active'")
  };

  const snapshot = normalizeSqliteSnapshot({
    ok: true,
    dbFile,
    counts,
    profileFacts,
    journalRollups,
    journalEntries,
    truncated: profileFacts.length < counts.profileFacts
      || journalRollups.length < counts.journalRollups
      || journalEntries.length < counts.journalEntries
  });
  if (shouldClose && db && typeof db.close === 'function') {
    try {
      db.close();
    } catch (_) {}
  }
  return snapshot;
}

function rollupHasVectorCopy(rollup = {}, vectorIds = new Set(), expectedIds = new Set()) {
  const id = normalizeId(rollup.id);
  const userId = normalizeText(rollup.userId);
  const level = normalizeText(rollup.level || rollup.rollupLevel).toLowerCase();
  const day = normalizeText(rollup.day || rollup.startDay || rollup.endDay);
  const directIds = [
    buildMemoryRowId(id),
    buildMemoryRowId(`episode:${id}`)
  ].filter(Boolean);
  if (directIds.some((item) => vectorIds.has(item) || expectedIds.has(item))) return true;
  if (!userId || !day) return false;
  if (level === 'daily') {
    const journalDayId = buildMemoryRowId(`journal-day:${userId}:${day}`);
    return vectorIds.has(journalDayId) || expectedIds.has(journalDayId);
  }
  if (level === 'segment') {
    const prefix = buildMemoryRowId(`journal-segment:${userId}:${day}:`);
    return Array.from(vectorIds).some((item) => item.startsWith(prefix))
      || Array.from(expectedIds).some((item) => item.startsWith(prefix));
  }
  return false;
}

function buildSqliteOnlyRows(sqliteSnapshot = {}, vectorIds = new Set(), expectedIds = new Set(), options = {}) {
  const sqlite = normalizeSqliteSnapshot(sqliteSnapshot);
  const profileOnly = sqlite.profileFacts.filter((row) => {
    const vectorId = buildMemoryRowId(row.id);
    return !vectorIds.has(vectorId);
  });
  const rollupOnly = sqlite.journalRollups.filter((row) => !rollupHasVectorCopy(row, vectorIds, expectedIds));
  const journalEntries = sqlite.journalEntries;
  const samples = [
    ...profileOnly.map((row) => ({ sourceTable: 'profile_facts', id: row.id, userId: row.userId, fieldKey: row.fieldKey, canonicalKeyHash: hashMaybe(row.canonicalKey), textHash: row.textHash })),
    ...rollupOnly.map((row) => ({ sourceTable: 'journal_rollups', id: row.id, userId: row.userId, rollupLevel: row.level, day: row.day || row.startDay || row.endDay, textHash: row.textHash })),
    ...journalEntries.map((row) => ({ sourceTable: 'journal_entries', id: row.id, userId: row.userId, day: row.day, kind: SOURCE_ONLY_KIND }))
  ];
  return {
    count: profileOnly.length + rollupOnly.length + journalEntries.length,
    activeProfileFacts: profileOnly.length,
    activeJournalRollups: rollupOnly.length,
    activeJournalEntries: journalEntries.length,
    expectedSourceOnlyJournalEntries: journalEntries.length,
    samples: sampleList(samples, options.limit)
  };
}

function analyzeStorageOverlap(input = {}, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || input.limit || DEFAULT_SAMPLE_LIMIT) || DEFAULT_SAMPLE_LIMIT));
  const expectedRows = Array.isArray(input.expectedRows)
    ? input.expectedRows
    : buildExpectedIndexCopies(input);
  const vectorRows = normalizeVectorRows(input.vectorRows || input.tableStats || []);
  const vectorRowsWithIds = vectorRows
    .map((row) => ({ ...row, id: normalizeId(row.id) }))
    .filter((row) => row.id);
  const expectedIds = new Set(expectedRows.map((row) => normalizeId(row.id)).filter(Boolean));
  const vectorIds = new Set(vectorRowsWithIds.map((row) => row.id));
  const missing = expectedRows.filter((row) => row.id && !vectorIds.has(row.id));
  const vectorOnly = vectorRowsWithIds.filter((row) => row.id && !expectedIds.has(row.id));
  const rawJournalRows = vectorRowsWithIds.filter(isRawJournalVectorLike);
  const staleRows = vectorRowsWithIds.filter(isInactiveVectorRow);
  const { duplicateRows, duplicateGroups } = findDuplicateActiveVectorRows(vectorRowsWithIds);
  const unexpectedById = new Map();
  for (const row of vectorOnly) unexpectedById.set(row.id, row);
  for (const row of rawJournalRows) unexpectedById.set(row.id, row);
  for (const row of staleRows) unexpectedById.set(row.id, row);
  for (const row of duplicateRows) unexpectedById.set(row.id, row);
  const sqliteOnlyRows = buildSqliteOnlyRows(input.sqliteSnapshot || {}, vectorIds, expectedIds, { limit });
  const rawJournalCount = rawJournalRows.length;
  const recommendedAction = rawJournalCount > 0
    ? 'investigate_raw_entry_vectors'
    : (vectorOnly.length > 0 || missing.length > 0 ? 'run_full_lancedb_reconcile' : 'none');

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    generatedAt: new Date().toISOString(),
    expectedIndexCopies: {
      count: expectedRows.length,
      bySource: countBy(expectedRows, (row) => row.source || row.type || 'memory'),
      journalCopies: expectedRows.filter((row) => row.source === 'journal' || String(row.type || '').includes('journal')).length,
      samples: sampleList(expectedRows.map(safeSampleRow), limit)
    },
    unexpectedVectorRows: {
      count: unexpectedById.size,
      rawJournalRows: rawJournalCount,
      staleRows: staleRows.length,
      duplicateActiveRows: duplicateRows.length,
      orphanRows: vectorOnly.length,
      duplicateGroups: sampleList(duplicateGroups, limit),
      samples: sampleList(Array.from(unexpectedById.values()).map(safeSampleRow), limit)
    },
    missingVectorRows: {
      count: missing.length,
      samples: sampleList(missing.map(safeSampleRow), limit)
    },
    sqliteOnlyRows,
    vectorOnlyRows: {
      count: vectorOnly.length,
      samples: sampleList(vectorOnly.map(safeSampleRow), limit)
    },
    alignment: {
      keys: ['nodeId', 'canonicalKeyHash', 'textHash', 'rollupId'],
      expectedIds: expectedRows.length,
      vectorIds: vectorIds.size,
      vectorRows: vectorRowsWithIds.length,
      vectorMetadataAvailable: vectorRowsWithIds.some((row) => normalizeText(row.canonicalKey || row.textHash || row.source || row.type)),
      sqlite: {
        ok: input.sqliteSnapshot?.ok !== false,
        dbFile: normalizeText(input.sqliteSnapshot?.dbFile),
        truncated: input.sqliteSnapshot?.truncated === true,
        counts: input.sqliteSnapshot?.counts || {}
      },
      lancedb: {
        table: normalizeText(input.tableStats?.table || input.tableName),
        rows: Number(input.tableStats?.rows || vectorRowsWithIds.length) || vectorRowsWithIds.length,
        truncated: input.tableStats?.truncated === true,
        reason: normalizeText(input.tableStats?.reason)
      }
    },
    recommendedAction
  };
}

async function buildStorageOverlapSummary(options = {}, deps = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || DEFAULT_SAMPLE_LIMIT) || DEFAULT_SAMPLE_LIMIT));
  const collectEmbeddingBackfillNodes = deps.collectEmbeddingBackfillNodes
    || require('./memory-v3/embeddingIndex').collectEmbeddingBackfillNodes;
  const loadEmbeddingIndex = deps.loadEmbeddingIndex
    || require('./memory-v3/embeddingIndex').loadEmbeddingIndex;
  const listTableIds = deps.listTableIds
    || require('./lancedbMemoryStore').listTableIds;

  const embeddingNodes = Array.isArray(options.embeddingNodes)
    ? options.embeddingNodes
    : (Array.isArray(deps.embeddingNodes) ? deps.embeddingNodes : collectEmbeddingBackfillNodes());
  const embeddingRows = Array.isArray(options.embeddingRows)
    ? options.embeddingRows
    : (Array.isArray(deps.embeddingRows) ? deps.embeddingRows : ((loadEmbeddingIndex() || {}).readyRows || []));
  const expectedRows = Array.isArray(options.expectedRows)
    ? options.expectedRows
    : buildExpectedIndexCopies({ embeddingRows, embeddingNodes });
  const tableName = normalizeText(options.tableName || config.MEMORY_LANCEDB_MEMORY_TABLE || 'memory_v3_vectors');
  const lancedbOptions = {
    ...(options.lanceDbOptions || {}),
    ...(options.dir ? { dir: options.dir } : {}),
    ...(options.partitionMode ? { partitionMode: options.partitionMode } : {}),
    ...(options.bucketCount ? { bucketCount: options.bucketCount } : {})
  };
  const tableStats = options.tableStats || deps.tableStats || await listTableIds(tableName, {
    ...lancedbOptions,
    includeRows: true
  });
  const sqliteSnapshot = loadSqliteSnapshot(options, deps);
  const summary = analyzeStorageOverlap({
    expectedRows,
    vectorRows: options.vectorRows || deps.vectorRows || tableStats,
    tableStats,
    sqliteSnapshot,
    tableName
  }, { limit });
  return {
    ...summary,
    lancedbDir: path.resolve(lancedbOptions.dir || config.MEMORY_LANCEDB_DIR),
    tableName
  };
}

module.exports = {
  SCHEMA_VERSION,
  analyzeStorageOverlap,
  buildExpectedIndexCopies,
  buildStorageOverlapSummary,
  isExpectedHotNode,
  isRawJournalVectorLike,
  loadSqliteSnapshot,
  safeSampleRow
};
