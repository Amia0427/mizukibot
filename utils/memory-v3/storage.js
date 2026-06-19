const fs = require('fs');
const config = require('../../config');
const { safeReadJson, safeReadJsonLines } = require('./helpers');

function cloneFallback(fallback) {
  if (typeof fallback === 'function') return fallback();
  return fallback;
}

function readJson(filePath, fallbackFactory) {
  const fallback = cloneFallback(fallbackFactory);
  return safeReadJson(filePath, fallback);
}

function clearProjectionReadCache() {
  return true;
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
  return readJson(config.MEMORY_V3_SESSION_PROJECTION_FILE, defaultSessionProjection);
}

function loadProfileProjection() {
  return readJson(config.MEMORY_V3_PROFILE_PROJECTION_FILE, defaultProfileProjection);
}

function loadScopeProjection() {
  return readJson(config.MEMORY_V3_SCOPE_PROJECTION_FILE, defaultScopeProjection);
}

function loadEpisodeProjection() {
  return readJson(config.MEMORY_V3_EPISODE_PROJECTION_FILE, defaultEpisodeProjection);
}

function scanJsonLines(filePath, predicate = null, limit = 0) {
  if (!fs.existsSync(filePath)) return [];
  const output = [];
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let carry = '';
  function visitLine(line) {
    const text = String(line || '').trim();
    if (!text) return false;
    try {
      const item = JSON.parse(text);
      if (typeof predicate === 'function' && !predicate(item)) return false;
      output.push(item);
      return limit > 0 && output.length >= limit;
    } catch (_) {}
    return false;
  }
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      const chunk = carry + buffer.toString('utf8', 0, bytesRead);
      const lines = chunk.split(/\r?\n/);
      carry = lines.pop() || '';
      let done = false;
      for (const line of lines) {
        if (visitLine(line)) {
          done = true;
          break;
        }
      }
      if (done) break;
    }
    if ((limit <= 0 || output.length < limit) && carry) {
      visitLine(carry);
    }
  } finally {
    fs.closeSync(fd);
  }
  return output;
}

function loadMemoryNodes(options = {}) {
  if (!options || Object.keys(options).length === 0) {
    return safeReadJsonLines(config.MEMORY_V3_NODES_FILE);
  }
  return scanJsonLines(config.MEMORY_V3_NODES_FILE, options.predicate, options.limit);
}

function loadMemoryNodesForUser(userId = '', options = {}) {
  const uid = String(userId || '').trim();
  const groupIds = new Set((Array.isArray(options.groupIds) ? options.groupIds : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean));
  const limit = Math.max(0, Number(options.limit || 0) || 0);
  return scanJsonLines(config.MEMORY_V3_NODES_FILE, (node) => {
    const nodeUserId = String(node?.userId || '').trim();
    const scopeType = String(node?.scopeType || '').trim().toLowerCase();
    const groupId = String(node?.groupId || '').trim();
    if (scopeType === 'group') return groupIds.has(groupId);
    return uid && nodeUserId === uid;
  }, limit);
}

function loadSessionProjectionForUser(userId = '', options = {}) {
  const uid = String(userId || '').trim();
  const currentSessionKey = String(options.sessionKey || '').trim();
  const projection = loadSessionProjection();
  const sessions = {};
  for (const [key, session] of Object.entries(projection.sessions || {})) {
    if (String(session?.userId || '').trim() === uid || key === currentSessionKey) {
      sessions[key] = session;
    }
  }
  return { ...projection, sessions };
}

function loadProfileProjectionForUser(userId = '') {
  const uid = String(userId || '').trim();
  const projection = loadProfileProjection();
  return {
    ...projection,
    users: uid && projection.users?.[uid] ? { [uid]: projection.users[uid] } : {}
  };
}

function loadScopeProjectionForUser(userId = '') {
  const uid = String(userId || '').trim();
  const projection = loadScopeProjection();
  return {
    ...projection,
    users: uid && projection.users?.[uid] ? { [uid]: projection.users[uid] } : {}
  };
}

function loadEpisodeProjectionForUser(userId = '') {
  const uid = String(userId || '').trim();
  const projection = loadEpisodeProjection();
  return {
    ...projection,
    users: uid && projection.users?.[uid] ? { [uid]: projection.users[uid] } : {}
  };
}

function loadEmbeddingCache() {
  return safeReadJsonLines(config.MEMORY_V3_EMBEDDING_CACHE_FILE);
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
  loadMemoryNodesForUser,
  loadSessionProjectionForUser,
  loadProfileProjectionForUser,
  loadScopeProjectionForUser,
  loadEpisodeProjectionForUser,
  loadEmbeddingCache
};
