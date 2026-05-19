const config = require('../config');
const { createPostReplyJobQueue, getPostReplyJobQueue } = require('./postReplyJobQueue');

function getMemoryExtractionModule() {
  return require('../api/memoryExtraction');
}

function getDailyJournalModule() {
  return require('./dailyJournal');
}

function getSelfImprovementModule() {
  return require('./selfImprovementRuntime');
}

function getMemoryV3Module() {
  return require('./memory-v3');
}

function getMemoryModule() {
  return require('./memory');
}

function getTaskMemoryModule() {
  return require('./taskMemory');
}

function getGroupMemoryModule() {
  return require('./groupMemory');
}

function getVectorMemoryModule() {
  return require('./vectorMemory');
}

function getMemoryEmbeddingBackfillScript() {
  return require('../scripts/backfill-memory-v3-embeddings');
}

function getLanceDbSyncScript() {
  return require('../scripts/sync-lancedb-memory-index');
}

function getLanceDbMemoryStoreModule() {
  return require('./lancedbMemoryStore');
}

function getPerfRuntimeModule() {
  return require('./perfRuntime');
}

const materializeDebounceState = {
  timer: null,
  promise: null,
  pendingCount: 0,
  lastScheduledAt: 0,
  dirtyScopes: {
    userIds: new Set(),
    sessionKeys: new Set(),
    groupIds: new Set()
  }
};

const vectorMaintenanceState = {
  running: false,
  lastRunAt: 0,
  lastResult: null
};

function normalizePhase(value = '') {
  const phase = String(value || '').trim().toLowerCase();
  return phase === 'enrich' ? 'enrich' : 'core';
}

function logStructured(event = '', payload = {}) {
  console.log(`[${event}]`, payload);
}

function isRateLimitError(errorText = '') {
  const value = String(errorText || '').toLowerCase();
  return /(429|rate limit|too many requests)/.test(value);
}

function isTransientPostReplyError(errorText = '') {
  const value = String(errorText || '').toLowerCase();
  return isRateLimitError(value)
    || /(408|425|500|502|503|504|timeout|timed out|temporarily unavailable|econnreset|etimedout|network)/.test(value);
}

function normalizeTurnItems(turns = []) {
  return normalizeArray(turns).filter((item) => item && typeof item === 'object');
}

function buildTurnsConversation(turns = []) {
  return normalizeTurnItems(turns)
    .map((item) => ({
      question: normalizeText(item.question),
      finalReply: normalizeText(item.finalReply)
    }))
    .filter((item) => item.question || item.finalReply);
}

function buildCoreLearningTurns(job = {}) {
  const turns = normalizeTurnItems(job.turns)
    .map((item, index) => {
      const routeMeta = normalizeObject(item.routeMeta, {});
      const question = normalizeText(item.question);
      const finalReply = normalizeText(item.finalReply);
      if (!question && !finalReply) return null;
      const createdAt = normalizeText(item.createdAt);
      return {
        turnId: normalizeText(item.turnId || item.turn_id) || `${normalizeText(job.jobId) || 'post_reply'}:${index + 1}`,
        question,
        finalReply,
        createdAt,
        evidence: normalizeObject(item.evidence, {}),
        sourceSessionId: normalizeText(item.sourceSessionId || item.source_session_id || routeMeta.sessionId || routeMeta.session_id || job.sessionKey),
        routeMeta
      };
    })
    .filter(Boolean);

  if (turns.length > 0) return turns;
  const fallbackQuestion = normalizeText(job.question);
  const fallbackReply = normalizeText(job.finalReply);
  if (!fallbackQuestion && !fallbackReply) return [];
  const routeMeta = normalizeObject(job.routeMeta, {});
  return [{
    turnId: `${normalizeText(job.jobId) || 'post_reply'}:1`,
    question: fallbackQuestion,
    finalReply: fallbackReply,
    createdAt: normalizeText(job.createdAt || new Date().toISOString()),
    evidence: {},
    sourceSessionId: normalizeText(routeMeta.sessionId || routeMeta.session_id || job.sessionKey),
    routeMeta
  }];
}

function buildCoreLearningConversation(job = {}) {
  const turns = buildCoreLearningTurns(job);
  if (turns.length <= 1) {
    const only = turns[0] || {};
    return {
      turns,
      userText: only.question || normalizeText(job.question),
      botReply: only.finalReply || normalizeText(job.finalReply)
    };
  }
  return {
    turns,
    userText: turns.map((item, index) => `Turn ${index + 1} User: ${item.question}`).join('\n'),
    botReply: turns.map((item, index) => `Turn ${index + 1} Assistant: ${item.finalReply}`).join('\n')
  };
}

function buildCoreLearningEvidence(job = {}) {
  const { turns } = buildCoreLearningConversation(job);
  const turnIds = turns.map((item) => normalizeText(item.turnId)).filter(Boolean);
  const latestTurn = turns[turns.length - 1] || {};
  const evidenceItems = turns.map((item, index) => ({
    turnId: normalizeText(item.turnId),
    createdAt: normalizeText(item.createdAt),
    userText: normalizeText(item.evidence?.userText || item.question).slice(0, 500),
    assistantText: normalizeText(item.evidence?.assistantText || item.finalReply).slice(0, 500),
    sourceSessionId: normalizeText(item.sourceSessionId),
    index: index + 1
  }));
  return {
    turns,
    turnId: normalizeText(latestTurn.turnId),
    turnIds,
    evidence: evidenceItems,
    sourceSessionId: normalizeText(latestTurn.sourceSessionId || job.sessionKey)
  };
}

function buildLearningDecisionMeta(type = '', meta = {}, status = 'candidate') {
  return {
    status,
    reason: 'post_reply_enrich_extractor',
    fieldKey: normalizeText(type),
    sourceKind: 'extractor',
    postReplyJobId: normalizeText(meta.jobId),
    jobId: normalizeText(meta.jobId),
    turnId: normalizeText(meta.turnId),
    turnIds: normalizeArray(meta.turnIds).map((item) => normalizeText(item)).filter(Boolean),
    sourceSessionId: normalizeText(meta.sourceSessionId || meta.sessionId),
    evidenceCount: normalizeArray(meta.evidence).length,
    phase: 'post_reply_enrich_write'
  };
}

function buildPostReplyEnrichMeta(base = {}, fieldKey = '', status = 'candidate') {
  const turnIds = normalizeArray(base.turnIds).map((item) => normalizeText(item)).filter(Boolean);
  const turnId = normalizeText(base.turnId || turnIds[turnIds.length - 1]);
  return {
    routePolicyKey: normalizeText(base.routePolicyKey),
    topRouteType: normalizeText(base.topRouteType),
    sessionId: normalizeText(base.sessionId),
    groupId: normalizeText(base.groupId),
    channelId: normalizeText(base.channelId),
    sourceSessionId: normalizeText(base.sourceSessionId || base.sessionId),
    turnId,
    turnIds,
    evidence: normalizeArray(base.evidence),
    learningDecision: buildLearningDecisionMeta(fieldKey, { ...base, turnId, turnIds }, status)
  };
}

function buildMinimalStyleMemoryItems(userId = '', styleMemory = {}, meta = {}) {
  const uid = normalizeText(userId);
  if (!uid) return [];
  const confidence = Number(styleMemory?.confidence || 0) || 0;
  const patterns = normalizeArray(styleMemory?.style_patterns).map((item) => normalizeText(item)).filter(Boolean).slice(0, 1);
  const avoids = normalizeArray(styleMemory?.style_avoid).map((item) => normalizeText(item)).filter(Boolean).slice(0, 1);
  const out = [];
  if (patterns[0]) {
    const enrichMeta = buildPostReplyEnrichMeta(meta, 'style_pattern', 'active');
    out.push({
      userId: uid,
      text: `style: ${patterns[0]}`,
      type: 'fact',
      weight: 1.02,
      source: 'post_reply_enrich',
      confidence,
      semanticSlot: 'style_pattern',
      routePolicyKey: enrichMeta.routePolicyKey,
      topRouteType: enrichMeta.topRouteType,
      sessionId: enrichMeta.sessionId,
      sourceSessionId: enrichMeta.sourceSessionId,
      turnId: enrichMeta.turnId,
      turnIds: enrichMeta.turnIds,
      evidence: enrichMeta.evidence,
      meta: {
        source: 'post_reply_enrich',
        confidence,
        sourceKind: 'extractor',
        status: 'active',
        memoryKind: 'style',
        fieldKey: 'style_pattern',
        participants: [],
        entities: [],
        relations: [],
        routePolicyKey: enrichMeta.routePolicyKey,
        topRouteType: enrichMeta.topRouteType,
        sourceSessionId: enrichMeta.sourceSessionId,
        turnId: enrichMeta.turnId,
        turnIds: enrichMeta.turnIds,
        evidence: enrichMeta.evidence,
        learningDecision: enrichMeta.learningDecision
      }
    });
  }
  if (!patterns[0] && avoids[0]) {
    const enrichMeta = buildPostReplyEnrichMeta(meta, 'style_avoid', 'active');
    out.push({
      userId: uid,
      text: `style: ${avoids[0]}`,
      type: 'fact',
      weight: 1.01,
      source: 'post_reply_enrich',
      confidence,
      semanticSlot: 'style_avoid',
      routePolicyKey: enrichMeta.routePolicyKey,
      topRouteType: enrichMeta.topRouteType,
      sessionId: enrichMeta.sessionId,
      sourceSessionId: enrichMeta.sourceSessionId,
      turnId: enrichMeta.turnId,
      turnIds: enrichMeta.turnIds,
      evidence: enrichMeta.evidence,
      meta: {
        source: 'post_reply_enrich',
        confidence,
        sourceKind: 'extractor',
        status: 'active',
        memoryKind: 'style',
        fieldKey: 'style_avoid',
        participants: [],
        entities: [],
        relations: [],
        routePolicyKey: enrichMeta.routePolicyKey,
        topRouteType: enrichMeta.topRouteType,
        sourceSessionId: enrichMeta.sourceSessionId,
        turnId: enrichMeta.turnId,
        turnIds: enrichMeta.turnIds,
        evidence: enrichMeta.evidence,
        learningDecision: enrichMeta.learningDecision
      }
    });
  }
  return out;
}

function buildMinimalJargonMemoryItems(groupId = '', jargonMemory = {}, meta = {}) {
  const gid = normalizeText(groupId);
  if (!gid) return [];
  const confidence = Number(jargonMemory?.confidence || 0) || 0;
  const terms = normalizeArray(jargonMemory?.jargon_terms).map((item) => normalizeText(item)).filter(Boolean).slice(0, 1);
  const patterns = normalizeArray(jargonMemory?.jargon_patterns).map((item) => normalizeText(item)).filter(Boolean).slice(0, 1);
  const selected = terms[0] || patterns[0];
  if (!selected) return [];
  const enrichMeta = buildPostReplyEnrichMeta(meta, 'group_jargon', 'active');
  return [{
    userId: `group:${gid}`,
    text: `group jargon: ${selected}`,
    type: 'fact',
    weight: 0.98,
    source: 'post_reply_enrich',
    confidence,
    semanticSlot: 'group_jargon',
    routePolicyKey: enrichMeta.routePolicyKey,
    topRouteType: enrichMeta.topRouteType,
    sessionId: enrichMeta.sessionId,
    sourceSessionId: enrichMeta.sourceSessionId,
    turnId: enrichMeta.turnId,
    turnIds: enrichMeta.turnIds,
    evidence: enrichMeta.evidence,
    meta: {
      source: 'post_reply_enrich',
      confidence,
      sourceKind: 'extractor',
      status: 'active',
      memoryKind: 'jargon',
      fieldKey: 'group_jargon',
      participants: [],
      entities: [],
      relations: [],
      routePolicyKey: enrichMeta.routePolicyKey,
      topRouteType: enrichMeta.topRouteType,
      sourceSessionId: enrichMeta.sourceSessionId,
      turnId: enrichMeta.turnId,
      turnIds: enrichMeta.turnIds,
      evidence: enrichMeta.evidence,
      learningDecision: enrichMeta.learningDecision
    }
  }];
}

async function runEnrichPhase(job = {}, meta = {}) {
  const { extractPostReplyEnrichment } = getMemoryExtractionModule();
  const { maybeSegmentJournalByThreshold } = getDailyJournalModule();
  const { storeExtractedSelfImprovementItems } = getSelfImprovementModule();
  const { applyAffinityProposal } = getMemoryModule();
  const { addTaskMemory, addTaskMemoryWithVectorBackfill } = getTaskMemoryModule();
  const { addGroupMemory, addGroupMemoryWithVectorBackfill } = getGroupMemoryModule();
  const { addMemoryItemsBatch, addMemoryItemsBatchWithVectorBackfill } = getVectorMemoryModule();
  const turns = buildTurnsConversation(job.turns);
  const latest = turns[turns.length - 1] || { question: normalizeText(job.question), finalReply: normalizeText(job.finalReply) };
  const enrichment = await extractPostReplyEnrichment(job.userId, turns, {
    routePolicyKey: meta.routePolicyKey,
    topRouteType: meta.topRouteType,
    groupId: meta.groupId
  });

  if (enrichment?.affinity && typeof enrichment.affinity === 'object') {
    applyAffinityProposal(job.userId, enrichment.affinity, {
      userText: latest.question,
      assistantText: latest.finalReply,
      routePolicyKey: meta.routePolicyKey,
      topRouteType: meta.topRouteType,
      groupId: meta.groupId,
      sessionId: meta.sessionId
    });
  }

  if (enrichment?.task_memory && typeof enrichment.task_memory === 'object') {
    const taskMemory = enrichment.task_memory;
    const confidence = Number(taskMemory.confidence || 0) || 0;
    if (confidence > 0 && normalizeText(taskMemory.task_type)) {
      const taskPayload = {
        taskType: normalizeText(taskMemory.task_type),
        trigger: normalizeText(taskMemory.trigger),
        strategy: normalizeText(taskMemory.strategy),
        avoid: normalizeText(taskMemory.avoid),
        outcome: normalizeText(taskMemory.outcome) || 'success',
        confidence,
        source: 'post_reply_enrich',
        routePolicyKey: meta.routePolicyKey,
        topRouteType: meta.topRouteType,
        agentName: meta.agentName,
        toolName: meta.toolName,
        sessionId: meta.sessionId,
        channelId: meta.channelId,
        sourceKind: 'extractor',
        status: 'candidate',
        sourceSessionId: meta.sourceSessionId || meta.sessionId,
        turnId: meta.turnId,
        turnIds: meta.turnIds,
        evidence: meta.evidence,
        learningDecision: buildLearningDecisionMeta('task', meta, 'candidate'),
        participants: [],
        entities: [],
        relations: []
      };
      if (typeof addTaskMemoryWithVectorBackfill === 'function') {
        await addTaskMemoryWithVectorBackfill(job.userId, taskPayload, meta);
      } else {
        addTaskMemory(job.userId, taskPayload);
      }
    }
  }

  if (meta.groupId && enrichment?.group_memory && typeof enrichment.group_memory === 'object') {
    const confidence = Number(enrichment.group_memory.confidence || 0) || 0;
    for (const value of normalizeArray(enrichment.group_memory.shared_facts).map((item) => normalizeText(item)).filter(Boolean)) {
      const groupMeta = { confidence, sourceKind: 'extractor', status: 'candidate', ...buildPostReplyEnrichMeta(meta, 'group_fact', 'candidate') };
      if (typeof addGroupMemoryWithVectorBackfill === 'function') {
        await addGroupMemoryWithVectorBackfill(meta.groupId, value, 'fact', groupMeta, 1.08, meta);
      } else {
        addGroupMemory(meta.groupId, value, 'fact', groupMeta, 1.08);
      }
    }
    for (const value of normalizeArray(enrichment.group_memory.shared_goals).map((item) => normalizeText(item)).filter(Boolean)) {
      const groupMeta = { confidence, sourceKind: 'extractor', status: 'active', ...buildPostReplyEnrichMeta(meta, 'group_goal', 'active') };
      if (typeof addGroupMemoryWithVectorBackfill === 'function') {
        await addGroupMemoryWithVectorBackfill(meta.groupId, `group goal: ${value}`, 'goal', groupMeta, 1.15, meta);
      } else {
        addGroupMemory(meta.groupId, `group goal: ${value}`, 'goal', groupMeta, 1.15);
      }
    }
    for (const value of normalizeArray(enrichment.group_memory.shared_topics).map((item) => normalizeText(item)).filter(Boolean)) {
      const groupMeta = { confidence, sourceKind: 'extractor', status: 'candidate', ...buildPostReplyEnrichMeta(meta, 'group_topic', 'candidate') };
      if (typeof addGroupMemoryWithVectorBackfill === 'function') {
        await addGroupMemoryWithVectorBackfill(meta.groupId, `group topic: ${value}`, 'topic', groupMeta, 0.96, meta);
      } else {
        addGroupMemory(meta.groupId, `group topic: ${value}`, 'topic', groupMeta, 0.96);
      }
    }
  }

  const signalItems = [
    ...buildMinimalStyleMemoryItems(job.userId, enrichment?.style_memory, meta),
    ...buildMinimalJargonMemoryItems(meta.groupId, enrichment?.jargon_memory, meta)
  ];
  if (signalItems.length > 0) {
    if (typeof addMemoryItemsBatchWithVectorBackfill === 'function') {
      await addMemoryItemsBatchWithVectorBackfill(signalItems, {
        ...meta,
        phase: 'post_reply_enrich_write'
      });
    } else {
      addMemoryItemsBatch(signalItems);
    }
  }

  if (enrichment?.self_improvement && typeof enrichment.self_improvement === 'object') {
    storeExtractedSelfImprovementItems(job.userId, enrichment.self_improvement.items, {
      routePolicyKey: meta.routePolicyKey,
      topRouteType: meta.topRouteType,
      toolName: meta.toolName,
      taskType: meta.taskType,
      sessionId: meta.sessionId,
      channelId: meta.channelId,
      groupId: meta.groupId
    });
  }

  const latestTurn = normalizeTurnItems(job.turns).slice(-1)[0] || {};
  const latestTurnCreatedAt = normalizeText(latestTurn.createdAt);
  const targetDay = latestTurnCreatedAt
    ? String(latestTurnCreatedAt).slice(0, 10)
    : '';
  if (targetDay) {
    await maybeSegmentJournalByThreshold(job.userId, targetDay, {
      sessionKey: meta.sessionKey,
      routePolicyKey: meta.routePolicyKey,
      topRouteType: meta.topRouteType,
      routeMeta: normalizeObject(job.routeMeta, {}),
      continuitySnapshot: normalizeObject(job.continuitySnapshot, {}),
      contextStats: normalizeObject(job.contextStats, {}),
      groupId: meta.groupId,
      channelId: meta.channelId,
      taskType: meta.taskType
    });
  }
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeCompletedTasks(value = {}) {
  const source = normalizeObject(value, {});
  const out = {};
  for (const [key, completed] of Object.entries(source)) {
    const normalizedKey = normalizeText(key);
    if (normalizedKey) out[normalizedKey] = completed === true;
  }
  return out;
}

function isPartialTaskRetryEnabled() {
  return config.POST_REPLY_PARTIAL_TASK_RETRY_ENABLED !== false;
}

function isTaskCompleted(job = {}, taskKey = '') {
  if (!isPartialTaskRetryEnabled()) return false;
  const key = normalizeText(taskKey);
  if (!key) return false;
  return normalizeCompletedTasks(job.completedTasks)[key] === true;
}

function markTaskCompleted(job = {}, deps = {}, taskKey = '') {
  if (!isPartialTaskRetryEnabled()) return job;
  const key = normalizeText(taskKey);
  if (!key) return job;
  const nextCompletedTasks = {
    ...normalizeCompletedTasks(job.completedTasks),
    [key]: true
  };
  const nextJob = {
    ...job,
    completedTasks: nextCompletedTasks
  };
  const queue = deps.queue;
  if (queue && typeof queue.updateProcessingJob === 'function') {
    try {
      return queue.updateProcessingJob(nextJob, {
        completedTasks: nextCompletedTasks
      });
    } catch (error) {
      console.warn('[post-reply-worker] failed to persist task progress:', error?.message || error);
    }
  }
  return nextJob;
}

function getPostReplyMaterializeDelayMs(options = {}) {
  if (options.force === true) return 0;
  const configured = Number(options.delayMs ?? config.POST_REPLY_MATERIALIZE_DEBOUNCE_MS);
  return Math.max(1000, Number.isFinite(configured) && configured > 0 ? configured : 45 * 1000);
}

function addPostReplyDirtyScope(options = {}) {
  const add = (set, value) => {
    const text = normalizeText(value);
    if (text) set.add(text);
  };
  add(materializeDebounceState.dirtyScopes.userIds, options.userId);
  add(materializeDebounceState.dirtyScopes.sessionKeys, options.sessionKey);
  add(materializeDebounceState.dirtyScopes.groupIds, options.groupId);
}

function consumePostReplyDirtyScopes() {
  const scopes = {
    userIds: Array.from(materializeDebounceState.dirtyScopes.userIds),
    sessionKeys: Array.from(materializeDebounceState.dirtyScopes.sessionKeys),
    groupIds: Array.from(materializeDebounceState.dirtyScopes.groupIds)
  };
  materializeDebounceState.dirtyScopes.userIds.clear();
  materializeDebounceState.dirtyScopes.sessionKeys.clear();
  materializeDebounceState.dirtyScopes.groupIds.clear();
  return scopes;
}

function schedulePostReplyMaterialize(options = {}) {
  const { materializeMemoryViews } = getMemoryV3Module();
  if (options.force === true) {
    return Promise.resolve(materializeMemoryViews({
      ...options,
      force: true,
      source: options.source || 'post_reply_force'
    }));
  }

  addPostReplyDirtyScope(options);
  materializeDebounceState.pendingCount += 1;
  if (materializeDebounceState.timer) {
    return {
      scheduled: true,
      coalesced: true,
      pendingCount: materializeDebounceState.pendingCount,
      delayMs: getPostReplyMaterializeDelayMs(options)
    };
  }

  const delayMs = getPostReplyMaterializeDelayMs(options);
  materializeDebounceState.lastScheduledAt = Date.now();
  materializeDebounceState.timer = setTimeout(() => {
    const pendingCount = materializeDebounceState.pendingCount;
    const dirtyScopes = consumePostReplyDirtyScopes();
    materializeDebounceState.timer = null;
    materializeDebounceState.pendingCount = 0;
    materializeDebounceState.promise = Promise.resolve()
      .then(() => materializeMemoryViews({
        source: 'post_reply_debounced',
        pendingCount,
        mode: 'incremental',
        dirtyScopes
      }))
      .catch((error) => {
        console.warn('[post_reply_worker] debounced materialize failed:', error?.message || error);
      })
      .finally(() => {
        materializeDebounceState.promise = null;
      });
  }, delayMs);
  if (typeof materializeDebounceState.timer.unref === 'function') {
    materializeDebounceState.timer.unref();
  }
  return {
    scheduled: true,
    coalesced: false,
    pendingCount: materializeDebounceState.pendingCount,
    delayMs
  };
}

async function flushPostReplyMaterialize(options = {}) {
  const { materializeMemoryViews } = getMemoryV3Module();
  if (materializeDebounceState.timer) {
    clearTimeout(materializeDebounceState.timer);
    materializeDebounceState.timer = null;
    const pendingCount = materializeDebounceState.pendingCount;
    const dirtyScopes = consumePostReplyDirtyScopes();
    materializeDebounceState.pendingCount = 0;
    materializeDebounceState.promise = Promise.resolve(materializeMemoryViews({
      source: options.source || 'post_reply_flush',
      pendingCount,
      force: options.force === true,
      mode: options.force === true ? 'full' : 'incremental',
      dirtyScopes
    })).finally(() => {
      materializeDebounceState.promise = null;
    });
  }
  if (materializeDebounceState.promise) {
    await materializeDebounceState.promise;
  }
  return {
    flushed: true,
    pendingCount: materializeDebounceState.pendingCount
  };
}

function normalizeVectorMaintenanceSource(value = 'all') {
  const normalized = normalizeText(value || 'all').toLowerCase();
  return ['all', 'memory', 'journal', 'worldbook'].includes(normalized) ? normalized : 'all';
}

function isPostReplyVectorMaintenanceEnabled(options = {}) {
  const enabled = Object.prototype.hasOwnProperty.call(options, 'enabled')
    ? options.enabled === true
    : config.POST_REPLY_VECTOR_MAINTENANCE_ENABLED === true;
  return enabled
    && config.MEMORY_V3_ENABLED === true
    && config.MEMORY_EMBEDDING_INDEX_ENABLED !== false
    && config.MEMORY_LANCEDB_SYNC_ENABLED !== false;
}

function hasVectorCoverageDrift(coverage = {}) {
  return Number(coverage.readyButNotSynced || 0) > 0
    || Number(coverage.staleTableRows || 0) > 0;
}

function shouldReconcileVectorSource(summary = {}, source = 'all') {
  const normalized = normalizeVectorMaintenanceSource(source);
  const coverage = normalizeObject(summary.coverage, {});
  if (normalized === 'worldbook') return hasVectorCoverageDrift(coverage.worldbook);
  if (normalized === 'memory' || normalized === 'journal') return hasVectorCoverageDrift(coverage.memory);
  return hasVectorCoverageDrift(coverage.memory) || hasVectorCoverageDrift(coverage.worldbook);
}

async function reconcilePostReplyVectorStore(source = 'all', deps = {}) {
  const normalized = normalizeVectorMaintenanceSource(source);
  const buildSyncSummary = typeof deps.buildSyncSummary === 'function'
    ? deps.buildSyncSummary
    : getLanceDbSyncScript().buildSyncSummary;
  const lanceDbStore = deps.lanceDbStore || getLanceDbMemoryStoreModule();
  const before = await buildSyncSummary({
    dryRun: true,
    fullReconcile: true
  });
  if (!shouldReconcileVectorSource(before, normalized)) {
    if (before && before._rows) delete before._rows;
    return { ok: true, skipped: true, reason: 'no_drift', before };
  }

  const writes = [];
  if (normalized === 'all' || normalized === 'memory' || normalized === 'journal') {
    writes.push(await lanceDbStore.syncMemoryRows(before._rows?.memory || [], {
      full: false,
      fullReconcile: true,
      deleteStaleRows: true
    }));
  }
  if (normalized === 'all' || normalized === 'worldbook') {
    writes.push(await lanceDbStore.syncWorldbookRows(before._rows?.worldbook || [], {
      full: false,
      fullReconcile: true,
      deleteStaleRows: true
    }));
  }
  const beforeCoverage = before.coverage;
  if (before && before._rows) delete before._rows;
  const after = await buildSyncSummary({
    dryRun: true,
    fullReconcile: true
  });
  if (after && after._rows) delete after._rows;
  return {
    ok: writes.every((item) => item && item.ok !== false),
    skipped: false,
    beforeCoverage,
    afterCoverage: after.coverage,
    writes
  };
}

async function runPostReplyVectorMaintenance(options = {}, deps = {}) {
  if (!isPostReplyVectorMaintenanceEnabled(options)) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  if (vectorMaintenanceState.running && options.force !== true) {
    return { ok: true, skipped: true, reason: 'already_running' };
  }

  const now = Date.now();
  const intervalMs = Math.max(0, Number(options.intervalMs ?? config.POST_REPLY_VECTOR_MAINTENANCE_INTERVAL_MS) || 0);
  const elapsedMs = now - Math.max(0, Number(vectorMaintenanceState.lastRunAt || 0) || 0);
  if (options.force !== true && intervalMs > 0 && elapsedMs < intervalMs) {
    return {
      ok: true,
      skipped: true,
      reason: 'throttled',
      nextRunInMs: intervalMs - elapsedMs,
      lastResult: vectorMaintenanceState.lastResult
    };
  }

  vectorMaintenanceState.running = true;
  vectorMaintenanceState.lastRunAt = now;
  const startedAt = Date.now();
  try {
    const flushMaterialize = typeof deps.flushPostReplyMaterialize === 'function'
      ? deps.flushPostReplyMaterialize
      : flushPostReplyMaterialize;
    await flushMaterialize({
      source: options.flushSource || 'post_reply_vector_maintenance',
      force: options.flushForce === true
    });

    const runBackfill = typeof deps.runMemoryVectorBackfill === 'function'
      ? deps.runMemoryVectorBackfill
      : getMemoryEmbeddingBackfillScript().runBackfill;
    const result = await runBackfill({
      source: normalizeVectorMaintenanceSource(options.source || config.POST_REPLY_VECTOR_MAINTENANCE_SOURCE),
      limit: Math.max(1, Number(options.limit ?? config.POST_REPLY_VECTOR_MAINTENANCE_LIMIT) || 32),
      retryFailed: Object.prototype.hasOwnProperty.call(options, 'retryFailed')
        ? options.retryFailed === true
        : config.POST_REPLY_VECTOR_MAINTENANCE_RETRY_FAILED === true,
      syncAfter: true,
      resume: true,
      maxBatches: Math.max(1, Number(options.maxBatches ?? config.POST_REPLY_VECTOR_MAINTENANCE_MAX_BATCHES) || 1),
      lowResourceMode: Object.prototype.hasOwnProperty.call(options, 'lowResourceMode')
        ? options.lowResourceMode === true
        : config.MEMORY_BACKFILL_LOW_RESOURCE_MODE === true
    }, deps.backfillDeps || {});
    const source = normalizeVectorMaintenanceSource(result?.source || options.source || config.POST_REPLY_VECTOR_MAINTENANCE_SOURCE);
    const syncRuns = Array.isArray(result?.syncRuns) ? result.syncRuns.length : 0;
    const stoppedBy = normalizeText(result?.stoppedBy);
    const shouldReconcile = config.POST_REPLY_VECTOR_MAINTENANCE_RECONCILE_ENABLED === true
      && (syncRuns === 0 || stoppedBy === 'post_sync_health_gate');
    const reconcile = shouldReconcile
      ? await reconcilePostReplyVectorStore(source, deps.reconcileDeps || {})
      : null;

    const summary = {
      ok: result?.ok !== false || (stoppedBy === 'post_sync_health_gate' && reconcile?.ok === true),
      skipped: false,
      durationMs: Date.now() - startedAt,
      source,
      considered: Number(result?.considered || 0) || 0,
      embedded: Number(result?.embedded || 0) || 0,
      failed: Number(result?.failed || 0) || 0,
      remaining: Number(result?.remaining || 0) || 0,
      syncRuns,
      reconciled: Boolean(reconcile && reconcile.skipped !== true),
      stoppedBy
    };
    vectorMaintenanceState.lastResult = summary;
    return {
      ...summary,
      result
    };
  } finally {
    vectorMaintenanceState.running = false;
  }
}

function buildLearningMeta(job = {}) {
  const routeMeta = normalizeObject(job.routeMeta, {});
  const evidenceMeta = buildCoreLearningEvidence(job);
  return {
    jobId: normalizeText(job.jobId),
    routePolicyKey: normalizeText(job.routePolicyKey),
    topRouteType: normalizeText(job.topRouteType || routeMeta.topRouteType),
    sessionKey: normalizeText(job.sessionKey),
    groupId: normalizeText(routeMeta.groupId || routeMeta.group_id),
    sessionId: normalizeText(routeMeta.sessionId || routeMeta.session_id || evidenceMeta.sourceSessionId),
    turnId: evidenceMeta.turnId,
    turnIds: evidenceMeta.turnIds,
    turns: evidenceMeta.turns,
    evidence: evidenceMeta.evidence,
    sourceSessionId: evidenceMeta.sourceSessionId,
    taskType: normalizeText(routeMeta.taskType || routeMeta.task_type),
    agentName: normalizeText(routeMeta.agentName || routeMeta.agent_name),
    toolName: normalizeText(routeMeta.toolName || routeMeta.tool_name),
    channelId: normalizeText(routeMeta.channelId || routeMeta.channel_id),
    continuitySnapshot: normalizeObject(job.continuitySnapshot, {}),
    contextStats: normalizeObject(job.contextStats, {}),
    execLogs: normalizeArray(job.execLogs)
  };
}

async function processPostReplyJob(job = {}, deps = {}) {
  let currentJob = {
    ...job,
    completedTasks: normalizeCompletedTasks(job.completedTasks)
  };
  const tasks = normalizeObject(job.tasks, {});
  const meta = buildLearningMeta(job);
  const phase = normalizePhase(job.phase);
  const workerTaskOptions = {
    ...meta,
    postReplyMemoryMode: String(config.POST_REPLY_MEMORY_MODE || 'core').trim().toLowerCase() || 'core',
    throwOnError: true
  };
  const learningConversation = buildCoreLearningConversation(job);
  const traceBase = {
    jobId: normalizeText(job.jobId),
    phase,
    userId: normalizeText(job.userId),
    routePolicyKey: normalizeText(job.routePolicyKey),
    topRouteType: normalizeText(job.topRouteType)
  };

  if (phase === 'core' && tasks.memoryLearning && !isTaskCompleted(currentJob, 'memoryLearning')) {
    const { learnSomethingNew } = getMemoryExtractionModule();
    logStructured('post_reply_step_start', { ...traceBase, step: 'learnSomethingNew' });
    await learnSomethingNew(job.userId, learningConversation.userText, learningConversation.botReply, workerTaskOptions);
    logStructured('post_reply_step_done', { ...traceBase, step: 'learnSomethingNew' });
    currentJob = markTaskCompleted(currentJob, deps, 'memoryLearning');
  }
  if (phase === 'core' && tasks.selfImprovement && !isTaskCompleted(currentJob, 'selfImprovement')) {
    const { learnSelfImprovement } = getSelfImprovementModule();
    logStructured('post_reply_step_start', { ...traceBase, step: 'learnSelfImprovement' });
    await learnSelfImprovement(job.userId, job.question, job.finalReply, workerTaskOptions);
    logStructured('post_reply_step_done', { ...traceBase, step: 'learnSelfImprovement' });
    currentJob = markTaskCompleted(currentJob, deps, 'selfImprovement');
  }
  if (tasks.dailyJournal && !isTaskCompleted(currentJob, 'dailyJournal')) {
    const { appendDailyJournalEntry } = getDailyJournalModule();
    logStructured('post_reply_step_start', { ...traceBase, step: 'appendDailyJournalEntry' });
    await appendDailyJournalEntry(
      job.userId,
      job.question,
      job.finalReply,
      normalizeObject(job.userInfo, {}),
      {
        segmentNow: phase === 'enrich'
          ? config.POST_REPLY_DAILY_JOURNAL_SEGMENT_NOW === true
          : false,
        throwOnError: true,
        sessionKey: normalizeText(job.sessionKey),
        sourceSessionId: normalizeText(meta.sourceSessionId || job.sourceSessionId || job.routeMeta?.sessionId || job.routeMeta?.session_id),
        jobId: normalizeText(job.jobId),
        postReplyJobId: normalizeText(job.jobId),
        turnId: normalizeText(meta.turnId),
        turnIds: normalizeArray(meta.turnIds).map((item) => normalizeText(item)).filter(Boolean),
        evidence: normalizeArray(meta.evidence),
        routePolicyKey: normalizeText(job.routePolicyKey),
        topRouteType: normalizeText(job.topRouteType),
        routeMeta: normalizeObject(job.routeMeta, {}),
        continuitySnapshot: normalizeObject(job.continuitySnapshot, {}),
        contextStats: normalizeObject(job.contextStats, {}),
        groupId: normalizeText(job.routeMeta?.groupId || job.routeMeta?.group_id),
        channelId: normalizeText(job.routeMeta?.channelId || job.routeMeta?.channel_id),
        taskType: normalizeText(job.routeMeta?.taskType || job.routeMeta?.task_type)
      }
    );
    logStructured('post_reply_step_done', { ...traceBase, step: 'appendDailyJournalEntry' });
    currentJob = markTaskCompleted(currentJob, deps, 'dailyJournal');
  }
  if (phase === 'core' && config.MEMORY_V3_ENABLED) {
    if (!isTaskCompleted(currentJob, 'memoryEvent')) {
      const { appendMemoryEvent } = getMemoryV3Module();
      logStructured('post_reply_step_start', { ...traceBase, step: 'appendMemoryEvent' });
      await appendMemoryEvent({
        type: 'memory_confirmed',
        userId: job.userId,
        sessionKey: normalizeText(job.sessionKey),
        groupId: normalizeText(job.routeMeta?.groupId || job.routeMeta?.group_id),
        channelId: normalizeText(job.routeMeta?.channelId || job.routeMeta?.channel_id),
        sessionId: normalizeText(job.routeMeta?.sessionId || job.routeMeta?.session_id),
        routePolicyKey: normalizeText(job.routePolicyKey),
        topRouteType: normalizeText(job.topRouteType),
        scopeType: normalizeText(job.routeMeta?.groupId || job.routeMeta?.group_id) ? 'group' : 'personal',
        source: 'post_reply_worker',
        sourceKind: 'runtime',
        memoryKind: 'turn_summary',
        semanticSlot: 'turn_summary',
        text: `Q: ${normalizeText(job.question)}\nA: ${normalizeText(job.finalReply)}`,
        payload: {
          type: 'fact'
        }
      });
      logStructured('post_reply_step_done', { ...traceBase, step: 'appendMemoryEvent' });
      currentJob = markTaskCompleted(currentJob, deps, 'memoryEvent');
    }
    if (!isTaskCompleted(currentJob, 'materialize')) {
      const scheduleMaterializeMemoryViews = typeof deps.scheduleMaterializeMemoryViews === 'function'
        ? deps.scheduleMaterializeMemoryViews
        : schedulePostReplyMaterialize;
      logStructured('post_reply_step_start', { ...traceBase, step: 'scheduleMaterializeMemoryViews' });
      const materializeResult = await scheduleMaterializeMemoryViews({
        reason: 'post_reply_core',
        userId: normalizeText(job.userId),
        sessionKey: normalizeText(job.sessionKey),
        groupId: normalizeText(job.routeMeta?.groupId || job.routeMeta?.group_id)
      });
      logStructured('post_reply_step_done', {
        ...traceBase,
        step: 'scheduleMaterializeMemoryViews',
        materialize: materializeResult && typeof materializeResult === 'object'
          ? {
              scheduled: Boolean(materializeResult.scheduled),
              coalesced: Boolean(materializeResult.coalesced),
              delayMs: Number(materializeResult.delayMs || 0) || 0,
              pendingCount: Number(materializeResult.pendingCount || 0) || 0
            }
          : {}
      });
      currentJob = markTaskCompleted(currentJob, deps, 'materialize');
    }
    if (!isTaskCompleted(currentJob, 'vectorMaintenance') && isPostReplyVectorMaintenanceEnabled()) {
      const runVectorMaintenance = typeof deps.runVectorMaintenance === 'function'
        ? deps.runVectorMaintenance
        : runPostReplyVectorMaintenance;
      logStructured('post_reply_step_start', { ...traceBase, step: 'runVectorMaintenance' });
      try {
        const maintenanceResult = await runVectorMaintenance({
          jobId: normalizeText(job.jobId),
          userId: normalizeText(job.userId),
          sessionKey: normalizeText(job.sessionKey),
          groupId: normalizeText(job.routeMeta?.groupId || job.routeMeta?.group_id)
        }, deps);
        logStructured('post_reply_step_done', {
          ...traceBase,
          step: 'runVectorMaintenance',
          maintenance: maintenanceResult && typeof maintenanceResult === 'object'
            ? {
                ok: maintenanceResult.ok !== false,
                skipped: Boolean(maintenanceResult.skipped),
                reason: normalizeText(maintenanceResult.reason),
                embedded: Number(maintenanceResult.embedded || 0) || 0,
                failed: Number(maintenanceResult.failed || 0) || 0,
                remaining: Number(maintenanceResult.remaining || 0) || 0,
                durationMs: Number(maintenanceResult.durationMs || 0) || 0
              }
            : {}
        });
      } catch (error) {
        logStructured('post_reply_step_failed', {
          ...traceBase,
          step: 'runVectorMaintenance',
          error: error?.message || error
        });
      }
      currentJob = markTaskCompleted(currentJob, deps, 'vectorMaintenance');
    }
  }
  if (phase === 'enrich' && !isTaskCompleted(currentJob, 'enrich')) {
    logStructured('post_reply_step_start', { ...traceBase, step: 'runEnrichPhase' });
    await runEnrichPhase(job, meta);
    logStructured('post_reply_step_done', { ...traceBase, step: 'runEnrichPhase' });
    currentJob = markTaskCompleted(currentJob, deps, 'enrich');
  }
  return {
    ok: true,
    job: currentJob
  };
}

function createPostReplyWorkerRuntime(options = {}) {
  const queue = options.queue
    || (options.queueOptions ? createPostReplyJobQueue(options.queueOptions) : getPostReplyJobQueue());
  const pollMs = Math.max(250, Number(options.pollMs || config.POST_REPLY_WORKER_POLL_MS) || 2000);
  const staleProcessingMs = Math.max(1000, Number(options.staleProcessingMs || config.POST_REPLY_WORKER_STALE_PROCESSING_MS) || 5 * 60 * 1000);
  const concurrency = Math.max(1, Number(options.concurrency || config.POST_REPLY_WORKER_CONCURRENCY) || 1);
  const processJobImpl = options.processJob || processPostReplyJob;
  const circuitBreakerThreshold = Math.max(1, Number(config.POST_REPLY_CIRCUIT_BREAKER_THRESHOLD) || 3);
  const rateLimitCooldownMs = Math.max(0, Number(config.POST_REPLY_RATE_LIMIT_COOLDOWN_MS) || 0);
  const rateLimitMaxConcurrency = Math.max(1, Number(config.POST_REPLY_RATE_LIMIT_MAX_CONCURRENCY) || 1);
  const retryBaseMs = Math.max(0, Number(config.POST_REPLY_RETRY_BASE_MS) || 1000);
  const retryMaxMs = Math.max(0, Number(config.POST_REPLY_RETRY_MAX_MS) || 30000);
  const retryJitterMs = Math.max(0, Number(config.POST_REPLY_RETRY_JITTER_MS) || 0);
  const rssRecycleBytes = Math.max(0, Number(options.rssRecycleMb ?? config.POST_REPLY_WORKER_RSS_RECYCLE_MB) || 0) * 1024 * 1024;
  const rssRecycleIdleMs = Math.max(0, Number(options.rssRecycleIdleMs ?? config.POST_REPLY_WORKER_RSS_RECYCLE_IDLE_MS) || 0);
  const onRecycle = typeof options.onRecycle === 'function' ? options.onRecycle : null;

  let timer = null;
  let stopped = true;
  let activeCount = 0;
  let lastActiveAt = Date.now();
  let recycleRequested = false;
  const activeUserIds = new Set();
  let scheduledTick = false;
  const phaseCircuitState = new Map();
  const phaseRateLimitState = new Map();

  function getActiveUserIds() {
    return Array.from(activeUserIds);
  }

  function getStats() {
    return {
      activeCount,
      activeUserIds: getActiveUserIds(),
      lastActiveAt,
      rssBytes: process.memoryUsage().rss,
      recycleRequested
    };
  }

  function maybeRequestIdleRecycle(reason = 'rss_high') {
    if (!rssRecycleBytes || recycleRequested || activeCount > 0) return false;
    const idleMs = Math.max(0, Date.now() - lastActiveAt);
    if (idleMs < rssRecycleIdleMs) return false;
    const rssBytes = process.memoryUsage().rss;
    if (rssBytes < rssRecycleBytes) return false;
    recycleRequested = true;
    logStructured('post_reply_worker_recycle_requested', {
      reason,
      rssMb: Math.round((rssBytes / 1024 / 1024) * 10) / 10,
      thresholdMb: Math.round((rssRecycleBytes / 1024 / 1024) * 10) / 10,
      idleMs
    });
    if (onRecycle) {
      try {
        onRecycle({
          reason,
          rssBytes,
          thresholdBytes: rssRecycleBytes,
          idleMs
        });
      } catch (error) {
        console.error('[post-reply-worker] recycle callback failed:', error?.message || error);
      }
    }
    return true;
  }

  function getCircuitKey(job = {}) {
    const phase = normalizePhase(job.phase);
    return phase;
  }

  function getEffectiveConcurrency() {
    const now = Date.now();
    const hasActiveRateLimit = Array.from(phaseRateLimitState.values())
      .map((item) => normalizeObject(item, {}))
      .some((item) => Math.max(0, Number(item.cooldownUntil || 0) || 0) > now);
    return hasActiveRateLimit
      ? Math.min(concurrency, rateLimitMaxConcurrency)
      : concurrency;
  }

  function applyRateLimitBackoff(job = {}, errorText = '') {
    const phase = getCircuitKey(job);
    const nextAttempt = Math.max(1, Number(job.attempt || 0) + 1);
    const exponentialDelayMs = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.max(0, nextAttempt - 1)));
    const jitterMs = retryJitterMs > 0 ? Math.floor(Math.random() * retryJitterMs) : 0;
    const retryDelayMs = exponentialDelayMs + jitterMs;
    const cooldownMs = Math.max(rateLimitCooldownMs, retryDelayMs);
    phaseRateLimitState.set(phase, {
      cooldownUntil: Date.now() + cooldownMs,
      retryDelayMs
    });
    logStructured('post_reply_rate_limited', {
      phase,
      retryDelayMs,
      cooldownMs,
      enforcedConcurrency: rateLimitMaxConcurrency,
      error: errorText
    });
    return retryDelayMs;
  }

  function getCircuitCooldownMs(phase = '') {
    return normalizePhase(phase) === 'enrich'
      ? Math.max(0, Number(config.POST_REPLY_ENRICH_CIRCUIT_COOLDOWN_MS) || 0)
      : Math.max(0, Number(config.POST_REPLY_CORE_CIRCUIT_COOLDOWN_MS) || 0);
  }

  function isTerminalPostReplyError(errorText = '') {
    const value = String(errorText || '').toLowerCase();
    return /(401|403|404|forbidden|unauthorized|not found|model not supported|unsupported model)/.test(value);
  }

  function canRunPhase(job = {}) {
    const key = getCircuitKey(job);
    const state = normalizeObject(phaseCircuitState.get(key), {});
    const until = Math.max(0, Number(state.openUntil || 0) || 0);
    if (!until) return true;
    if (Date.now() >= until) {
      phaseCircuitState.delete(key);
      logStructured('post_reply_circuit_half_open', { phase: key });
      return true;
    }
    return false;
  }

  function recordPhaseFailure(job = {}, errorText = '') {
    const key = getCircuitKey(job);
    const state = normalizeObject(phaseCircuitState.get(key), { consecutiveFailures: 0, openUntil: 0 });
    state.consecutiveFailures = Math.max(0, Number(state.consecutiveFailures || 0) || 0) + 1;
    if (state.consecutiveFailures >= circuitBreakerThreshold) {
      const cooldownMs = getCircuitCooldownMs(key);
      state.openUntil = cooldownMs > 0 ? (Date.now() + cooldownMs) : 0;
      logStructured('post_reply_circuit_open', {
        phase: key,
        cooldownMs,
        consecutiveFailures: state.consecutiveFailures,
        reason: errorText
      });
    }
    phaseCircuitState.set(key, state);
  }

  function recordPhaseSuccess(job = {}) {
    const key = getCircuitKey(job);
    if (phaseCircuitState.has(key)) phaseCircuitState.delete(key);
  }

  function buildEnrichAggregateKey(job = {}) {
    const routeMeta = normalizeObject(job.routeMeta, {});
    const groupId = normalizeText(routeMeta.groupId || routeMeta.group_id);
    return ['enrich', normalizeText(job.userId) || 'unknown', normalizeText(job.sessionKey) || 'unknown', groupId || 'nogroup'].join('|');
  }

  function enqueueEnrichJob(job = {}) {
    if (!config.POST_REPLY_ENRICH_ENABLED) return null;
    const turns = normalizeArray(job.turns).filter((item) => item && typeof item === 'object');
    const joinedChars = Array.from(turns.map((item) => `${item.question || ''}\n${item.finalReply || ''}`).join('\n').replace(/\s+/g, '')).length;
    const hasExplicitRemember = turns.some((item) => /^(?:记住|记一下|帮我记住|remember)\b/i.test(String(item?.question || '').trim()));
    const routeMeta = normalizeObject(job.routeMeta, {});
    const groupId = normalizeText(routeMeta.groupId || routeMeta.group_id);
    const shouldEnrich = turns.length >= Math.max(1, Number(config.POST_REPLY_ENRICH_MIN_TURNS) || 2)
      || joinedChars >= Math.max(0, Number(config.POST_REPLY_ENRICH_MIN_CONTENT_CHARS) || 0)
      || hasExplicitRemember
      || Boolean(groupId);
    if (!shouldEnrich) return null;

    const aggregateKey = buildEnrichAggregateKey(job);
    const nowIso = new Date().toISOString();
    const existing = typeof queue.findQueuedJobByAggregateKey === 'function'
      ? queue.findQueuedJobByAggregateKey(aggregateKey, 'enrich')
      : null;
    if (existing && typeof queue.mergeQueuedJob === 'function') {
      const merged = queue.mergeQueuedJob(existing, {
        turns,
        routeMeta,
        continuitySnapshot: normalizeObject(job.continuitySnapshot, {}),
        contextStats: normalizeObject(job.contextStats, {}),
        lastMergedAt: nowIso,
        tasks: normalizeObject(job.tasks, {})
      }, {
        aggregateWindowMs: Number(config.POST_REPLY_ENRICH_DELAY_MS) || 0,
        idleFlushMs: Number(config.POST_REPLY_ENRICH_DELAY_MS) || 0
      });
      logStructured('post_reply_enrich_merged', {
        jobId: merged.jobId,
        aggregateKey,
        turns: normalizeArray(merged.turns).length
      });
      return merged;
    }

    const result = queue.enqueue({
      ...job,
      phase: 'enrich',
      aggregateKey,
      dedupeKey: '',
      firstQueuedAt: nowIso,
      lastMergedAt: nowIso,
      availableAt: new Date(Date.now() + Math.max(0, Number(config.POST_REPLY_ENRICH_DELAY_MS) || 0)).toISOString()
    });
    if (result?.job) {
      logStructured('post_reply_enrich_scheduled', {
        jobId: result.job.jobId,
        aggregateKey,
        turns: normalizeArray(result.job.turns).length,
        enqueued: Boolean(result.enqueued)
      });
    }
    return result?.job || null;
  }

  function scheduleTick(delayMs = 0) {
    if (stopped || scheduledTick) return;
    scheduledTick = true;
    timer = setTimeout(() => {
      scheduledTick = false;
      timer = null;
      void tick();
    }, Math.max(0, delayMs));
  }

  function tryClaimJob() {
    const staleBefore = Date.now() - staleProcessingMs;
    queue.recoverStaleProcessingJobs({ staleBefore });
    return queue.claimNextJob(new Date(), {
      activeUserIds: getActiveUserIds()
    });
  }

  function getPressureDeferMs() {
    return getPerfRuntimeModule().getBackgroundPressureDelayMs();
  }

  async function runOneJob(job) {
    if (!job) return null;
    if (!job) return null;
    let latestJob = job;
    const progressQueue = Object.create(queue);
    progressQueue.updateProcessingJob = (...args) => {
      if (typeof queue.updateProcessingJob !== 'function') return args[0];
      const updated = queue.updateProcessingJob(...args);
      if (updated && typeof updated === 'object') latestJob = updated;
      return updated;
    };
    const activeUserId = normalizeText(job.userId);
    const phase = normalizePhase(job.phase);
    if (!canRunPhase(job)) {
      logStructured('post_reply_skipped', {
        phase,
        reason: 'circuit_open',
        jobId: job.jobId
      });
      return queue.markDone(job, {
        lastError: 'skipped:circuit_open'
      });
    }
    activeCount += 1;
    lastActiveAt = Date.now();
    if (activeUserId) activeUserIds.add(activeUserId);

    try {
      const processResult = await processJobImpl(job, {
        ...options,
        queue: progressQueue
      });
      recordPhaseSuccess(job);
      const completed = queue.markDone(processResult?.job || job);
      logStructured(phase === 'core' ? 'post_reply_core_completed' : 'post_reply_enrich_completed', {
        jobId: completed.jobId,
        dedupeKey: completed.dedupeKey,
        attempt: completed.attempt,
        turns: normalizeArray(completed.turns).length,
        post_reply_worker_active: Math.max(1, activeCount)
      });
      if (phase === 'core') enqueueEnrichJob(completed);
      return completed;
    } catch (error) {
      const errorText = error?.message || error;
      if (isTerminalPostReplyError(errorText)) {
        const failed = queue.markFailed(job, errorText);
        logStructured('post_reply_terminal_error', {
          phase,
          jobId: failed.jobId,
          error: errorText
        });
        return failed;
      }
      recordPhaseFailure(job, errorText);
      const retryDelayMs = isTransientPostReplyError(errorText)
        ? applyRateLimitBackoff(job, errorText)
        : 0;
      const result = queue.retryOrFail({
        ...latestJob,
        retryDelayMs,
        lastTransientErrorAt: retryDelayMs > 0 ? new Date().toISOString() : latestJob.lastTransientErrorAt
      }, error?.message || error);
      console.error('[post-reply-worker] job failed', {
        jobId: job.jobId,
        dedupeKey: job.dedupeKey,
        attempt: Number(job.attempt || 0) + 1,
        retried: result.retried,
        error: error?.message || error,
        post_reply_worker_active: Math.max(1, activeCount)
      });
      return result.job;
    } finally {
      activeCount = Math.max(0, activeCount - 1);
      if (activeCount === 0) lastActiveAt = Date.now();
      if (activeUserId) activeUserIds.delete(activeUserId);
      scheduleTick(0);
    }
  }

  async function tick() {
    if (stopped) return;
    if (maybeRequestIdleRecycle()) return;

    const pressureDeferMs = getPressureDeferMs();
    if (pressureDeferMs > 0) {
      const {
        getResourcePressureState,
        appendPerfEvent,
        appendResourceSnapshot
      } = getPerfRuntimeModule();
      appendPerfEvent({
        category: 'background_pressure',
        type: 'post_reply_deferred',
        delayMs: pressureDeferMs,
        activeCount,
        pressureLevel: getResourcePressureState().level
      });
      appendResourceSnapshot({
        component: 'post_reply_worker',
        postReplyActiveCount: activeCount,
        postReplyEffectiveConcurrency: getEffectiveConcurrency(),
        postReplyQueuedDeferMs: pressureDeferMs
      });
      scheduleTick(pressureDeferMs);
      return;
    }

    const slots = Math.max(0, getEffectiveConcurrency() - activeCount);
    let startedJobs = 0;
    if (slots > 0) {
      for (let i = 0; i < slots; i += 1) {
        const job = tryClaimJob();
        if (!job) break;
        void runOneJob(job);
        startedJobs += 1;
      }
    }

    if (startedJobs === 0) scheduleTick(pollMs);
  }

  function start() {
    if (!config.POST_REPLY_WORKER_ENABLED && options.forceStart !== true) {
      return false;
    }
    if (!stopped) return true;
    stopped = false;
    scheduleTick(0);
    return true;
  }

  function stop() {
    stopped = true;
    scheduledTick = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    queue,
    concurrency,
    pollMs,
    staleProcessingMs,
    start,
    stop,
    tick,
    runOneJob,
    getActiveUserIds,
    getStats,
    maybeRequestIdleRecycle
  };
}

module.exports = {
  createPostReplyWorkerRuntime,
  flushPostReplyMaterialize,
  runPostReplyVectorMaintenance,
  schedulePostReplyMaterialize,
  buildCoreLearningConversation,
  buildCoreLearningEvidence,
  processPostReplyJob
};
