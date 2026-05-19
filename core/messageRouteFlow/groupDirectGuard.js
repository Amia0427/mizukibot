const { buildRouteMetaEnvelope } = require('../executablePlan');
const {
  applyGroupDirectStyleGuard
} = require('../../api/runtimeV2/guards/groupDirectReplyStyleGuard');

function buildGroupDirectGuardRequest(route = {}, routeExecutionPlan = {}, chatType = 'group', groupId = '') {
  const routeMeta = buildRouteMetaEnvelope(route, routeExecutionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, {
    groupId,
    chatType
  });
  return {
    topRouteType: routeExecutionPlan?.topRouteType || routeMeta.topRouteType,
    routeMeta
  };
}

function applyGroupDirectGuardToReplyEnvelopeInput(input = {}, route = {}, routeExecutionPlan = {}, chatType = 'group', groupId = '') {
  const replyText = String(input?.replyText || '').trim();
  if (!replyText) return input;
  const guardRequest = buildGroupDirectGuardRequest(route, routeExecutionPlan, chatType, groupId);
  const guard = applyGroupDirectStyleGuard(
    replyText,
    guardRequest
  );
  const persistedText = String(input?.persistedReplyText || '').trim();
  const persistedGuard = persistedText
    ? applyGroupDirectStyleGuard(persistedText, guardRequest)
    : null;
  if (!guard.applied && !persistedGuard?.applied) return input;
  return {
    ...input,
    replyText: guard.applied ? guard.text : input.replyText,
    persistedReplyText: persistedGuard?.applied ? persistedGuard.text : input.persistedReplyText
  };
}

module.exports = {
  buildGroupDirectGuardRequest,
  applyGroupDirectGuardToReplyEnvelopeInput
};
