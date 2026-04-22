const config = require('../../config');
const { safeReadJson, safeReadJsonLines } = require('./helpers');

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
  return safeReadJson(config.MEMORY_V3_SESSION_PROJECTION_FILE, defaultSessionProjection());
}

function loadProfileProjection() {
  return safeReadJson(config.MEMORY_V3_PROFILE_PROJECTION_FILE, defaultProfileProjection());
}

function loadScopeProjection() {
  return safeReadJson(config.MEMORY_V3_SCOPE_PROJECTION_FILE, defaultScopeProjection());
}

function loadEpisodeProjection() {
  return safeReadJson(config.MEMORY_V3_EPISODE_PROJECTION_FILE, defaultEpisodeProjection());
}

function loadMemoryNodes() {
  return safeReadJsonLines(config.MEMORY_V3_NODES_FILE);
}

function loadEmbeddingCache() {
  return safeReadJsonLines(config.MEMORY_V3_EMBEDDING_CACHE_FILE);
}

module.exports = {
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
