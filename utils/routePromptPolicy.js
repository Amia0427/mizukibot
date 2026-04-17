const fs = require('fs');
const path = require('path');

const ROUTE_PROMPT_POLICY_PATH = path.join(__dirname, '..', 'prompts', 'runtime', 'route-policies.json');

const DEFAULT_ROUTE_PROMPT_POLICY = {
  version: 1,
  defaults: {
    chat: {
      include_tool_guidance: true,
      include_streaming_segmentation: true,
      include_qq_rich_reply_when_requested: true,
      disable_stream_when_qq_rich_requested: true
    },
    subagent: {
      include_tool_guidance: true,
      include_bridge_guidance: true
    }
  },
  routes: {}
};

function normalizeRouteKey(value, fallback = 'chat') {
  const text = String(value || '').trim();
  return text || fallback;
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function readRoutePromptPolicy() {
  return safeReadJson(ROUTE_PROMPT_POLICY_PATH, DEFAULT_ROUTE_PROMPT_POLICY);
}

function mergePolicy(basePolicy, overridePolicy) {
  const base = basePolicy && typeof basePolicy === 'object' ? basePolicy : {};
  const override = overridePolicy && typeof overridePolicy === 'object' ? overridePolicy : {};
  return { ...base, ...override };
}

function getNamedRoutePolicy(routePolicies = {}, routeKey = 'chat') {
  const type = normalizeRouteKey(routeKey);
  return routePolicies[type] && typeof routePolicies[type] === 'object'
    ? routePolicies[type]
    : {};
}

function resolveRoutePromptPolicy(routeKey = 'chat/default') {
  const options = arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : {};
  const type = normalizeRouteKey(routeKey);
  const topRouteType = normalizeRouteKey(options?.topRouteType || '', '');
  const policy = readRoutePromptPolicy();
  const routePolicies = policy.routes && typeof policy.routes === 'object' ? policy.routes : {};
  const topRoutePolicy = topRouteType ? getNamedRoutePolicy(routePolicies, topRouteType) : {};
  const routeDebugPolicy = getNamedRoutePolicy(routePolicies, type);

  const resolved = {
    chat: mergePolicy(
      mergePolicy(
        policy.defaults?.chat,
        topRoutePolicy.chat
      ),
      routeDebugPolicy.chat
    ),
    subagent: mergePolicy(
      mergePolicy(
        policy.defaults?.subagent,
        topRoutePolicy.subagent
      ),
      routeDebugPolicy.subagent
    )
  };
  return resolved;
}

function buildRoutePromptBundle({
  route,
  routeExecutionPlan,
  cleanText,
  maxStreamSegments,
  buildToolGuidancePrompt,
  buildBridgeGuidancePrompt,
  buildStreamingSegmentationPrompt,
  shouldPreferQqRichReply,
  buildQqRichReplyPrompt
}) {
  const policyKey = normalizeRouteKey(
    routeExecutionPlan?.policyKey
      || route?.policyKey
      || routeExecutionPlan?.routeDebugKey
      || route?.routeDebugKey
      || 'chat/default'
  );
  const topRouteType = normalizeRouteKey(route?.topRouteType || routeExecutionPlan?.topRouteType || '', '');
  const policy = resolveRoutePromptPolicy(policyKey, {
    topRouteType,
    routeReason: String(route?.meta?.reason || '').trim()
  });

  const toolGuidancePrompt = policy.chat.include_tool_guidance
    ? buildToolGuidancePrompt(route)
    : null;
  const bridgeGuidancePrompt = policy.subagent.include_bridge_guidance && typeof buildBridgeGuidancePrompt === 'function'
    ? buildBridgeGuidancePrompt(route)
    : null;
  const streamingSegmentationPrompt = policy.chat.include_streaming_segmentation
    ? buildStreamingSegmentationPrompt(maxStreamSegments)
    : null;

  const preferQqRichReply = Boolean(
    policy.chat.include_qq_rich_reply_when_requested &&
    shouldPreferQqRichReply(cleanText)
  );
  const qqRichReplyPrompt = preferQqRichReply ? buildQqRichReplyPrompt() : null;

  return {
    policy,
    toolGuidancePrompt,
    bridgeGuidancePrompt,
    streamingSegmentationPrompt,
    streamRoutePrompt: [toolGuidancePrompt, streamingSegmentationPrompt].filter(Boolean).join('\n'),
    preferQqRichReply,
    qqRichReplyPrompt,
    disableStreamForReply: Boolean(
      preferQqRichReply &&
      policy.chat.disable_stream_when_qq_rich_requested
    )
  };
}

module.exports = {
  DEFAULT_ROUTE_PROMPT_POLICY,
  ROUTE_PROMPT_POLICY_PATH,
  buildRoutePromptBundle,
  readRoutePromptPolicy,
  resolveRoutePromptPolicy
};

