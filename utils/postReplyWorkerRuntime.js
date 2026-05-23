const config = require('../config');
const { createPostReplyJobQueue, getPostReplyJobQueue } = require('./postReplyJobQueue');
const {
  flushPostReplyMaterialize,
  schedulePostReplyMaterialize
} = require('./postReplyWorker/materialize');
const {
  runPostReplyVectorMaintenance
} = require('./postReplyWorker/vectorMaintenance');
const {
  createPostReplyVectorWatchdogLoop,
  runPostReplyVectorWatchdog
} = require('./postReplyWorker/vectorWatchdog');
const {
  buildCoreLearningConversation,
  buildCoreLearningEvidence
} = require('./postReplyWorker/enrichPhase');
const { processPostReplyJob } = require('./postReplyWorker/processJob');
const {
  isTerminalPostReplyError
} = require('./postReplyWorker/errorClassifier');
const {
  appendPostReplyJobTrace
} = require('./postReplyWorker/jobTrace');
const {
  detectPostReplyLearningIntent,
  isExplicitRememberText,
  mergeLearningIntent
} = require('./postReplyWorker/learningIntent');
const {
  isTransientPostReplyError,
  logStructured,
  normalizeArray,
  normalizeObject,
  normalizePhase,
  normalizeText
} = require('./postReplyWorker/common');

function getPerfRuntimeModule() {
  return require('./perfRuntime');
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
  const vectorWatchdogLoop = options.vectorWatchdogLoop === false
    ? null
    : (options.vectorWatchdogLoop || createPostReplyVectorWatchdogLoop({
        isBusy: () => activeCount > 0,
        source: config.POST_REPLY_VECTOR_WATCHDOG_SOURCE,
        limit: config.POST_REPLY_VECTOR_WATCHDOG_LIMIT,
        maxBatches: config.POST_REPLY_VECTOR_WATCHDOG_MAX_BATCHES
      }));

  let timer = null;
  let stopped = true;
  let activeCount = 0;
  let lastActiveAt = Date.now();
  let recycleRequested = false;
  const activeUserIds = new Set();
  let scheduledTick = false;
  const phaseCircuitState = new Map();
  const phaseRateLimitState = new Map();
  let pressureBackoffState = {
    active: false,
    delayMs: 0,
    pressureLevel: 'normal',
    pressureReasons: []
  };

  function getActiveUserIds() {
    return Array.from(activeUserIds);
  }

  function getStats() {
    return {
      activeCount,
      activeUserIds: getActiveUserIds(),
      lastActiveAt,
      rssBytes: process.memoryUsage().rss,
      recycleRequested,
      pressureBackoff: {
        ...pressureBackoffState,
        pressureReasons: Array.isArray(pressureBackoffState.pressureReasons)
          ? pressureBackoffState.pressureReasons.slice()
          : []
      }
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
    const hasExplicitRemember = turns.some((item) => isExplicitRememberText(item?.question));
    const routeMeta = normalizeObject(job.routeMeta, {});
    const groupId = normalizeText(routeMeta.groupId || routeMeta.group_id);
    const shouldEnrich = turns.length >= Math.max(1, Number(config.POST_REPLY_ENRICH_MIN_TURNS) || 2)
      || joinedChars >= Math.max(0, Number(config.POST_REPLY_ENRICH_MIN_CONTENT_CHARS) || 0)
      || hasExplicitRemember
      || Boolean(groupId);
    if (!shouldEnrich) return null;

    const aggregateKey = buildEnrichAggregateKey(job);
    const nowIso = new Date().toISOString();
    const enrichBudget = {
      maxTurns: Math.max(1, Number(config.POST_REPLY_ENRICH_MAX_TURNS) || 12),
      maxChars: Math.max(200, Number(config.POST_REPLY_ENRICH_MAX_CHARS) || 6000),
      maxWrites: Math.max(1, Number(config.POST_REPLY_ENRICH_MAX_WRITES) || 12),
      maxCostHint: 0
    };
    const learningIntent = detectPostReplyLearningIntent(job, turns);
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
        tasks: normalizeObject(job.tasks, {}),
        learningIntent: mergeLearningIntent(existing.learningIntent, learningIntent),
        enrichBudget
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
      learningIntent,
      enrichBudget,
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
    const recovered = queue.recoverStaleProcessingJobs({ staleBefore });
    for (const recoveredJob of normalizeArray(recovered)) {
      appendPostReplyJobTrace(recoveredJob, 'job_recovered_stale', {
        staleBefore: new Date(staleBefore).toISOString()
      });
    }
    return queue.claimNextJob(new Date(), {
      activeUserIds: getActiveUserIds(),
      deferredPhases: pressureBackoffState.active && config.POST_REPLY_ENRICH_PRESSURE_PAUSE_ENABLED === true
        ? ['enrich']
        : [],
      leaseOwner: `post-reply-worker:${process.pid}`,
      leaseMs: staleProcessingMs
    });
  }

  function getPressureDeferMs() {
    return getPerfRuntimeModule().getBackgroundPressureDelayMs();
  }

  function updatePressureBackoff(delayMs = 0) {
    const {
      getResourcePressureState
    } = getPerfRuntimeModule();
    const pressure = getResourcePressureState();
    pressureBackoffState = {
      active: Math.max(0, Number(delayMs) || 0) > 0,
      delayMs: Math.max(0, Number(delayMs) || 0),
      pressureLevel: normalizeText(pressure.level || 'normal') || 'normal',
      pressureReasons: normalizeArray(pressure.reasons)
        .map((item) => normalizeText(item))
        .filter(Boolean)
    };
    return pressureBackoffState;
  }

  function buildJobForCurrentPressure(job = {}) {
    if (!pressureBackoffState.active) return job;
    const phase = normalizePhase(job.phase);
    if (phase !== 'core' || config.POST_REPLY_CORE_MINIMAL_UNDER_PRESSURE !== true) return job;
    return {
      ...job,
      postReplyPressureMode: 'minimal',
      postReplyPressure: {
        level: pressureBackoffState.pressureLevel,
        reasons: pressureBackoffState.pressureReasons.slice(),
        delayMs: pressureBackoffState.delayMs
      }
    };
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
    progressQueue.heartbeatProcessingJob = (...args) => {
      if (typeof queue.heartbeatProcessingJob !== 'function') return args[0];
      const updated = queue.heartbeatProcessingJob(...args);
      if (updated && typeof updated === 'object') latestJob = updated;
      return updated;
    };
    progressQueue.readProcessingJob = (...args) => {
      if (typeof queue.readProcessingJob !== 'function') return null;
      return queue.readProcessingJob(...args);
    };
    const activeUserId = normalizeText(job.userId);
    const phase = normalizePhase(job.phase);
    if (!canRunPhase(job)) {
      logStructured('post_reply_skipped', {
        phase,
        reason: 'circuit_open',
        jobId: job.jobId
      });
      appendPostReplyJobTrace(job, 'job_skipped', {
        reason: 'circuit_open'
      });
      const skipped = queue.markDone(job, {
        lastError: 'skipped:circuit_open'
      });
      appendPostReplyJobTrace(skipped, 'job_done', {
        skipped: true,
        reason: 'circuit_open'
      });
      return skipped;
    }
    activeCount += 1;
    lastActiveAt = Date.now();
    if (activeUserId) activeUserIds.add(activeUserId);

    try {
      appendPostReplyJobTrace(job, 'job_started', {
        activeCount,
        phase,
        attempt: Number(job.attempt || 0) || 0,
        pressureMode: pressureBackoffState.active
          ? (normalizePhase(job.phase) === 'core' && config.POST_REPLY_CORE_MINIMAL_UNDER_PRESSURE === true ? 'minimal' : 'normal')
          : 'normal',
        pressureLevel: pressureBackoffState.pressureLevel
      });
      const runnableJob = buildJobForCurrentPressure(job);
      const processResult = await processJobImpl(runnableJob, {
        ...options,
        queue: progressQueue
      });
      recordPhaseSuccess(job);
      const completed = queue.markDone(processResult?.job || job);
      appendPostReplyJobTrace(completed, 'job_done', {
        turns: normalizeArray(completed.turns).length,
        attempt: completed.attempt
      });
      logStructured(phase === 'core' ? 'post_reply_core_completed' : 'post_reply_enrich_completed', {
        jobId: completed.jobId,
        dedupeKey: completed.dedupeKey,
        attempt: completed.attempt,
        turns: normalizeArray(completed.turns).length,
        post_reply_worker_active: Math.max(1, activeCount)
      });
      if (phase === 'core') {
        const enrichJob = enqueueEnrichJob(completed);
        if (enrichJob) {
          appendPostReplyJobTrace(enrichJob, 'job_enqueued', {
            sourceJobId: completed.jobId,
            phase: 'enrich'
          });
        }
      }
      return completed;
    } catch (error) {
      const errorText = error?.message || error;
      if (isTerminalPostReplyError(errorText)) {
        const failed = queue.markFailed(latestJob, errorText);
        appendPostReplyJobTrace(failed, 'job_failed', {
          terminal: true,
          errorClass: failed.errorClass,
          error: errorText
        });
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
      appendPostReplyJobTrace(result.job, result.retried ? 'job_retry_scheduled' : 'job_failed', {
        retried: result.retried,
        retryDelayMs,
        errorClass: result.job?.errorClass,
        error: errorText
      });
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
    updatePressureBackoff(pressureDeferMs);
    const selectivePressureMode = pressureDeferMs > 0
      && (config.POST_REPLY_ENRICH_PRESSURE_PAUSE_ENABLED === true || config.POST_REPLY_CORE_MINIMAL_UNDER_PRESSURE === true);
    if (pressureDeferMs > 0 && !selectivePressureMode) {
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

    if (startedJobs === 0) scheduleTick(selectivePressureMode ? Math.max(pollMs, pressureDeferMs) : pollMs);
  }

  function start() {
    if (!config.POST_REPLY_WORKER_ENABLED && options.forceStart !== true) {
      return false;
    }
    if (!stopped) return true;
    stopped = false;
    scheduleTick(0);
    if (vectorWatchdogLoop && config.POST_REPLY_VECTOR_WATCHDOG_ENABLED === true) {
      vectorWatchdogLoop.start();
    }
    return true;
  }

  function stop() {
    stopped = true;
    scheduledTick = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (vectorWatchdogLoop && typeof vectorWatchdogLoop.stop === 'function') {
      vectorWatchdogLoop.stop();
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
    maybeRequestIdleRecycle,
    vectorWatchdogLoop
  };
}

module.exports = {
  createPostReplyWorkerRuntime,
  flushPostReplyMaterialize,
  runPostReplyVectorMaintenance,
  runPostReplyVectorWatchdog,
  schedulePostReplyMaterialize,
  buildCoreLearningConversation,
  buildCoreLearningEvidence,
  processPostReplyJob
};
