const crypto = require('crypto');
const fs = require('fs');
const config = require('../../config');
const {
  safeReadJsonLines,
  writeJsonLines,
  normalizeText,
  clampText,
  canonicalizeText
} = require('./helpers');

const CACHE_VERSION = 1;
const DEFAULT_DOC_MAX_CHARS = 1800;
const BACKFILL_SOURCE_SET = new Set(['all', 'memory', 'journal']);
const FAILURE_REASONS = ['embedding_request_failed', 'empty_embedding', 'rate_limit', 'auth_failed', 'timeout'];

let embeddingIndexCache = null;

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
    || source === 'episode'
    || type === 'episode'
    || type === 'daily_journal'
    || type === 'daily_journal_segment'
    || nodeId.startsWith('episode:')
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

module.exports = {
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
  normalizeCacheRow,
  normalizeFailureReason,
  rowMatchesIdentity,
  writeEmbeddingRows
};
