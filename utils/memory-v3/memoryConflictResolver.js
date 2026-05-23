const {
  canonicalizeText,
  normalizeText
} = require('./helpers');
const { isMemoryNotRecallable, lifecycleStatusOf } = require('./recallFilter');
const { isProfileField } = require('./profileLifecycle');

function normalizeScopeType(value = '') {
  return normalizeText(value || 'personal').toLowerCase() || 'personal';
}

function normalizeFieldKey(input = {}) {
  return normalizeText(input.fieldKey || input.semanticSlot || input.type || input.memoryKind || 'fact').toLowerCase();
}

function normalizeConflictKey(input = {}) {
  return normalizeText(input.conflictKey || input.payload?.conflictKey).toLowerCase();
}

function buildGenericConflictKey(node = {}) {
  const explicit = normalizeConflictKey(node);
  if (explicit) return explicit;
  const category = normalizeText(node.category || node.payload?.category).toLowerCase();
  const fieldKey = normalizeFieldKey(node);
  const canonical = normalizeText(node.canonicalKey || canonicalizeText(node.text)).toLowerCase();
  if (!canonical) return '';
  if (isProfileField(node)) return '';
  if (category && ['preference', 'identity', 'profile', 'relationship', 'style'].includes(category)) {
    return '';
  }
  if (fieldKey === 'episode' || normalizeText(node.source).toLowerCase() === 'journal') return '';
  return [node.userId, normalizeScopeType(node.scopeType), node.groupId || '', category || fieldKey, canonical]
    .map((item) => normalizeText(item).toLowerCase())
    .join('|');
}

function isConflictVisible(node = {}) {
  if (!node || typeof node !== 'object') return false;
  if (normalizeText(node.status).toLowerCase() === 'archived') return false;
  if (isMemoryNotRecallable(node)) return false;
  const lifecycleStatus = lifecycleStatusOf(node);
  return !['stale', 'suspect', 'superseded', 'archived'].includes(lifecycleStatus);
}

function conflictWinnerRank(node = {}) {
  const status = normalizeText(node.status).toLowerCase();
  const sourceKind = normalizeText(node.sourceKind || node.source).toLowerCase();
  const activeRank = status === 'active' ? 5 : status === 'confirmed' ? 4 : status === 'candidate' ? 2 : 1;
  const sourceRank = sourceKind === 'explicit' || sourceKind === 'manual'
    ? 5
    : sourceKind === 'runtime'
      ? 3
      : sourceKind === 'extractor'
        ? 2
        : 1;
  const evidenceRank = normalizeText(node.evidenceTier).toLowerCase() === 'strict' ? 2 : 0;
  return (activeRank * 100000)
    + (sourceRank * 10000)
    + (evidenceRank * 5000)
    + (Number(node.confidence || 0) * 1000)
    + (Number(node.importance || 0) * 300)
    + (Number(node.stabilityScore || 0) * 250)
    + Math.min(200, Number(node.evidenceCount || 1) * 25)
    + (Number(node.updatedAt || node.createdAt || 0) / 100000000000);
}

function resolveMemoryConflicts(nodes = [], options = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const buckets = new Map();
  for (const node of list) {
    if (!isConflictVisible(node)) continue;
    const key = normalizeConflictKey(node) || buildGenericConflictKey(node);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(node);
  }

  const loserToWinner = new Map();
  const conflictRows = [];
  for (const [conflictKey, group] of buckets.entries()) {
    if (group.length <= 1) continue;
    const ranked = group.slice().sort((a, b) => {
      const rankDelta = conflictWinnerRank(b) - conflictWinnerRank(a);
      if (rankDelta !== 0) return rankDelta;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    const winner = ranked[0];
    for (const loser of ranked.slice(1)) {
      const winnerId = normalizeText(winner.id || winner.nodeId);
      const loserId = normalizeText(loser.id || loser.nodeId);
      if (!winnerId || !loserId || winnerId === loserId) continue;
      loserToWinner.set(loserId, {
        winner,
        conflictKey,
        reason: normalizeText(options.reason || 'memory_conflict_resolved')
      });
      conflictRows.push({
        userId: normalizeText(loser.userId || winner.userId),
        scopeType: normalizeScopeType(loser.scopeType || winner.scopeType),
        groupId: normalizeText(loser.groupId || winner.groupId),
        conflictKey,
        fieldKey: normalizeFieldKey(loser),
        canonicalKey: normalizeText(loser.canonicalKey || canonicalizeText(loser.text)).toLowerCase(),
        id: loserId,
        text: normalizeText(loser.text),
        winnerId,
        winnerText: normalizeText(winner.text),
        reason: normalizeText(options.reason || 'memory_conflict_resolved')
      });
    }
  }

  if (!loserToWinner.size) {
    return {
      nodes: list,
      conflicts: [],
      suppressed: []
    };
  }

  const resolved = list.map((node) => {
    const loser = loserToWinner.get(normalizeText(node.id || node.nodeId));
    if (!loser) return node;
    const winnerId = normalizeText(loser.winner.id || loser.winner.nodeId);
    return {
      ...node,
      lifecycleStatus: 'superseded',
      conflictWinnerId: winnerId,
      supersededBy: normalizeText(node.supersededBy) || winnerId,
      suppressedBy: normalizeText(node.suppressedBy) || winnerId,
      notRecallable: true,
      recallHiddenReason: loser.reason
    };
  });

  return {
    nodes: resolved,
    conflicts: conflictRows,
    suppressed: conflictRows.map((row) => ({
      userId: row.userId,
      fieldKey: row.fieldKey,
      canonicalKey: row.canonicalKey,
      conflictKey: row.conflictKey,
      id: row.id,
      suppressedBy: row.winnerId,
      text: row.text,
      reason: row.reason,
      winnerText: row.winnerText
    }))
  };
}

function filterResolvedMemoryConflicts(items = []) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    const hiddenReason = normalizeText(item.recallHiddenReason || item.meta?.recallHiddenReason || item.payload?.recallHiddenReason);
    if (hiddenReason === 'memory_conflict_resolved') return false;
    const lifecycleStatus = lifecycleStatusOf(item);
    return lifecycleStatus !== 'superseded' || !normalizeText(item.conflictWinnerId || item.supersededBy || item.suppressedBy);
  });
}

module.exports = {
  buildGenericConflictKey,
  conflictWinnerRank,
  filterResolvedMemoryConflicts,
  resolveMemoryConflicts
};
