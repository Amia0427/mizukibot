function createMemoryGovernanceConflictHandlers(deps = {}) {
  const {
    loadLibrary,
    saveLibrary,
    rebuildMemoryIndex,
    saveProjection,
    nowTs,
    normalizeText
  } = deps;

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

  return {
    listConflictGroups,
    resolveConflictGroup
  };
}

module.exports = {
  createMemoryGovernanceConflictHandlers
};
