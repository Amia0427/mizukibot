const fs = require('fs');
const path = require('path');
const config = require('../../config');
const {
  loadSessionProjection,
  loadProfileProjection,
  loadScopeProjection,
  loadEpisodeProjection,
  loadMemoryNodes
} = require('./storage');
const {
  normalizeText,
  safeReadJson
} = require('./helpers');
const {
  getDailyJournalFileStats
} = require('./journalDocs');
const {
  buildDailyJournalDocs,
  buildEpisodeDocs,
  buildNodeDocs,
  buildNotebookDocs,
  buildProfileDocs,
  buildSessionDocs,
  makeDocBase
} = require('./cliSearchSnapshot/docs');

const NOTEBOOK_ROOT = path.join(config.DATA_DIR, 'notebook');

function nowMs() {
  return Date.now();
}

function normalizeArray(values) {
  return Array.isArray(values) ? values : [];
}

function safeStat(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    return {
      filePath,
      mtimeMs: Number(stat.mtimeMs || 0) || 0,
      size: Number(stat.size || 0) || 0
    };
  } catch (_) {
    return {
      filePath,
      mtimeMs: 0,
      size: 0
    };
  }
}

function snapshotSignature(meta = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      parts.push(`${key}:${value.map((item) => `${item.filePath}:${item.mtimeMs}:${item.size}`).join(',')}`);
      continue;
    }
    if (value && typeof value === 'object') {
      parts.push(`${key}:${value.filePath || key}:${value.mtimeMs || 0}:${value.size || 0}`);
      continue;
    }
    parts.push(`${key}:${String(value || '')}`);
  }
  return parts.join('|');
}

function readNotebookUsers() {
  try {
    if (!fs.existsSync(NOTEBOOK_ROOT)) return [];
    return fs.readdirSync(NOTEBOOK_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch (_) {
    return [];
  }
}

function readNotebookIndexes(userIds = []) {
  const indexes = new Map();
  const fileStats = [];
  for (const userId of Array.isArray(userIds) ? userIds : []) {
    const filePath = path.join(NOTEBOOK_ROOT, String(userId || '').trim(), 'index.json');
    const stat = safeStat(filePath);
    fileStats.push(stat);
    const index = safeReadJson(filePath, {
      docs: [],
      file_state: {},
      updated_at: ''
    });
    indexes.set(String(userId || '').trim(), index && typeof index === 'object' ? index : { docs: [], file_state: {}, updated_at: '' });
  }
  return { indexes, fileStats };
}

function readNotebookIndexStats(userIds = []) {
  return normalizeArray(userIds).map((userId) => {
    const filePath = path.join(NOTEBOOK_ROOT, String(userId || '').trim(), 'index.json');
    return safeStat(filePath);
  });
}

function pushIndexValue(map, key, value) {
  const normalizedKey = normalizeText(key);
  const normalizedValue = String(value || '').trim();
  if (!normalizedKey || !normalizedValue) return;
  if (!map.has(normalizedKey)) map.set(normalizedKey, []);
  map.get(normalizedKey).push(normalizedValue);
}

function finalizeIndex(map) {
  for (const [key, values] of map.entries()) {
    const unique = Array.from(new Set(normalizeArray(values).map((item) => String(item || '').trim()).filter(Boolean)));
    map.set(key, unique);
  }
  return map;
}

function buildSnapshot() {
  const hydrateStartedAt = nowMs();
  const meta = {
    sessionProjection: safeStat(config.MEMORY_V3_SESSION_PROJECTION_FILE),
    profileProjection: safeStat(config.MEMORY_V3_PROFILE_PROJECTION_FILE),
    scopeProjection: safeStat(config.MEMORY_V3_SCOPE_PROJECTION_FILE),
    episodeProjection: safeStat(config.MEMORY_V3_EPISODE_PROJECTION_FILE),
    memoryNodes: safeStat(config.MEMORY_V3_NODES_FILE),
    embeddingCache: safeStat(config.MEMORY_V3_EMBEDDING_CACHE_FILE),
    dailyJournalFiles: getDailyJournalFileStats()
  };
  const sessionProjection = loadSessionProjection();
  const profileProjection = loadProfileProjection();
  const scopeProjection = loadScopeProjection();
  const episodeProjection = loadEpisodeProjection();
  const memoryNodes = loadMemoryNodes();
  const notebookUsers = readNotebookUsers();
  const notebookData = readNotebookIndexes(notebookUsers);
  meta.notebookIndexes = notebookData.fileStats;
  const signature = snapshotSignature(meta);

  const rawSnapshot = {
    sessionProjection,
    profileProjection,
    scopeProjection,
    episodeProjection,
    memoryNodes,
    notebookIndexes: notebookData.indexes
  };

  const dailyJournalDocs = buildDailyJournalDocs();
  const docs = []
    .concat(buildSessionDocs(rawSnapshot))
    .concat(buildProfileDocs(rawSnapshot))
    .concat(buildNodeDocs(rawSnapshot))
    .concat(buildEpisodeDocs(rawSnapshot))
    .concat(dailyJournalDocs)
    .concat(buildNotebookDocs(rawSnapshot));

  const docsById = new Map();
  const docIdsBySource = new Map();
  const docIdsByUser = new Map();
  const docIdsByGroup = new Map();
  const docIdsBySession = new Map();
  const docIdsByMemoryKind = new Map();
  const docIdsByFieldKey = new Map();
  const docIdsByOwner = new Map();

  for (const doc of docs) {
    if (!doc || !doc.id || !doc.text) continue;
    docsById.set(doc.id, doc);
    pushIndexValue(docIdsBySource, doc.source, doc.id);
    pushIndexValue(docIdsByUser, doc.userId, doc.id);
    pushIndexValue(docIdsByOwner, doc.ownerUserId || doc.userId, doc.id);
    pushIndexValue(docIdsByGroup, doc.groupId, doc.id);
    pushIndexValue(docIdsBySession, doc.sessionKey || doc.sessionId, doc.id);
    pushIndexValue(docIdsByMemoryKind, doc.memoryKind, doc.id);
    pushIndexValue(docIdsByFieldKey, doc.fieldKey, doc.id);
  }

  return {
    signature,
    loadedAt: nowMs(),
    buildMs: nowMs() - hydrateStartedAt,
    meta,
    docsById,
    docIdsBySource: finalizeIndex(docIdsBySource),
    docIdsByUser: finalizeIndex(docIdsByUser),
    docIdsByOwner: finalizeIndex(docIdsByOwner),
    docIdsByGroup: finalizeIndex(docIdsByGroup),
    docIdsBySession: finalizeIndex(docIdsBySession),
    docIdsByMemoryKind: finalizeIndex(docIdsByMemoryKind),
    docIdsByFieldKey: finalizeIndex(docIdsByFieldKey),
    projections: {
      sessionProjection,
      profileProjection,
      scopeProjection,
      episodeProjection,
      notebookIndexes: notebookData.indexes
    }
  };
}

function shouldReloadSnapshot(current = null) {
  if (!current) return true;
  const notebookUsers = readNotebookUsers();
  const meta = {
    sessionProjection: safeStat(config.MEMORY_V3_SESSION_PROJECTION_FILE),
    profileProjection: safeStat(config.MEMORY_V3_PROFILE_PROJECTION_FILE),
    scopeProjection: safeStat(config.MEMORY_V3_SCOPE_PROJECTION_FILE),
    episodeProjection: safeStat(config.MEMORY_V3_EPISODE_PROJECTION_FILE),
    memoryNodes: safeStat(config.MEMORY_V3_NODES_FILE),
    embeddingCache: safeStat(config.MEMORY_V3_EMBEDDING_CACHE_FILE),
    dailyJournalFiles: getDailyJournalFileStats(),
    notebookIndexes: readNotebookIndexStats(notebookUsers)
  };
  return snapshotSignature(meta) !== String(current.signature || '');
}

module.exports = {
  makeDocBase,
  buildSessionDocs,
  buildProfileDocs,
  buildNodeDocs,
  buildEpisodeDocs,
  buildDailyJournalDocs,
  buildNotebookDocs,
  buildSnapshot,
  shouldReloadSnapshot,
  safeStat,
  snapshotSignature
};
