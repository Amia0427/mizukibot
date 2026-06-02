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
    'Minimal misuse boundary for this turn.',
    'Answer naturally in character; do not give generic safety lectures or policy explanations.',
    'Only avoid directly actionable real-world misuse: operational steps, code, commands, payloads, attack chains, evasion, weaponization, credential theft, harassment workflows, or bypass details.',
    'Benign creative writing, fictional roleplay, dark themes, historical discussion, defensive/recovery help, high-level explanation, and emotional support should be answered normally without sanitizing the tone.'
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
