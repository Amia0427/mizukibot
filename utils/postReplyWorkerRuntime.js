const config = require('../config');
const { learnSomethingNew } = require('../api/memoryExtraction');
const { appendDailyJournalEntry } = require('./dailyJournal');
const { learnSelfImprovement } = require('./selfImprovementRuntime');
const { createPostReplyJobQueue, getPostReplyJobQueue } = require('./postReplyJobQueue');
const { appendMemoryEvent, materializeMemoryViews } = require('./memory-v3');

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
  const workerTaskOptions = {
    ...meta,
    throwOnError: true
  };
  if (tasks.memoryLearning) {
    await learnSomethingNew(job.userId, job.question, job.finalReply, workerTaskOptions);
  }
  if (tasks.selfImprovement) {
    await learnSelfImprovement(job.userId, job.question, job.finalReply, workerTaskOptions);
  }
  if (tasks.dailyJournal) {
    await appendDailyJournalEntry(
      job.userId,
      job.question,
      job.finalReply,
      normalizeObject(job.userInfo, {}),
      {
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
  }
  if (config.MEMORY_V3_ENABLED) {
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
  const processJobImpl = options.processJob || processPostReplyJob;

  let timer = null;
  let running = false;
  let stopped = true;

  async function runOneJob() {
    const staleBefore = Date.now() - staleProcessingMs;
    queue.recoverStaleProcessingJobs({ staleBefore });
    const job = queue.claimNextJob();
    if (!job) return null;

    try {
      await processJobImpl(job, options);
      const completed = queue.markDone(job);
      console.log('[post-reply-worker] job completed', {
        jobId: completed.jobId,
        dedupeKey: completed.dedupeKey,
        attempt: completed.attempt
      });
      return completed;
    } catch (error) {
      const result = queue.retryOrFail(job, error?.message || error);
      console.error('[post-reply-worker] job failed', {
        jobId: job.jobId,
        dedupeKey: job.dedupeKey,
        attempt: Number(job.attempt || 0) + 1,
        retried: result.retried,
        error: error?.message || error
      });
      return result.job;
    }
  }

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      await runOneJob();
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(() => {
          void tick();
        }, pollMs);
      }
    }
  }

  function start() {
    if (!config.POST_REPLY_WORKER_ENABLED && options.forceStart !== true) {
      return false;
    }
    if (!stopped) return true;
    stopped = false;
    timer = setTimeout(() => {
      void tick();
    }, 0);
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    queue,
    pollMs,
    staleProcessingMs,
    start,
    stop,
    tick,
    runOneJob
  };
}

module.exports = {
  createPostReplyWorkerRuntime,
  processPostReplyJob
};
