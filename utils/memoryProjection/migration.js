const path = require('path');
const config = require('../../config');
const {
  addMemoryItemsBatch,
  getMemoryItems,
  rebuildMemoryIndex
} = require('../vectorMemory');
const {
  LEGACY_MEMORY_LIMITS,
  MIGRATION_DIR,
  PROJECTION_FILE,
  atomicWriteJson,
  ensureDir,
  safeReadJson,
  sanitizeText
} = require('./common');
const {
  buildConflictGroups,
  chooseConflictWinner,
  makeConflictKey
} = require('./conflicts');
const { saveProjection } = require('./persistence');

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
  buildMigrationReport,
  convertLegacyMemoriesToItems,
  createMigrationSnapshot,
  importLegacyMemoriesToItemStore,
  runMemoryMigration
};
