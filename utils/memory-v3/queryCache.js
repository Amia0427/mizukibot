const config = require('../../config');
const { normalizeText } = require('./helpers');

const queryEmbeddingCache = new Map();

function getNowMs() {
  return Date.now();
}

function getQueryEmbeddingCacheTtlMs() {
  return Math.max(0, Number(config.MEMORY_EMBEDDING_CACHE_TTL_MS || 0) || 0);
}

function getQueryEmbeddingCacheMaxEntries() {
  return Math.max(1, Math.floor(Number(config.MEMORY_QUERY_EMBEDDING_CACHE_MAX || 512) || 512));
}

function buildQueryEmbeddingCacheKey(query = '', facet = 'default', options = {}) {
  return JSON.stringify({
    query: normalizeText(query),
    facet: normalizeText(facet).toLowerCase(),
    userId: normalizeText(options.userId),
    groupId: normalizeText(options.groupId),
    sessionKey: normalizeText(options.sessionKey || options.sessionId),
    source: normalizeText(options.source || 'all').toLowerCase(),
    rewrites: Array.isArray(options.rewrites) ? options.rewrites.map(normalizeText).filter(Boolean) : []
  });
}

function getCachedQueryEmbedding(key = '') {
  const ttlMs = getQueryEmbeddingCacheTtlMs();
  if (!ttlMs || !key || !queryEmbeddingCache.has(key)) return null;
  const entry = queryEmbeddingCache.get(key);
  if (!entry || !Array.isArray(entry.embedding) || entry.embedding.length === 0) {
    queryEmbeddingCache.delete(key);
    return null;
  }
  if (getNowMs() - Number(entry.at || 0) > ttlMs) {
    queryEmbeddingCache.delete(key);
    return null;
  }
  queryEmbeddingCache.delete(key);
  queryEmbeddingCache.set(key, entry);
  return entry.embedding;
}

function setCachedQueryEmbedding(key = '', embedding = []) {
  const ttlMs = getQueryEmbeddingCacheTtlMs();
  if (!ttlMs || !key || !Array.isArray(embedding) || embedding.length === 0) return;
  queryEmbeddingCache.set(key, {
    embedding,
    at: getNowMs()
  });
  const maxEntries = getQueryEmbeddingCacheMaxEntries();
  while (queryEmbeddingCache.size > maxEntries) {
    const firstKey = queryEmbeddingCache.keys().next().value;
    if (!firstKey) break;
    queryEmbeddingCache.delete(firstKey);
  }
}

function clearQueryEmbeddingCache() {
  queryEmbeddingCache.clear();
}

module.exports = {
  buildQueryEmbeddingCacheKey,
  clearQueryEmbeddingCache,
  getCachedQueryEmbedding,
  getNowMs,
  getQueryEmbeddingCacheMaxEntries,
  getQueryEmbeddingCacheTtlMs,
  queryEmbeddingCache,
  setCachedQueryEmbedding
};
