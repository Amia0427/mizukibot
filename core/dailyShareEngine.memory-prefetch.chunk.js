async function prefetchQzoneDailyShareMemory({
  type,
  groupId,
  windowKey,
  windowLabel,
  today,
  stateEntry,
  recentShareSummaries,
  topicLabel,
  payload,
  runMemoryCli,
  recordMemoryScope,
  memoryQueryPlanner
} = {}) {
  const memoryOwner = String(config.BOT_QQ || '').trim();
  const daypartTone = getQzoneDaypartTone(windowKey);
  const meta = {
    memoryOwner,
    memoryQuery: '',
    memorySearchCount: 0,
    memoryOpenUsed: false,
    memoryOpenedSource: '',
    memoryPrefetchError: '',
    memoryEvidenceSources: []
  };

  const effectiveRunMemoryCli = typeof runMemoryCli === 'function'
    ? runMemoryCli
    : getDefaultRunMemoryCli();

  if (!memoryOwner || typeof effectiveRunMemoryCli !== 'function' || typeof recordMemoryScope !== 'function') {
    meta.memoryPrefetchError = !memoryOwner ? 'missing-memory-owner' : 'memory-prefetch-unavailable';
    return { memoryEvidence: { items: [], sources: [] }, meta };
  }

  const planned = await planQzoneDailyShareMemoryQuery({
    type,
    windowKey,
    windowLabel,
    topicLabel: topicLabel || payload?.topicLabel || '',
    recentShareSummaries,
    daypartTone
  }, { memoryQueryPlanner });

  meta.memoryQuery = planned.query;
  if (planned.plannerError) meta.memoryPrefetchError = planned.plannerError;

  try {
    recordMemoryScope(memoryOwner, { groupId: String(groupId || '').trim() });
  } catch (error) {
    meta.memoryPrefetchError = String(error?.message || error || 'record-scope-failed');
    logDailyShare({
      groupId: QZONE_TARGET_ID,
      windowKey,
      type,
      reason: meta.memoryPrefetchError,
      source: payload?.source || '',
      event: 'memory prefetch degraded'
    });
    return { memoryEvidence: { items: [], sources: [] }, meta };
  }

  const memoryContext = {
    userId: memoryOwner,
    groupId: String(groupId || '').trim(),
    channelId: '__qzone__',
    taskType: 'daily_share',
    topRouteType: 'proactive',
    routePolicyKey: 'proactive/daily-share'
  };

  let searchPayload = null;
  try {
    searchPayload = await effectiveRunMemoryCli(`mem search --query ${JSON.stringify(meta.memoryQuery)} --source all --limit 6`, memoryContext);
  } catch (error) {
    meta.memoryPrefetchError = String(error?.message || error || 'memory-search-failed');
    logDailyShare({
      groupId: QZONE_TARGET_ID,
      windowKey,
      type,
      reason: meta.memoryPrefetchError,
      source: payload?.source || '',
      event: 'memory prefetch degraded'
    });
    return { memoryEvidence: { items: [], sources: [] }, meta };
  }

  if (!searchPayload?.ok || searchPayload.command !== 'search') {
    meta.memoryPrefetchError = 'unexpected-memory-search-payload';
    logDailyShare({
      groupId: QZONE_TARGET_ID,
      windowKey,
      type,
      reason: meta.memoryPrefetchError,
      source: payload?.source || '',
      event: 'memory prefetch degraded'
    });
    return { memoryEvidence: { items: [], sources: [] }, meta };
  }

  meta.memorySearchCount = Math.max(0, Number(searchPayload.count || 0) || 0);

  let openedMemory = null;
  const openCandidate = meta.memorySearchCount > 0 ? pickQzoneMemoryOpenCandidate(searchPayload.results) : null;
  if (openCandidate?.ref) {
    try {
      const openPayload = await effectiveRunMemoryCli(`mem open --ref ${JSON.stringify(String(openCandidate.ref).trim())}`, memoryContext);
      openedMemory = sanitizeQzoneOpenedMemory(openPayload, openCandidate.source);
      if (openedMemory) {
        meta.memoryOpenUsed = true;
        meta.memoryOpenedSource = openedMemory.source;
      }
    } catch (_) {}
  }

  const memoryEvidence = sanitizeQzoneMemoryEvidence({
    searchPayload,
    openedMemory
  });

  meta.memoryEvidenceSources = memoryEvidence.sources.slice();
  if (!memoryEvidence.items.length && meta.memorySearchCount <= 0 && !meta.memoryPrefetchError) {
    meta.memoryPrefetchError = 'memory-search-empty';
  }

  logDailyShare({
    groupId: QZONE_TARGET_ID,
    windowKey,
    type,
    reason: memoryEvidence.items.length
      ? `hits=${meta.memorySearchCount};sources=${meta.memoryEvidenceSources.join(',') || 'none'}`
      : (meta.memoryPrefetchError || `hits=${meta.memorySearchCount}`),
    source: payload?.source || '',
    event: memoryEvidence.items.length ? 'memory prefetch ok' : 'memory prefetch degraded'
  });

  if (meta.memorySearchCount > memoryEvidence.items.length) {
    logDailyShare({
      groupId: QZONE_TARGET_ID,
      windowKey,
      type,
      reason: `search=${meta.memorySearchCount};kept=${memoryEvidence.items.length}`,
      source: payload?.source || '',
      event: 'memory evidence filtered'
    });
  }

  return { memoryEvidence, meta };
}

