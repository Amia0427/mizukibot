const path = require('path');
const config = require('../config');
const { BoundedCache } = require('./boundedCache');
const { createJsonHotStore, createJsonLineHotWriter } = require('./jsonHotStore');

const jsonStoreCache = new BoundedCache({
  maxEntries: Math.max(8, Number(config.EPHEMERAL_CACHE_MAX_SESSIONS || 512) || 512),
  ttlMs: Math.max(0, Number(config.EPHEMERAL_CACHE_TTL_MS || 30 * 60 * 1000) || (30 * 60 * 1000))
});
const jsonLineWriterCache = new BoundedCache({
  maxEntries: Math.max(8, Number(config.EPHEMERAL_CACHE_MAX_SESSIONS || 512) || 512),
  ttlMs: Math.max(0, Number(config.EPHEMERAL_CACHE_TTL_MS || 30 * 60 * 1000) || (30 * 60 * 1000))
});

function normalizeFileKey(filePath = '') {
  return path.resolve(String(filePath || '').trim());
}

function getJsonStore(filePath, options = {}) {
  const key = normalizeFileKey(filePath);
  return jsonStoreCache.getOrCompute(key, () => createJsonHotStore(key, {
    fallback: options.fallback,
    debounceMs: Math.max(0, Number(options.debounceMs || config.HOT_STORE_DEBOUNCE_MS || 250) || 250),
    maxDelayMs: Math.max(0, Number(options.maxDelayMs || config.HOT_STORE_MAX_DELAY_MS || 2000) || 2000),
    deserialize: options.deserialize,
    serialize: options.serialize
  }));
}

function getJsonLineWriter(filePath, options = {}) {
  const key = normalizeFileKey(filePath);
  return jsonLineWriterCache.getOrCompute(key, () => createJsonLineHotWriter(key, {
    debounceMs: Math.max(0, Number(options.debounceMs || config.HOT_STORE_DEBOUNCE_MS || 250) || 250),
    maxDelayMs: Math.max(0, Number(options.maxDelayMs || config.HOT_STORE_MAX_DELAY_MS || 2000) || 2000),
    serializeLine: options.serializeLine
  }));
}

module.exports = {
  getJsonLineWriter,
  getJsonStore
};
