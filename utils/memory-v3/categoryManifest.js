const { deriveMemoryMetadata } = require('./categoryMetadata');
const { normalizeText } = require('./helpers');
const { buildSnapshot } = require('./cliSearchSnapshot');

function increment(map, key = '', amount = 1) {
  const normalized = normalizeText(key);
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) || 0) + amount);
}

function topEntries(map, limit = 12) {
  return Array.from(map.entries())
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || String(a[0]).localeCompare(String(b[0])))
    .slice(0, Math.max(1, Number(limit) || 1))
    .map(([name, count]) => ({ name, count }));
}

function emptyBucket(category = '') {
  return {
    category,
    count: 0,
    latestAt: 0,
    sources: {},
    tags: [],
    intents: [],
    privacyLevels: {}
  };
}

function addDocToBuckets(buckets, doc = {}) {
  const metadata = deriveMemoryMetadata(doc);
  if (!metadata.category) return;
  if (!buckets.has(metadata.category)) buckets.set(metadata.category, {
    bucket: emptyBucket(metadata.category),
    tagCounts: new Map(),
    intentCounts: new Map()
  });
  const entry = buckets.get(metadata.category);
  entry.bucket.count += 1;
  entry.bucket.latestAt = Math.max(Number(entry.bucket.latestAt || 0) || 0, Number(doc.updatedAt || doc.ts || 0) || 0);
  entry.bucket.sources[doc.source || 'unknown'] = (entry.bucket.sources[doc.source || 'unknown'] || 0) + 1;
  entry.bucket.privacyLevels[metadata.privacyLevel] = (entry.bucket.privacyLevels[metadata.privacyLevel] || 0) + 1;
  for (const tag of metadata.tags) increment(entry.tagCounts, tag);
  increment(entry.intentCounts, metadata.intent);
}

function finalizeBuckets(buckets) {
  return Array.from(buckets.values())
    .map((entry) => ({
      ...entry.bucket,
      tags: topEntries(entry.tagCounts, 16),
      intents: topEntries(entry.intentCounts, 8)
    }))
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || String(a.category).localeCompare(String(b.category)));
}

function buildMemoryCategoryManifestFromDocs(docs = [], options = {}) {
  const buckets = new Map();
  const sourceCounts = {};
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (!doc || !doc.text) continue;
    sourceCounts[doc.source || 'unknown'] = (sourceCounts[doc.source || 'unknown'] || 0) + 1;
    addDocToBuckets(buckets, doc);
  }
  const categories = finalizeBuckets(buckets);
  return {
    schemaVersion: 'memory_category_manifest_v1',
    generatedAt: Number(options.generatedAt || Date.now()) || Date.now(),
    totalDocs: categories.reduce((sum, item) => sum + Number(item.count || 0), 0),
    sourceCounts,
    categories,
    categoryNames: categories.map((item) => item.category)
  };
}

function buildMemoryCategoryManifest(options = {}) {
  const snapshot = options.snapshot || buildSnapshot();
  const docs = Array.from(snapshot.docsById?.values?.() || []);
  return buildMemoryCategoryManifestFromDocs(docs, {
    generatedAt: options.generatedAt
  });
}

function compactMemoryCategoryManifest(manifest = {}, limit = 12) {
  const categories = Array.isArray(manifest.categories) ? manifest.categories : [];
  return {
    schemaVersion: manifest.schemaVersion || 'memory_category_manifest_v1',
    generatedAt: Number(manifest.generatedAt || 0) || 0,
    totalDocs: Number(manifest.totalDocs || 0) || 0,
    sourceCounts: manifest.sourceCounts || {},
    categories: categories.slice(0, Math.max(1, Number(limit) || 12)).map((item) => ({
      category: item.category,
      count: item.count,
      latestAt: item.latestAt,
      sources: item.sources,
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
      intents: Array.isArray(item.intents) ? item.intents.slice(0, 4) : [],
      privacyLevels: item.privacyLevels || {}
    }))
  };
}

module.exports = {
  buildMemoryCategoryManifest,
  buildMemoryCategoryManifestFromDocs,
  compactMemoryCategoryManifest
};
