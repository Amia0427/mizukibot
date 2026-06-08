const fs = require('fs');
const path = require('path');
const config = require('../../config');
const {
  ensureDir,
  normalizeText
} = require('../memory-v3/helpers');
const {
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
} = require('./rows');
const {
  PARTITION_USER_BUCKET,
  buildAllMemoryBucketTableNames,
  groupRowsByMemoryBucket,
  isLanceDbLegacyFallbackEnabled,
  isMemoryBucketTableName,
  isUserBucketPartitionMode,
  normalizeLanceDbPartitionMode,
  normalizeMemoryTableBase,
  normalizeWorldbookTable,
  resolveLanceDbBucketCount,
  resolveMemoryBucketTableName,
  resolveMemorySearchTableNames
} = require('./partitioning');

let lancedbModulePromise = null;
let connectionPromise = null;
let connectionDir = '';


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

async function listExistingMemoryTables(db, baseTableName = '', options = {}) {
  const tableNames = await db.tableNames();
  const base = normalizeMemoryTableBase(baseTableName);
  if (!isUserBucketPartitionMode(options)) {
    return tableNames.includes(base) ? [base] : [];
  }
  const expected = new Set(buildAllMemoryBucketTableNames(base, options));
  return tableNames
    .filter((name) => expected.has(name) || isMemoryBucketTableName(name, base, options))
    .sort();
}

function shouldAggregateMemoryBuckets(tableName = '', options = {}) {
  if (!isUserBucketPartitionMode(options)) return false;
  const normalizedTable = normalizeText(tableName);
  const memoryBase = normalizeMemoryTableBase(options.memoryTable || config.MEMORY_LANCEDB_MEMORY_TABLE || 'memory_v3_vectors');
  return normalizedTable === memoryBase;
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
      try {
        await table
          .mergeInsert('id')
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(cleanRows, { timeoutMs: Math.max(1000, Number(options.timeoutMs || config.MEMORY_LANCEDB_TIMEOUT_MS || 800) || 800) });
      } catch (error) {
        if (!looksLikeMissingColumnError(error)) throw error;
        await table
          .mergeInsert('id')
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(stripMetadataColumnsFromRows(cleanRows), { timeoutMs: Math.max(1000, Number(options.timeoutMs || config.MEMORY_LANCEDB_TIMEOUT_MS || 800) || 800) });
      }
      mode = options.fullReconcile || options.deleteStaleRows ? 'merge_reconcile' : 'merge_insert';
    } else {
      try {
        await table.add(cleanRows);
      } catch (error) {
        if (!looksLikeMissingColumnError(error)) throw error;
        await table.add(stripMetadataColumnsFromRows(cleanRows));
      }
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

function summarizePartitionWriteResults(results = [], options = {}) {
  const list = Array.isArray(results) ? results : [];
  const rows = list.reduce((sum, item) => sum + (Number(item?.rows || 0) || 0), 0);
  return {
    ok: list.every((item) => item && item.ok !== false),
    partitionMode: PARTITION_USER_BUCKET,
    bucketCount: resolveLanceDbBucketCount(options.bucketCount || options.config?.MEMORY_LANCEDB_BUCKET_COUNT),
    tableCount: list.length,
    rows,
    results: list
  };
}

async function syncBucketedMemoryRows(tableName = '', rows = [], options = {}) {
  const baseTable = normalizeMemoryTableBase(tableName);
  const grouped = groupRowsByMemoryBucket(baseTable, dedupeVectorRows(rows), options);
  if (options.dryRun === true || options.fullReconcile === true || options.deleteStaleRows === true) {
    const desiredTables = new Set(grouped.keys());
    for (const bucketTable of buildAllMemoryBucketTableNames(baseTable, options)) {
      if (!desiredTables.has(bucketTable)) grouped.set(bucketTable, []);
    }
  }
  const results = [];
  for (const [bucketTable, bucketRows] of Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    if (bucketRows.length === 0 && options.dryRun !== true && options.full === true) {
      continue;
    }
    if (bucketRows.length === 0 && options.dryRun !== true && (options.fullReconcile === true || options.deleteStaleRows === true)) {
      results.push(await deleteAllTableRows(bucketTable, options));
      continue;
    }
    if (bucketRows.length === 0 && options.dryRun !== true) continue;
    const result = options.full
      ? await replaceTableRows(bucketTable, bucketRows, options)
      : await upsertTableRows(bucketTable, bucketRows, options);
    results.push(result);
  }
  return summarizePartitionWriteResults(results, options);
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

async function deleteAllTableRows(tableName = '', options = {}) {
  const normalizedTable = normalizeText(tableName);
  if (!normalizedTable) return { ok: true, skipped: true, reason: 'empty_table', table: normalizedTable, rows: 0 };
  const openResult = await openLanceDb(options);
  if (!openResult.ok) return openResult;
  const table = await openTable(openResult.db, normalizedTable);
  if (!table) return { ok: true, skipped: true, reason: 'table_missing', table: normalizedTable, rows: 0 };
  const stats = await listTableIds(normalizedTable, { ...options, partitionMode: 'legacy' });
  const ids = Array.isArray(stats.ids) ? stats.ids : [];
  if (ids.length === 0) return { ok: true, skipped: true, reason: 'no_rows', table: normalizedTable, rows: 0 };
  const chunkSize = Math.max(1, Math.min(200, Number(options.deleteChunkSize || 100) || 100));
  let deleted = 0;
  for (const chunk of chunkList(ids, chunkSize)) {
    await table.delete(`id IN (${chunk.map(quoteSql).join(', ')})`);
    deleted += chunk.length;
  }
  return { ok: true, table: normalizedTable, rows: 0, mode: 'delete_all', deleted };
}

async function syncMemoryRows(rows = [], options = {}) {
  if (!isLanceDbSyncEnabled(options.config || config)) {
    return { ok: false, skipped: true, reason: 'sync_disabled', rows: 0 };
  }
  const tableName = normalizeMemoryTableBase(options.tableName || config.MEMORY_LANCEDB_MEMORY_TABLE || 'memory_v3_vectors');
  if (isUserBucketPartitionMode(options)) {
    return syncBucketedMemoryRows(tableName, rows, options);
  }
  return options.full
    ? replaceTableRows(tableName, rows, options)
    : upsertTableRows(tableName, rows, options);
}

async function syncMemoryBucketRows(tableName = '', rows = [], options = {}) {
  if (!isLanceDbSyncEnabled(options.config || config)) {
    return { ok: false, skipped: true, reason: 'sync_disabled', rows: 0 };
  }
  const normalizedTable = normalizeText(tableName);
  if (!normalizedTable) return { ok: false, skipped: true, reason: 'empty_table', rows: 0 };
  const cleanRows = dedupeVectorRows(rows);
  const singleTableOptions = {
    ...options,
    partitionMode: 'legacy'
  };
  if (cleanRows.length === 0 && (options.full || options.fullReconcile || options.deleteStaleRows)) {
    return deleteAllTableRows(normalizedTable, singleTableOptions);
  }
  return options.full
    ? replaceTableRows(normalizedTable, cleanRows, singleTableOptions)
    : upsertTableRows(normalizedTable, cleanRows, singleTableOptions);
}

async function syncWorldbookRows(rows = [], options = {}) {
  if (!isLanceDbSyncEnabled(options.config || config)) {
    return { ok: false, skipped: true, reason: 'sync_disabled', rows: 0 };
  }
  const tableName = normalizeWorldbookTable(options.tableName || config.MEMORY_LANCEDB_WORLDBOOK_TABLE || 'persona_worldbook_vectors');
  return options.full
    ? replaceTableRows(tableName, rows, options)
    : upsertTableRows(tableName, rows, options);
}

function safeSearchFailure(reason = 'unavailable') {
  return { ok: false, skipped: true, reason, results: [], rows: [] };
}

function looksLikeMissingColumnError(error = null) {
  const message = String(error?.message || error || '').toLowerCase();
  return (message.includes('column') || message.includes('field'))
    && (message.includes('not found') || message.includes('does not exist') || message.includes('no field') || message.includes('missing') || message.includes('not in schema'));
}

function legacySelectColumns() {
  return LANCEDB_SELECT_COLUMNS.filter((column) => !['category', 'tagsText', 'intent', 'privacyLevel'].includes(column));
}

function stripMetadataColumnsFromRows(rows = []) {
  const metadataColumns = new Set(['category', 'tagsText', 'intent', 'privacyLevel']);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const next = {};
    for (const [key, value] of Object.entries(row)) {
      if (!metadataColumns.has(key)) next[key] = value;
    }
    return next;
  });
}

function stripMetadataFilterClauses(filterSql = '') {
  return String(filterSql || '')
    .split(/\s+AND\s+/i)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .filter((clause) => !/^(category|intent|privacyLevel)\s*=/.test(clause))
    .join(' AND ');
}

async function countTableRows(tableName = '', options = {}) {
  const normalizedTable = normalizeText(tableName);
  if (!normalizedTable) return { ok: false, skipped: true, reason: 'empty_table', rows: 0 };
  const openResult = await openLanceDb(options);
  if (!openResult.ok) return { ...openResult, rows: 0 };
  try {
    const targetTables = shouldAggregateMemoryBuckets(normalizedTable, options)
      ? await listExistingMemoryTables(openResult.db, normalizedTable, options)
      : [normalizedTable];
    if (targetTables.length === 0) return { ok: false, skipped: true, reason: 'table_missing', rows: 0 };
    const tableResults = [];
    let totalRows = 0;
    for (const targetTable of targetTables) {
      const table = await openTable(openResult.db, targetTable);
      if (!table) continue;
      const rows = typeof table.countRows === 'function'
        ? Number(await table.countRows() || 0) || 0
        : (await table.query().select(['id']).limit(1000000).toArray()).length;
      totalRows += rows;
      tableResults.push({ table: targetTable, rows });
    }
    return {
      ok: tableResults.length > 0,
      table: normalizedTable,
      rows: totalRows,
      partitionMode: isUserBucketPartitionMode(options) ? PARTITION_USER_BUCKET : 'legacy',
      tableCount: tableResults.length,
      tables: tableResults
    };
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
    const targetTables = shouldAggregateMemoryBuckets(normalizedTable, options)
      ? await listExistingMemoryTables(openResult.db, normalizedTable, options)
      : [normalizedTable];
    if (targetTables.length === 0) return { ok: false, skipped: true, reason: 'table_missing', rows: 0, ids: [] };
    const maxIds = Math.max(1, Math.floor(Number(options.maxIds || 1000000) || 1000000));
    const ids = [];
    const tables = [];
    let rowCount = 0;
    for (const targetTable of targetTables) {
      const remaining = Math.max(0, maxIds - ids.length);
      const table = await openTable(openResult.db, targetTable);
      if (!table) continue;
      const idRows = remaining > 0
        ? await table.query().select(['id']).limit(remaining).toArray()
        : [];
      const tableIds = (Array.isArray(idRows) ? idRows : [])
        .map((row) => normalizeText(row.id))
        .filter(Boolean);
      const tableRowCount = typeof table.countRows === 'function'
        ? Number(await table.countRows() || 0) || tableIds.length
        : tableIds.length;
      rowCount += tableRowCount;
      ids.push(...tableIds);
      tables.push({ table: targetTable, rows: tableRowCount, ids: tableIds.length });
    }
    return {
      ok: true,
      table: normalizedTable,
      rows: rowCount,
      ids,
      partitionMode: isUserBucketPartitionMode(options) ? PARTITION_USER_BUCKET : 'legacy',
      tableCount: tables.length,
      tables,
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
    const runQuery = async (selectColumns, sql) => {
      let query = table
        .vectorSearch(vector)
        .distanceType('cosine')
        .select(selectColumns)
        .limit(limit);
      if (sql) query = query.where(sql);
      return query.toArray();
    };
    let rows;
    try {
      rows = await runQuery(LANCEDB_SELECT_COLUMNS, filterSql);
    } catch (error) {
      if (!looksLikeMissingColumnError(error)) throw error;
      rows = await runQuery(legacySelectColumns(), stripMetadataFilterClauses(filterSql));
    }
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
  const tableName = normalizeMemoryTableBase(options.tableName || config.MEMORY_LANCEDB_MEMORY_TABLE || 'memory_v3_vectors');
  return withTimeout(
    async () => {
      if (!isUserBucketPartitionMode(options)) {
        return searchTableVectors(tableName, queryEmbedding, filter.sql, options);
      }
      const targetTables = resolveMemorySearchTableNames(tableName, context, options);
      if (targetTables.length === 0) return safeSearchFailure('no_bucket_targets');
      const results = await Promise.all(targetTables.map((targetTable) => searchTableVectors(targetTable, queryEmbedding, filter.sql, options)));
      let rows = results
        .filter((result) => result && result.ok === true)
        .flatMap((result) => Array.isArray(result.rows) ? result.rows : []);
      if (rows.length === 0 && isLanceDbLegacyFallbackEnabled(options)) {
        const legacyResult = await searchTableVectors(tableName, queryEmbedding, filter.sql, options);
        return {
          ...legacyResult,
          partitionMode: PARTITION_USER_BUCKET,
          fallbackToLegacy: legacyResult.ok === true,
          targetTables
        };
      }
      const limit = Math.max(1, Math.floor(Number(options.limit || config.MEMORY_LANCEDB_CANDIDATE_LIMIT || 32) || 32));
      rows = rows
        .sort((a, b) => Number(a._distance ?? Number.POSITIVE_INFINITY) - Number(b._distance ?? Number.POSITIVE_INFINITY))
        .slice(0, limit);
      return {
        ok: true,
        rows,
        results: rows,
        reason: '',
        partitionMode: PARTITION_USER_BUCKET,
        targetTables,
        searchedTables: results.map((result, index) => ({
          table: targetTables[index],
          ok: result?.ok === true,
          reason: result?.reason || '',
          rows: Array.isArray(result?.rows) ? result.rows.length : 0
        }))
      };
    },
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
  const tableName = normalizeWorldbookTable(options.tableName || config.MEMORY_LANCEDB_WORLDBOOK_TABLE || 'persona_worldbook_vectors');
  return withTimeout(
    () => searchTableVectors(tableName, queryEmbedding, "status != 'archived'", options),
    options.timeoutMs || config.MEMORY_LANCEDB_TIMEOUT_MS,
    (error) => safeSearchFailure(error && error.message === 'timeout' ? 'timeout' : `failed:${error.message}`)
  );
}

async function compactLanceDbTables(options = {}) {
  const openResult = await openLanceDb(options);
  if (!openResult.ok) return openResult;
  const memoryTable = normalizeMemoryTableBase(options.memoryTable || config.MEMORY_LANCEDB_MEMORY_TABLE || 'memory_v3_vectors');
  const memoryTargets = isUserBucketPartitionMode(options)
    ? await listExistingMemoryTables(openResult.db, memoryTable, options)
    : [memoryTable];
  const targets = Array.from(new Set([
    ...memoryTargets,
    normalizeWorldbookTable(options.worldbookTable || config.MEMORY_LANCEDB_WORLDBOOK_TABLE || 'persona_worldbook_vectors')
  ].filter(Boolean)));
  const compactOptions = {};
  if (options.cleanupOlderThan) compactOptions.cleanupOlderThan = options.cleanupOlderThan;
  if (options.deleteUnverified === true) compactOptions.deleteUnverified = true;
  const results = [];
  for (const tableName of targets) {
    try {
      const table = await openTable(openResult.db, tableName);
      if (!table || typeof table.optimize !== 'function') {
        results.push({ table: tableName, ok: false, skipped: true, reason: 'table_missing' });
        continue;
      }
      const stats = Object.keys(compactOptions).length > 0
        ? await table.optimize(compactOptions)
        : await table.optimize();
      results.push({ table: tableName, ok: true, stats });
    } catch (error) {
      results.push({ table: tableName, ok: false, skipped: true, reason: error.message });
    }
  }
  return { ok: true, results };
}

module.exports = {
  LANCEDB_ROW_COLUMNS,
  PARTITION_USER_BUCKET,
  buildMemoryFilter,
  buildMemoryVectorRow,
  buildWorldbookVectorRow,
  buildAllMemoryBucketTableNames,
  compactLanceDbTables,
  countTableRows,
  dedupeVectorRows,
  deleteStaleTableRows,
  diffStaleTableIds,
  fuseRecallCandidates,
  groupRowsByMemoryBucket,
  isLanceDbReadEnabled,
  isLanceDbSyncEnabled,
  isUserBucketPartitionMode,
  lancedbDistanceToScore,
  listTableIds,
  normalizeLanceDbPartitionMode,
  normalizeVectorStoreMode,
  openLanceDb,
  resolveLanceDbBucketCount,
  resolveMemoryBucketTableName,
  resolveMemorySearchTableNames,
  resolveVectorCandidates,
  rowPassesMemoryFilter,
  searchMemoryVectors,
  searchWorldbookVectors,
  syncMemoryBucketRows,
  syncMemoryRows,
  syncWorldbookRows
};
