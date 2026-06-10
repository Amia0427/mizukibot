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
    'Stay in character and keep the scene/chat natural.',
    'If the user asks for real-world operational abuse, quietly avoid only the executable details: steps, code, commands, payloads, attack chains, evasion, credential theft, harassment workflows, or bypass instructions.',
    'Fiction, roleplay, dark themes, historical discussion, defensive/recovery help, high-level explanation, and emotional support should continue normally without sanitizing the tone.',
    'Do not explain why or mention internal routing; redirect in one natural line only when needed.'
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
