const config = require('../config');
const {
  cosineArray,
  embedText,
  embedTexts,
  getEmbeddingModel,
  hashText,
  normalizeEmbeddingVector
} = require('./memoryEmbeddingClient');

const DEFAULT_QUERY_CACHE_MAX_ENTRIES = 500;
const DEFAULT_QUERY_CACHE_TTL_MS = 5 * 60 * 1000;

const queryCache = new Map();

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeList(values = []) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = sanitizeText(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function buildEmbeddingText(item = {}) {
  const parts = [];
  if (item.type) parts.push(`type: ${item.type}`);
  if (item.memoryKind || item.meta?.memoryKind) parts.push(`kind: ${item.memoryKind || item.meta?.memoryKind}`);
  if (item.scopeType) parts.push(`scope: ${item.scopeType}`);
  if (item.taskType) parts.push(`task: ${item.taskType}`);
  if (item.text) parts.push(`text: ${item.text}`);
  const entities = normalizeList(item.entities || item.meta?.entities || []);
  const relations = normalizeList(item.relations || item.meta?.relations || []);
  const participants = normalizeList(item.participants || item.meta?.participants || []);
  if (entities.length) parts.push(`entities: ${entities.join(', ')}`);
  if (relations.length) parts.push(`relations: ${relations.join(', ')}`);
  if (participants.length) parts.push(`participants: ${participants.join(', ')}`);
  if (item.trigger || item.meta?.trigger) parts.push(`trigger: ${item.trigger || item.meta?.trigger}`);
  if (item.strategy || item.meta?.strategy) parts.push(`strategy: ${item.strategy || item.meta?.strategy}`);
  if (item.avoid || item.meta?.avoid) parts.push(`avoid: ${item.avoid || item.meta?.avoid}`);

  const maxChars = Math.max(64, Number(config.MEMORY_EMBEDDING_MAX_TEXT_CHARS) || 1200);
  return parts.join('\n').slice(0, maxChars).trim();
}

function getEmbeddingMeta(item = {}) {
  const meta = item.meta && typeof item.meta === 'object' ? item.meta : {};
  const embeddingMeta = meta.embeddingMeta && typeof meta.embeddingMeta === 'object'
    ? meta.embeddingMeta
    : (item.embeddingMeta && typeof item.embeddingMeta === 'object' ? item.embeddingMeta : {});
  return {
    model: sanitizeText(embeddingMeta.model),
    dimensions: Number(embeddingMeta.dimensions || 0) || 0,
    textHash: sanitizeText(embeddingMeta.textHash),
    generatedAt: Number(embeddingMeta.generatedAt || 0) || 0
  };
}

function isEmbeddingFresh(item = {}, options = {}) {
  const vector = normalizeEmbeddingVector(item.meta?.embedding || item.embedding);
  if (!vector) return false;
  const embeddingText = buildEmbeddingText(item);
  if (!embeddingText) return false;
  const embeddingMeta = getEmbeddingMeta(item);
  const model = sanitizeText(options.model || getEmbeddingModel());
  if (model && embeddingMeta.model && embeddingMeta.model !== model) return false;
  if (embeddingMeta.dimensions && embeddingMeta.dimensions !== vector.length) return false;
  return embeddingMeta.textHash === hashText(embeddingText);
}

function attachEmbeddingToItem(item = {}, vector = null, options = {}) {
  const normalized = normalizeEmbeddingVector(vector);
  if (!item || typeof item !== 'object' || !normalized) return item;
  const embeddingText = buildEmbeddingText(item);
  item.meta = {
    ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
    embedding: normalized,
    embeddingMeta: {
      model: sanitizeText(options.model || getEmbeddingModel()),
      dimensions: normalized.length,
      textHash: hashText(embeddingText),
      generatedAt: Number(options.generatedAt || Date.now()) || Date.now()
    }
  };
  return item;
}

function semanticScoreDoc(queryEmbedding = null, doc = {}) {
  const queryVector = normalizeEmbeddingVector(queryEmbedding);
  const docVector = normalizeEmbeddingVector(doc.meta?.embedding || doc.embedding);
  if (!queryVector || !docVector) return 0;
  if (!isEmbeddingFresh(doc)) return 0;
  return Math.max(0, cosineArray(queryVector, docVector));
}

function getQueryEmbeddingCacheTtlMs() {
  return Math.max(1000, Number(config.MEMORY_EMBEDDING_CACHE_TTL_MS) || DEFAULT_QUERY_CACHE_TTL_MS);
}

function getQueryEmbeddingCacheMaxEntries() {
  return Math.max(1, Math.floor(Number(
    config.MEMORY_QUERY_EMBEDDING_CACHE_MAX
    || config.MEMORY_EMBEDDING_CACHE_MAX_ENTRIES
    || process.env.MEMORY_QUERY_EMBEDDING_CACHE_MAX
    || process.env.MEMORY_EMBEDDING_CACHE_MAX_ENTRIES
    || DEFAULT_QUERY_CACHE_MAX_ENTRIES
  ) || DEFAULT_QUERY_CACHE_MAX_ENTRIES));
}

function pruneQueryEmbeddingCache(maxEntries = getQueryEmbeddingCacheMaxEntries()) {
  while (queryCache.size > maxEntries) {
    const oldestKey = queryCache.keys().next().value;
    if (oldestKey === undefined) break;
    queryCache.delete(oldestKey);
  }
}

function getCachedQueryEmbedding(key = '', now = Date.now()) {
  if (!key) return null;
  const cached = queryCache.get(key);
  if (!cached || !Array.isArray(cached.vector) || cached.expiresAt <= now) {
    if (cached) queryCache.delete(key);
    return null;
  }
  queryCache.delete(key);
  queryCache.set(key, cached);
  return cached.vector;
}

function setCachedQueryEmbedding(key = '', vector = null, ttlMs = getQueryEmbeddingCacheTtlMs(), now = Date.now()) {
  const normalized = normalizeEmbeddingVector(vector);
  if (!key || !normalized) return;
  queryCache.set(key, {
    vector: normalized,
    expiresAt: now + Math.max(1000, Number(ttlMs) || DEFAULT_QUERY_CACHE_TTL_MS)
  });
  pruneQueryEmbeddingCache();
}

async function embedQueryText(query = '', options = {}) {
  const text = sanitizeText(query);
  if (!text) return null;
  if (Array.isArray(options.queryEmbedding)) return normalizeEmbeddingVector(options.queryEmbedding);

  const model = sanitizeText(options.model || getEmbeddingModel());
  const key = `${model}:${hashText(text)}`;
  const cached = getCachedQueryEmbedding(key);
  if (cached) return cached;

  const vector = await embedText(text, options);
  if (vector) setCachedQueryEmbedding(key, vector, getQueryEmbeddingCacheTtlMs());
  return vector || null;
}

async function embedMemoryItems(items = [], options = {}) {
  const list = Array.isArray(items) ? items : [];
  const stale = list.filter((item) => item && !isEmbeddingFresh(item, options));
  if (!stale.length) return { attempted: 0, embedded: 0, items: list };

  const batchSize = Math.max(1, Number(options.batchSize || config.MEMORY_EMBEDDING_BATCH_SIZE) || 16);
  let embedded = 0;
  for (let i = 0; i < stale.length; i += batchSize) {
    const batch = stale.slice(i, i + batchSize);
    const vectors = await embedTexts(batch.map((item) => buildEmbeddingText(item)), options);
    for (let j = 0; j < batch.length; j += 1) {
      if (!vectors[j]) continue;
      attachEmbeddingToItem(batch[j], vectors[j], options);
      embedded += 1;
    }
  }

  return { attempted: stale.length, embedded, items: list };
}

function clearQueryEmbeddingCache() {
  queryCache.clear();
}

function getQueryEmbeddingCacheStats() {
  return {
    size: queryCache.size,
    maxEntries: getQueryEmbeddingCacheMaxEntries(),
    ttlMs: getQueryEmbeddingCacheTtlMs()
  };
}

module.exports = {
  buildEmbeddingText,
  getEmbeddingMeta,
  isEmbeddingFresh,
  attachEmbeddingToItem,
  semanticScoreDoc,
  embedQueryText,
  embedMemoryItems,
  clearQueryEmbeddingCache,
  getQueryEmbeddingCacheStats,
  _test: {
    getCachedQueryEmbedding,
    getQueryEmbeddingCacheMaxEntries,
    getQueryEmbeddingCacheTtlMs,
    pruneQueryEmbeddingCache,
    queryCache,
    setCachedQueryEmbedding
  }
};
