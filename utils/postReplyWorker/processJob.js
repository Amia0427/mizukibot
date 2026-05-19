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
  isTaskCompleted,
  logStructured,
  markTaskCompleted,
  normalizeArray,
  normalizeCompletedTasks,
  normalizeObject,
  normalizePhase,
  normalizeText
} = require('./common');

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
    if (!isTaskCompleted(currentJob, 'memoryQualityAudit') && config.POST_REPLY_MEMORY_QUALITY_AUDIT_ENABLED === true) {
      const runMemoryQualityAudit = typeof deps.runMemoryQualityAudit === 'function'
        ? deps.runMemoryQualityAudit
        : getMemoryQualityAuditModule().runMemoryQualityAudit;
      logStructured('post_reply_step_start', { ...traceBase, step: 'runMemoryQualityAudit' });
      try {
        const auditResult = await runMemoryQualityAudit({
          jobId: normalizeText(job.jobId),
          userId: normalizeText(job.userId),
          sessionKey: normalizeText(job.sessionKey),
          groupId: normalizeText(job.routeMeta?.groupId || job.routeMeta?.group_id),
          sampleSize: config.POST_REPLY_MEMORY_QUALITY_AUDIT_SAMPLE_SIZE,
          timeoutMs: config.POST_REPLY_MEMORY_QUALITY_AUDIT_TIMEOUT_MS,
          intervalMs: config.POST_REPLY_MEMORY_QUALITY_AUDIT_INTERVAL_MS
        }, deps);
        logStructured('post_reply_step_done', {
          ...traceBase,
          step: 'runMemoryQualityAudit',
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
        });
      } catch (error) {
        logStructured('post_reply_step_failed', {
          ...traceBase,
          step: 'runMemoryQualityAudit',
          error: error?.message || error
        });
      }
      currentJob = markTaskCompleted(currentJob, deps, 'memoryQualityAudit');
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

module.exports = {
  buildLearningMeta,
  processPostReplyJob
};
