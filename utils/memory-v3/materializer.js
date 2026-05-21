const config = require('../../config');
const { getBackgroundPressureDelayMs, appendPerfEvent } = require('../perfRuntime');
const { getUserAffinityState } = require('../memory');
const {
  ensureDir,
  atomicWriteJson,
  writeJsonLines,
  normalizeText,
  clampText,
  canonicalizeText,
  uniqueBy
} = require('./helpers');
const { loadMemoryEvents } = require('./events');
const {
  clearProjectionReadCache,
  defaultSessionProjection,
  defaultProfileProjection,
  defaultScopeProjection,
  defaultEpisodeProjection,
  loadSessionProjection,
  loadProfileProjection,
  loadScopeProjection,
  loadEpisodeProjection,
  loadMemoryNodes
} = require('./storage');
const { collectEmbeddingBackfillNodes, enqueueMissingEmbeddings } = require('./embeddingIndex');
const { acquireMaterializeLock, DEFAULT_STALE_MS: DEFAULT_MATERIALIZE_LOCK_STALE_MS } = require('./materializeLock');
const { isMemoryNotRecallable } = require('./recallFilter');
const {
  applyNearDuplicateMerges,
  applyProfileLifecycle,
  applySupersession,
  isProfileField,
  lifecycleHiddenReason
} = require('./profileLifecycle');
const {
  buildLanceDbSyncPlan,
  createNodeFromEvent,
  upsertNode
} = require('./materializerNodes');
const { applySessionEvent } = require('./materializerSessions');
const {
  countDirtyScopes,
  eventMatchesDirtyScopes,
  getLatestEventTs,
  mergeIncrementalProjection,
  normalizeDirtyScopes
} = require('./materializerIncremental');
const {
  BOT_PERSONA_FIELDS,
  PERSONA_SUPPORT_FIELDS,
  RELATIONSHIP_STYLE_FIELDS,
  STRICT_PROFILE_FIELD_MAP,
  WEAK_PROFILE_FIELD_MAP,
  buildPersonaCore,
  buildProfileConflictKey,
  computeStabilityScore,
  createEmptyProfileProjection,
  getRecentTopicTtlMs,
  isExpiredRecentTopic,
  isExpiringSoonRecentTopic,
  isProfileProjectionBlockedByExtractionClass,
  pushProfileItem,
  resolveEvidenceTier,
  resolveProfileNodeConflicts
} = require('./profileProjection');

const NODE_EVENT_TYPES = new Set([
  'memory_candidate_extracted',
  'memory_confirmed',
  'memory_archived',
  'migration_bootstrap'
]);

function normalizeDedupeValue(value = '') {
  return normalizeText(value).toLowerCase();
}

function getEventPayload(event = {}) {
  return event && event.payload && typeof event.payload === 'object' ? event.payload : {};
}

function buildNodeEventSemanticKey(event = {}) {
  const payload = getEventPayload(event);
  const fieldKey = normalizeDedupeValue(
    payload.fieldKey
    || event.fieldKey
    || payload.type
    || event.memoryKind
    || payload.memoryKind
    || event.semanticSlot
    || payload.semanticSlot
    || 'fact'
  );
  return [
    event.type,
    event.userId,
    event.groupId,
    event.channelId,
    event.sessionId,
    event.routePolicyKey,
    event.topRouteType,
    event.scopeType,
    event.source,
    event.sourceKind,
    event.status,
    fieldKey,
    event.memoryKind,
    event.semanticSlot,
    event.conflictKey,
    event.canonicalKey || event.dedupeKey || canonicalizeText(event.text),
    event.text,
    payload.lifecycleStatus,
    payload.extractionClass || payload.classification
  ].map(normalizeDedupeValue).join('|');
}

function buildEpisodeEventSemanticKey(event = {}) {
  const payload = getEventPayload(event);
  return [
    event.type,
    event.userId,
    event.groupId,
    event.channelId,
    event.sessionKey,
    event.scopeType,
    event.source,
    event.sourceKind,
    event.memoryKind,
    event.semanticSlot,
    event.canonicalKey || event.dedupeKey || canonicalizeText(event.text),
    payload.rollupLevel,
    payload.episodeDay,
    payload.startDay,
    payload.endDay,
    payload.yearMonth,
    payload.part,
    payload.sourceFile,
    event.text
  ].map(normalizeDedupeValue).join('|');
}

function shouldDedupeMaterializeEvent(event = {}) {
  if (!event || typeof event !== 'object') return false;
  return NODE_EVENT_TYPES.has(normalizeDedupeValue(event.type))
    || normalizeDedupeValue(event.type) === 'episode_rollup_generated';
}

function buildMaterializeEventSemanticKey(event = {}) {
  const type = normalizeDedupeValue(event.type);
  if (type === 'episode_rollup_generated') return buildEpisodeEventSemanticKey(event);
  if (NODE_EVENT_TYPES.has(type)) return buildNodeEventSemanticKey(event);
  return '';
}

function preferMaterializeEvent(left = {}, right = {}) {
  const leftTs = Number(left.ts || 0) || 0;
  const rightTs = Number(right.ts || 0) || 0;
  if (leftTs !== rightTs) return leftTs < rightTs ? left : right;
  return String(left.id || '').localeCompare(String(right.id || '')) <= 0 ? left : right;
}

function dedupeMaterializeEvents(events = []) {
  const list = Array.isArray(events) ? events : [];
  const byKey = new Map();
  let suppressed = 0;
  for (const event of list) {
    if (!shouldDedupeMaterializeEvent(event)) continue;
    const key = buildMaterializeEventSemanticKey(event);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, event);
      continue;
    }
    byKey.set(key, preferMaterializeEvent(existing, event));
    suppressed += 1;
  }
  if (!suppressed) {
    return {
      events: list,
      stats: {
        enabled: true,
        inputEvents: list.length,
        outputEvents: list.length,
        suppressedEvents: 0
      }
    };
  }

  const kept = new Set(byKey.values());
  const output = list.filter((event) => !shouldDedupeMaterializeEvent(event) || kept.has(event));
  return {
    events: output,
    stats: {
      enabled: true,
      inputEvents: list.length,
      outputEvents: output.length,
      suppressedEvents: suppressed
    }
  };
}

function materializeMemoryViews(options = {}) {
  const pressureDelayMs = getBackgroundPressureDelayMs();
  if (pressureDelayMs > 0 && options.force !== true) {
    appendPerfEvent({
      category: 'background_pressure',
      type: 'memory_v3_materialize_deferred',
      delayMs: pressureDelayMs
    });
    return {
      deferred: true,
      reason: 'resource_pressure_deferred',
      deferMs: pressureDelayMs
    };
  }
  ensureDir(config.MEMORY_V3_DIR);
  ensureDir(config.MEMORY_V3_PROJECTIONS_DIR);
  const lock = acquireMaterializeLock(
    config.MEMORY_V3_MATERIALIZE_LOCK_FILE || `${config.MEMORY_V3_PROJECTIONS_DIR}.materialize.lock`,
    {
      staleMs: Number(config.MEMORY_V3_MATERIALIZE_LOCK_STALE_MS || DEFAULT_MATERIALIZE_LOCK_STALE_MS)
        || DEFAULT_MATERIALIZE_LOCK_STALE_MS
    }
  );
  if (!lock.acquired) {
    appendPerfEvent({
      category: 'memory_v3',
      type: 'materialize_deferred',
      reason: lock.reason || 'busy'
    });
    return {
      deferred: true,
      reason: 'materialize_lock_busy'
    };
  }
  try {
  const allEvents = Array.isArray(options.events) ? options.events : loadMemoryEvents();
  const deduped = options.dedupeEvents === false
    ? {
        events: allEvents,
        stats: {
          enabled: false,
          inputEvents: allEvents.length,
          outputEvents: allEvents.length,
          suppressedEvents: 0
        }
      }
    : dedupeMaterializeEvents(allEvents);
  const dirtyScopes = normalizeDirtyScopes(options.dirtyScopes || options);
  const dirtyScopeCount = countDirtyScopes(dirtyScopes);
  const incrementalRequested = config.MEMORY_V3_INCREMENTAL_MATERIALIZE_ENABLED !== false
    && options.force !== true
    && (options.mode === 'incremental' || dirtyScopeCount > 0);
  const incrementalLimit = Math.max(1, Number(config.MEMORY_V3_INCREMENTAL_SCOPE_LIMIT || 100) || 100);
  const incrementalMode = incrementalRequested && dirtyScopeCount > 0 && dirtyScopeCount <= incrementalLimit;
  const events = incrementalMode
    ? deduped.events.filter((event) => eventMatchesDirtyScopes(event, dirtyScopes))
    : deduped.events;
  const now = Date.now();
  const eventHighWatermarkTs = getLatestEventTs(allEvents);
  const sessionProjection = defaultSessionProjection();
  const previousProfileProjection = options.previousProfileProjection || defaultProfileProjection();
  const profileProjection = defaultProfileProjection();
  const scopeProjection = defaultScopeProjection();
  const episodeProjection = defaultEpisodeProjection();
  const nodeMap = new Map();

  for (const event of events) {
    const userId = normalizeText(event.userId);

    applySessionEvent(sessionProjection, event);

    if (event.type === 'turn_received' || event.type === 'turn_replied' || event.type === 'migration_bootstrap') {
      if (userId) {
        const scope = scopeProjection.users[userId] || { updatedAt: 0, groups: [], channels: [] };
        if (event.groupId && !scope.groups.includes(event.groupId)) scope.groups.push(event.groupId);
        if (event.channelId && !scope.channels.includes(event.channelId)) scope.channels.push(event.channelId);
        scope.updatedAt = Math.max(Number(scope.updatedAt || 0), Number(event.ts || 0));
        scopeProjection.users[userId] = scope;
      }
    }

    if (event.type === 'memory_candidate_extracted' || event.type === 'memory_confirmed' || event.type === 'memory_archived' || event.type === 'migration_bootstrap') {
      const node = createNodeFromEvent(event);
      if (node) {
        if (event.type === 'memory_archived') node.status = 'archived';
        upsertNode(nodeMap, node);
      }
    }

    if (event.type === 'episode_rollup_generated' && userId) {
      if (!episodeProjection.users[userId]) {
        episodeProjection.users[userId] = { updatedAt: 0, items: [] };
      }
      const target = episodeProjection.users[userId];
      target.updatedAt = Math.max(Number(target.updatedAt || 0), Number(event.ts || 0));
      const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
      const rollupLevel = normalizeText(payload.rollupLevel || event.memoryKind || 'daily') || 'daily';
      const sourceFile = normalizeText(payload.sourceFile);
      const item = {
        id: String(event.id || '').trim(),
        type: rollupLevel,
        rollupLevel,
        text: clampText(event.text, 4000),
        episodeDay: normalizeText(payload.episodeDay),
        yearMonth: normalizeText(payload.yearMonth),
        startDay: normalizeText(payload.startDay),
        endDay: normalizeText(payload.endDay),
        part: Math.max(0, Number(payload.part || 0) || 0),
        source: normalizeText(event.source),
        sourceKind: normalizeText(event.sourceKind || payload.sourceKind || 'journal'),
        sourceFile,
        sourceCompleteness: normalizeText(payload.sourceCompleteness || 'summary'),
        textKind: normalizeText(payload.textKind) || `journal_${rollupLevel}`,
        sessionKeys: Array.isArray(payload.sessionKeys) ? payload.sessionKeys.map(normalizeText).filter(Boolean).slice(0, 16) : [],
        topics: Array.isArray(payload.topics) ? payload.topics.map(normalizeText).filter(Boolean).slice(0, 16) : [],
        canonicalKey: normalizeText(event.canonicalKey || event.dedupeKey).toLowerCase(),
        dedupeKey: normalizeText(event.dedupeKey),
        confidence: Number(event.confidence || 0) || 0.92,
        importance: Number(event.importance || 0) || (rollupLevel === 'monthly' ? 1.2 : 1.0),
        evidenceCount: Math.max(1, Number(event.evidenceCount || payload.evidenceCount || 1) || 1),
        updatedAt: Number(event.ts || 0) || 0,
        notRecallable: isMemoryNotRecallable(event),
        recallVerification: payload.recallVerification && typeof payload.recallVerification === 'object'
          ? payload.recallVerification
          : null
      };
      if (item.text) target.items.push(item);
    }
  }

  const nodes = Array.from(nodeMap.values());
  const supportMap = new Map();
  for (const node of nodes) {
    const slot = `${node.userId}|${node.scopeType}|${node.fieldKey}|${node.canonicalKey}`;
    supportMap.set(slot, (supportMap.get(slot) || 0) + 1);
  }
  for (const node of nodes) {
    const slot = `${node.userId}|${node.scopeType}|${node.fieldKey}|${node.canonicalKey}`;
    const support = Number(supportMap.get(slot) || 1);
    node.evidenceCount = Math.max(Number(node.evidenceCount || 1), support);
    node.evidenceTier = resolveEvidenceTier(node, support);
    node.stabilityScore = computeStabilityScore(node, support);
    node.conflictKey = node.conflictKey || buildProfileConflictKey(node);
    if (node.fieldKey === 'topic' || node.type === 'topic') {
      const ttlMs = getRecentTopicTtlMs();
      node.expiresAt = ttlMs && Number(node.updatedAt || node.createdAt || 0)
        ? Number(node.updatedAt || node.createdAt || 0) + ttlMs
        : 0;
    }
  }
  const lifecycleNodes = applyNearDuplicateMerges(applySupersession(nodes.map((item) => applyProfileLifecycle(item, { now }))), { now });
  const activeNodes = lifecycleNodes.filter((item) => item.status !== 'archived' && !isMemoryNotRecallable(item));
  const hiddenRecallNodes = lifecycleNodes
    .filter((item) => item.status !== 'archived' && isMemoryNotRecallable(item))
    .map((item) => ({
      ...item,
      suppressedBy: item.suppressedBy || item.supersededBy || 'not_recallable',
      recallHiddenReason: item.recallHiddenReason || lifecycleHiddenReason(item, { now }) || 'not_recallable'
    }));
  const hiddenProfileSuppressed = hiddenRecallNodes
    .filter((item) => isProfileField(item))
    .map((item) => ({
      userId: item.userId,
      fieldKey: item.fieldKey,
      canonicalKey: item.canonicalKey,
      conflictKey: item.conflictKey || '',
      id: item.id,
      suppressedBy: item.suppressedBy || item.supersededBy || '',
      text: item.text,
      reason: item.recallHiddenReason || lifecycleHiddenReason(item, { now }) || 'profile_lifecycle_hidden',
      expiresAt: item.expiresAt || 0
    }));
  const hiddenExpiredRecentTopicSuppressed = hiddenRecallNodes
    .filter((item) => isProfileField(item) && isExpiredRecentTopic(item, now))
    .map((item) => ({
      userId: item.userId,
      fieldKey: item.fieldKey,
      canonicalKey: item.canonicalKey,
      conflictKey: item.conflictKey || '',
      id: item.id,
      suppressedBy: item.suppressedBy || item.supersededBy || '',
      text: item.text,
      reason: 'recent_topic_expired',
      expiresAt: item.expiresAt || 0
    }));
  const hiddenProfileConflicts = hiddenProfileSuppressed
    .filter((item) => item.reason === 'profile_lifecycle_superseded')
    .map((item) => ({
      userId: item.userId,
      conflictKey: item.conflictKey,
      fieldKey: item.fieldKey,
      canonicalKey: item.canonicalKey,
      id: item.id,
      text: item.text,
      suppressedBy: item.suppressedBy,
      winnerId: item.suppressedBy,
      winnerText: '',
      reason: 'profile_superseded'
    }));
  const winners = new Map();
  const suppressed = [];
  for (const node of activeNodes.slice().sort((a, b) => {
    if ((b.evidenceTier === 'strict') !== (a.evidenceTier === 'strict')) return b.evidenceTier === 'strict' ? 1 : -1;
    if (Number(b.stabilityScore || 0) !== Number(a.stabilityScore || 0)) return Number(b.stabilityScore || 0) - Number(a.stabilityScore || 0);
    if (Number(b.updatedAt || 0) !== Number(a.updatedAt || 0)) return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    return String(a.id || '').localeCompare(String(b.id || ''));
  })) {
    const slot = `${node.userId}|${node.scopeType}|${node.fieldKey}|${node.canonicalKey}`;
    if (!winners.has(slot)) {
      winners.set(slot, node);
      continue;
    }
    node.suppressedBy = String(winners.get(slot)?.id || '');
    suppressed.push({
      userId: node.userId,
      fieldKey: node.fieldKey,
      canonicalKey: node.canonicalKey,
      id: node.id,
      suppressedBy: node.suppressedBy,
      text: node.text
    });
  }

  const resolvedNodes = Array.from(winners.values());
  const outputResolvedNodes = resolvedNodes.concat(hiddenRecallNodes);
  const profileConflictResolution = resolveProfileNodeConflicts(resolvedNodes);
  const profileNodes = profileConflictResolution.selected;
  const profileConflicts = profileConflictResolution.conflicts;
  const expiredProfileNodes = [];
  const expiringProfileNodes = [];

  for (const node of profileNodes) {
    const userId = normalizeText(node.userId);
    if (!userId || userId.startsWith('group:')) continue;
    if (!profileProjection.users[userId]) {
      profileProjection.users[userId] = createEmptyProfileProjection();
    }
    const profile = profileProjection.users[userId];
    if (isExpiredRecentTopic(node, now)) {
      expiredProfileNodes.push({
        userId,
        fieldKey: node.fieldKey,
        canonicalKey: node.canonicalKey,
        id: node.id,
        text: node.text,
        reason: 'recent_topic_expired',
        expiresAt: node.expiresAt || 0
      });
      continue;
    }
    const hiddenReason = lifecycleHiddenReason(node, { now });
    if (hiddenReason) {
      expiredProfileNodes.push({
        userId,
        fieldKey: node.fieldKey,
        canonicalKey: node.canonicalKey,
        conflictKey: node.conflictKey || '',
        id: node.id,
        text: node.text,
        reason: hiddenReason,
        suppressedBy: node.suppressedBy || node.supersededBy || '',
        expiresAt: node.expiresAt || 0
      });
      continue;
    }
    if (isExpiringSoonRecentTopic(node, now)) {
      expiringProfileNodes.push({
        userId,
        fieldKey: node.fieldKey,
        canonicalKey: node.canonicalKey,
        id: node.id,
        text: node.text,
        expiresAt: node.expiresAt || 0
      });
    }
    const profileProjectionBlocked = isProfileProjectionBlockedByExtractionClass(node);
    if (!profileProjectionBlocked && STRICT_PROFILE_FIELD_MAP[node.fieldKey] && node.evidenceTier === 'strict') {
      pushProfileItem(profile, 'strictProfile', STRICT_PROFILE_FIELD_MAP[node.fieldKey], node, 20);
    } else if (!profileProjectionBlocked && WEAK_PROFILE_FIELD_MAP[node.fieldKey]) {
      pushProfileItem(profile, 'weakProfile', WEAK_PROFILE_FIELD_MAP[node.fieldKey], node, 12);
    } else if (
      !profileProjectionBlocked
      &&
      !PERSONA_SUPPORT_FIELDS.has(node.fieldKey)
      && node.fieldKey !== 'episode'
      && node.fieldKey !== 'topic'
      && node.type !== 'topic'
    ) {
      pushProfileItem(profile, 'weakProfile', 'recent_topics', node, 12);
    }
  }

  for (const [userId, profile] of Object.entries(profileProjection.users)) {
    const affinity = getUserAffinityState(userId);
    profile.relation_stage = normalizeText(affinity?.relationship || profile.relation_stage || '陌生人') || '陌生人';
    const userNodes = resolvedNodes.filter((item) => item.userId === userId && item.scopeType !== 'group');
    const personaSupports = userNodes.filter((item) => (
      PERSONA_SUPPORT_FIELDS.has(item.fieldKey)
      && !isProfileProjectionBlockedByExtractionClass(item)
    ));
    const styleNodes = userNodes.filter((item) => item.fieldKey === 'style_pattern' || item.fieldKey === 'style_avoid');
    const botPersonaNodes = userNodes.filter((item) => BOT_PERSONA_FIELDS.has(item.fieldKey));
    const relationshipNodes = userNodes.filter((item) => RELATIONSHIP_STYLE_FIELDS.has(item.fieldKey));
    profile.personaCore = buildPersonaCore(
      profile,
      personaSupports,
      styleNodes,
      affinity,
      previousProfileProjection.users?.[userId]?.personaCore || {},
      botPersonaNodes,
      relationshipNodes
    );
    profile.suppressed = [
      ...suppressed.filter((item) => item.userId === userId),
      ...hiddenProfileSuppressed.filter((item) => item.userId === userId),
      ...hiddenExpiredRecentTopicSuppressed.filter((item) => item.userId === userId),
      ...expiredProfileNodes.filter((item) => item.userId === userId),
      ...profileConflicts.filter((item) => item.userId === userId)
    ];
    profile.conflicts = [
      ...profileConflicts.filter((item) => item.userId === userId),
      ...hiddenProfileConflicts.filter((item) => item.userId === userId)
    ];
    profile.expiresSoon = expiringProfileNodes.filter((item) => item.userId === userId);
  }

  for (const userId of Object.keys(episodeProjection.users)) {
    episodeProjection.users[userId].items = uniqueBy(
      episodeProjection.users[userId].items
        .filter((item) => item.text)
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)),
      (item) => `${item.type}|${item.episodeDay}|${item.yearMonth}|${item.startDay}|${item.endDay}|${canonicalizeText(item.text)}`
    );
  }

  sessionProjection.updatedAt = now;
  profileProjection.updatedAt = now;
  scopeProjection.updatedAt = now;
  episodeProjection.updatedAt = now;
  for (const projection of [sessionProjection, profileProjection, scopeProjection, episodeProjection]) {
    projection.materializedAt = now;
    projection.eventHighWatermarkTs = eventHighWatermarkTs;
  }

  const outputSessionProjection = incrementalMode
    ? mergeIncrementalProjection(loadSessionProjection(), sessionProjection, 'sessions', dirtyScopes.sessionKeys)
    : sessionProjection;
  const outputProfileProjection = incrementalMode
    ? mergeIncrementalProjection(loadProfileProjection(), profileProjection, 'users', dirtyScopes.userIds)
    : profileProjection;
  const outputScopeProjection = incrementalMode
    ? mergeIncrementalProjection(loadScopeProjection(), scopeProjection, 'users', dirtyScopes.userIds)
    : scopeProjection;
  const outputEpisodeProjection = incrementalMode
    ? mergeIncrementalProjection(loadEpisodeProjection(), episodeProjection, 'users', dirtyScopes.userIds)
    : episodeProjection;
  for (const projection of [outputSessionProjection, outputProfileProjection, outputScopeProjection, outputEpisodeProjection]) {
    projection.updatedAt = now;
    projection.materializedAt = now;
    projection.eventHighWatermarkTs = eventHighWatermarkTs;
    projection.materializeMode = incrementalMode ? 'incremental' : 'full';
  }

  const outputNodes = incrementalMode
    ? [
        ...loadMemoryNodes().filter((node) => !eventMatchesDirtyScopes(node, dirtyScopes)),
        ...outputResolvedNodes
      ]
    : outputResolvedNodes;

  atomicWriteJson(config.MEMORY_V3_SESSION_PROJECTION_FILE, outputSessionProjection);
  atomicWriteJson(config.MEMORY_V3_PROFILE_PROJECTION_FILE, outputProfileProjection);
  atomicWriteJson(config.MEMORY_V3_SCOPE_PROJECTION_FILE, outputScopeProjection);
  atomicWriteJson(config.MEMORY_V3_EPISODE_PROJECTION_FILE, outputEpisodeProjection);
  writeJsonLines(config.MEMORY_V3_NODES_FILE, outputNodes);
  clearProjectionReadCache();
  const embeddingNodes = incrementalMode ? resolvedNodes : collectEmbeddingBackfillNodes();
  const embeddingIndex = enqueueMissingEmbeddings(embeddingNodes, {
    fullReconcile: !incrementalMode,
    schedule: options.scheduleEmbeddingBackfill !== false,
    delayMs: options.embeddingBackfillDelayMs
  });
  const lancedbSyncPlan = buildLanceDbSyncPlan(incrementalMode ? outputNodes : embeddingNodes, {
    fullReconcile: !incrementalMode,
    dryRun: true
  });

  return {
    ok: true,
    stats: {
      events: events.length,
      totalEvents: allEvents.length,
      latestEventTs: eventHighWatermarkTs,
      nodes: outputNodes.length,
      materializeMode: incrementalMode ? 'incremental' : 'full',
      dirtyScopes: dirtyScopeCount,
      embeddings: embeddingIndex,
      lancedbSyncPlan,
      dedupe: deduped.stats,
      sessions: Object.keys(outputSessionProjection.sessions).length,
      profiles: Object.keys(outputProfileProjection.users).length,
      episodeUsers: Object.keys(outputEpisodeProjection.users).length
    },
    sessionProjection: outputSessionProjection,
    profileProjection: outputProfileProjection,
    scopeProjection: outputScopeProjection,
    episodeProjection: outputEpisodeProjection,
    nodes: outputNodes
  };
  } finally {
    lock.release();
  }
}

module.exports = {
  materializeMemoryViews,
  createNodeFromEvent,
  buildLanceDbSyncPlan,
  dedupeMaterializeEvents
};
