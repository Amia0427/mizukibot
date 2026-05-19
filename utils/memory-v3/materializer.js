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

function createNodeFromEvent(event) {
  const text = normalizeText(event.text);
  if (!text) return null;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const fieldKey = normalizeText(
    payload.fieldKey
    || event.fieldKey
    || payload.type
    || event.memoryKind
    || payload.memoryKind
    || event.semanticSlot
    || payload.semanticSlot
    || 'fact'
  ).toLowerCase();
  const normalizedFieldKey = fieldKey === 'like'
    ? 'preference_like'
    : fieldKey === 'dislike'
      ? 'preference_dislike'
      : fieldKey;
  return {
    id: String(event.id || '').trim(),
    userId: normalizeText(event.userId),
    groupId: normalizeText(event.groupId),
    channelId: normalizeText(event.channelId),
    sessionId: normalizeText(event.sessionId),
    sessionKey: normalizeText(event.sessionKey),
    routePolicyKey: normalizeText(event.routePolicyKey),
    topRouteType: normalizeText(event.topRouteType),
    scopeType: normalizeText(event.scopeType || 'personal').toLowerCase() || 'personal',
    source: normalizeText(event.source),
    sourceKind: normalizeText(event.sourceKind || event.source),
    status: normalizeText(event.status || (event.type === 'memory_candidate_extracted' ? 'candidate' : 'active')).toLowerCase(),
    type: normalizeText(payload.type || event.memoryKind || 'fact').toLowerCase() || 'fact',
    memoryKind: normalizeText(event.memoryKind || payload.memoryKind).toLowerCase(),
    fieldKey: normalizedFieldKey,
    semanticSlot: normalizeText(event.semanticSlot || payload.semanticSlot || normalizedFieldKey).toLowerCase(),
    conflictKey: normalizeText(event.conflictKey || payload.conflictKey),
    canonicalKey: normalizeText(event.canonicalKey || canonicalizeText(text)).toLowerCase(),
    text,
    confidence: Number(event.confidence || payload.confidence || 0) || 0,
    importance: Number(event.importance || payload.importance || 0) || 0,
    evidenceCount: Math.max(1, Number(event.evidenceCount || payload.evidenceCount || 1) || 1),
    evidenceTier: 'weak',
    stabilityScore: 0,
    suppressedBy: '',
    notRecallable: isMemoryNotRecallable(event),
    recallVerification: payload.recallVerification && typeof payload.recallVerification === 'object'
      ? payload.recallVerification
      : null,
    participants: Array.isArray(event.participants) ? event.participants : [],
    entities: Array.isArray(event.entities) ? event.entities : [],
    relations: Array.isArray(event.relations) ? event.relations : [],
    taskType: normalizeText(event.taskType || payload.taskType),
    extractionClass: normalizeText(payload.extractionClass || payload.classification || event.extractionClass).toLowerCase(),
    toolName: normalizeText(event.toolName || payload.toolName),
    agentName: normalizeText(event.agentName || payload.agentName),
    updatedAt: Number(event.ts || 0) || 0,
    createdAt: Number(event.ts || 0) || 0
  };
}

function upsertNode(nodeMap, node) {
  if (!node || !node.id) return;
  const existing = nodeMap.get(node.id);
  if (!existing) {
    nodeMap.set(node.id, node);
    return;
  }
  nodeMap.set(node.id, {
    ...existing,
    ...node,
    evidenceCount: Math.max(Number(existing.evidenceCount || 1), Number(node.evidenceCount || 1)),
    confidence: Math.max(Number(existing.confidence || 0), Number(node.confidence || 0)),
    importance: Math.max(Number(existing.importance || 0), Number(node.importance || 0)),
    updatedAt: Math.max(Number(existing.updatedAt || 0), Number(node.updatedAt || 0))
  });
}

function normalizeSessionScopeFromEvent(event = {}) {
  return {
    sessionKey: normalizeText(event.sessionKey),
    userId: normalizeText(event.userId),
    groupId: normalizeText(event.groupId),
    channelId: normalizeText(event.channelId),
    sessionId: normalizeText(event.sessionId)
  };
}

function resolveNodeConflicts(nodes = []) {
  const winners = new Map();
  for (const node of (Array.isArray(nodes) ? nodes : []).slice().sort((a, b) => {
    const aRank = (a.status === 'active' ? 2 : 1) + (a.sourceKind === 'explicit' ? 2 : 0) + (String(a.type || '').toLowerCase() === 'dislike' ? 1 : 0);
    const bRank = (b.status === 'active' ? 2 : 1) + (b.sourceKind === 'explicit' ? 2 : 0) + (String(b.type || '').toLowerCase() === 'dislike' ? 1 : 0);
    if (bRank !== aRank) return bRank - aRank;
    if (Number(b.confidence || 0) !== Number(a.confidence || 0)) return Number(b.confidence || 0) - Number(a.confidence || 0);
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
  })) {
    const slot = `${node.userId}|${node.scopeType}|${node.semanticSlot || node.type}|${node.canonicalKey}`;
    if (!winners.has(slot)) winners.set(slot, node);
  }
  return Array.from(winners.values());
}

function getLatestEventTs(events = []) {
  let latest = 0;
  for (const event of Array.isArray(events) ? events : []) {
    latest = Math.max(latest, Number(event?.ts || 0) || 0);
  }
  return latest;
}

function normalizeDirtyScopes(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const userIds = new Set();
  const sessionKeys = new Set();
  const groupIds = new Set();
  const add = (set, item) => {
    const text = normalizeText(item);
    if (text) set.add(text);
  };
  for (const item of Array.isArray(source.userIds) ? source.userIds : []) add(userIds, item);
  for (const item of Array.isArray(source.sessionKeys) ? source.sessionKeys : []) add(sessionKeys, item);
  for (const item of Array.isArray(source.groupIds) ? source.groupIds : []) add(groupIds, item);
  add(userIds, source.userId);
  add(sessionKeys, source.sessionKey);
  add(groupIds, source.groupId);
  return { userIds, sessionKeys, groupIds };
}

function countDirtyScopes(scopes = {}) {
  return Number(scopes.userIds?.size || 0) + Number(scopes.sessionKeys?.size || 0) + Number(scopes.groupIds?.size || 0);
}

function eventMatchesDirtyScopes(event = {}, scopes = {}) {
  const userId = normalizeText(event.userId);
  const sessionKey = normalizeText(event.sessionKey);
  const groupId = normalizeText(event.groupId);
  return Boolean(
    (userId && scopes.userIds?.has(userId))
    || (sessionKey && scopes.sessionKeys?.has(sessionKey))
    || (groupId && scopes.groupIds?.has(groupId))
  );
}

function mergeIncrementalProjection(fullProjection = {}, partialProjection = {}, key = 'users', dirtyKeys = new Set()) {
  const merged = {
    ...(fullProjection && typeof fullProjection === 'object' ? fullProjection : {}),
    ...(partialProjection && typeof partialProjection === 'object' ? partialProjection : {})
  };
  const existingItems = fullProjection?.[key] && typeof fullProjection[key] === 'object' ? fullProjection[key] : {};
  const partialItems = partialProjection?.[key] && typeof partialProjection[key] === 'object' ? partialProjection[key] : {};
  merged[key] = { ...existingItems };
  for (const dirtyKey of dirtyKeys || []) {
    delete merged[key][dirtyKey];
  }
  for (const [itemKey, value] of Object.entries(partialItems)) {
    merged[key][itemKey] = value;
  }
  return merged;
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
  const dirtyScopes = normalizeDirtyScopes(options.dirtyScopes || options);
  const dirtyScopeCount = countDirtyScopes(dirtyScopes);
  const incrementalRequested = config.MEMORY_V3_INCREMENTAL_MATERIALIZE_ENABLED !== false
    && options.force !== true
    && (options.mode === 'incremental' || dirtyScopeCount > 0);
  const incrementalLimit = Math.max(1, Number(config.MEMORY_V3_INCREMENTAL_SCOPE_LIMIT || 100) || 100);
  const incrementalMode = incrementalRequested && dirtyScopeCount > 0 && dirtyScopeCount <= incrementalLimit;
  const events = incrementalMode
    ? allEvents.filter((event) => eventMatchesDirtyScopes(event, dirtyScopes))
    : allEvents;
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
    const sessionKey = normalizeText(event.sessionKey);

    if (event.type === 'turn_received' || event.type === 'turn_replied' || event.type === 'session_checkpoint') {
      if (sessionKey) {
        const existing = sessionProjection.sessions[sessionKey] || {
          sessionKey,
          userId,
          groupId: '',
          channelId: '',
          sessionId: '',
          updatedAt: 0,
          snapshotType: '',
          activeTopic: '',
          openLoops: [],
          assistantCommitments: [],
          userConstraints: [],
          recentMessages: [],
          carryOverUserTurn: '',
          summary: '',
          phaseHint: '',
          interactionState: {},
          sceneState: {},
          expressionState: {},
          moduleState: {}
        };
        const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const clearsRestartRecallTopic = event.type === 'session_checkpoint'
          && Object.prototype.hasOwnProperty.call(payload, 'activeTopic')
          && (normalizeText(event.sourceKind).toLowerCase() === 'restart_recall_clear'
            || normalizeText(payload.summarySource || payload.source || '').toLowerCase() === 'restart_recall_clear');
        sessionProjection.sessions[sessionKey] = {
          ...existing,
          ...normalizeSessionScopeFromEvent(event),
          updatedAt: Math.max(Number(existing.updatedAt || 0), Number(event.ts || 0)),
          snapshotType: normalizeText(payload.snapshotType || existing.snapshotType),
          activeTopic: Object.prototype.hasOwnProperty.call(payload, 'activeTopic')
            ? normalizeText(payload.activeTopic)
            : normalizeText(existing.activeTopic),
          carryOverUserTurn: Object.prototype.hasOwnProperty.call(payload, 'carryOverUserTurn')
            ? normalizeText(payload.carryOverUserTurn)
            : normalizeText(existing.carryOverUserTurn),
          summary: Object.prototype.hasOwnProperty.call(payload, 'summary')
            ? clampText(payload.summary, 2400)
            : clampText(existing.summary, 2400),
          phaseHint: normalizeText(payload.phaseHint || existing.phaseHint),
          openLoops: Array.isArray(payload.openLoops) ? payload.openLoops.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4) : existing.openLoops,
          assistantCommitments: Array.isArray(payload.assistantCommitments) ? payload.assistantCommitments.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4) : existing.assistantCommitments,
          userConstraints: Array.isArray(payload.userConstraints) ? payload.userConstraints.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4) : existing.userConstraints,
          interactionState: clearsRestartRecallTopic
            ? {
                ...(existing.interactionState && typeof existing.interactionState === 'object' ? existing.interactionState : {}),
                activeTopic: normalizeText(payload.activeTopic)
              }
            : payload.interactionState && typeof payload.interactionState === 'object'
              ? payload.interactionState
            : existing.interactionState,
          sceneState: payload.sceneState && typeof payload.sceneState === 'object'
            ? payload.sceneState
            : existing.sceneState,
          expressionState: payload.expressionState && typeof payload.expressionState === 'object'
            ? payload.expressionState
            : existing.expressionState,
          moduleState: payload.moduleState && typeof payload.moduleState === 'object'
            ? payload.moduleState
            : existing.moduleState,
          recentMessages: Array.isArray(payload.recentMessages)
            ? payload.recentMessages
              .map((item) => ({
                role: normalizeText(item?.role).toLowerCase(),
                content: clampText(item?.content, 320)
              }))
              .filter((item) => item.role && item.content)
              .slice(-Math.max(1, Number(config.MEMORY_V3_SESSION_RECENT_MESSAGES || 6)))
            : existing.recentMessages
        };
      }
    }

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
  const activeNodes = nodes.filter((item) => item.status !== 'archived' && !isMemoryNotRecallable(item));
  const hiddenRecallNodes = nodes
    .filter((item) => item.status !== 'archived' && isMemoryNotRecallable(item))
    .map((item) => ({
      ...item,
      suppressedBy: item.suppressedBy || 'not_recallable'
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
      ...expiredProfileNodes.filter((item) => item.userId === userId),
      ...profileConflicts.filter((item) => item.userId === userId)
    ];
    profile.conflicts = profileConflicts.filter((item) => item.userId === userId);
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

function buildLanceDbSyncPlan(nodes = [], options = {}) {
  const activeNodes = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => node && normalizeText(node.status).toLowerCase() !== 'archived' && !isMemoryNotRecallable(node));
  const readyNodeIds = new Set();
  try {
    const { loadEmbeddingIndex } = require('./embeddingIndex');
    for (const row of loadEmbeddingIndex().readyRows || []) {
      if (normalizeText(row.nodeId)) readyNodeIds.add(normalizeText(row.nodeId));
    }
  } catch (_) {}
  const embeddableNodes = activeNodes.filter((node) => readyNodeIds.has(normalizeText(node.id || node.nodeId)));
  return {
    dryRun: options.dryRun !== false,
    fullReconcile: options.fullReconcile === true,
    sourceNodes: activeNodes.length,
    readyRows: embeddableNodes.length,
    pendingRows: Math.max(0, activeNodes.length - embeddableNodes.length),
    recommendedCommand: options.fullReconcile === true
      ? 'node scripts/sync-lancedb-memory-index.js --full --compact'
      : 'node scripts/sync-lancedb-memory-index.js'
  };
}

module.exports = {
  materializeMemoryViews,
  createNodeFromEvent,
  buildLanceDbSyncPlan
};
