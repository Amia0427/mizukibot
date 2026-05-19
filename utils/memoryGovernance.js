const fs = require('fs');
const path = require('path');
const config = require('../config');
const { rebuildMemoryIndex } = require('./vectorMemory');
const { loadProjection, runMemoryMigration, saveProjection } = require('./memoryProjection');
const { createMemoryGovernancePlanHelpers } = require('./memoryGovernance/plan');

const ITEMS_FILE = path.join(config.DATA_DIR, 'memory_items.json');
const SNAPSHOT_DIR = path.join(config.DATA_DIR, 'memory_snapshots');

const DEFAULTS = {
  mode: 'balanced',
  action: 'archive',
  minConfidence: 0.72,
  topicTtlDays: 21,
  dedupeThreshold: 0.9
};

function nowTs() {
  return Date.now();
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[memoryGovernance] read json failed:', filePath, e.message);
    return fallback;
  }
}

function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const text = JSON.stringify(obj, null, 2);
  try {
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.writeFileSync(filePath, text, 'utf-8');
    } finally {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (_) {}
    }
    if (e.code !== 'EPERM' && e.code !== 'EXDEV') throw e;
  }
}

function ensureSnapshotDir() {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
}

function resolveSnapshotPath(snapshotFile) {
  const name = String(snapshotFile || '').trim();
  if (!name) throw new Error('snapshot file is required');
  // Keep snapshot names strict to avoid ../ traversal and arbitrary file reads.
  if (path.basename(name) !== name) throw new Error('invalid snapshot file name');
  if (!/^memory_items_.*\.json$/i.test(name)) throw new Error('invalid snapshot file name');

  const root = path.resolve(SNAPSHOT_DIR);
  const fullPath = path.resolve(path.join(SNAPSHOT_DIR, name));
  const rel = path.relative(root, fullPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('snapshot file must stay inside snapshot dir');
  }
  return { name, fullPath };
}

function loadLibrary() {
  const fallback = { version: 2, items: [] };
  const data = safeReadJson(ITEMS_FILE, fallback);
  if (!data || typeof data !== 'object') return fallback;
  if (!Array.isArray(data.items)) data.items = [];
  return { version: 2, items: data.items };
}

function saveLibrary(library) {
  atomicWriteJson(ITEMS_FILE, {
    version: 2,
    items: Array.isArray(library?.items) ? library.items : []
  });
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeStringArray(values = []) {
  const list = Array.isArray(values) ? values : [values];
  return Array.from(new Set(list.map((item) => normalizeText(item)).filter(Boolean)));
}

const {
  buildGovernancePlan,
  mergeIntoKeeper
} = createMemoryGovernancePlanHelpers({
  defaults: DEFAULTS,
  nowTs
});

function listConflictGroups(filters = {}) {
  const userId = normalizeText(filters.userId || filters.user_id);
  const items = loadLibrary().items
    .filter((item) => !userId || String(item.userId || '') === userId)
    .filter((item) => String(item.conflictKey || '').trim());

  const groups = new Map();
  for (const item of items) {
    const key = String(item.conflictKey || '').trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  return Array.from(groups.entries())
    .map(([conflictKey, list]) => {
      const sorted = list
        .slice()
        .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
      return {
        conflictKey,
        userId: String(sorted[0]?.userId || ''),
        size: sorted.length,
        items: sorted.map((item) => ({
          id: item.id,
          text: item.text,
          type: item.type,
          status: item.status,
          sourceKind: item.sourceKind,
          confidence: item.confidence,
          importance: item.importance,
          tier: item.tier,
          updatedAt: item.updatedAt || item.createdAt || 0
        }))
      };
    })
    .filter((row) => row.items.length > 1)
    .sort((a, b) => b.size - a.size || String(a.conflictKey).localeCompare(String(b.conflictKey)));
}

function resolveConflictGroup(conflictKey = '', winnerId = '') {
  const key = normalizeText(conflictKey);
  const chosenWinnerId = normalizeText(winnerId);
  if (!key) throw new Error('conflictKey is required');
  if (!chosenWinnerId) throw new Error('winnerId is required');

  const library = loadLibrary();
  let foundWinner = false;
  let changed = 0;

  for (const item of library.items) {
    if (String(item.conflictKey || '').trim() !== key) continue;
    if (String(item.id || '').trim() === chosenWinnerId) {
      item.status = 'active';
      item.updatedAt = nowTs();
      item.meta = {
        ...(item.meta || {}),
        resolvedByGovernance: true,
        resolvedConflictKey: key
      };
      foundWinner = true;
      changed += 1;
      continue;
    }

    if (String(item.status || '').trim().toLowerCase() !== 'archived') {
      item.status = 'archived';
      item.updatedAt = nowTs();
      item.meta = {
        ...(item.meta || {}),
        archivedReason: 'governance_conflict_resolution',
        resolvedConflictKey: key,
        winnerId: chosenWinnerId
      };
      changed += 1;
    }
  }

  if (!foundWinner) throw new Error('winnerId not found in conflict group');
  if (changed > 0) {
    saveLibrary(library);
    rebuildMemoryIndex(library);
    saveProjection();
  }

  return {
    ok: true,
    conflictKey: key,
    winnerId: chosenWinnerId,
    changed
  };
}

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

function createSnapshot(label = 'manual') {
  ensureSnapshotDir();
  const safeLabel = String(label || 'manual').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 24) || 'manual';
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const file = `memory_items_${stamp}_${safeLabel}.json`;
  const fullPath = path.join(SNAPSHOT_DIR, file);
  const library = loadLibrary();
  atomicWriteJson(fullPath, library);
  return file;
}

function listSnapshots(limit = 30) {
  ensureSnapshotDir();
  const files = fs.readdirSync(SNAPSHOT_DIR)
    .filter((name) => /^memory_items_.*\.json$/i.test(name))
    .map((name) => {
      const full = path.join(SNAPSHOT_DIR, name);
      const stat = fs.statSync(full);
      return {
        file: name,
        size: stat.size,
        createdAt: stat.mtimeMs
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  return files.slice(0, Math.max(1, Math.min(200, Number(limit) || 30)));
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

function hasAnyPostReplyLearningRef(item = {}) {
  const meta = item.meta && typeof item.meta === 'object' ? item.meta : {};
  const decision = meta.learningDecision && typeof meta.learningDecision === 'object' ? meta.learningDecision : {};
  const phase = normalizeText(decision.phase).toLowerCase();
  return Boolean(
    decision.jobId
    || decision.postReplyJobId
    || meta.jobId
    || meta.postReplyJobId
    || item.jobId
    || item.postReplyJobId
    || phase === 'post_reply_learning'
    || phase === 'post_reply_enrich_write'
  );
}

function collectItemLearningJobIds(item = {}) {
  const meta = item.meta && typeof item.meta === 'object' ? item.meta : {};
  const decision = meta.learningDecision && typeof meta.learningDecision === 'object' ? meta.learningDecision : {};
  return normalizeStringArray([
    item.jobId,
    item.postReplyJobId,
    meta.jobId,
    meta.postReplyJobId,
    decision.jobId,
    decision.postReplyJobId
  ]);
}

function collectItemLearningTurnIds(item = {}) {
  const meta = item.meta && typeof item.meta === 'object' ? item.meta : {};
  const decision = meta.learningDecision && typeof meta.learningDecision === 'object' ? meta.learningDecision : {};
  return normalizeStringArray([
    item.turnId,
    ...(Array.isArray(item.turnIds) ? item.turnIds : []),
    meta.turnId,
    ...(Array.isArray(meta.turnIds) ? meta.turnIds : []),
    decision.turnId,
    ...(Array.isArray(decision.turnIds) ? decision.turnIds : [])
  ]);
}

function itemMatchesPostReplyLearningRef(item = {}, criteria = {}) {
  if (!item || typeof item !== 'object') return false;
  const userId = normalizeText(criteria.userId);
  if (userId && normalizeText(item.userId) !== userId) return false;
  if (!hasAnyPostReplyLearningRef(item)) return false;

  const jobIds = normalizeStringArray([criteria.jobId, criteria.postReplyJobId]);
  const turnIds = normalizeStringArray([
    criteria.turnId,
    ...(Array.isArray(criteria.turnIds) ? criteria.turnIds : [])
  ]);
  const itemJobIds = collectItemLearningJobIds(item);
  const itemTurnIds = collectItemLearningTurnIds(item);
  const jobMatched = jobIds.length === 0 || jobIds.some((id) => itemJobIds.includes(id));
  const turnMatched = turnIds.length === 0 || turnIds.some((id) => itemTurnIds.includes(id));
  return jobMatched && turnMatched;
}

function rollbackPostReplyLearning(options = {}) {
  const jobIds = normalizeStringArray([options.jobId, options.postReplyJobId]);
  const turnIds = normalizeStringArray([
    options.turnId,
    ...(Array.isArray(options.turnIds) ? options.turnIds : [])
  ]);
  if (jobIds.length === 0 && turnIds.length === 0) {
    throw new Error('jobId, postReplyJobId, turnId, or turnIds is required');
  }

  const library = loadLibrary();
  const matches = library.items
    .filter((item) => itemMatchesPostReplyLearningRef(item, {
      ...options,
      jobId: jobIds[0] || '',
      postReplyJobId: jobIds[1] || options.postReplyJobId || '',
      turnIds
    }))
    .map((item) => ({
      id: String(item.id || '').trim(),
      userId: String(item.userId || '').trim(),
      status: String(item.status || 'active').trim() || 'active',
      text: normalizeText(item.text || item.canonicalText || '')
    }))
    .filter((item) => item.id);

  if (options.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      matched: matches.length,
      changed: 0,
      ids: matches.map((item) => item.id),
      items: matches
    };
  }

  const activeIds = new Set(
    matches
      .filter((item) => normalizeText(item.status).toLowerCase() !== 'archived')
      .map((item) => item.id)
  );
  if (activeIds.size === 0) {
    return {
      ok: true,
      dryRun: false,
      matched: matches.length,
      changed: 0,
      snapshot: '',
      ids: matches.map((item) => item.id),
      items: matches
    };
  }

  const snapshot = createSnapshot('post_reply_rollback');
  const now = nowTs();
  const reason = normalizeText(options.reason) || 'post_reply_learning_rollback';
  for (const item of library.items) {
    if (!activeIds.has(String(item.id || '').trim())) continue;
    item.status = 'archived';
    item.updatedAt = now;
    item.meta = {
      ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
      archivedByGovernance: true,
      rollback: {
        reason,
        jobIds,
        turnIds,
        rolledBackAt: now
      }
    };
  }

  saveLibrary({ version: 2, items: library.items });
  rebuildMemoryIndex({ version: 2, items: library.items });
  saveProjection();

  return {
    ok: true,
    dryRun: false,
    matched: matches.length,
    changed: activeIds.size,
    snapshot,
    ids: matches.map((item) => item.id),
    items: matches
  };
}

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
