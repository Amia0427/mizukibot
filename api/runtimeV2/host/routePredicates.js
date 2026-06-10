const config = require('../../../config');
const { isReplyFailure } = require('../../../utils/replyFailure');
const { normalizeObject } = require('./runtimeHelpers');

function isReviewMode(reviewMode = '') {
  return Boolean(String(reviewMode || '').trim());
}

function isChatLikeRoute(request = {}) {
  const routeMeta = normalizeObject(request.routeMeta, {});
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(request.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  if (request.systemInitiated) return false;
  if (isReviewMode(request.reviewMode)) return false;
  if (!topRouteType && !routePolicyKey) return true;
  return (
    topRouteType === 'direct_chat'
    || routePolicyKey.startsWith('direct_chat/')
  );
}

function isDirectChatRequest(request = {}) {
  const routeMeta = normalizeObject(request.routeMeta, {});
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(request.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  return topRouteType === 'direct_chat' || routePolicyKey.startsWith('direct_chat/');
}

function shouldQueueMemoryLearningForV2(request = {}, finalReply = '') {
  if (!config.MEMORY_LEARNING_ENABLED) return false;
  if (request.disableMemoryLearning) return false;
  if (request.systemInitiated) return false;
  if (String(request.customPrompt || '').trim()) return false;
  if (isReviewMode(request.reviewMode)) return false;

  const uid = String(request.userId || '').trim();
  const q = String(request.persistUserText || request.runtimeQuestionText || request.question || '').trim();
  const a = String(finalReply || '').trim();
  if (!uid || !q || !a) return false;
  if (isReplyFailure(a, { emptyIsFailure: true })) return false;

  const routeMeta = normalizeObject(request.routeMeta, {});
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(request.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  if (!topRouteType && !routePolicyKey) return true;
  if (new Set(['admin', 'ignore', 'refuse']).has(topRouteType || '')) return false;

  const hasGroupId = Boolean(String(routeMeta.groupId || routeMeta.group_id || '').trim());
  const hasTaskContext = Boolean(
    String(routeMeta.taskType || routeMeta.task_type || '').trim()
    || String(routeMeta.toolName || routeMeta.tool_name || '').trim()
    || String(routeMeta.agentName || routeMeta.agent_name || '').trim()
  );

  if (topRouteType === 'direct_chat') return true;
  if (hasGroupId) return true;
  if (hasTaskContext) return true;
  return routePolicyKey.startsWith('direct_chat/');
}

function shouldAppendDailyJournalForV2(request = {}, finalReply = '') {
  if (!config.DAILY_JOURNAL_ENABLED) return false;
  if (request.disableDailyJournal) return false;
  if (request.systemInitiated) return false;
  if (String(request.customPrompt || '').trim()) return false;

  const uid = String(request.userId || '').trim();
  const q = String(request.persistUserText || request.runtimeQuestionText || request.question || '').trim();
  const a = String(finalReply || '').trim();
  if (!uid || !q || !a) return false;
  if (isReplyFailure(a, { emptyIsFailure: true })) return false;

  const routeMeta = normalizeObject(request.routeMeta, {});
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(request.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  if (!topRouteType && !routePolicyKey) return true;
  if (topRouteType) return topRouteType === 'direct_chat';
  return routePolicyKey.startsWith('direct_chat/');
}

module.exports = {
  isReviewMode,
  isChatLikeRoute,
  isDirectChatRequest,
  shouldQueueMemoryLearningForV2,
  shouldAppendDailyJournalForV2
};
