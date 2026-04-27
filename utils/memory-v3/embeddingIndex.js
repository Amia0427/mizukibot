const crypto = require('crypto');
const config = require('../../config');
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

function loadEmbeddingRows() {
  return safeReadJsonLines(config.MEMORY_V3_EMBEDDING_CACHE_FILE)
    .map(normalizeCacheRow)
    .filter(Boolean);
}

function loadEmbeddingIndex() {
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
  return {
    rows,
    byKey,
    byNodeId,
    byCanonicalKey,
    readyRows: rows.filter((row) => row.status === 'ready' && row.embedding.length > 0)
  };
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
    writeJsonLines(config.MEMORY_V3_EMBEDDING_CACHE_FILE, []);
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

  writeJsonLines(config.MEMORY_V3_EMBEDDING_CACHE_FILE, rows);
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

function loadNodeMapByEmbeddingKey() {
  const map = new Map();
  for (const node of collectEmbeddingBackfillNodes()) {
    const identity = buildEmbeddingIdentity(node);
    map.set(identity.key, { node, identity });
  }
  return map;
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
    reconcileEmbeddingCache(collectEmbeddingBackfillNodes());
    const rows = loadEmbeddingRows();
    const nodeMap = loadNodeMapByEmbeddingKey();
    const batchSize = Math.max(1, Math.floor(Number(options.batchSize || config.MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE || 32) || 32));
    const maxPerRun = Math.max(1, Math.floor(Number(options.maxPerRun || config.MEMORY_EMBEDDING_BACKFILL_MAX_PER_RUN || 128) || 128));
    const limit = Math.min(batchSize, maxPerRun);
    const force = options.force === true;
    const pending = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.status !== 'ready' && (force || !row.nextRetryAt || row.nextRetryAt <= now))
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
      rows[item.index] = {
        ...item.row,
        status: 'failed',
        failCount,
        nextRetryAt: Date.now() + Math.max(60000, Number(config.MEMORY_EMBEDDING_RETRY_COOLDOWN_MS || 1800000) || 1800000),
        error: 'embedding_request_failed'
      };
      failed += 1;
    }

    writeJsonLines(config.MEMORY_V3_EMBEDDING_CACHE_FILE, rows);
    const remaining = rows.filter((row) => row.status !== 'ready').length;
    const journalRemaining = rows.filter((row) => isJournalEmbeddingDoc(row) && row.status !== 'ready').length;
    if (journalRemaining > 0 && options.continue !== false && embedded > 0) {
      continueOptions = {
        ...options,
        force: false,
        delayMs: Math.max(1000, Number(options.continueDelayMs ?? 60000) || 60000)
      };
    }
    return {
      ok: true,
      considered: pending.length,
      embedded,
      failed,
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
  loadEmbeddingIndex,
  reconcileEmbeddingCache,
  enqueueMissingEmbeddings,
  backfillMissingEmbeddings,
  getEmbeddingForCandidate,
  calcEmbeddingSimilarity
};
