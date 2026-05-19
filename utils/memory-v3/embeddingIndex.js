const config = require('../../config');
const { getLastEmbeddingFailure } = require('../memoryEmbeddingClient');
const {
  ensureDir,
  normalizeText,
  canonicalizeText
} = require('./helpers');
const { isMemoryNotRecallable } = require('./recallFilter');
const { shouldUseRemoteEmbedding, requestEmbedding, cosineArray } = require('../vectorMemory');
const {
  CACHE_VERSION,
  buildEmbeddingIdentity,
  buildEmbeddingText,
  buildFailureBreakdown,
  clearEmbeddingIndexCache,
  filterEmbeddingBackfillNodes,
  findReusableRow,
  getEmbeddingModel,
  isEmbeddingIndexEnabled,
  isJournalEmbeddingDoc,
  loadEmbeddingIndex,
  loadEmbeddingRows,
  makePendingRow,
  normalizeBackfillSource,
  normalizeFailureReason,
  writeEmbeddingRows
} = require('./embeddingIndexCache');
const { createEmbeddingPriority } = require('./embeddingPriority');
const { createEmbeddingNodes } = require('./embeddingNodes');

const backfillState = {
  running: false,
  timer: null
};

const { classifyEmbeddingPriority } = createEmbeddingPriority({
  isJournalEmbeddingDoc
});

const {
  buildNodeMapByEmbeddingKey,
  collectEmbeddingBackfillNodes
} = createEmbeddingNodes({
  buildEmbeddingIdentity
});

function reconcileEmbeddingCache(nodes = [], options = {}) {
  ensureDir(config.MEMORY_V3_PROJECTIONS_DIR);
  const activeNodes = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => normalizeText(node?.text) && normalizeText(node?.status).toLowerCase() !== 'archived' && !isMemoryNotRecallable(node));
  if (!isEmbeddingIndexEnabled()) {
    if (options.dryRun === true) {
      return { enabled: false, rows: 0, ready: 0, pending: 0, reused: 0, created: 0, dropped: 0 };
    }
    writeEmbeddingRows([]);
    return { enabled: false, rows: 0, ready: 0, pending: 0, reused: 0, created: 0, dropped: 0 };
  }

  const plan = buildEmbeddingCacheReconcilePlan(activeNodes, options);
  if (options.dryRun === true) return plan;
  writeEmbeddingRows(plan.rowsData || []);
  return {
    enabled: plan.enabled,
    fullReconcile: plan.fullReconcile,
    rows: plan.rows,
    ready: plan.ready,
    pending: plan.pending,
    reused: plan.reused,
    created: plan.created,
    dropped: plan.dropped,
    dryRun: false
  };
}

function buildEmbeddingCacheReconcilePlan(nodes = [], options = {}) {
  const activeNodes = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => normalizeText(node?.text) && normalizeText(node?.status).toLowerCase() !== 'archived' && !isMemoryNotRecallable(node));
  if (!isEmbeddingIndexEnabled()) {
    return {
      enabled: false,
      fullReconcile: options.fullReconcile === true || options.full === true,
      rows: 0,
      ready: 0,
      pending: 0,
      reused: 0,
      created: 0,
      dropped: 0,
      rowsData: []
    };
  }

  const index = loadEmbeddingIndex();
  const rows = [];
  let reused = 0;
  let created = 0;
  const fullReconcile = options.fullReconcile === true || options.full === true;
  const activeKeys = new Set(activeNodes.map((node) => buildEmbeddingIdentity(node).key).filter(Boolean));
  const activeNodeIds = new Set(activeNodes.map((node) => normalizeText(node.id || node.nodeId)).filter(Boolean));
  const shouldPreserveExisting = (row) => (
    !fullReconcile
    && !activeKeys.has(normalizeText(row.key))
    && !activeNodeIds.has(normalizeText(row.nodeId))
  );

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

  return {
    enabled: true,
    fullReconcile,
    rows: rows.length,
    ready: rows.filter((row) => row.status === 'ready' && row.embedding.length > 0).length,
    pending: rows.filter((row) => row.status !== 'ready').length,
    reused,
    created,
    dropped: Math.max(0, index.rows.length + created - rows.length),
    rowsData: rows
  };
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
  const nodePriorityByKey = new Map();
  let created = 0;

  for (const node of nodes) {
    const identity = buildEmbeddingIdentity(node);
    nodePriorityByKey.set(identity.key, classifyEmbeddingPriority(node));
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
      const priorityA = nodePriorityByKey.get(a.key) || classifyEmbeddingPriority(a);
      const priorityB = nodePriorityByKey.get(b.key) || classifyEmbeddingPriority(b);
      if (priorityA.rank !== priorityB.rank) return priorityA.rank - priorityB.rank;
      const retryDiff = Number(a.nextRetryAt || 0) - Number(b.nextRetryAt || 0);
      if (retryDiff !== 0) return retryDiff;
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    })
    .slice(0, resolveBackfillLimit(options));
  const batchSize = Math.max(1, Math.floor(Number(options.batchSize || config.MEMORY_EMBEDDING_BACKFILL_BATCH_SIZE || 32) || 32));
  const remaining = plannedRows.filter((row) => row.status !== 'ready').length;
  const byPriority = {};
  for (const row of plannedRows.filter((item) => item.status !== 'ready')) {
    const priority = nodePriorityByKey.get(row.key) || classifyEmbeddingPriority(row);
    if (!byPriority[priority.priority]) {
      byPriority[priority.priority] = {
        pending: 0,
        considered: 0,
        reason: priority.reason
      };
    }
    byPriority[priority.priority].pending += 1;
  }
  for (const row of pending) {
    const priority = nodePriorityByKey.get(row.key) || classifyEmbeddingPriority(row);
    if (!byPriority[priority.priority]) {
      byPriority[priority.priority] = {
        pending: 0,
        considered: 0,
        reason: priority.reason
      };
    }
    byPriority[priority.priority].considered += 1;
  }
  const nextPriority = pending.length > 0
    ? (nodePriorityByKey.get(pending[0].key) || classifyEmbeddingPriority(pending[0]))
    : null;

  return {
    ok: true,
    enabled: true,
    source,
    sourceRows: nodes.length,
    rows: plannedRows.length,
    readyBefore: plannedRows.filter((row) => row.status === 'ready' && Array.isArray(row.embedding) && row.embedding.length > 0).length,
    considered: pending.length,
    remaining,
    failed: plannedRows.filter((row) => row.status === 'failed').length,
    failureBreakdown: buildFailureBreakdown(plannedRows),
    staleRows: plannedRows.filter((row) => row.status === 'stale').length,
    created,
    priority: nextPriority?.priority || '',
    reason: nextPriority?.reason || '',
    byPriority,
    estimatedBatches: Math.ceil(remaining / batchSize),
    checkpoint: {
      source,
      remaining,
      nextNodeId: pending[0]?.nodeId || '',
      nextPriority: nextPriority?.priority || ''
    }
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
  const stats = Array.isArray(nodes) ? reconcileEmbeddingCache(nodes, options) : {
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
    reconcileEmbeddingCache(selectedNodes, {
      fullReconcile: options.fullReconcile === true || options.full === true
    });
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
        const priorityA = classifyEmbeddingPriority(nodeMap.get(a.row.key)?.node || a.row);
        const priorityB = classifyEmbeddingPriority(nodeMap.get(b.row.key)?.node || b.row);
        if (priorityA.rank !== priorityB.rank) return priorityA.rank - priorityB.rank;
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
  buildEmbeddingCacheReconcilePlan,
  buildEmbeddingBackfillPlan,
  buildFailureBreakdown,
  classifyEmbeddingPriority,
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
