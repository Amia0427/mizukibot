const fs = require('fs');
const config = require('../../config');
const { safeReadJson, safeReadJsonLines } = require('./helpers');

const readCache = new Map();

function cloneFallback(fallback) {
  if (typeof fallback === 'function') return fallback();
  return fallback;
}

function fileSignature(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${Number(stat.mtimeMs || 0)}:${Number(stat.size || 0)}`;
  } catch (_) {
    return `${filePath}:missing`;
  }
}

function readCachedJson(filePath, fallbackFactory) {
  const signature = fileSignature(filePath);
  const cached = readCache.get(filePath);
  if (cached && cached.signature === signature) return cached.value;
  const fallback = cloneFallback(fallbackFactory);
  const value = safeReadJson(filePath, fallback);
  readCache.set(filePath, { signature, value });
  return value;
}

function readCachedJsonLines(filePath) {
  const signature = fileSignature(filePath);
  const cached = readCache.get(filePath);
  if (cached && cached.signature === signature) return cached.value;
  const value = safeReadJsonLines(filePath);
  readCache.set(filePath, { signature, value });
  return value;
}

function clearProjectionReadCache() {
  readCache.clear();
}

function defaultSessionProjection() {
  return { version: 2, updatedAt: 0, sessions: {} };
}

function defaultProfileProjection() {
  return {
    version: 2,
    updatedAt: 0,
    users: {}
  };
}

function defaultScopeProjection() {
  return { version: 1, updatedAt: 0, users: {} };
}

function defaultEpisodeProjection() {
  return { version: 1, updatedAt: 0, users: {} };
}

function loadSessionProjection() {
  return readCachedJson(config.MEMORY_V3_SESSION_PROJECTION_FILE, defaultSessionProjection);
}

function loadProfileProjection() {
  return readCachedJson(config.MEMORY_V3_PROFILE_PROJECTION_FILE, defaultProfileProjection);
}

function loadScopeProjection() {
  return readCachedJson(config.MEMORY_V3_SCOPE_PROJECTION_FILE, defaultScopeProjection);
}

function loadEpisodeProjection() {
  return readCachedJson(config.MEMORY_V3_EPISODE_PROJECTION_FILE, defaultEpisodeProjection);
}

function loadMemoryNodes() {
  return readCachedJsonLines(config.MEMORY_V3_NODES_FILE);
}

function loadEmbeddingCache() {
  return readCachedJsonLines(config.MEMORY_V3_EMBEDDING_CACHE_FILE);
}

module.exports = {
  clearProjectionReadCache,
  defaultSessionProjection,
  defaultProfileProjection,
  defaultScopeProjection,
  defaultEpisodeProjection,
  loadSessionProjection,
  loadProfileProjection,
  loadScopeProjection,
  loadEpisodeProjection,
  loadMemoryNodes,
  loadEmbeddingCache
};
