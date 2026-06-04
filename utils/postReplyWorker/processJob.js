const config = require('../../config');
const {
  schedulePostReplyMaterialize
} = require('./materialize');
const {
  isPostReplyVectorMaintenanceEnabled,
  runPostReplyVectorMaintenance
} = require('./vectorMaintenance');
const {
  buildCoreLearningConversation,
  buildCoreLearningEvidence,
  runEnrichPhase
} = require('./enrichPhase');
const {
  appendPostReplyJobTrace
} = require('./jobTrace');
const {
  detectPostReplyLearningIntent
} = require('./learningIntent');
const {
  buildPostReplyJobWithoutRecapTurns,
  isPostReplyRecapJob
} = require('./recapPolicy');
const {
  buildPostReplyCanceledError,
  isTaskCompleted,
  logStructured,
  normalizeArray,
  normalizeCompletedTasks,
  normalizeObject,
  normalizePhase,
  normalizeTaskStates,
  normalizeText
} = require('./common');
const {
  createPostReplyTaskRunner
} = require('./taskRunner');

function getMemoryExtractionModule() {
  return require('../../api/memoryExtraction');
}

function getDailyJournalModule() {
  return require('../dailyJournal');
}

function getSelfImprovementModule() {
  return require('../selfImprovementRuntime');
}

function getMemoryV3Module() {
  return require('../memory-v3');
}

function getMemoryQualityAuditModule() {
  return require('../memoryQualityAudit');
}

function getProfileMaintenanceModule() {
  return require('../memory-v3/profileMaintenance');
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
    learningIntent: detectPostReplyLearningIntent(job, evidenceMeta.turns),
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
    taskStates: normalizeTaskStates(job.taskStates, job.completedTasks)
  };
  currentJob.completedTasks = normalizeCompletedTasks(job.completedTasks, currentJob.taskStates);
  const tasks = normalizeObject(job.tasks, {});
  const phase = normalizePhase(job.phase);
  const recapJob = isPostReplyRecapJob(job);
  const recapFiltered = phase === 'enrich'
    ? buildPostReplyJobWithoutRecapTurns(job)
    : { job, skippedCount: 0 };
  const runnableEnrichJob = recapFiltered.job || job;
  const meta = buildLearningMeta(runnableEnrichJob);
  const pressureMode = normalizeText(job.postReplyPressureMode).toLowerCase();
  const coreMinimalUnderPressure = phase === 'core' && pressureMode === 'minimal';
  const workerTaskOptions = {
    ...meta,
    postReplyMemoryMode: String(config.POST_REPLY_MEMORY_MODE || 'core').trim().toLowerCase() || 'core',
    learningIntent: meta.learningIntent,
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
  const trace = (event, payload = {}) => appendPostReplyJobTrace(currentJob, event, payload);
  const heartbeatAndCheckCancel = (step = '') => {
    const queue = deps.queue;
    const latest = queue && typeof queue.readProcessingJob === 'function'
      ? queue.readProcessingJob(currentJob.jobId)
      : null;
    if (latest && latest.cancelRequested === true) {
      currentJob = {
        ...currentJob,
        ...latest
      };
      trace('job_cancel_detected', {
        step,
        cancelReason: latest.cancelReason
      });
      throw buildPostReplyCanceledError(latest);
    }
    if (queue && typeof queue.heartbeatProcessingJob === 'function') {
      try {
        currentJob = queue.heartbeatProcessingJob(currentJob, {
          leaseOwner: currentJob.leaseOwner
        });
        trace('job_heartbeat', {
          step,
          leaseUntil: currentJob.leaseUntil
        });
      } catch (error) {
        console.warn('[post-reply-worker] heartbeat failed:', error?.message || error);
      }
    }
    if (currentJob.cancelRequested === true) {
      trace('job_cancel_detected', {
        step,
        cancelReason: currentJob.cancelReason
      });
      throw buildPostReplyCanceledError(currentJob);
    }
    return currentJob;
  };
  const taskRunner = createPostReplyTaskRunner({
    job: currentJob,
    deps,
    trace,
    heartbeatAndCheckCancel,
    logStepStart(step, payload = {}) {
      logStructured('post_reply_step_start', { ...traceBase, ...payload, step });
    },
    logStepDone(step, payload = {}) {
      logStructured('post_reply_step_done', { ...traceBase, step, ...normalizeObject(payload, {}) });
    },
    logStepFailed(step, error = '') {
      logStructured('post_reply_step_failed', {
        ...traceBase,
        step,
        error: error?.message || error
      });
    }
  });
  const runTask = async (...args) => {
    taskRunner.setJob(currentJob);
    currentJob = await taskRunner.runTask(...args);
    return currentJob;
  };
  const skipTask = (...args) => {
    taskRunner.setJob(currentJob);
    currentJob = taskRunner.skipTask(...args);
    return currentJob;
  };
  if (phase === 'core' && tasks.memoryLearning && !isTaskCompleted(currentJob, 'memoryLearning') && recapJob) {
    currentJob = skipTask('memoryLearning', 'learnSomethingNew', 'recap_query');
  }
  if (phase === 'core' && tasks.memoryLearning && !isTaskCompleted(currentJob, 'memoryLearning')) {
    const { learnSomethingNew } = getMemoryExtractionModule();
    currentJob = await runTask('memoryLearning', async () => {
      await learnSomethingNew(job.userId, learningConversation.userText, learningConversation.botReply, workerTaskOptions);
    }, {
      traceStart: { step: 'learnSomethingNew', learningIntent: meta.learningIntent },
      logStart: { learningIntent: meta.learningIntent }
    });
  }
  if (phase === 'core' && tasks.selfImprovement && !isTaskCompleted(currentJob, 'selfImprovement') && recapJob) {
    currentJob = skipTask('selfImprovement', 'learnSelfImprovement', 'recap_query');
  }
  if (phase === 'core' && tasks.selfImprovement && !isTaskCompleted(currentJob, 'selfImprovement') && coreMinimalUnderPressure) {
    currentJob = skipTask('selfImprovement', 'learnSelfImprovement', 'pressure_minimal_core');
  }
  if (phase === 'core' && tasks.selfImprovement && !isTaskCompleted(currentJob, 'selfImprovement')) {
    const { learnSelfImprovement } = getSelfImprovementModule();
    currentJob = await runTask('selfImprovement', async () => {
      await learnSelfImprovement(job.userId, job.question, job.finalReply, workerTaskOptions);
    });
  }
  if (tasks.dailyJournal && !isTaskCompleted(currentJob, 'dailyJournal') && recapJob) {
    currentJob = skipTask('dailyJournal', 'appendDailyJournalEntry', 'recap_query');
  }
  if (tasks.dailyJournal && !isTaskCompleted(currentJob, 'dailyJournal')) {
    const { appendDailyJournalEntry } = getDailyJournalModule();
    currentJob = await runTask('dailyJournal', async () => {
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
    });
  }
  if (phase === 'core' && config.MEMORY_V3_ENABLED) {
    if (!isTaskCompleted(currentJob, 'memoryEvent')) {
      const { appendVersionedMemoryUpdate } = getMemoryV3Module();
      currentJob = await runTask('memoryEvent', async () => {
        await appendVersionedMemoryUpdate({
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
        }, {
          updateRuntimeSummaries: true
        });
      });
    }
    if (!isTaskCompleted(currentJob, 'materialize')) {
      const scheduleMaterializeMemoryViews = typeof deps.scheduleMaterializeMemoryViews === 'function'
        ? deps.scheduleMaterializeMemoryViews
        : schedulePostReplyMaterialize;
      currentJob = await runTask('materialize', async () => {
        const materializeResult = await scheduleMaterializeMemoryViews({
          reason: 'post_reply_core',
          userId: normalizeText(job.userId),
          sessionKey: normalizeText(job.sessionKey),
          groupId: normalizeText(job.routeMeta?.groupId || job.routeMeta?.group_id)
        });
        return {
          materialize: materializeResult && typeof materializeResult === 'object'
          ? {
              scheduled: Boolean(materializeResult.scheduled),
              coalesced: Boolean(materializeResult.coalesced),
              delayMs: Number(materializeResult.delayMs || 0) || 0,
              pendingCount: Number(materializeResult.pendingCount || 0) || 0
            }
          : {}
        };
      });
    }
    if (!isTaskCompleted(currentJob, 'vectorMaintenance') && isPostReplyVectorMaintenanceEnabled() && coreMinimalUnderPressure) {
      currentJob = skipTask('vectorMaintenance', 'runVectorMaintenance', 'pressure_minimal_core');
    }
    if (!isTaskCompleted(currentJob, 'vectorMaintenance') && isPostReplyVectorMaintenanceEnabled()) {
      const runVectorMaintenance = typeof deps.runVectorMaintenance === 'function'
        ? deps.runVectorMaintenance
        : runPostReplyVectorMaintenance;
      currentJob = await runTask('vectorMaintenance', async () => {
        const maintenanceResult = await runVectorMaintenance({
          jobId: normalizeText(job.jobId),
          userId: normalizeText(job.userId),
          sessionKey: normalizeText(job.sessionKey),
          groupId: normalizeText(job.routeMeta?.groupId || job.routeMeta?.group_id)
        }, deps);
        return {
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
        };
      });
    }
    if (!isTaskCompleted(currentJob, 'memoryQualityAudit') && config.POST_REPLY_MEMORY_QUALITY_AUDIT_ENABLED === true && coreMinimalUnderPressure) {
      currentJob = skipTask('memoryQualityAudit', 'runMemoryQualityAudit', 'pressure_minimal_core');
    }
    if (!isTaskCompleted(currentJob, 'memoryQualityAudit') && config.POST_REPLY_MEMORY_QUALITY_AUDIT_ENABLED === true) {
      const runMemoryQualityAudit = typeof deps.runMemoryQualityAudit === 'function'
        ? deps.runMemoryQualityAudit
        : getMemoryQualityAuditModule().runMemoryQualityAudit;
      currentJob = await runTask('memoryQualityAudit', async () => {
        const auditResult = await runMemoryQualityAudit({
          jobId: normalizeText(job.jobId),
          userId: normalizeText(job.userId),
          sessionKey: normalizeText(job.sessionKey),
          groupId: normalizeText(job.routeMeta?.groupId || job.routeMeta?.group_id),
          sampleSize: config.POST_REPLY_MEMORY_QUALITY_AUDIT_SAMPLE_SIZE,
          timeoutMs: config.POST_REPLY_MEMORY_QUALITY_AUDIT_TIMEOUT_MS,
          intervalMs: config.POST_REPLY_MEMORY_QUALITY_AUDIT_INTERVAL_MS
        }, deps);
        return {
          audit: auditResult && typeof auditResult === 'object'
            ? {
                ok: auditResult.ok !== false,
                skipped: Boolean(auditResult.skipped),
                reason: normalizeText(auditResult.reason),
                score: Number(auditResult.score ?? 0) || 0,
                warnings: normalizeArray(auditResult.warnings).length,
                writeFindings: normalizeArray(auditResult.writeFindings).length,
                recallFindings: normalizeArray(auditResult.recallFindings).length,
                durationMs: Number(auditResult.durationMs || 0) || 0
              }
            : {}
        };
      });
    }
    if (!isTaskCompleted(currentJob, 'profileMaintenance') && config.MEMORY_PROFILE_MAINTENANCE_ENABLED === true && coreMinimalUnderPressure) {
      currentJob = skipTask('profileMaintenance', 'runProfileMaintenance', 'pressure_minimal_core');
    }
    if (!isTaskCompleted(currentJob, 'profileMaintenance') && config.MEMORY_PROFILE_MAINTENANCE_ENABLED === true) {
      const runProfileMaintenance = typeof deps.runProfileMaintenance === 'function'
        ? deps.runProfileMaintenance
        : getProfileMaintenanceModule().runProfileMemoryMaintenance;
      currentJob = await runTask('profileMaintenance', async () => {
        const maintenanceResult = await runProfileMaintenance({
          jobId: normalizeText(job.jobId),
          userId: normalizeText(job.userId),
          sessionKey: normalizeText(job.sessionKey),
          groupId: normalizeText(job.routeMeta?.groupId || job.routeMeta?.group_id),
          intervalMs: config.MEMORY_PROFILE_MAINTENANCE_INTERVAL_MS,
          limit: config.MEMORY_PROFILE_MAINTENANCE_SAMPLE_SIZE
        });
        return {
          maintenance: maintenanceResult && typeof maintenanceResult === 'object'
            ? {
                ok: maintenanceResult.ok !== false,
                skipped: Boolean(maintenanceResult.skipped),
                reason: normalizeText(maintenanceResult.reason),
                cleanupCandidates: Number(maintenanceResult.cleanupCandidates || 0) || 0,
                hardDeleteCandidates: Number(maintenanceResult.hardDeleteCandidates || 0) || 0,
                durationMs: Number(maintenanceResult.durationMs || 0) || 0
              }
            : {}
        };
      });
    }
  }
  if (phase === 'enrich' && !isTaskCompleted(currentJob, 'enrich')) {
    if (!recapFiltered.job) {
      currentJob = skipTask('enrich', 'runEnrichPhase', 'recap_query');
    } else {
      currentJob = await runTask('enrich', async () => {
        const result = await runEnrichPhase(runnableEnrichJob, meta);
        return recapFiltered.skippedCount > 0
          ? {
              ...normalizeObject(result, {}),
              skippedRecapTurns: recapFiltered.skippedCount
            }
          : result;
      }, {
        traceStart: {
          step: 'runEnrichPhase',
          skippedRecapTurns: recapFiltered.skippedCount
        }
      });
    }
  }
  return {
    ok: true,
    job: currentJob
  };
}

module.exports = {
  buildLearningMeta,
  processPostReplyJob
};
