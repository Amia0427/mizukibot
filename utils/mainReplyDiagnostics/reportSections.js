const {
  GROUP_DIRECT_REPLY_CHAR_LIMIT,
  GROUP_DIRECT_REPLY_MAX_QUESTION_SENTENCES,
  GROUP_DIRECT_REPLY_MAX_SENTENCES,
  applyGroupDirectStyleGuard,
  buildGroupDirectStyleGuardReasons,
  isGroupDirectChatRequest
} = require('../../api/runtimeV2/guards/groupDirectReplyStyleGuard');
const { buildRouteMetaEnvelope } = require('../../core/executablePlan');
const {
  normalizeArray,
  normalizeObject,
  normalizeText
} = require('./input');

function compactProjectionFreshness(freshness = {}, sessionKey = '') {
  const lock = normalizeObject(freshness.materializeLock);
  const sessionSnapshot = normalizeObject(freshness.sessionSnapshot);
  return {
    sessionKey: normalizeText(sessionKey || sessionSnapshot.sessionKey),
    projectionStale: freshness.projectionStale === true,
    projectionStaleReason: normalizeText(freshness.projectionStaleReason),
    usedOldSnapshot: freshness.usedOldSnapshot === true,
    usedOldSnapshotReason: normalizeText(freshness.usedOldSnapshotReason),
    latestEventTs: Number(freshness.latestEventTs || 0) || 0,
    latestRelevantEventTs: Number(freshness.latestRelevantEventTs || 0) || 0,
    projectionEventHighWatermarkTs: Number(freshness.projectionEventHighWatermarkTs || 0) || 0,
    materializerUpdatedAt: Number(freshness.materializerUpdatedAt || 0) || 0,
    lockHit: lock.hit === true,
    lockStale: lock.stale === true,
    lockAgeMs: Number(lock.ageMs || 0) || 0,
    sessionSnapshotHit: sessionSnapshot.hit === true,
    sessionUpdatedAt: Number(sessionSnapshot.sessionUpdatedAt || 0) || 0
  };
}

function buildGuardSummary(context = {}, route = {}, executionPlan = {}) {
  const routeMeta = buildRouteMetaEnvelope(route, executionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, {
    groupId: context.groupId,
    chatType: context.chatType
  });
  const guardRequest = {
    topRouteType: executionPlan.topRouteType || routeMeta.topRouteType,
    routeMeta
  };
  const eligible = isGroupDirectChatRequest(guardRequest);
  const candidateReply = normalizeText(context.candidateReply);
  const guard = candidateReply ? applyGroupDirectStyleGuard(candidateReply, guardRequest) : null;
  const reasons = candidateReply
    ? normalizeArray(guard?.reasons)
    : buildGroupDirectStyleGuardReasons(candidateReply);
  return {
    groupDirectStyle: {
      eligible,
      checkedReply: Boolean(candidateReply),
      hit: Boolean(guard?.applied),
      reasons,
      originalChars: candidateReply ? Number(guard?.originalChars || candidateReply.length) || 0 : 0,
      finalChars: candidateReply ? Number(guard?.finalChars || 0) || 0 : 0,
      needsReplyText: !candidateReply,
      limits: {
        charLimit: GROUP_DIRECT_REPLY_CHAR_LIMIT,
        maxSentences: GROUP_DIRECT_REPLY_MAX_SENTENCES,
        maxQuestionSentences: GROUP_DIRECT_REPLY_MAX_QUESTION_SENTENCES
      }
    }
  };
}

function buildPlannerSummary(plannerDecision = null, source = '') {
  const decision = normalizeObject(plannerDecision, null);
  if (!decision) {
    return {
      source,
      mode: '',
      taskShape: '',
      decisionSource: '',
      fallbackUsed: false,
      reason: '',
      allowedToolNames: [],
      needsBackground: false,
      backgroundResearchRequested: false
    };
  }
  const decisionV2 = normalizeObject(decision.plannerDecisionV2);
  const meta = normalizeObject(decisionV2.plannerMeta);
  return {
    source,
    mode: normalizeText(decisionV2.mode || (decision.shouldUseTools ? 'tool_plan' : 'chat_only')),
    taskShape: normalizeText(decision.taskShape || decisionV2.taskShape),
    decisionSource: normalizeText(decision.decisionSource || meta.decisionSource),
    fallbackUsed: decision.plannerFallbackUsed === true || meta.fallbackUsed === true,
    reason: normalizeText(decision.reason || meta.reason),
    allowedToolNames: normalizeArray(decision.allowedToolNames || decisionV2.allowedToolNames).map((item) => normalizeText(item)).filter(Boolean),
    needsBackground: decision.needsBackground === true,
    backgroundResearchRequested: decision.backgroundResearchRequested === true || meta.backgroundResearchRequested === true
  };
}

module.exports = {
  buildGuardSummary,
  buildPlannerSummary,
  compactProjectionFreshness
};
