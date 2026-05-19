const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { getLastEmbeddingFailure } = require('../memoryEmbeddingClient');
const {
  ensureDir,
  safeReadJsonLines,
  writeJsonLines,
  normalizeText,
  clampText
} = require('../memory-v3/helpers');
const {
  DEFAULT_DOC_MAX_CHARS,
  buildWorldbookDocuments
} = require('./documents');

const CACHE_VERSION = 1;
const FAILURE_REASONS = ['embedding_request_failed', 'empty_embedding', 'rate_limit', 'auth_failed', 'timeout'];

const backfillState = {
  running: false,
  timer: null
};

function sha1(value = '') {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex');
}

function getVectorMemory() {
  try {
    return require('../vectorMemory');
  } catch (_) {
    return {};
  }
}

function shouldUsePersonaWorldbookRemoteEmbedding() {
  const vectorMemory = getVectorMemory();
  return typeof vectorMemory.shouldUseRemoteEmbedding === 'function'
    ? vectorMemory.shouldUseRemoteEmbedding()
    : false;
}

async function requestPersonaWorldbookEmbedding(text = '') {
  const vectorMemory = getVectorMemory();
  if (typeof vectorMemory.requestEmbedding !== 'function') return null;
  return vectorMemory.requestEmbedding(text);
}

function resolveBackfillLimit(options = {}) {
  const explicitLimit = Math.floor(Number(options.limit || 0) || 0);
  if (explicitLimit > 0) return explicitLimit;
  return Math.max(
    1,
    Math.floor(Number(options.maxPerRun || config.PERSONA_WORLDBOOK_EMBEDDING_BACKFILL_MAX_PER_RUN || 24) || 24)
  );
}

function normalizeFailureReason(reason = '') {
  const normalized = normalizeText(reason).toLowerCase();
  return FAILURE_REASONS.includes(normalized) ? normalized : 'empty_embedding';
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

function getEmbeddingModel() {
  return normalizeText(config.MEMORY_EMBEDDING_MODEL);
}

function isEmbeddingEnabled() {
  return Boolean(
    config.PERSONA_WORLDBOOK_SEARCH_ENABLED !== false
    && config.PERSONA_WORLDBOOK_EMBEDDING_ENABLED !== false
    && getEmbeddingModel()
  );
}

function buildEmbeddingIdentity(doc = {}) {
  const text = clampText(doc.text, DEFAULT_DOC_MAX_CHARS);
  const payload = {
    moduleId: normalizeText(doc.moduleId || doc.id),
    model: getEmbeddingModel(),
    textHash: sha1(text),
    fileMtimeMs: Number(doc.fileMtimeMs || 0) || 0,
    fileSize: Number(doc.fileSize || 0) || 0
  };
  return {
    ...payload,
    text,
    key: sha1(JSON.stringify(payload))
  };
}

function normalizeCacheRow(row = {}) {
  if (!row || typeof row !== 'object') return null;
  const moduleId = normalizeText(row.moduleId || row.id);
  const key = normalizeText(row.key);
  if (!moduleId && !key) return null;
  const embedding = Array.isArray(row.embedding) ? row.embedding : [];
  return {
    version: Number(row.version || CACHE_VERSION) || CACHE_VERSION,
    key,
    moduleId,
    model: normalizeText(row.model || getEmbeddingModel()),
    textHash: normalizeText(row.textHash),
    fileMtimeMs: Number(row.fileMtimeMs || 0) || 0,
    fileSize: Number(row.fileSize || 0) || 0,
    embedding,
    lastEmbeddedAt: Number(row.lastEmbeddedAt || 0) || 0,
    status: normalizeText(row.status || (embedding.length > 0 ? 'ready' : 'pending')).toLowerCase(),
    failCount: Math.max(0, Number(row.failCount || 0) || 0),
    nextRetryAt: Math.max(0, Number(row.nextRetryAt || 0) || 0),
    error: normalizeText(row.error)
  };
}

function getCacheFile() {
  return normalizeText(config.PERSONA_WORLDBOOK_EMBEDDING_CACHE_FILE)
    || path.join(config.DATA_DIR, 'persona_worldbook_embedding_cache.jsonl');
}

function loadEmbeddingRows() {
  return safeReadJsonLines(getCacheFile()).map(normalizeCacheRow).filter(Boolean);
}

function loadWorldbookEmbeddingIndex() {
  const rows = loadEmbeddingRows();
  const byKey = new Map();
  const byModuleId = new Map();
  for (const row of rows) {
    if (row.key) byKey.set(row.key, row);
    if (row.moduleId) byModuleId.set(row.moduleId, row);
  }
  return {
    rows,
    byKey,
    byModuleId,
    readyRows: rows.filter((row) => row.status === 'ready' && row.embedding.length > 0)
  };
}

function rowMatchesIdentity(row = {}, identity = {}) {
  return row
    && row.model === identity.model
    && row.textHash === identity.textHash
    && Number(row.fileMtimeMs || 0) === Number(identity.fileMtimeMs || 0)
    && Number(row.fileSize || 0) === Number(identity.fileSize || 0);
}

function reconcilePersonaWorldbookEmbeddingCache(catalog = { modules: [] }, options = {}) {
  ensureDir(path.dirname(getCacheFile()));
  if (!isEmbeddingEnabled()) {
    if (options.dryRun === true) {
      return { enabled: false, rows: 0, ready: 0, pending: 0, reused: 0, created: 0, dropped: 0 };
    }
    writeJsonLines(getCacheFile(), []);
    return { enabled: false, rows: 0, ready: 0, pending: 0, reused: 0, created: 0, dropped: 0 };
  }

  const plan = buildPersonaWorldbookEmbeddingCacheReconcilePlan(catalog);
  if (options.dryRun === true) return plan;
  writeJsonLines(getCacheFile(), plan.rowsData || []);
  return {
    enabled: plan.enabled,
    rows: plan.rows,
    ready: plan.ready,
    pending: plan.pending,
    reused: plan.reused,
    created: plan.created,
    dropped: plan.dropped
  };
}

function buildPersonaWorldbookEmbeddingCacheReconcilePlan(catalog = { modules: [] }) {
  const docs = buildWorldbookDocuments(catalog);
  const index = loadWorldbookEmbeddingIndex();
  const rows = [];
  let reused = 0;
  let created = 0;
  for (const doc of docs) {
    const identity = buildEmbeddingIdentity(doc);
    const existing = index.byKey.get(identity.key) || index.byModuleId.get(identity.moduleId);
    if (rowMatchesIdentity(existing, identity)) {
      reused += 1;
      rows.push({
        ...existing,
        version: CACHE_VERSION,
        key: identity.key,
        moduleId: identity.moduleId,
        model: identity.model,
        textHash: identity.textHash,
        fileMtimeMs: identity.fileMtimeMs,
        fileSize: identity.fileSize
      });
    } else {
      created += 1;
      rows.push({
        version: CACHE_VERSION,
        key: identity.key,
        moduleId: identity.moduleId,
        model: identity.model,
        textHash: identity.textHash,
        fileMtimeMs: identity.fileMtimeMs,
        fileSize: identity.fileSize,
        embedding: [],
        lastEmbeddedAt: 0,
        status: 'pending',
        failCount: 0,
        nextRetryAt: 0,
        error: ''
      });
    }
  }
  return {
    enabled: true,
    rows: rows.length,
    ready: rows.filter((row) => row.status === 'ready' && row.embedding.length > 0).length,
    pending: rows.filter((row) => row.status !== 'ready').length,
    reused,
    created,
    dropped: Math.max(0, index.rows.length + created - rows.length),
    rowsData: rows
  };
}

function buildPersonaWorldbookBackfillPlan(catalog = { modules: [] }, options = {}) {
  if (!isEmbeddingEnabled()) {
    return {
      ok: false,
      enabled: false,
      source: 'worldbook',
      reason: 'embedding_disabled',
      sourceRows: 0,
      readyBefore: 0,
      considered: 0,
      remaining: 0,
      failed: 0,
      staleRows: 0
    };
  }
  const docs = buildWorldbookDocuments(catalog);
  const index = loadWorldbookEmbeddingIndex();
  const plannedRows = [];
  let created = 0;
  for (const doc of docs) {
    const identity = buildEmbeddingIdentity(doc);
    const existing = index.byKey.get(identity.key) || index.byModuleId.get(identity.moduleId);
    if (rowMatchesIdentity(existing, identity)) {
      plannedRows.push({
        ...existing,
        version: CACHE_VERSION,
        key: identity.key,
        moduleId: identity.moduleId,
        model: identity.model,
        textHash: identity.textHash,
        fileMtimeMs: identity.fileMtimeMs,
        fileSize: identity.fileSize
      });
    } else {
      created += 1;
      plannedRows.push({
        version: CACHE_VERSION,
        key: identity.key,
        moduleId: identity.moduleId,
        model: identity.model,
        textHash: identity.textHash,
        fileMtimeMs: identity.fileMtimeMs,
        fileSize: identity.fileSize,
        embedding: [],
        lastEmbeddedAt: 0,
        status: 'pending',
        failCount: 0,
        nextRetryAt: 0,
        error: ''
      });
    }
  }
  const now = Date.now();
  const force = options.force === true || options.forceStale === true;
  const retryFailed = options.retryFailed === true;
  const pending = plannedRows
    .filter((row) => {
      if (row.status === 'ready') return false;
      if (force) return true;
      if (retryFailed && row.status === 'failed') return true;
      return !row.nextRetryAt || row.nextRetryAt <= now;
    })
    .slice(0, resolveBackfillLimit(options));
  return {
    ok: true,
    enabled: true,
    source: 'worldbook',
    sourceRows: docs.length,
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

function schedulePersonaWorldbookEmbeddingBackfill(catalog = { modules: [] }, options = {}) {
  if (!isEmbeddingEnabled() || !shouldUsePersonaWorldbookRemoteEmbedding()) return false;
  if (backfillState.running || backfillState.timer) return false;
  const delayMs = Math.max(0, Number(options.delayMs ?? 350) || 0);
  backfillState.timer = setTimeout(() => {
    backfillState.timer = null;
    backfillPersonaWorldbookEmbeddings(catalog, options).catch((error) => {
      console.warn('[personaWorldbookSearch] background backfill failed:', error.message);
    });
  }, delayMs);
  if (typeof backfillState.timer.unref === 'function') backfillState.timer.unref();
  return true;
}

async function backfillPersonaWorldbookEmbeddings(catalog = { modules: [] }, options = {}) {
  if (!isEmbeddingEnabled() || !shouldUsePersonaWorldbookRemoteEmbedding()) {
    return { ok: false, skipped: true, reason: 'embedding_disabled' };
  }
  if (backfillState.running) {
    return { ok: false, skipped: true, reason: 'already_running' };
  }
  backfillState.running = true;
  try {
    const planBefore = buildPersonaWorldbookBackfillPlan(catalog, options);
    if (options.dryRun === true) {
      return {
        ...planBefore,
        dryRun: true,
        embedded: 0
      };
    }
    reconcilePersonaWorldbookEmbeddingCache(catalog);
    const docsByModuleId = new Map(buildWorldbookDocuments(catalog).map((doc) => [doc.moduleId, doc]));
    const rows = loadEmbeddingRows();
    const now = Date.now();
    const limit = resolveBackfillLimit(options);
    const force = options.force === true || options.forceStale === true;
    const retryFailed = options.retryFailed === true;
    const pending = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        if (row.status === 'ready') return false;
        if (force) return true;
        if (retryFailed && row.status === 'failed') return true;
        return !row.nextRetryAt || row.nextRetryAt <= now;
      })
      .slice(0, limit);
    let embedded = 0;
    let failed = 0;
    for (const { row, index } of pending) {
      const doc = docsByModuleId.get(row.moduleId);
      if (!doc) continue;
      const identity = buildEmbeddingIdentity(doc);
      const embedding = await requestPersonaWorldbookEmbedding(identity.text);
      if (Array.isArray(embedding) && embedding.length > 0) {
        rows[index] = {
          ...row,
          key: identity.key,
          moduleId: identity.moduleId,
          model: identity.model,
          textHash: identity.textHash,
          fileMtimeMs: identity.fileMtimeMs,
          fileSize: identity.fileSize,
          embedding,
          status: 'ready',
          lastEmbeddedAt: Date.now(),
          failCount: 0,
          nextRetryAt: 0,
          error: ''
        };
        embedded += 1;
      } else {
        const failCount = Math.max(0, Number(row.failCount || 0) || 0) + 1;
        const failure = getLastEmbeddingFailure();
        const errorReason = normalizeFailureReason(failure.reason || 'empty_embedding');
        rows[index] = {
          ...row,
          status: 'failed',
          failCount,
          nextRetryAt: Date.now() + Math.min(6 * 60 * 60 * 1000, failCount * 30 * 60 * 1000),
          error: errorReason,
          lastErrorMessage: failure.message || ''
        };
        failed += 1;
      }
    }
    writeJsonLines(getCacheFile(), rows);
    return {
      ok: true,
      source: 'worldbook',
      readyBefore: planBefore.readyBefore || 0,
      considered: pending.length,
      embedded,
      failed,
      failureBreakdown: buildFailureBreakdown(rows),
      remaining: rows.filter((row) => row.status !== 'ready').length,
      pending: pending.length
    };
  } finally {
    backfillState.running = false;
  }
}

module.exports = {
  backfillPersonaWorldbookEmbeddings,
  buildEmbeddingIdentity,
  buildFailureBreakdown,
  buildPersonaWorldbookBackfillPlan,
  buildPersonaWorldbookEmbeddingCacheReconcilePlan,
  isEmbeddingEnabled,
  loadWorldbookEmbeddingIndex,
  reconcilePersonaWorldbookEmbeddingCache,
  requestPersonaWorldbookEmbedding,
  schedulePersonaWorldbookEmbeddingBackfill,
  shouldUsePersonaWorldbookRemoteEmbedding
};
