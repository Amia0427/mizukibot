const { buildRuntimePrompt } = require('../utils/runtimePrompts');
const {
  buildSubagentStyleGuardInstruction,
  buildSubagentExecutionGuidanceLine,
  buildSubagentExecutionPlanLines,
  buildSubagentToolReasonLine
} = require('../utils/subagentPrompting');

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

function buildBridgeGuidancePrompt(route = {}, backend = 'command', routeExecutionPlan = {}) {
  const routeKey = getRouteDisplayType(route, routeExecutionPlan);
  const routeDescription = String(routeKey || '').trim();
  const reason = String(route?.meta?.reason || '').trim();
  const toolLine = buildSubagentToolReasonLine(route, backend);
  const executionLine = buildSubagentExecutionGuidanceLine(route, backend, routeExecutionPlan);
  const executionPlanLines = buildSubagentExecutionPlanLines(routeExecutionPlan, backend);
  const styleGuardLine = buildSubagentStyleGuardInstruction();
  return buildRuntimePrompt('bridge-guidance', {
    routeKey,
    routeDescription,
    planId: 'none',
    styleGuardLine,
    toolLine,
    executionLine,
    executionPlanBlock: executionPlanLines.length ? `执行步骤:\n${executionPlanLines.join('\n')}` : '',
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
    'This request touches a potentially dangerous theme.',
    'Answer normally and naturally.',
    'Only provide safe, defensive, explanatory, or risk-awareness content.',
    'Do not provide operational steps, attack chains, abuse workflows, or bypass details.',
    'Avoid templated scolding or preachy safety disclaimers.'
  ].join('\n');
}

module.exports = {
  buildBridgeGuidancePrompt,
  buildQqRichReplyPrompt,
  buildSafetyBoundaryRoutePrompt,
  buildStreamingSegmentationPrompt,
  buildToolGuidancePrompt,
  getRouteDisplayType,
  shouldPreferQqRichReply
};
