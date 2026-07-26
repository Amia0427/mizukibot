const config = require('../../../config');
const { importanceToTier, normalizeTier } = require('../../../utils/memoryTier');
const {
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  clamp,
  getItemMemoryKind,
  normalizeStatus,
  nowTs
} = require('./normalization');
const {
  ensureShardStateHydrated,
  getMemoryItems,
  getShardIndexStore,
  getShardItemsStore,
  isExpired,
  listAllShardEntries,
  materializeShardIndex,
  syncCompatSnapshots,
  updateManifestForShard
} = require('./store-runtime');
const { calcMemoryStrength } = require('./scoring-core');

function touchAccessStats(userId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;

  const wanted = new Set(ids.map((id) => String(id)));
  ensureShardStateHydrated();
  let changed = false;
  for (const entry of listAllShardEntries()) {
    let shardChanged = false;
    for (const item of entry.items.items) {
      if (String(item.userId) !== String(userId)) continue;
      if (!wanted.has(String(item.id))) continue;
      const touchedAt = nowTs();
      item.lastAccessAt = touchedAt;
      if (config.MEMORY_RECALL_TOUCH_ENABLED !== false) item.lastRecalledAt = touchedAt;
      item.accessCount = Math.max(0, Number(item.accessCount || 0)) + 1;
      item.recallCount = Math.max(0, Number(item.recallCount || 0)) + 1;
      item.stabilityScore = clamp((Number(item.stabilityScore || 0) || 0) + 0.03, 0, 1);
      const strength = calcMemoryStrength(item, {});
      item.memoryStrength = strength.memoryStrength;
      item.nextReviewAt = strength.nextReviewAt;
      shardChanged = true;
      changed = true;
    }
    if (!shardChanged) continue;
    entry.index = materializeShardIndex(entry.items.items, entry.meta);
    getShardItemsStore(entry.meta).replace(entry.items);
    getShardIndexStore(entry.meta).replace(entry.index);
    updateManifestForShard(entry);
  }

  if (changed) {
    syncCompatSnapshots();
  }
}

function getMemoryStats(userId = null) {
  const items = getMemoryItems(userId).filter((item) => normalizeStatus(item.status, STATUS_ACTIVE) !== STATUS_ARCHIVED && !isExpired(item));
  const byType = {};
  const byTier = {};
  const byMemoryKind = {};
  const byStatus = {};
  const bySourceKind = {};
  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    const tier = normalizeTier(item.tier) || importanceToTier(item.importance, item.confidence, item.type);
    byTier[tier] = (byTier[tier] || 0) + 1;
    const memoryKind = getItemMemoryKind(item);
    if (memoryKind) byMemoryKind[memoryKind] = (byMemoryKind[memoryKind] || 0) + 1;
    const status = normalizeStatus(item.status, STATUS_ACTIVE);
    byStatus[status] = (byStatus[status] || 0) + 1;
    const sourceKind = String(item.sourceKind || 'legacy').toLowerCase();
    bySourceKind[sourceKind] = (bySourceKind[sourceKind] || 0) + 1;
  }
  return { total: items.length, byType, byTier, byMemoryKind, byStatus, bySourceKind };
}

module.exports = {
  getMemoryStats,
  touchAccessStats
};
