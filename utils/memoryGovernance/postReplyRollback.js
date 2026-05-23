function createPostReplyLearningRollback(deps = {}) {
  const {
    createSnapshot,
    loadLibrary,
    normalizeStringArray,
    normalizeText,
    nowTs,
    rebuildMemoryIndex,
    saveLibrary,
    saveProjection,
    readSelfImprovementEvents,
    recomputeSelfImprovementPatterns,
    writeSelfImprovementEvents,
    writeSelfImprovementPatterns,
    writeSelfImprovementPromotedRules,
    writeSelfImprovementSkillGuides
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

  function collectEventLearningJobIds(event = {}) {
    return normalizeStringArray([
      event.jobId,
      event.postReplyJobId
    ]);
  }

  function collectEventLearningTurnIds(event = {}) {
    return normalizeStringArray([
      event.turnId,
      ...(Array.isArray(event.turnIds) ? event.turnIds : [])
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

  function eventMatchesPostReplyLearningRef(event = {}, criteria = {}) {
    if (!event || typeof event !== 'object') return false;
    const userId = normalizeText(criteria.userId);
    if (userId && normalizeText(event.userId) !== userId) return false;
    const eventJobIds = collectEventLearningJobIds(event);
    const eventTurnIds = collectEventLearningTurnIds(event);
    if (eventJobIds.length === 0 && eventTurnIds.length === 0) return false;
    const jobIds = normalizeStringArray([criteria.jobId, criteria.postReplyJobId]);
    const turnIds = normalizeStringArray([
      criteria.turnId,
      ...(Array.isArray(criteria.turnIds) ? criteria.turnIds : [])
    ]);
    const jobMatched = jobIds.length === 0 || jobIds.some((id) => eventJobIds.includes(id));
    const turnMatched = turnIds.length === 0 || turnIds.some((id) => eventTurnIds.includes(id));
    return jobMatched && turnMatched;
  }

  function listSelfImprovementMatches(criteria = {}) {
    if (typeof readSelfImprovementEvents !== 'function') return [];
    return readSelfImprovementEvents()
      .filter((event) => eventMatchesPostReplyLearningRef(event, criteria))
      .map((event) => ({
        id: String(event.id || '').trim(),
        userId: String(event.userId || '').trim(),
        status: String(event.status || 'open').trim() || 'open',
        kind: String(event.kind || '').trim(),
        summary: normalizeText(event.summary || '')
      }))
      .filter((event) => event.id);
  }

  function archiveSelfImprovementMatches(criteria = {}, options = {}) {
    if (typeof readSelfImprovementEvents !== 'function' || typeof writeSelfImprovementEvents !== 'function') {
      return {
        matched: 0,
        changed: 0,
        ids: [],
        items: []
      };
    }
    const events = readSelfImprovementEvents();
    const providedMatches = Array.isArray(options.matches) ? options.matches : [];
    const matches = (providedMatches.length > 0
      ? providedMatches
      : events
        .filter((event) => eventMatchesPostReplyLearningRef(event, criteria))
        .map((event) => ({
          id: String(event.id || '').trim(),
          userId: String(event.userId || '').trim(),
          status: String(event.status || 'open').trim() || 'open',
          kind: String(event.kind || '').trim(),
          summary: normalizeText(event.summary || '')
        }))
    ).filter((event) => event.id);
    const activeIds = new Set(
      matches
        .filter((event) => normalizeText(event.status).toLowerCase() !== 'archived')
        .map((event) => event.id)
    );
    if (activeIds.size === 0) {
      return {
        matched: matches.length,
        changed: 0,
        ids: matches.map((event) => event.id),
        items: matches
      };
    }
    const now = new Date().toISOString();
    const reason = normalizeText(options.reason) || 'post_reply_learning_rollback';
    const activeMatchIds = new Set(activeIds);
    const nextEvents = events.map((event) => {
      const eventId = String(event.id || '').trim();
      if (activeMatchIds.has(eventId)) {
        return {
          ...event,
          status: 'archived',
          updatedAt: now,
          rollback: {
            reason,
            jobIds: criteria.jobIds || [],
            turnIds: criteria.turnIds || [],
            rolledBackAt: now
          }
        };
      }
      if (providedMatches.length > 0 || !eventMatchesPostReplyLearningRef(event, criteria)) return event;
      const matched = matches.find((item) => item.id === eventId);
      if (!matched || normalizeText(matched.status).toLowerCase() === 'archived') return event;
      activeMatchIds.add(eventId);
      return {
        ...event,
        status: 'archived',
        updatedAt: now,
        rollback: {
          reason,
          jobIds: criteria.jobIds || [],
          turnIds: criteria.turnIds || [],
          rolledBackAt: now
        }
      };
    });
    if (typeof recomputeSelfImprovementPatterns === 'function') {
      const recomputed = recomputeSelfImprovementPatterns(nextEvents);
      writeSelfImprovementEvents(recomputed.events);
      if (typeof writeSelfImprovementPatterns === 'function') writeSelfImprovementPatterns({ items: recomputed.patterns });
      if (typeof writeSelfImprovementPromotedRules === 'function') writeSelfImprovementPromotedRules({ items: recomputed.promotedRules });
      if (typeof writeSelfImprovementSkillGuides === 'function') writeSelfImprovementSkillGuides({ items: recomputed.skillGuides });
    } else {
      writeSelfImprovementEvents(nextEvents);
    }
    return {
      matched: matches.length,
      changed: activeIds.size,
      ids: matches.map((event) => event.id),
      items: matches
    };
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

    const criteria = {
      ...options,
      jobId: jobIds[0] || '',
      postReplyJobId: jobIds[1] || options.postReplyJobId || '',
      jobIds,
      turnIds
    };

    const library = loadLibrary();
    const memoryMatches = library.items
      .filter((item) => itemMatchesPostReplyLearningRef(item, {
        ...criteria
      }))
      .map((item) => ({
        id: String(item.id || '').trim(),
        userId: String(item.userId || '').trim(),
        status: String(item.status || 'active').trim() || 'active',
        text: normalizeText(item.text || item.canonicalText || '')
      }))
      .filter((item) => item.id);
    const selfImprovementMatches = listSelfImprovementMatches(criteria);
    const matches = memoryMatches;

    if (options.dryRun === true) {
      return {
        ok: true,
        dryRun: true,
        matched: memoryMatches.length + selfImprovementMatches.length,
        changed: 0,
        ids: memoryMatches.map((item) => item.id),
        items: memoryMatches,
        memory: {
          matched: memoryMatches.length,
          changed: 0,
          ids: memoryMatches.map((item) => item.id),
          items: memoryMatches
        },
        selfImprovement: {
          matched: selfImprovementMatches.length,
          changed: 0,
          ids: selfImprovementMatches.map((item) => item.id),
          items: selfImprovementMatches
        }
      };
    }

    const activeIds = new Set(
      matches
        .filter((item) => normalizeText(item.status).toLowerCase() !== 'archived')
        .map((item) => item.id)
    );
    const selfImprovementResult = archiveSelfImprovementMatches(criteria, {
      reason: normalizeText(options.reason) || 'post_reply_learning_rollback',
      matches: selfImprovementMatches
    });

    if (activeIds.size === 0) {
      return {
        ok: true,
        dryRun: false,
        matched: memoryMatches.length + selfImprovementResult.matched,
        changed: selfImprovementResult.changed,
        snapshot: '',
        ids: memoryMatches.map((item) => item.id),
        items: memoryMatches,
        memory: {
          matched: memoryMatches.length,
          changed: 0,
          ids: memoryMatches.map((item) => item.id),
          items: memoryMatches
        },
        selfImprovement: selfImprovementResult
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
      matched: memoryMatches.length + selfImprovementResult.matched,
      changed: activeIds.size + selfImprovementResult.changed,
      snapshot,
      ids: matches.map((item) => item.id),
      items: matches,
      memory: {
        matched: memoryMatches.length,
        changed: activeIds.size,
        ids: memoryMatches.map((item) => item.id),
        items: memoryMatches
      },
      selfImprovement: selfImprovementResult
    };
  }

  return {
    collectEventLearningJobIds,
    collectEventLearningTurnIds,
    collectItemLearningJobIds,
    collectItemLearningTurnIds,
    eventMatchesPostReplyLearningRef,
    hasAnyPostReplyLearningRef,
    itemMatchesPostReplyLearningRef,
    rollbackPostReplyLearning
  };
}

module.exports = {
  createPostReplyLearningRollback
};
