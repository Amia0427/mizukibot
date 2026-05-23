const config = require('../../config');
const {
  clampPositiveInt,
  makeJobId,
  normalizeArray,
  normalizeObject,
  normalizeText,
  nowIso,
  stableHash
} = require('./common');
const {
  mergeLearningIntent,
  normalizeLearningIntent
} = require('../postReplyWorker/learningIntent');

const POST_REPLY_JOB_SCHEMA_VERSION = 2;

function normalizeStringArray(value) {
  return normalizeArray(value)
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function normalizeCompletedTasks(value) {
  const source = normalizeObject(value, {});
  const out = {};
  for (const [key, taskValue] of Object.entries(source)) {
    const normalizedKey = normalizeText(key);
    if (normalizedKey) out[normalizedKey] = taskValue === true;
  }
  return out;
}

function mergeCompletedTasksForQueuedPatch(current = {}, patch = {}, incomingTurns = []) {
  const completed = normalizeCompletedTasks(current.completedTasks);
  if (incomingTurns.length === 0) return completed;
  const patchedTasks = normalizeObject(patch.tasks, {});
  const keys = ['memoryLearning', 'selfImprovement', 'dailyJournal', 'memoryEvent', 'materialize', 'vectorMaintenance', 'memoryQualityAudit', 'enrich'];
  for (const key of keys) {
    if (patchedTasks[key] === true || completed[key] === true) {
      completed[key] = false;
    }
  }
  return completed;
}

function normalizePhase(value = '') {
  const phase = normalizeText(value).toLowerCase();
  return phase === 'enrich' ? 'enrich' : 'core';
}

function normalizeTurn(turn = {}) {
  const normalized = normalizeObject(turn, {});
  return {
    turnId: normalizeText(normalized.turnId || normalized.turn_id),
    question: String(normalized.question || '').trim(),
    finalReply: String(normalized.finalReply || '').trim(),
    createdAt: normalizeText(normalized.createdAt) || nowIso(),
    evidence: normalizeObject(normalized.evidence, {}),
    sourceSessionId: normalizeText(normalized.sourceSessionId || normalized.source_session_id),
    routeMeta: normalizeObject(normalized.routeMeta, {}),
    continuitySnapshot: normalizeObject(normalized.continuitySnapshot, {}),
    contextStats: normalizeObject(normalized.contextStats, {})
  };
}

function getTurnDedupeKey(turn = {}, index = 0) {
  const normalized = normalizeTurn(turn);
  const explicit = normalizeText(normalized.turnId);
  if (explicit) return `turn:${explicit}`;
  return `hash:${stableHash({
    question: normalized.question,
    finalReply: normalized.finalReply,
    createdAt: normalized.createdAt,
    sourceSessionId: normalized.sourceSessionId
  })}`;
}

function mergeTurnsUnique(currentTurns = [], incomingTurns = []) {
  const out = [];
  const seen = new Set();
  for (const raw of [...normalizeArray(currentTurns), ...normalizeArray(incomingTurns)]) {
    const turn = normalizeTurn(raw);
    if (!turn.question && !turn.finalReply) continue;
    const key = getTurnDedupeKey(turn, out.length);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(turn);
  }
  return out;
}

function computeAggregateKey(job = {}) {
  const phase = normalizePhase(job.phase);
  const userId = normalizeText(job.userId);
  const sessionKey = normalizeText(job.sessionKey);
  const routeMeta = normalizeObject(job.routeMeta, {});
  const groupId = normalizeText(job.groupId || routeMeta.groupId || routeMeta.group_id);
  return [phase || 'core', userId || 'unknown', sessionKey || 'unknown', groupId || 'nogroup'].join('|');
}

function buildAggregateAvailableAt(firstQueuedAt = '', lastMergedAt = '', options = {}) {
  const aggregateWindowMs = Math.max(0, Number(options.aggregateWindowMs || config.POST_REPLY_AGGREGATE_WINDOW_MS) || 0);
  const idleFlushMs = Math.max(0, Number(options.idleFlushMs || config.POST_REPLY_IDLE_FLUSH_MS) || 0);
  const firstTs = Date.parse(String(firstQueuedAt || ''));
  const lastTs = Date.parse(String(lastMergedAt || ''));
  const candidates = [];
  if (Number.isFinite(firstTs) && aggregateWindowMs > 0) candidates.push(firstTs + aggregateWindowMs);
  if (Number.isFinite(lastTs) && idleFlushMs > 0) candidates.push(lastTs + idleFlushMs);
  if (candidates.length === 0) return normalizeText(lastMergedAt) || normalizeText(firstQueuedAt) || nowIso();
  return new Date(Math.min(...candidates)).toISOString();
}

function getPhaseMaxAttempts(phase = '', fallback = 5) {
  const normalized = normalizePhase(phase);
  if (normalized === 'enrich') {
    return clampPositiveInt(config.POST_REPLY_ENRICH_MAX_ATTEMPTS, clampPositiveInt(config.POST_REPLY_JOB_MAX_ATTEMPTS, fallback));
  }
  return clampPositiveInt(config.POST_REPLY_CORE_MAX_ATTEMPTS, clampPositiveInt(config.POST_REPLY_JOB_MAX_ATTEMPTS, fallback));
}

function normalizeJob(job = {}) {
  const createdAt = normalizeText(job.createdAt) || nowIso();
  const updatedAt = normalizeText(job.updatedAt) || createdAt;
  const routeMeta = normalizeObject(job.routeMeta, {});
  const phase = normalizePhase(job.phase);
  const jobId = normalizeText(job.jobId) || makeJobId();
  const turns = normalizeArray(job.turns).map((item) => normalizeTurn(item)).filter((item) => item.question || item.finalReply);
  const fallbackTurn = normalizeTurn({
    question: job.question,
    finalReply: job.finalReply,
    createdAt,
    routeMeta,
    continuitySnapshot: job.continuitySnapshot,
    contextStats: job.contextStats
  });
  const normalizedTurns = turns.length > 0
    ? turns
    : ((fallbackTurn.question || fallbackTurn.finalReply) ? [fallbackTurn] : []);
  const firstQueuedAt = normalizeText(job.firstQueuedAt) || createdAt;
  const lastMergedAt = normalizeText(job.lastMergedAt) || updatedAt;
  const aggregateKey = normalizeText(job.aggregateKey);
  const traceId = normalizeText(job.traceId || job.trace_id) || stableHash({
    jobId,
    aggregateKey,
    userId: job.userId,
    sessionKey: job.sessionKey,
    createdAt
  });
  const sourceMessageIds = normalizeStringArray(job.sourceMessageIds || job.source_message_ids);
  const learningIntent = normalizeLearningIntent(job.learningIntent || job.learning_intent);
  const rawEnrichBudget = normalizeObject(job.enrichBudget || job.enrich_budget, {});
  return {
    schemaVersion: POST_REPLY_JOB_SCHEMA_VERSION,
    jobId,
    type: normalizeText(job.type || 'post_reply') || 'post_reply',
    phase,
    aggregateKey,
    dedupeKey: normalizeText(job.dedupeKey),
    status: normalizeText(job.status || 'queued') || 'queued',
    userId: normalizeText(job.userId),
    userInfo: job.userInfo && typeof job.userInfo === 'object' ? { ...job.userInfo } : {},
    question: String(job.question || ''),
    finalReply: String(job.finalReply || ''),
    routePolicyKey: normalizeText(job.routePolicyKey),
    topRouteType: normalizeText(job.topRouteType),
    routeMeta,
    sessionKey: normalizeText(job.sessionKey),
    continuitySnapshot: normalizeObject(job.continuitySnapshot, {}),
    contextStats: normalizeObject(job.contextStats, {}),
    execLogs: Array.isArray(job.execLogs) ? [...job.execLogs] : [],
    turns: normalizedTurns,
    firstQueuedAt,
    lastMergedAt,
    mergeCount: Math.max(1, Number(job.mergeCount) || normalizedTurns.length || 1),
    tasks: job.tasks && typeof job.tasks === 'object'
      ? {
          memoryLearning: Boolean(job.tasks.memoryLearning),
          selfImprovement: Boolean(job.tasks.selfImprovement),
          dailyJournal: Boolean(job.tasks.dailyJournal)
        }
      : {
          memoryLearning: false,
          selfImprovement: false,
          dailyJournal: false
        },
    threadId: normalizeText(job.threadId),
    traceId,
    sourceMessageIds,
    learningIntent,
    enrichBudget: {
      maxTurns: Math.max(0, Number(rawEnrichBudget.maxTurns || rawEnrichBudget.max_turns) || 0),
      maxChars: Math.max(0, Number(rawEnrichBudget.maxChars || rawEnrichBudget.max_chars) || 0),
      maxWrites: Math.max(0, Number(rawEnrichBudget.maxWrites || rawEnrichBudget.max_writes) || 0),
      maxCostHint: Math.max(0, Number(rawEnrichBudget.maxCostHint || rawEnrichBudget.max_cost_hint) || 0)
    },
    leaseOwner: normalizeText(job.leaseOwner || job.lease_owner),
    leaseUntil: normalizeText(job.leaseUntil || job.lease_until),
    lastHeartbeatAt: normalizeText(job.lastHeartbeatAt || job.last_heartbeat_at),
    cancelRequested: job.cancelRequested === true || job.cancel_requested === true,
    canceledAt: normalizeText(job.canceledAt || job.canceled_at),
    cancelReason: normalizeText(job.cancelReason || job.cancel_reason),
    priority: Math.max(0, Number(job.priority) || 0),
    tags: normalizeStringArray(job.tags),
    createdAt,
    updatedAt,
    availableAt: normalizeText(job.availableAt) || createdAt,
    attempt: Math.max(0, Number(job.attempt) || 0),
    lastError: normalizeText(job.lastError),
    retryDelayMs: Math.max(0, Number(job.retryDelayMs) || 0),
    lastTransientErrorAt: normalizeText(job.lastTransientErrorAt),
    nextRetryAt: normalizeText(job.nextRetryAt),
    errorClass: normalizeText(job.errorClass || job.error_class),
    requeueSafe: job.requeueSafe === true || job.requeue_safe === true,
    completedTasks: normalizeCompletedTasks(job.completedTasks),
    completedAt: normalizeText(job.completedAt),
    failedAt: normalizeText(job.failedAt)
  };
}

module.exports = {
  POST_REPLY_JOB_SCHEMA_VERSION,
  buildAggregateAvailableAt,
  computeAggregateKey,
  getPhaseMaxAttempts,
  mergeLearningIntent,
  mergeCompletedTasksForQueuedPatch,
  mergeTurnsUnique,
  normalizeCompletedTasks,
  normalizeJob,
  normalizePhase,
  normalizeLearningIntent,
  normalizeStringArray,
  normalizeTurn,
  getTurnDedupeKey
};
