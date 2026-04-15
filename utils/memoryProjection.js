const fs = require('fs');
const path = require('path');
const config = require('../config');
const {
  getMemoryItems,
  getMemoryItemsByFilter,
  rebuildMemoryIndex,
  addMemoryItemsBatch
} = require('./vectorMemory');

const LEGACY_MEMORY_LIMITS = Object.freeze({
  facts: 30,
  factLength: 400,
  profileItems: 20,
  profileItemLength: 160,
  recentTopics: 12,
  summaryLength: 1200,
  impressionLength: 800,
  relationStageLength: 32,
  relationshipLength: 32,
  attitudeLength: 120,
  affinityReasonLength: 160
});

const MIGRATION_DIR = path.join(config.DATA_DIR, 'memory_migration');
const PROJECTION_FILE = path.join(config.DATA_DIR, 'memory_projection.json');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  const text = JSON.stringify(payload, null, 2);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, text, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM' && error.code !== 'EXDEV') throw error;
  }
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function sanitizeText(value, maxLength = 0) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!maxLength) return text;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeUniqueStringList(values = [], itemLimit = 20, itemMaxLength = 160) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const text = sanitizeText(raw, itemMaxLength);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= Math.max(1, Number(itemLimit) || 1)) break;
  }
  return out;
}

function defaultFavorite() {
  return {
    points: 0,
    level: '陌生人',
    relationship: '陌生人',
    attitude: '中立、保持距离',
    trust_score: 0,
    last_affinity_reason: '',
    last_affinity_source: '',
    last_affinity_update_at: 0,
    scope: 'global',
    last_morning: '',
    last_night: '',
    group_id: '',
    last_group_seen_at: 0,
    last_seen_at: 0
  };
}

function defaultProfile() {
  return {
    identities: [],
    personality_traits: [],
    hobbies: [],
    likes: [],
    dislikes: [],
    goals: [],
    recent_topics: [],
    relation_stage: '陌生人'
  };
}

function defaultMemory() {
  return {
    facts: [],
    profile: defaultProfile(),
    summary: '',
    impression: ''
  };
}

function tierRank(value = '') {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'S') return 4;
  if (normalized === 'A') return 3;
  if (normalized === 'B') return 2;
  if (normalized === 'C') return 1;
  return 0;
}

function sourceKindRank(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'explicit') return 5;
  if (normalized === 'journal') return 4;
  if (normalized === 'rollup') return 4;
  if (normalized === 'extractor') return 3;
  if (normalized === 'legacy') return 2;
  return 1;
}

function compareMemoryItems(a, b) {
  const statusA = String(a?.status || '').trim().toLowerCase();
  const statusB = String(b?.status || '').trim().toLowerCase();
  if (statusA !== statusB) {
    if (statusA === 'active') return -1;
    if (statusB === 'active') return 1;
  }

  const sourceDelta = sourceKindRank(b?.sourceKind) - sourceKindRank(a?.sourceKind);
  if (sourceDelta !== 0) return sourceDelta;

  const confidenceDelta = Number(b?.confidence || 0) - Number(a?.confidence || 0);
  if (confidenceDelta !== 0) return confidenceDelta;

  const importanceDelta = Number(b?.importance || 0) - Number(a?.importance || 0);
  if (importanceDelta !== 0) return importanceDelta;

  const tierDelta = tierRank(b?.tier) - tierRank(a?.tier);
  if (tierDelta !== 0) return tierDelta;

  return Number(b?.updatedAt || b?.createdAt || 0) - Number(a?.updatedAt || a?.createdAt || 0);
}

function dedupeAndSort(items = []) {
  return Array.from(items)
    .sort(compareMemoryItems)
    .filter((item, index, list) => {
      const text = sanitizeText(item?.text || item?.canonicalText || '');
      if (!text) return false;
      const key = `${String(item?.type || '').toLowerCase()}|${text.toLowerCase()}`;
      return list.findIndex((candidate) => {
        const candidateText = sanitizeText(candidate?.text || candidate?.canonicalText || '');
        return `${String(candidate?.type || '').toLowerCase()}|${candidateText.toLowerCase()}` === key;
      }) === index;
    });
}

function chooseConflictWinner(group = []) {
  const sorted = dedupeAndSort(group);
  return sorted[0] || null;
}

function buildConflictGroups(items = []) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = sanitizeText(item?.conflictKey || '');
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function projectUserProfile(userId, items = [], favorite = null) {
  const profile = defaultProfile();
  const memory = defaultMemory();
  memory.profile = profile;

  const activeItems = dedupeAndSort(
    items.filter((item) => String(item?.status || '').toLowerCase() !== 'archived')
  );

  const conflictGroups = buildConflictGroups(activeItems);
  const suppressedIds = new Set();
  for (const group of conflictGroups.values()) {
    const winner = chooseConflictWinner(group);
    for (const item of group) {
      if (!winner || String(item.id) !== String(winner.id)) suppressedIds.add(String(item.id));
    }
  }

  for (const item of activeItems) {
    if (suppressedIds.has(String(item.id))) continue;
    const type = String(item.type || '').trim().toLowerCase();
    const text = sanitizeText(item.text || item.canonicalText || '', LEGACY_MEMORY_LIMITS.factLength);
    if (!text) continue;

    if (type === 'summary' && !memory.summary) {
      memory.summary = sanitizeText(text, LEGACY_MEMORY_LIMITS.summaryLength);
      continue;
    }
    if (type === 'impression' && !memory.impression) {
      memory.impression = sanitizeText(text, LEGACY_MEMORY_LIMITS.impressionLength);
      continue;
    }
    if (type === 'identity') {
      profile.identities = normalizeUniqueStringList([...profile.identities, text], LEGACY_MEMORY_LIMITS.profileItems, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }
    if (type === 'personality') {
      profile.personality_traits = normalizeUniqueStringList([...profile.personality_traits, text], LEGACY_MEMORY_LIMITS.profileItems, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }
    if (type === 'hobby') {
      profile.hobbies = normalizeUniqueStringList([...profile.hobbies, text], LEGACY_MEMORY_LIMITS.profileItems, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }
    if (type === 'like') {
      profile.likes = normalizeUniqueStringList([...profile.likes, text], LEGACY_MEMORY_LIMITS.profileItems, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }
    if (type === 'dislike') {
      profile.dislikes = normalizeUniqueStringList([...profile.dislikes, text], LEGACY_MEMORY_LIMITS.profileItems, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }
    if (type === 'goal') {
      profile.goals = normalizeUniqueStringList([...profile.goals, text], LEGACY_MEMORY_LIMITS.profileItems, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }
    if (type === 'topic') {
      profile.recent_topics = normalizeUniqueStringList([...profile.recent_topics, text], LEGACY_MEMORY_LIMITS.recentTopics, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }

    memory.facts = normalizeUniqueStringList(
      [...memory.facts, text],
      LEGACY_MEMORY_LIMITS.facts,
      LEGACY_MEMORY_LIMITS.factLength
    );
  }

  if (favorite && typeof favorite === 'object') {
    profile.relation_stage = sanitizeText(
      favorite.relationship || favorite.level || profile.relation_stage || '陌生人',
      LEGACY_MEMORY_LIMITS.relationStageLength
    ) || '陌生人';
  }

  return memory;
}

function buildProjection() {
  const items = getMemoryItems();
  const favorites = safeReadJson(config.DATA_FILE, {});
  const users = new Set([
    ...Object.keys(favorites || {}),
    ...items.map((item) => String(item.userId || '').trim()).filter(Boolean)
  ]);

  const projection = {
    version: 1,
    generatedAt: Date.now(),
    users: {},
    favorites: {}
  };

  for (const userId of users) {
    const userItems = items.filter((item) => String(item.userId || '').trim() === userId);
    const favorite = favorites[userId] && typeof favorites[userId] === 'object'
      ? { ...defaultFavorite(), ...favorites[userId] }
      : defaultFavorite();
    projection.users[userId] = projectUserProfile(userId, userItems, favorite);
    projection.favorites[userId] = favorite;
  }

  return projection;
}

function saveProjection(projection = null) {
  const next = projection && typeof projection === 'object'
    ? projection
    : buildProjection();
  atomicWriteJson(PROJECTION_FILE, next);
  return next;
}

function loadProjection() {
  const fallback = {
    version: 1,
    generatedAt: 0,
    users: {},
    favorites: {}
  };
  const loaded = safeReadJson(PROJECTION_FILE, fallback);
  if (!loaded || typeof loaded !== 'object') return fallback;
  if (!loaded.users || typeof loaded.users !== 'object') loaded.users = {};
  if (!loaded.favorites || typeof loaded.favorites !== 'object') loaded.favorites = {};
  return loaded;
}

function createMigrationSnapshot() {
  ensureDir(MIGRATION_DIR);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(MIGRATION_DIR, `memory_migration_snapshot_${timestamp}.json`);
  const payload = {
    createdAt: Date.now(),
    memories: safeReadJson(config.MEMORY_FILE, {}),
    favorites: safeReadJson(config.DATA_FILE, {}),
    projection: safeReadJson(PROJECTION_FILE, null)
  };
  atomicWriteJson(snapshotPath, payload);
  return snapshotPath;
}

function makeConflictKey(userId, type, text) {
  const uid = sanitizeText(userId);
  const normalizedType = sanitizeText(type).toLowerCase();
  const normalizedText = sanitizeText(text).toLowerCase();
  if (!uid || !normalizedType || !normalizedText) return '';

  if (normalizedType === 'like' || normalizedType === 'dislike') {
    return `${uid}|preference|${normalizedText}`;
  }
  if (normalizedType === 'identity') {
    return `${uid}|identity|${normalizedText}`;
  }
  if (normalizedType === 'goal') {
    return `${uid}|goal|${normalizedText}`;
  }
  if (normalizedType === 'summary') {
    return `${uid}|summary|primary`;
  }
  if (normalizedType === 'impression') {
    return `${uid}|impression|primary`;
  }
  return '';
}

function convertLegacyMemoriesToItems() {
  const legacyMemories = safeReadJson(config.MEMORY_FILE, {});
  const items = [];

  for (const [userId, entry] of Object.entries(legacyMemories || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const profile = entry.profile && typeof entry.profile === 'object' ? entry.profile : {};

    const appendItems = (type, values, extra = {}) => {
      for (const value of Array.isArray(values) ? values : []) {
        const text = sanitizeText(value, LEGACY_MEMORY_LIMITS.profileItemLength);
        if (!text) continue;
        items.push({
          userId,
          text,
          type,
          source: 'legacy_memory_migration',
          sourceKind: 'legacy',
          status: ['identity', 'goal', 'summary', 'impression'].includes(type) ? 'active' : 'candidate',
          confidence: ['identity', 'goal', 'summary', 'impression'].includes(type) ? 0.9 : 0.82,
          conflictKey: makeConflictKey(userId, type, text),
          ...extra
        });
      }
    };

    appendItems('identity', profile.identities);
    appendItems('personality', profile.personality_traits);
    appendItems('hobby', profile.hobbies);
    appendItems('like', profile.likes);
    appendItems('dislike', profile.dislikes);
    appendItems('goal', profile.goals);
    appendItems('topic', profile.recent_topics, {
      confidence: 0.78
    });
    appendItems('fact', entry.facts, {
      confidence: 0.8
    });

    const summary = sanitizeText(entry.summary, LEGACY_MEMORY_LIMITS.summaryLength);
    if (summary) {
      items.push({
        userId,
        text: summary,
        type: 'summary',
        source: 'legacy_memory_migration',
        sourceKind: 'legacy',
        status: 'active',
        confidence: 0.9,
        conflictKey: makeConflictKey(userId, 'summary', summary)
      });
    }

    const impression = sanitizeText(entry.impression, LEGACY_MEMORY_LIMITS.impressionLength);
    if (impression) {
      items.push({
        userId,
        text: impression,
        type: 'impression',
        source: 'legacy_memory_migration',
        sourceKind: 'legacy',
        status: 'active',
        confidence: 0.88,
        conflictKey: makeConflictKey(userId, 'impression', impression)
      });
    }
  }

  return items;
}

function importLegacyMemoriesToItemStore() {
  const legacyItems = convertLegacyMemoriesToItems();
  if (legacyItems.length === 0) {
    return {
      inserted: 0
    };
  }

  const before = getMemoryItems().length;
  addMemoryItemsBatch(legacyItems);
  const after = getMemoryItems().length;
  return {
    inserted: Math.max(0, after - before),
    attempted: legacyItems.length
  };
}

function buildMigrationReport() {
  const items = getMemoryItems();
  const conflicts = [];
  for (const [conflictKey, group] of buildConflictGroups(items).entries()) {
    if (group.length < 2) continue;
    const winner = chooseConflictWinner(group);
    conflicts.push({
      conflictKey,
      size: group.length,
      winnerId: winner?.id || '',
      ids: group.map((item) => item.id)
    });
  }

  return {
    generatedAt: Date.now(),
    totalItems: items.length,
    candidateCount: items.filter((item) => String(item.status || '').toLowerCase() === 'candidate').length,
    archivedCount: items.filter((item) => String(item.status || '').toLowerCase() === 'archived').length,
    activeCount: items.filter((item) => String(item.status || '').toLowerCase() === 'active').length,
    conflictGroups: conflicts.length,
    conflicts
  };
}

function runMemoryMigration() {
  const snapshotFile = createMigrationSnapshot();
  const importResult = importLegacyMemoriesToItemStore();
  rebuildMemoryIndex();
  const projection = saveProjection();
  const report = buildMigrationReport();
  return {
    ok: true,
    snapshotFile: path.basename(snapshotFile),
    projectionFile: path.basename(PROJECTION_FILE),
    projectionUsers: Object.keys(projection.users || {}).length,
    importResult,
    report
  };
}

module.exports = {
  PROJECTION_FILE,
  buildProjection,
  buildMigrationReport,
  loadProjection,
  projectUserProfile,
  runMemoryMigration,
  saveProjection
};
