const fs = require('fs');
const path = require('path');
const config = require('../config');
const { rebuildMemoryIndex } = require('./vectorMemory');
const { loadProjection, runMemoryMigration, saveProjection } = require('./memoryProjection');
const {
  DEFAULTS,
  normalizeStringArray,
  normalizeText,
  nowTs
} = require('./memoryGovernance/common');
const { createMemoryGovernanceConflictHandlers } = require('./memoryGovernance/conflicts');
const { createMemoryGovernancePlanHelpers } = require('./memoryGovernance/plan');
const { createPostReplyLearningRollback } = require('./memoryGovernance/postReplyRollback');
const { createMemoryGovernanceStore } = require('./memoryGovernance/store');

const ITEMS_FILE = path.join(config.DATA_DIR, 'memory_items.json');
const SNAPSHOT_DIR = path.join(config.DATA_DIR, 'memory_snapshots');

const {
  canonicalizeText,
  clamp,
  buildGovernancePlan,
  mergeIntoKeeper
} = createMemoryGovernancePlanHelpers({
  defaults: DEFAULTS,
  nowTs
});
const {
  createSnapshot,
  ensureSnapshotDir,
  listSnapshots,
  loadLibrary,
  resolveSnapshotPath,
  safeReadJson,
  saveLibrary
} = createMemoryGovernanceStore({
  itemsFile: ITEMS_FILE,
  snapshotDir: SNAPSHOT_DIR
});
const {
  listConflictGroups,
  resolveConflictGroup
} = createMemoryGovernanceConflictHandlers({
  loadLibrary,
  normalizeText,
  nowTs,
  rebuildMemoryIndex,
  saveLibrary,
  saveProjection
});

function rebuildMemoryArtifacts() {
  const library = loadLibrary();
  rebuildMemoryIndex(library);
  const projection = saveProjection();
  return {
    ok: true,
    totalItems: Array.isArray(library.items) ? library.items.length : 0,
    projectionUsers: Object.keys(projection.users || {}).length
  };
}

function previewGovernance(options = {}) {
  const library = loadLibrary();
  const plan = buildGovernancePlan(library.items, options);
  const previewRows = plan.plans.slice(0, 200).map((row) => {
    const item = library.items.find((it) => String(it.id) === String(row.id));
    return {
      id: row.id,
      userId: item?.userId || '',
      type: item?.type || '',
      text: normalizeText(item?.text || ''),
      op: row.op,
      reason: row.reason,
      mergeTo: row.mergeTo || ''
    };
  });

  return {
    ok: true,
    plan: plan.options,
    stats: plan.stats,
    preview: previewRows
  };
}

function applyGovernance(options = {}) {
  const library = loadLibrary();
  const plan = buildGovernancePlan(library.items, options);
  if (plan.plans.length === 0) {
    return {
      ok: true,
      changed: false,
      snapshot: '',
      plan: plan.options,
      stats: plan.stats,
      after: {
        total: library.items.length,
        active: library.items.filter((x) => String(x.status || 'active') === 'active').length
      }
    };
  }

  const snapshot = createSnapshot('governance');
  const itemMap = new Map(library.items.map((item) => [String(item.id), item]));
  const removeSet = new Set();
  const now = nowTs();

  for (const row of plan.plans) {
    const item = itemMap.get(String(row.id));
    if (!item) continue;

    if (row.mergeTo) {
      const keeper = itemMap.get(String(row.mergeTo));
      if (keeper) mergeIntoKeeper(keeper, item);
    }

    if (row.op === 'delete') {
      removeSet.add(String(row.id));
      continue;
    }

    item.status = 'archived';
    item.updatedAt = now;
    item.meta = {
      ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
      governance: {
        reason: row.reason,
        at: now
      }
    };
  }

  const nextItems = plan.options.action === 'delete'
    ? library.items.filter((item) => !removeSet.has(String(item.id)))
    : library.items;

  saveLibrary({ version: 2, items: nextItems });
  rebuildMemoryIndex();
  saveProjection();

  return {
    ok: true,
    changed: true,
    snapshot,
    plan: plan.options,
    stats: plan.stats,
    after: {
      total: nextItems.length,
      active: nextItems.filter((x) => String(x.status || 'active') === 'active').length
    }
  };
}

const { rollbackPostReplyLearning } = createPostReplyLearningRollback({
  createSnapshot,
  loadLibrary,
  normalizeStringArray,
  normalizeText,
  nowTs,
  rebuildMemoryIndex,
  saveLibrary,
  saveProjection
});

const rollbackMemoryWritesByLearningRef = rollbackPostReplyLearning;

function listMemoryItems(filters = {}) {
  const userId = String(filters.userId || '').trim();
  const type = String(filters.type || '').trim();
  const status = String(filters.status || '').trim();
  const limit = Math.max(1, Math.min(1000, Number(filters.limit) || 200));

  const library = loadLibrary();
  let items = library.items.slice();
  if (userId) items = items.filter((x) => String(x.userId) === userId);
  if (type) items = items.filter((x) => String(x.type) === type);
  if (status) items = items.filter((x) => String(x.status || 'active') === status);

  items.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
  return items.slice(0, limit);
}

function getGovernanceStats(userId = '') {
  const library = loadLibrary();
  const items = library.items.filter((item) => (userId ? String(item.userId) === String(userId) : true));
  const byType = {};
  const byStatus = {};
  const byUser = {};

  for (const item of items) {
    const t = String(item.type || 'fact');
    const s = String(item.status || 'active');
    const u = String(item.userId || '');
    byType[t] = (byType[t] || 0) + 1;
    byStatus[s] = (byStatus[s] || 0) + 1;
    byUser[u] = (byUser[u] || 0) + 1;
  }

  return {
    total: items.length,
    byType,
    byStatus,
    topUsers: Object.entries(byUser)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id, count]) => ({ userId: id, count }))
  };
}

function updateMemoryItem(id, patch = {}) {
  const targetId = String(id || '').trim();
  if (!targetId) throw new Error('id is required');

  const library = loadLibrary();
  const item = library.items.find((x) => String(x.id) === targetId);
  if (!item) throw new Error('memory item not found');

  if (Object.prototype.hasOwnProperty.call(patch, 'text')) {
    const text = normalizeText(patch.text);
    if (!text) throw new Error('text cannot be empty');
    item.text = text;
    item.canonicalText = canonicalizeText(text);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'type')) {
    const t = String(patch.type || '').trim().toLowerCase();
    if (!['fact', 'like', 'dislike', 'goal', 'topic'].includes(t)) {
      throw new Error('invalid type');
    }
    item.type = t;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'confidence')) {
    item.confidence = clamp(patch.confidence, 0.01, 1);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'importance')) {
    item.importance = clamp(patch.importance, 0.2, 3);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    const s = String(patch.status || '').trim().toLowerCase();
    if (!['active', 'archived'].includes(s)) throw new Error('invalid status');
    item.status = s;
  }

  item.updatedAt = nowTs();
  saveLibrary(library);
  rebuildMemoryIndex();
  saveProjection();

  return { ok: true, item };
}

function archiveMemoryItem(id, reason = 'manual_archive') {
  return updateMemoryItem(id, {
    status: 'archived',
    reason
  });
}

function rollbackSnapshot(snapshotFile) {
  ensureSnapshotDir();
  const resolved = resolveSnapshotPath(snapshotFile);

  if (!fs.existsSync(resolved.fullPath)) throw new Error('snapshot file not found');
  const data = safeReadJson(resolved.fullPath, null);
  if (!data || !Array.isArray(data.items)) throw new Error('invalid snapshot data');

  createSnapshot('before_rollback');
  saveLibrary({ version: 2, items: data.items });
  rebuildMemoryIndex();
  saveProjection();

  return {
    ok: true,
    restored: resolved.name,
    total: data.items.length
  };
}

module.exports = {
  listMemoryItems,
  getGovernanceStats,
  previewGovernance,
  applyGovernance,
  listConflictGroups,
  resolveConflictGroup,
  rebuildMemoryArtifacts,
  runMemoryMigration,
  listSnapshots,
  rollbackSnapshot,
  rollbackPostReplyLearning,
  rollbackMemoryWritesByLearningRef,
  updateMemoryItem,
  archiveMemoryItem
};
