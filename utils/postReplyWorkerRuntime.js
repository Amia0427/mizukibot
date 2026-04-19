const config = require('../config');
const { learnSomethingNew, extractPostReplyEnrichment } = require('../api/memoryExtraction');
const { appendDailyJournalEntry, maybeSegmentJournalByThreshold } = require('./dailyJournal');
const { learnSelfImprovement, storeExtractedSelfImprovementItems } = require('./selfImprovementRuntime');
const { createPostReplyJobQueue, getPostReplyJobQueue } = require('./postReplyJobQueue');
const { appendMemoryEvent, materializeMemoryViews } = require('./memory-v3');
const { applyAffinityProposal } = require('./memory');
const { addTaskMemory } = require('./taskMemory');
const { addGroupMemory } = require('./groupMemory');
const { addMemoryItemsBatch } = require('./vectorMemory');

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

function buildMinimalStyleMemoryItems(userId = '', styleMemory = {}, meta = {}) {
  const uid = normalizeText(userId);
  if (!uid) return [];
  const confidence = Number(styleMemory?.confidence || 0) || 0;
  const patterns = normalizeArray(styleMemory?.style_patterns).map((item) => normalizeText(item)).filter(Boolean).slice(0, 1);
  const avoids = normalizeArray(styleMemory?.style_avoid).map((item) => normalizeText(item)).filter(Boolean).slice(0, 1);
  const out = [];
  if (patterns[0]) {
    out.push({
      userId: uid,
      text: `style: ${patterns[0]}`,
      type: 'fact',
      weight: 1.02,
      source: 'post_reply_enrich',
      confidence,
      semanticSlot: 'style_pattern',
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
        routePolicyKey: normalizeText(meta.routePolicyKey),
        topRouteType: normalizeText(meta.topRouteType)
      }
    });
  }
  if (!patterns[0] && avoids[0]) {
    out.push({
      userId: uid,
      text: `style: ${avoids[0]}`,
      type: 'fact',
      weight: 1.01,
      source: 'post_reply_enrich',
      confidence,
      semanticSlot: 'style_avoid',
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
        routePolicyKey: normalizeText(meta.routePolicyKey),
        topRouteType: normalizeText(meta.topRouteType)
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
  return [{
    userId: `group:${gid}`,
    text: `group jargon: ${selected}`,
    type: 'fact',
    weight: 0.98,
    source: 'post_reply_enrich',
    confidence,
    semanticSlot: 'group_jargon',
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
      routePolicyKey: normalizeText(meta.routePolicyKey),
      topRouteType: normalizeText(meta.topRouteType)
    }
  }];
}

async function runEnrichPhase(job = {}, meta = {}) {
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
      addTaskMemory(job.userId, {
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
        sourceSessionId: meta.sessionId,
        participants: [],
        entities: [],
        relations: []
      });
    }
  }

  if (meta.groupId && enrichment?.group_memory && typeof enrichment.group_memory === 'object') {
    const confidence = Number(enrichment.group_memory.confidence || 0) || 0;
    for (const value of normalizeArray(enrichment.group_memory.shared_facts).map((item) => normalizeText(item)).filter(Boolean)) {
      addGroupMemory(meta.groupId, value, 'fact', { confidence, sourceKind: 'extractor', status: 'candidate' }, 1.08);
    }
    for (const value of normalizeArray(enrichment.group_memory.shared_goals).map((item) => normalizeText(item)).filter(Boolean)) {
      addGroupMemory(meta.groupId, `group goal: ${value}`, 'goal', { confidence, sourceKind: 'extractor', status: 'active' }, 1.15);
    }
    for (const value of normalizeArray(enrichment.group_memory.shared_topics).map((item) => normalizeText(item)).filter(Boolean)) {
      addGroupMemory(meta.groupId, `group topic: ${value}`, 'topic', { confidence, sourceKind: 'extractor', status: 'candidate' }, 0.96);
    }
  }

  const signalItems = [
    ...buildMinimalStyleMemoryItems(job.userId, enrichment?.style_memory, meta),
    ...buildMinimalJargonMemoryItems(meta.groupId, enrichment?.jargon_memory, meta)
  ];
  if (signalItems.length > 0) addMemoryItemsBatch(signalItems);

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

function buildLearningMeta(job = {}) {
  const routeMeta = normalizeObject(job.routeMeta, {});
  return {
    routePolicyKey: normalizeText(job.routePolicyKey),
    topRouteType: normalizeText(job.topRouteType || routeMeta.topRouteType),
    sessionKey: normalizeText(job.sessionKey),
    groupId: normalizeText(routeMeta.groupId || routeMeta.group_id),
    sessionId: normalizeText(routeMeta.sessionId || routeMeta.session_id),
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
  const tasks = normalizeObject(job.tasks, {});
  const meta = buildLearningMeta(job);
  const phase = normalizePhase(job.phase);
  const workerTaskOptions = {
    ...meta,
    postReplyMemoryMode: String(config.POST_REPLY_MEMORY_MODE || 'core').trim().toLowerCase() || 'core',
    throwOnError: true
  };
  const traceBase = {
    jobId: normalizeText(job.jobId),
    phase,
    userId: normalizeText(job.userId),
    routePolicyKey: normalizeText(job.routePolicyKey),
    topRouteType: normalizeText(job.topRouteType)
  };

  if (phase === 'core' && tasks.memoryLearning) {
    logStructured('post_reply_step_start', { ...traceBase, step: 'learnSomethingNew' });
    await learnSomethingNew(job.userId, job.question, job.finalReply, workerTaskOptions);
    logStructured('post_reply_step_done', { ...traceBase, step: 'learnSomethingNew' });
  }
  if (phase === 'core' && tasks.selfImprovement) {
    logStructured('post_reply_step_start', { ...traceBase, step: 'learnSelfImprovement' });
    await learnSelfImprovement(job.userId, job.question, job.finalReply, workerTaskOptions);
    logStructured('post_reply_step_done', { ...traceBase, step: 'learnSelfImprovement' });
  }
  if (tasks.dailyJournal) {
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
  }
  if (phase === 'core' && config.MEMORY_V3_ENABLED) {
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
    materializeMemoryViews();
    logStructured('post_reply_step_done', { ...traceBase, step: 'appendMemoryEvent' });
  }
  if (phase === 'enrich') {
    logStructured('post_reply_step_start', { ...traceBase, step: 'runEnrichPhase' });
    await runEnrichPhase(job, meta);
    logStructured('post_reply_step_done', { ...traceBase, step: 'runEnrichPhase' });
  }
  return {
    ok: true
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

  let timer = null;
  let stopped = true;
  let activeCount = 0;
  const activeUserIds = new Set();
  let scheduledTick = false;
  const phaseCircuitState = new Map();
  const phaseRateLimitState = new Map();

  function getActiveUserIds() {
    return Array.from(activeUserIds);
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

  async function runOneJob(job) {
    if (!job) return null;
    if (!job) return null;
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
    if (activeUserId) activeUserIds.add(activeUserId);

    try {
      await processJobImpl(job, options);
      recordPhaseSuccess(job);
      const completed = queue.markDone(job);
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
      const retryDelayMs = isRateLimitError(errorText)
        ? applyRateLimitBackoff(job, errorText)
        : 0;
      const result = queue.retryOrFail({
        ...job,
        retryDelayMs
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
      if (activeUserId) activeUserIds.delete(activeUserId);
      scheduleTick(0);
    }
  }

  async function tick() {
    if (stopped) return;

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
    getActiveUserIds
  };
}

module.exports = {
  createPostReplyWorkerRuntime,
  processPostReplyJob
};
