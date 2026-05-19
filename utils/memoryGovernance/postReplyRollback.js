function createPostReplyLearningRollback(deps = {}) {
  const {
    createSnapshot,
    loadLibrary,
    normalizeStringArray,
    normalizeText,
    nowTs,
    rebuildMemoryIndex,
    saveLibrary,
    saveProjection
  } = deps;

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

  return {
    collectItemLearningJobIds,
    collectItemLearningTurnIds,
    hasAnyPostReplyLearningRef,
    itemMatchesPostReplyLearningRef,
    rollbackPostReplyLearning
  };
}

module.exports = {
  createPostReplyLearningRollback
};
