function composeDirectRoutePrompt({
  toolGuidancePrompt = null,
  perceptionPrompt = null,
  safetyBoundaryRoutePrompt = null,
  streamingSegmentationPrompt = null,
  qqRichReplyPrompt = null
} = {}) {
  return [
    toolGuidancePrompt,
    perceptionPrompt,
    safetyBoundaryRoutePrompt,
    streamingSegmentationPrompt,
    qqRichReplyPrompt
  ].filter(Boolean).join('\n\n');
}

function markDirectSessionPresenceReplied({ groupId, senderId }) {
  const sessionKey = resolveShortTermSessionKey(senderId, { groupId });
  const now = Date.now();
  updateShortTermPresence(sessionKey, shortTermMemory, {}, (current) => ({
    ...current,
    state: 'waiting',
    lastAction: 'reply',
    stateUpdatedAt: now,
    lastBotReplyAt: now,
    humanTurnsSinceBotReply: 0,
    waitingSince: now,
    closedAt: 0
  }));
}

function buildInboundSessionTiming({ continuousMeta = null, previousPresence = null, now = Date.now() } = {}) {
  const meta = continuousMeta && typeof continuousMeta === 'object' ? continuousMeta : {};
  const presence = previousPresence && typeof previousPresence === 'object' ? previousPresence : {};
  const firstTimestamp = Number(meta.firstTimestamp || 0) || 0;
  const lastTimestamp = Number(meta.lastTimestamp || 0) || 0;
  const currentInboundAt = lastTimestamp || firstTimestamp || Number(now || 0) || Date.now();
  const sourceMessageIds = Array.isArray(meta.sourceMessageIds) ? meta.sourceMessageIds.filter(Boolean) : [];

  return {
    currentInboundAt,
    previousHumanInboundAt: Number(presence.lastHumanInboundAt || 0) || 0,
    previousBotReplyAt: Number(presence.lastBotReplyAt || 0) || 0,
    humanTurnsSinceBotReply: Math.max(0, Number(presence.humanTurnsSinceBotReply || 0) || 0),
    mergedSourceCount: sourceMessageIds.length || 1,
    mergedSpanMs: firstTimestamp > 0 && lastTimestamp >= firstTimestamp ? (lastTimestamp - firstTimestamp) : 0
  };
}

function markDirectSessionHumanInbound({ groupId, senderId, sessionTiming = null }) {
  const sessionKey = resolveShortTermSessionKey(senderId, { groupId });
  const timing = sessionTiming && typeof sessionTiming === 'object' ? sessionTiming : {};
  const inboundAt = Number(timing.currentInboundAt || 0) || Date.now();
  updateShortTermPresence(sessionKey, shortTermMemory, {}, (current) => ({
    ...current,
    stateUpdatedAt: inboundAt,
    lastInboundAt: inboundAt,
    lastHumanInboundAt: inboundAt,
    lastAtBotInboundAt: inboundAt,
    humanTurnsSinceBotReply: Math.max(
      0,
      Number(timing.humanTurnsSinceBotReply || current.humanTurnsSinceBotReply || 0)
    )
  }));
}

function getBackgroundTaskAckDelayMs(config) {
  const n = Number(config.BACKGROUND_TASK_ACK_DELAY_MS);
  if (!Number.isFinite(n)) return 1200;
  return Math.max(200, Math.floor(n));
}

function getBackgroundTaskSessionTtlMs(config) {
  const n = Number(config.BACKGROUND_TASK_SESSION_TTL_MS);
  if (!Number.isFinite(n)) return 30 * 60 * 1000;
  return Math.max(60 * 1000, Math.floor(n));
}

function escapeRegExp(text = '') {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripLeadingCqControlSegments(rawText = '', botQQ = '') {
  const atPattern = String(botQQ || '').trim()
    ? new RegExp(`^\\s*\\[CQ:at,qq=${escapeRegExp(String(botQQ || '').trim())}\\]\\s*`, 'i')
    : null;

  let text = String(rawText || '');
  while (true) {
    const next = text.replace(/^\s*\[CQ:reply,[^\]]*\]\s*/i, '');
    if (next === text) break;
    text = next;
  }
  if (atPattern) {
    while (true) {
      const next = text.replace(atPattern, '');
      if (next === text) break;
      text = next;
    }
  }
  return text.trim();
}

function buildStreamingSegmentationPrompt(maxSegments) {
  return buildRuntimePrompt('streaming-segmentation', { maxSegments });
}

function shouldSendScheduledGreeting(data, type, today, config) {
  if (!data || !hasFreshGroupBinding(data)) return false;
  if (config.PROACTIVE_GREETING_FALLBACK_ENABLED === false) return false;

  const minPoints = Number(config.SCHEDULED_GREETING_MIN_POINTS || 250);
  if (Number(data.points || 0) <= minPoints) return false;

  if (type === 'morning' && data.last_morning === today) return false;
  if (type === 'night' && data.last_night === today) return false;
  return true;
}

function isToolReplyRoute(routeContext = {}) {
  const routePolicyKey = typeof routeContext === 'string'
    ? String(routeContext || '').trim()
    : String(routeContext?.routeDebugKey || '').trim();
  const allowTools = typeof routeContext === 'string'
    ? false
    : Boolean(routeContext?.allowTools);
  const routeCapability = String(routeExecution.getPolicyDefinition(routePolicyKey)?.capability || '').trim();

  return (
    allowTools
    || routeCapability === 'tool'
    || isToolStyleRoute(routePolicyKey)
  );
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

function isToolStyleRoute(routeKey = '') {
  return /^(?:act|tool)\//i.test(String(routeKey || '').trim());
}

function buildRoutePlanLogPayload(routeExecutionPlan = {}, extra = {}, route = null) {
  const allowedToolNames = Array.isArray(routeExecutionPlan?.allowedTools) ? routeExecutionPlan.allowedTools : [];
  const planner = route?.meta?.toolPlanner && typeof route.meta.toolPlanner === 'object'
    ? route.meta.toolPlanner
    : (route?.meta?.directChatPlanner && typeof route.meta.directChatPlanner === 'object'
      ? route.meta.directChatPlanner
      : {});
  const plannerExecutionPlan = planner?.executionPlan && typeof planner.executionPlan === 'object'
    ? planner.executionPlan
    : {};
  const plannerSteps = Array.isArray(plannerExecutionPlan.steps) ? plannerExecutionPlan.steps : [];
  return {
    routeDebugKey: String(routeExecutionPlan?.routeDebugKey || 'direct_chat/text_chat/answer'),
    topRouteType: String(routeExecutionPlan?.topRouteType || 'direct_chat'),
    executor: String(routeExecutionPlan?.executor || 'direct'),
    plannerModel: String(planner?.plannerModel || '').trim(),
    shouldUseTools: Boolean(planner?.shouldUseTools),
    plannerMode: String(plannerExecutionPlan.mode || '').trim(),
    plannerStepCount: plannerSteps.length,
    plannerTools: plannerSteps.map((step) => String(step?.action || '').trim()).filter(Boolean),
    plannerFallbackUsed: Boolean(planner?.plannerFallbackUsed),
    allowedToolNames,
    allowedToolBuckets: Array.isArray(routeExecutionPlan?.allowedToolBuckets) ? routeExecutionPlan.allowedToolBuckets : [],
    needsBackground: Boolean(routeExecutionPlan?.needsBackground),
    ...extra
  };
}

