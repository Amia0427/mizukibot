const { buildRuntimePrompt } = require('../utils/runtimePrompts');
function getRouteDisplayType(route = {}, routeExecutionPlan = {}) {
  return String(
    routeExecutionPlan?.policyKey
    || routeExecutionPlan?.routeDebugKey
    || routeExecutionPlan?.topRouteType
    || route?.topRouteType
    || route?.type
    || 'direct_chat/text_chat/answer'
  ).trim() || 'direct_chat/text_chat/answer';
}

function buildToolGuidancePrompt(route = {}) {
  const toolHints = Array.isArray(route?.meta?.directChatPlanner?.allowedToolNames)
    ? route.meta.directChatPlanner.allowedToolNames.filter(Boolean)
    : [];
  if (!toolHints.length) return null;

  const routeKey = getRouteDisplayType(route);
  const reason = String(route?.meta?.reason || '').trim();
  return buildRuntimePrompt('tool-guidance', {
    routeKey,
    toolHints: toolHints.join(', '),
    reasonLine: reason ? `路由原因: ${reason}` : ''
  });
}

function buildStreamingSegmentationPrompt(maxSegments) {
  return buildRuntimePrompt('streaming-segmentation', { maxSegments });
}

function shouldPreferQqRichReply(text = '') {
  const input = String(text || '').trim();
  if (!input) return false;
  return /(表情包|发表情|发个表情|emoji|sticker|贴纸|动图|gif)/i.test(input);
}

function buildQqRichReplyPrompt() {
  return buildRuntimePrompt('qq-rich-reply');
}

function buildSafetyBoundaryRoutePrompt(route = {}) {
  if (route?.meta?.safetyBoundary !== true) return null;
  return [
    'This request may involve real-world harm, abuse, or illegal misuse.',
    'Answer naturally and do not give generic safety lectures.',
    'Only withhold directly actionable harm: operational steps, code, commands, attack chains, evasion, weaponization, credential theft, harassment workflows, or bypass details.',
    'For benign creative, fictional, historical, defensive, recovery, explanatory, or emotional-support context, answer normally without sanitizing the tone.'
  ].join('\n');
}

module.exports = {
  buildQqRichReplyPrompt,
  buildSafetyBoundaryRoutePrompt,
  buildStreamingSegmentationPrompt,
  buildToolGuidancePrompt,
  getRouteDisplayType,
  shouldPreferQqRichReply
};
