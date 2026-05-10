const crypto = require('crypto');
const config = require('../../config');
const { getLastEmbeddingFailure } = require('../memoryEmbeddingClient');
const {
  ensureDir,
  safeReadJsonLines,
  writeJsonLines,
  normalizeText,
  clampText,
  canonicalizeText
} = require('./helpers');
const { shouldUseRemoteEmbedding, requestEmbedding, cosineArray } = require('../vectorMemory');

const CACHE_VERSION = 1;
const DEFAULT_DOC_MAX_CHARS = 1800;

const backfillState = {
  running: false,
  timer: null
};
let embeddingIndexCache = null;

const BACKFILL_SOURCE_SET = new Set(['all', 'memory', 'journal']);
const FAILURE_REASONS = ['embedding_request_failed', 'empty_embedding', 'rate_limit', 'auth_failed', 'timeout'];

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function getEmbeddingModel() {
  return normalizeText(config.MEMORY_EMBEDDING_MODEL);
}

function isEmbeddingIndexEnabled() {
  return config.MEMORY_EMBEDDING_INDEX_ENABLED !== false && Boolean(getEmbeddingModel());
}

function buildEmbeddingText(node = {}) {
  const tags = [
    node.source,
    node.sourceKind,
    node.scopeType,
    node.fieldKey || node.semanticSlot,
    node.type || node.memoryKind,
    node.evidenceTier,
    node.status
  ].map(normalizeText).filter(Boolean);
  const canonical = normalizeText(node.canonicalKey || canonicalizeText(node.text));
  const text = normalizeText(node.text);
  return clampText([
    tags.length ? `[${tags.join('|')}]` : '',
    canonical ? `key: ${canonical}` : '',
    text
  ].filter(Boolean).join('\n'), DEFAULT_DOC_MAX_CHARS);
}

function buildEmbeddingIdentity(node = {}) {
  const text = buildEmbeddingText(node);
  const textHash = sha1(text);
  const model = getEmbeddingModel();
  const payload = {
    nodeId: normalizeText(node.id),
    canonicalKey: normalizeText(node.canonicalKey || canonicalizeText(node.text)).toLowerCase(),
    source: normalizeText(node.source),
    model,
    textHash,
    updatedAt: Number(node.updatedAt || node.createdAt || 0) || 0
  };
  return {
    ...payload,
    text,
    key: sha1(JSON.stringify(payload))
  };
}

function isJournalEmbeddingDoc(value = {}) {
  const source = normalizeText(value.source).toLowerCase();
  const type = normalizeText(value.type || value.memoryKind).toLowerCase();
  const nodeId = normalizeText(value.nodeId || value.id);
  return source === 'journal'
    || type === 'daily_journal'
    || type === 'daily_journal_segment'
    || nodeId.startsWith('journal-day:')
    || nodeId.startsWith('journal-segment:');
}

function normalizeBackfillSource(source = 'all') {
  const normalized = normalizeText(source || 'all').toLowerCase();
  return BACKFILL_SOURCE_SET.has(normalized) ? normalized : 'all';
}

function normalizeFailureReason(reason = '') {
  const normalized = normalizeText(reason || '').toLowerCase();
  return FAILURE_REASONS.includes(normalized) ? normalized : 'embedding_request_failed';
}

function buildFailureBreakdown(rows = []) {
  const breakdown = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (normalizeText(row.status).toLowerCase() !== 'failed') continue;
    const reason = normalizeFailureReason(row.error);
    breakdown[reason] = (breakdown[reason] || 0) + 1;
  }
  for (const reason of FAILURE_REASONS) {
    if (!Object.prototype.hasOwnProperty.call(breakdown, reason)) breakdown[reason] = 0;
  }
  return breakdown;
}

function filterEmbeddingBackfillNodes(nodes = [], source = 'all') {
  const normalized = normalizeBackfillSource(source);
  const list = Array.isArray(nodes) ? nodes : [];
  if (normalized === 'journal') return list.filter(isJournalEmbeddingDoc);
  if (normalized === 'memory') return list.filter((node) => !isJournalEmbeddingDoc(node));
  return list;
}

function normalizeCacheRow(row = {}) {
  if (!row || typeof row !== 'object') return null;
  const key = normalizeText(row.key);
  const nodeId = normalizeText(row.nodeId || row.id);
  const canonicalKey = normalizeText(row.canonicalKey).toLowerCase();
  const model = normalizeText(row.model || getEmbeddingModel());
  if (!key && !nodeId && !canonicalKey) return null;
  return {
    version: Number(row.version || CACHE_VERSION) || CACHE_VERSION,
    key,
    nodeId,
    canonicalKey,
    model,
    source: normalizeText(row.source),
    textHash: normalizeText(row.textHash),
    embedding: Array.isArray(row.embedding) ? row.embedding : [],
    updatedAt: Number(row.updatedAt || 0) || 0,
    lastEmbeddedAt: Number(row.lastEmbeddedAt || 0) || 0,
    status: normalizeText(row.status || (Array.isArray(row.embedding) && row.embedding.length ? 'ready' : 'pending')).toLowerCase(),
    failCount: Math.max(0, Number(row.failCount || 0) || 0),
    nextRetryAt: Math.max(0, Number(row.nextRetryAt || 0) || 0),
    error: normalizeText(row.error)
  };
}

function getEmbeddingCacheSignature() {
  const file = config.MEMORY_V3_EMBEDDING_CACHE_FILE;
  try {
    const stat = fs.statSync(file);
    return {
      file,
      mtimeMs: Number(stat.mtimeMs || 0) || 0,
      size: Number(stat.size || 0) || 0
    };
  } catch (_) {
    return {
      file,
      mtimeMs: 0,
      size: 0
    };
  }
}

function clearEmbeddingIndexCache() {
  embeddingIndexCache = null;
}

function writeEmbeddingRows(rows = []) {
  writeJsonLines(config.MEMORY_V3_EMBEDDING_CACHE_FILE, rows);
  clearEmbeddingIndexCache();
}

function loadEmbeddingRows() {
  return safeReadJsonLines(config.MEMORY_V3_EMBEDDING_CACHE_FILE)
    .map(normalizeCacheRow)
    .filter(Boolean);
}

function loadEmbeddingIndex() {
  const signature = getEmbeddingCacheSignature();
  if (
    embeddingIndexCache
    && embeddingIndexCache.file === signature.file
    && embeddingIndexCache.mtimeMs === signature.mtimeMs
    && embeddingIndexCache.size === signature.size
  ) {
    return embeddingIndexCache.index;
  }
  const rows = loadEmbeddingRows();
  const byKey = new Map();
  const byNodeId = new Map();
  const byCanonicalKey = new Map();
  for (const row of rows) {
    if (row.key) byKey.set(row.key, row);
    if (row.nodeId) byNodeId.set(row.nodeId, row);
    if (row.canonicalKey && !byCanonicalKey.has(row.canonicalKey)) {
      byCanonicalKey.set(row.canonicalKey, row);
    }
  }
  const index = {
    rows,
    byKey,
    byNodeId,
    byCanonicalKey,
    readyRows: rows.filter((row) => row.status === 'ready' && row.embedding.length > 0)
  };
  embeddingIndexCache = {
    ...signature,
    index
  };
  return index;
}

function rowMatchesIdentity(row, identity) {
  if (!row || !identity) return false;
  return row.model === identity.model
    && row.textHash === identity.textHash
    && row.updatedAt === identity.updatedAt;
}

function findReusableRow(index, identity) {
  const byKey = index.byKey.get(identity.key);
  if (rowMatchesIdentity(byKey, identity)) return byKey;
  const byNode = identity.nodeId ? index.byNodeId.get(identity.nodeId) : null;
  if (rowMatchesIdentity(byNode, identity)) return byNode;
  const byCanonical = identity.canonicalKey ? index.byCanonicalKey.get(identity.canonicalKey) : null;
  if (rowMatchesIdentity(byCanonical, identity)) return byCanonical;
  return null;
}

function makePendingRow(identity) {
  return {
    version: CACHE_VERSION,
    key: identity.key,
    nodeId: identity.nodeId,
    canonicalKey: identity.canonicalKey,
    model: identity.model,
    source: identity.source,
    textHash: identity.textHash,
    embedding: [],
    updatedAt: identity.updatedAt,
    lastEmbeddedAt: 0,
    status: 'pending',
    failCount: 0,
    nextRetryAt: 0,
    error: ''
  };
}

function reconcileEmbeddingCache(nodes = []) {
  ensureDir(config.MEMORY_V3_PROJECTIONS_DIR);
  const activeNodes = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => normalizeText(node?.text) && normalizeText(node?.status).toLowerCase() !== 'archived');
  if (!isEmbeddingIndexEnabled()) {
    writeEmbeddingRows([]);
    return { enabled: false, rows: 0, ready: 0, pending: 0, reused: 0, created: 0 };
  }

  const index = loadEmbeddingIndex();
  const rows = [];
  let reused = 0;
  let created = 0;
  const includesJournalDocs = activeNodes.some(isJournalEmbeddingDoc);
  const includesMemoryDocs = activeNodes.some((node) => !isJournalEmbeddingDoc(node));
  const shouldPreserveExisting = (row) => {
    if (activeNodes.length === 0) return isJournalEmbeddingDoc(row);
    if (includesJournalDocs && !includesMemoryDocs) return !isJournalEmbeddingDoc(row);
    if (includesMemoryDocs && !includesJournalDocs) return isJournalEmbeddingDoc(row);
    return false;
  };

  for (const row of index.rows) {
    if (shouldPreserveExisting(row)) rows.push(row);
  }

  for (const node of activeNodes) {
    const identity = buildEmbeddingIdentity(node);
    const existing = findReusableRow(index, identity);
    if (existing) {
      reused += 1;
      rows.push({
        ...existing,
        version: CACHE_VERSION,
        key: identity.key,
        nodeId: identity.nodeId,
        canonicalKey: identity.canonicalKey,
        model: identity.model,
        source: identity.source,
        textHash: identity.textHash,
        updatedAt: identity.updatedAt
      });
      continue;
    }
    created += 1;
    rows.push(makePendingRow(identity));
  }

  writeEmbeddingRows(rows);
  return {
    enabled: true,
    rows: rows.length,
    ready: rows.filter((row) => row.status === 'ready' && row.embedding.length > 0).length,
    pending: rows.filter((row) => row.status !== 'ready').length,
    reused,
    created
  };
}

function collectEmbeddingBackfillNodes() {
  const { loadMemoryNodes } = require('./storage');
  const nodes = [];
  for (const node of loadMemoryNodes()) {
    if (!node || normalizeText(node.status).toLowerCase() === 'archived') continue;
    nodes.push(node);
  }
  if (config.MEMORY_JOURNAL_EMBEDDING_BACKFILL_ENABLED !== false) {
    const { buildDailyJournalDocsForAllUsers } = require('./journalDocs');
    for (const doc of buildDailyJournalDocsForAllUsers({ includeSegments: true })) {
      if (!doc || normalizeText(doc.status).toLowerCase() === 'archived') continue;
      nodes.push(doc);
    }
  }
  return nodes;
}

function buildNodeMapByEmbeddingKey(nodes = []) {
  const map = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const identity = buildEmbeddingIdentity(node);
    if (identity.key) map.set(identity.key, { node, identity });
  }
  return map;
}

function loadNodeMapByEmbeddingKey() {
  return buildNodeMapByEmbeddingKey(collectEmbeddingBackfillNodes());
}

function resolveBackfillLimit(options = {}) {
  const explicitLimit = Math.floor(Number(options.limit || 0) || 0);
  if (explicitLimit > 0) return explicitLimit;
  const batchSize = Math.max(1, Math.floor(Number(options.batchSize || config.MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE || 32) || 32));
  const maxPerRun = Math.max(1, Math.floor(Number(options.maxPerRun || config.MEMORY_EMBEDDING_BACKFILL_MAX_PER_RUN || 128) || 128));
  return Math.min(batchSize, maxPerRun);
}

function buildEmbeddingBackfillPlan(options = {}) {
  const source = normalizeBackfillSource(options.source);
  if (!isEmbeddingIndexEnabled()) {
    return {
      ok: false,
      enabled: false,
      source,
      reason: 'embedding_index_disabled',
      sourceRows: 0,
      readyBefore: 0,
      considered: 0,
      remaining: 0,
      failed: 0,
      staleRows: 0
    };
  }

  const now = Date.now();
  const force = options.force === true || options.forceStale === true;
  const retryFailed = options.retryFailed === true;
  const nodes = filterEmbeddingBackfillNodes(collectEmbeddingBackfillNodes(), source);
  const index = loadEmbeddingIndex();
  const plannedRows = [];
  let created = 0;

  for (const node of nodes) {
    const identity = buildEmbeddingIdentity(node);
    const existing = findReusableRow(index, identity);
    if (existing) {
      plannedRows.push({
        ...existing,
        version: CACHE_VERSION,
        key: identity.key,
        nodeId: identity.nodeId,
        canonicalKey: identity.canonicalKey,
        model: identity.model,
        source: identity.source,
        textHash: identity.textHash,
        updatedAt: identity.updatedAt
      });
      continue;
    }
    created += 1;
    plannedRows.push(makePendingRow(identity));
  }

  const pending = plannedRows
    .filter((row) => {
      if (row.status === 'ready') return false;
      if (force) return true;
      if (retryFailed && row.status === 'failed') return true;
      return !row.nextRetryAt || row.nextRetryAt <= now;
    })
    .sort((a, b) => {
      const retryDiff = Number(a.nextRetryAt || 0) - Number(b.nextRetryAt || 0);
      if (retryDiff !== 0) return retryDiff;
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    })
    .slice(0, resolveBackfillLimit(options));

  return {
    ok: true,
    enabled: true,
    source,
    sourceRows: nodes.length,
    rows: plannedRows.length,
    readyBefore: plannedRows.filter((row) => row.status === 'ready' && Array.isArray(row.embedding) && row.embedding.length > 0).length,
    considered: pending.length,
    remaining: plannedRows.filter((row) => row.status !== 'ready').length,
    failed: plannedRows.filter((row) => row.status === 'failed').length,
    failureBreakdown: buildFailureBreakdown(plannedRows),
    staleRows: plannedRows.filter((row) => row.status === 'stale').length,
    created
  };
}

function scheduleEmbeddingBackfill(options = {}) {
  if (!isEmbeddingIndexEnabled() || !shouldUseRemoteEmbedding()) return false;
  if (backfillState.timer || backfillState.running) return false;
  const delayMs = Math.max(0, Number(options.delayMs ?? 250) || 0);
  backfillState.timer = setTimeout(() => {
    backfillState.timer = null;
    backfillMissingEmbeddings(options).catch((error) => {
      console.warn('[memory-v3/embeddingIndex] background backfill failed:', error.message);
    });
  }, delayMs);
  if (typeof backfillState.timer.unref === 'function') backfillState.timer.unref();
  return true;
}

function enqueueMissingEmbeddings(nodes = [], options = {}) {
  const stats = Array.isArray(nodes) ? reconcileEmbeddingCache(nodes) : {
    enabled: isEmbeddingIndexEnabled(),
    rows: loadEmbeddingRows().length
  };
  if (stats.enabled && options.schedule !== false) {
    scheduleEmbeddingBackfill(options);
  }
  return stats;
}

async function backfillMissingEmbeddings(options = {}) {
  if (!isEmbeddingIndexEnabled() || !shouldUseRemoteEmbedding()) {
    return { ok: false, skipped: true, reason: 'embedding_disabled' };
  }
  if (backfillState.running) {
    return { ok: false, skipped: true, reason: 'already_running' };
  }

  backfillState.running = true;
  let continueOptions = null;
  try {
    const now = Date.now();
    const source = normalizeBackfillSource(options.source);
    const selectedNodes = filterEmbeddingBackfillNodes(collectEmbeddingBackfillNodes(), source);
    const planBefore = buildEmbeddingBackfillPlan({
      ...options,
      source
    });
    if (options.dryRun === true) {
      return {
        ...planBefore,
        ok: true,
        dryRun: true,
        embedded: 0
      };
    }
    reconcileEmbeddingCache(selectedNodes);
    const rows = loadEmbeddingRows();
    const nodeMap = buildNodeMapByEmbeddingKey(selectedNodes);
    const limit = resolveBackfillLimit(options);
    const force = options.force === true || options.forceStale === true;
    const retryFailed = options.retryFailed === true;
    const pending = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        if (!nodeMap.has(row.key) || row.status === 'ready') return false;
        if (force) return true;
        if (retryFailed && row.status === 'failed') return true;
        return !row.nextRetryAt || row.nextRetryAt <= now;
      })
      .sort((a, b) => {
        const journalA = isJournalEmbeddingDoc(a.row) ? 1 : 0;
        const journalB = isJournalEmbeddingDoc(b.row) ? 1 : 0;
        if (journalA !== journalB) return journalB - journalA;
        if (Number(a.row.nextRetryAt || 0) !== Number(b.row.nextRetryAt || 0)) {
          return Number(a.row.nextRetryAt || 0) - Number(b.row.nextRetryAt || 0);
        }
        return Number(b.row.updatedAt || 0) - Number(a.row.updatedAt || 0);
      })
      .slice(0, limit);

    let embedded = 0;
    let failed = 0;
    for (const item of pending) {
      const nodeEntry = nodeMap.get(item.row.key);
      if (!nodeEntry) {
        rows[item.index] = {
          ...item.row,
          status: 'stale',
          error: 'node_not_found'
        };
        continue;
      }
      const vector = await requestEmbedding(nodeEntry.identity.text);
      if (Array.isArray(vector) && vector.length > 0) {
        rows[item.index] = {
          ...item.row,
          embedding: vector,
          lastEmbeddedAt: Date.now(),
          status: 'ready',
          failCount: 0,
          nextRetryAt: 0,
          error: ''
        };
        embedded += 1;
        continue;
      }
      const failCount = Math.max(0, Number(item.row.failCount || 0) || 0) + 1;
      const failure = getLastEmbeddingFailure();
      const errorReason = normalizeFailureReason(failure.reason || 'embedding_request_failed');
      rows[item.index] = {
        ...item.row,
        status: 'failed',
        failCount,
        nextRetryAt: Date.now() + Math.max(60000, Number(config.MEMORY_EMBEDDING_RETRY_COOLDOWN_MS || 1800000) || 1800000),
        error: errorReason,
        lastErrorMessage: failure.message || ''
      };
      failed += 1;
    }

    writeEmbeddingRows(rows);
    const scopedRows = rows.filter((row) => nodeMap.has(row.key));
    const remaining = scopedRows.filter((row) => row.status !== 'ready').length;
    const journalRemaining = scopedRows.filter((row) => isJournalEmbeddingDoc(row) && row.status !== 'ready').length;
    const failureBreakdown = buildFailureBreakdown(scopedRows);
    if (journalRemaining > 0 && options.continue !== false && embedded > 0) {
      continueOptions = {
        ...options,
        force: false,
        delayMs: Math.max(1000, Number(options.continueDelayMs ?? 60000) || 60000)
      };
    }
    return {
      ok: true,
      source,
      readyBefore: planBefore.readyBefore || 0,
      considered: pending.length,
      embedded,
      failed,
      failureBreakdown,
      remaining,
      journalRemaining
    };
  } finally {
    backfillState.running = false;
    if (continueOptions) scheduleEmbeddingBackfill(continueOptions);
  }
}

function getEmbeddingForCandidate(candidate = {}, index = loadEmbeddingIndex()) {
  if (!candidate) return null;
  const nodeId = normalizeText(candidate.id || candidate.nodeId);
  const canonicalKey = normalizeText(candidate.canonicalKey || canonicalizeText(candidate.text)).toLowerCase();
  const identity = buildEmbeddingIdentity(candidate);
  const row = index.byKey.get(identity.key)
    || (nodeId ? index.byNodeId.get(nodeId) : null)
    || (canonicalKey ? index.byCanonicalKey.get(canonicalKey) : null);
  if (!row || row.status !== 'ready' || !Array.isArray(row.embedding) || row.embedding.length === 0) return null;
  if (row.model !== getEmbeddingModel()) return null;
  return row;
}

function calcEmbeddingSimilarity(queryEmbedding, candidate = {}, index = loadEmbeddingIndex()) {
  const row = getEmbeddingForCandidate(candidate, index);
  if (!row || !Array.isArray(queryEmbedding)) return 0;
  return Math.max(0, cosineArray(queryEmbedding, row.embedding));
}

module.exports = {
  buildEmbeddingText,
  buildEmbeddingIdentity,
  buildEmbeddingBackfillPlan,
  buildFailureBreakdown,
  clearEmbeddingIndexCache,
  loadEmbeddingIndex,
  reconcileEmbeddingCache,
  enqueueMissingEmbeddings,
  backfillMissingEmbeddings,
  collectEmbeddingBackfillNodes,
  filterEmbeddingBackfillNodes,
  getEmbeddingForCandidate,
  calcEmbeddingSimilarity
};
