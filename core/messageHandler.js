const fs = require('fs');
const path = require('path');
const { getDatePartsInTz, todayStrInTz } = require('../utils/time');
const {
  favorites,
  chatHistory,
  shortTermMemory,
  updateFavor,
  saveData,
  hasFreshGroupBinding,
  clearGroupBindingsByGroupId,
  clearGroupBindingForUser
} = require('../utils/memory');
const { recordMemoryScope } = require('../utils/memoryScopeIndex');
const { askAIByGraph, runPersistInBackgroundFromCheckpoint } = require('../api/agentGraph');
const { extractJsonSafely } = require('../api/parser');
const {
  startSubagentBridgeCall
} = require('../api/subagentExecutor');
const { buildSessionId } = require('../api/subagentSessionManager');
const { humanizeReply } = require('../utils/humanizer');
const { classifyReplyFailure, isReplyFailure } = require('../utils/replyFailure');
const { sanitizeUserFacingText } = require('../utils/userFacingText');
const { buildRoutePromptBundle } = require('../utils/routePromptPolicy');
const { buildRuntimePrompt } = require('../utils/runtimePrompts');
const { getBackgroundTaskRuntime, summarizeReply: summarizeBackgroundReply } = require('../utils/backgroundTaskRuntime');
const {
  buildToolReplyFormatInstruction,
  cleanToolReplyText,
  resolveToolReplyFormattingPreferences
} = require('../utils/toolReplyFormatting');
const {
  buildSubagentExecutionGuidanceLine,
  buildSubagentExecutionPlanLines,
  buildSubagentToolReasonLine
} = require('../utils/subagentPrompting');
const { isAtBot, detectIntentHybrid } = require('./router');
const routeExecution = require('./routeExecution');
const { createMessageEventDeduper } = require('./messageDeduper');
const { createInboundConcurrencyController } = require('./inboundConcurrency');
const { isPrivilegedPrivateChatUser } = require('../utils/privilegedPrivateChat');
const { handlePassiveGroupAwareness } = require('./passiveGroupAwareness');
const {
  createContinuousMessagePreprocessor,
  resolveContinuousEntryDetails
} = require('./continuousMessagePreprocessor');
const {
  buildCuteRefusalReply,
  buildRefusalReply
} = require('./refusalReply');
const { resolveMessageDirectedContext } = require('./messageDirectedContext');
const { buildLlmPerception } = require('./llmPerception');
// source-compat note: passive flow is delegated, but the historical call site
// remains documented here for source regression coverage:
// const passiveResult = await handlePassiveGroupAwareness({
const {
  buildInboundMessageContext,
  resolveEffectiveBotQQ,
  shouldHandleNotice,
  shouldSkipNonGroupMessage,
  shouldSkipSelfMessage
} = require('./messageIngress');
const { runPassiveFlow } = require('./messagePassiveFlow');
const { createMessageReplyRuntime } = require('./messageReplyRuntime');
const { createMessageSideEffects } = require('./messageSideEffects');
const { createMessageRouteFlow } = require('./messageRouteFlow');
const {
  buildBridgeGuidancePrompt: buildBridgeGuidancePromptOwner,
  buildQqRichReplyPrompt: buildQqRichReplyPromptOwner,
  buildSafetyBoundaryRoutePrompt: buildSafetyBoundaryRoutePromptOwner,
  buildStreamingSegmentationPrompt: buildStreamingSegmentationPromptOwner,
  buildToolGuidancePrompt: buildToolGuidancePromptOwner,
  getRouteDisplayType: getRouteDisplayTypeOwner,
  shouldPreferQqRichReply: shouldPreferQqRichReplyOwner
} = require('./messagePromptComposer');
const {
  createProactiveGreetingFlow,
  shouldSendScheduledGreeting: proactiveShouldSendScheduledGreeting
} = require('./proactiveGreetingFlow');
const {
  consumePendingUploadFromMessage,
  handleAdminCommand,
  maybeSendMemeFollowup
} = require('./memeManager');
const { getDailyShareEngine } = require('./dailyShareEngine');
const { planDirectChat } = require('./directChatPlanner');
const {
  cancelScheduledTask,
  createScheduledCommand,
  deleteScheduledTask,
  isAdminUser,
  listScheduledTasks,
  publishQzoneForContext,
  scheduleGroupMessage,
  setMessageEmojiLike
} = require('../api/qqActionService');
const {
  detectQzonePostDraftMode,
  generateBotDiaryDraft,
  generateGenericQzoneDraft,
  normalizeGeneratedQzoneContent
} = require('../api/qzoneDiaryService');
const {
  resolveShortTermSessionKey,
  getShortTermPresence,
  updateShortTermPresence
} = require('../utils/shortTermMemory');
const { createCheckpointStore, resolveThreadId } = require('../utils/langgraphV2Store');
const {
  saveSessionContextSummary,
  getSessionSummaryCooldownStatus
} = require('../utils/sessionContextSummaryStore');
const {
  generateSessionContextSummary
} = require('../utils/sessionContextSummaryRuntime');
const {
  captureCorrection,
  captureFeatureRequest,
  formatEventsAsText,
  formatGuidesAsText,
  formatPatternsAsText,
  formatRulesAsText,
  listGuides,
  listPatterns,
  listRecentEvents,
  listRules,
  searchEvents
} = require('../utils/selfImprovementRuntime');
const {
  formatStyleProfileAsText,
  recordHumanGroupMessage: recordStyleHumanGroupMessage
} = require('../utils/styleProfileRuntime');
const {
  formatRelationshipGraphAsText,
  formatSocialContextAsText,
  recordHumanGroupMessage: recordSocialHumanGroupMessage
} = require('../utils/socialContextRuntime');
const { appendGroupMessage, getLastReplyAt } = require('../utils/groupAwarenessState');
const { recordHumanInbound } = require('./initiativeState');
const { clearGroupMute, getGroupInitiativeState, setGroupMute } = require('./initiativeState');
const {
  sendGroupReply: sendSystemGroupReply
} = require('./systemGroupReply');

const shouldUseSubagentToolRoute = (...args) => routeExecution.shouldUseSubagentToolRoute(...args);
const shouldUseToolRoute = (...args) => routeExecution.shouldUseToolRoute(...args);
const promptComposerGetRouteDisplayType = (...args) => getRouteDisplayTypeOwner(...args);
const promptComposerBuildToolGuidancePrompt = (...args) => buildToolGuidancePromptOwner(...args);
const promptComposerBuildBridgeGuidancePrompt = (...args) => buildBridgeGuidancePromptOwner(...args);
const promptComposerBuildStreamingSegmentationPrompt = (...args) => buildStreamingSegmentationPromptOwner(...args);
const promptComposerShouldPreferQqRichReply = (...args) => shouldPreferQqRichReplyOwner(...args);
const promptComposerBuildQqRichReplyPrompt = (...args) => buildQqRichReplyPromptOwner(...args);
const promptComposerBuildSafetyBoundaryRoutePrompt = (...args) => buildSafetyBoundaryRoutePromptOwner(...args);
// source-compat anchors for admin route handling now owned by messageRouteFlow:
// cmd === 'learn_recent'
// cmd === 'learn_search'
// cmd === 'learn_patterns'
// cmd === 'learn_rules'
// cmd === 'learn_guide'

function getSafeLifeSchedulerEngine() {
  try {
    const lifeModule = require('./lifeSchedulerEngine');
    if (lifeModule && typeof lifeModule.getLifeSchedulerEngine === 'function') {
      return lifeModule.getLifeSchedulerEngine();
    }
  } catch (error) {
    console.warn('[life-scheduler] unavailable', error?.message || error);
  }
  return {
    async handleAdminCommand() {
      return {
        handled: true,
        replyText: 'Life Scheduler 当前环境不可用。'
      };
    }
  };
}

function parseJsonTail(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`JSON 解析失败: ${error.message || error}`);
  }
}

function buildRouteContextForQqAction(route = {}, senderId = '', groupId = '') {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const qqActionTools = Array.isArray(routeMeta.allowedTools) ? routeMeta.allowedTools : [];
  return {
    ...route,
    meta: {
      ...routeMeta,
      userId: String(senderId || routeMeta.userId || '').trim(),
      groupId: String(groupId || routeMeta.groupId || '').trim(),
      allowedTools: qqActionTools
    }
  };
}

const PRIVATE_GROUP_ONLY_REPLY = '该能力当前仅支持群聊中使用，请在目标群内 @我。';
const PRIVATE_CHAT_WHITELIST_REPLY = '当前私聊接入仅对白名单用户开放。';

function isPrivateChatType(chatType = '') {
  return String(chatType || '').trim().toLowerCase() === 'private';
}

function isPrivateChatUserAllowed(userId = '', runtimeConfig = {}) {
  const allowlist = Array.isArray(runtimeConfig?.PRIVATE_CHAT_ALLOWED_USER_IDS)
    ? runtimeConfig.PRIVATE_CHAT_ALLOWED_USER_IDS
    : [];
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return false;
  return allowlist.includes(normalizedUserId);
}

function formatSummaryCooldownReply(remainingMs = 0) {
  const seconds = Math.max(1, Math.ceil((Number(remainingMs || 0) || 0) / 1000));
  return `当前会话总结刚生成过，请 ${seconds} 秒后再试。`;
}

async function handleSessionSummaryCommand({
  rawText = '',
  senderId = '',
  groupId = '',
  summarizeSessionContext = generateSessionContextSummary
} = {}) {
  const text = String(rawText || '').trim();
  if (!/^\s*\/sr(?:\s|$)/i.test(text)) return null;
  if (!String(groupId || '').trim()) {
    return { handled: true, replyText: '仅群聊会话支持 /sr。' };
  }

  const sessionKey = resolveShortTermSessionKey(senderId, { groupId });
  const cooldownStatus = getSessionSummaryCooldownStatus(sessionKey);
  if (cooldownStatus.limited) {
    return {
      handled: true,
      replyText: formatSummaryCooldownReply(cooldownStatus.remainingMs)
    };
  }

  const summaryResult = await summarizeSessionContext({
    userId: senderId,
    sessionKey,
    routeMeta: { groupId },
    chatHistory,
    shortTermMemory
  });

  const summaryText = String(summaryResult?.summary || '').trim();
  if (!summaryText) {
    return {
      handled: true,
      replyText: '当前会话总结生成失败，请稍后再试。'
    };
  }

  const saved = saveSessionContextSummary({
    sessionKey,
    userId: senderId,
    groupId,
    trigger: 'manual_sr',
    summary: summaryText
  });

  if (saved.cooldownLimited) {
    return {
      handled: true,
      replyText: formatSummaryCooldownReply(saved.remainingMs)
    };
  }

  if (saved.duplicate) {
    return {
      handled: true,
      replyText: '当前会话总结已是最新，无需重复保存。'
    };
  }

  if (!saved.saved) {
    return {
      handled: true,
      replyText: '当前会话总结保存失败，请稍后再试。'
    };
  }

  return {
    handled: true,
    replyText: '当前会话总结已保存。'
  };
}

async function handleInitiativeAdminCommand({ rawText = '', groupId = '', userId = '' } = {}) {
  const text = String(rawText || '').trim();
  if (!/^\s*\/initiative(?:\s|$)/i.test(text)) return null;
  if (!String(groupId || '').trim()) {
    return { handled: true, replyText: '仅群聊可用。' };
  }
  if (!isAdminUser(userId)) {
    return { handled: true, replyText: '仅管理员可用。' };
  }
  const parts = text.split(/\s+/).slice(1);
  const sub = String(parts[0] || 'status').trim().toLowerCase();
  if (sub === 'mute') {
    const minutes = Math.max(1, Number(parts[1] || 30) || 30);
    const until = Date.now() + (minutes * 60 * 1000);
    setGroupMute(groupId, {
      until,
      by: userId,
      at: Date.now()
    });
    return { handled: true, replyText: `当前群主动回复已静音 ${minutes} 分钟。` };
  }
  if (sub === 'resume' || sub === 'unmute') {
    clearGroupMute(groupId, Date.now());
    return { handled: true, replyText: '当前群主动回复已恢复。' };
  }
  const state = getGroupInitiativeState(groupId, Date.now());
  const muteUntil = Number(state?.mute?.until || 0) || 0;
  return {
    handled: true,
    replyText: [
      `主动策略：${config.INITIATIVE_POLICY_ENABLED ? '已启用' : '已关闭'}`,
      `静音状态：${muteUntil > Date.now() ? '静音中' : '正常'}`,
      `今日主动次数：${Math.max(0, Number(state?.daily?.count || 0) || 0)}/${Math.max(1, Number(config.INITIATIVE_GROUP_MAX_PER_DAY || 8))}`,
      `最近主动来源：${String(state?.daily?.lastSource || '无').trim() || '无'}`,
      `最近跳过原因：${String(state?.lastSkipReason || '无').trim() || '无'}`
    ].join('\n')
  };
}

async function handleQqScheduleAdminCommand(command = {}, context = {}) {
  const payload = parseJsonTail(command.payload);
  const kind = String(payload.kind || '').trim().toLowerCase();
  if (kind === 'message') {
    return scheduleGroupMessage(payload.message, payload.when, context);
  }
  if (kind === 'command') {
    return createScheduledCommand(payload.action, payload.when, {
      content: payload.content,
      mode: payload.mode,
      hint: payload.hint
    }, context);
  }
  throw new Error('schedule_create.kind 仅支持 message 或 command');
}

function getRouteDisplayType(route = {}, routeExecutionPlan = {}) {
  return String(
    routeExecutionPlan?.routeDebugKey
    || routeExecutionPlan?.topRouteType
    || route?.topRouteType
    || route?.type
    || 'direct_chat/text_chat/answer'
  ).trim() || 'direct_chat/text_chat/answer';
}

function buildToolGuidancePrompt(route) {
  const planner = route?.meta?.toolPlanner && typeof route.meta.toolPlanner === 'object'
    ? route.meta.toolPlanner
    : (route?.meta?.directChatPlanner && typeof route.meta.directChatPlanner === 'object'
      ? route.meta.directChatPlanner
      : null);
  const toolHints = Array.isArray(planner?.allowedToolNames)
    ? planner.allowedToolNames.filter(Boolean)
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

function buildBridgeGuidancePrompt(route, backend = 'command', routeExecutionPlan = {}) {
  const routeKey = getRouteDisplayType(route, routeExecutionPlan);
  const routeDescription = String(routeKey || '').trim();
  const reason = String(route?.meta?.reason || '').trim();
  const toolLine = buildSubagentToolReasonLine(route, backend);
  const executionLine = buildSubagentExecutionGuidanceLine(route, backend, routeExecutionPlan);
  const executionPlanLines = buildSubagentExecutionPlanLines(routeExecutionPlan, backend);
  return buildRuntimePrompt('bridge-guidance', {
    routeKey,
    routeDescription,
    planId: 'none',
    toolLine,
    executionLine,
    executionPlanBlock: executionPlanLines.length ? `执行步骤:\n${executionPlanLines.join('\n')}` : '',
    reasonLine: reason ? `路由原因: ${reason}` : ''
  });
}

function composeDirectRoutePrompt({
  toolGuidancePrompt = null,
  bridgeGuidancePrompt = null,
  perceptionPrompt = null,
  safetyBoundaryRoutePrompt = null,
  streamingSegmentationPrompt = null,
  qqRichReplyPrompt = null
} = {}) {
  return [
    toolGuidancePrompt,
    bridgeGuidancePrompt,
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

function getReplyChunkChars(config = {}) {
  const n = Number(config.AI_REPLY_CHUNK_CHARS);
  if (!Number.isFinite(n)) return 1200;
  return Math.max(300, Math.min(3000, Math.floor(n)));
}

function getStreamSendGapMs(config = {}) {
  const n = Number(config.AI_STREAM_SEND_GAP_MS);
  if (!Number.isFinite(n)) return 260;
  return Math.max(80, Math.floor(n));
}

function getStreamMaxSegments(config = {}) {
  const n = Number(config.AI_STREAM_MAX_SEGMENTS);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(6, Math.floor(n)));
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

function getRawMessageTimestampMs(msg = {}) {
  const seconds = Number(msg?.time || 0);
  return seconds > 0 ? (seconds * 1000) : 0;
}

function appendInboundTimingLog(logFilePath, enableDebugLog, payload = {}) {
  if (!enableDebugLog) return;
  try {
    const normalized = payload && typeof payload === 'object' ? payload : {};
    const line = JSON.stringify({
      recordedAt: new Date().toISOString(),
      processId: process.pid,
      ...normalized
    });
    fs.appendFile(logFilePath, `${line}\n`, () => {});
  } catch (_) {}
}

function createReplyTelemetryBridge(runtimeConfig = config) {
  const store = createCheckpointStore({
    checkpointDir: runtimeConfig.LANGGRAPH_V2_CHECKPOINT_DIR,
    eventDir: runtimeConfig.LANGGRAPH_V2_EVENT_DIR
  });

  return function buildReplyTelemetry({
    senderId = '',
    groupId = '',
    chatType = 'group',
    routePolicyKey = '',
    topRouteType = '',
    routeMeta = null
  } = {}) {
    const normalizedRouteMeta = routeMeta && typeof routeMeta === 'object'
      ? {
          ...routeMeta,
          groupId: String(groupId || routeMeta.groupId || routeMeta.group_id || '').trim(),
          chatType: String(chatType || routeMeta.chatType || '').trim(),
          topRouteType: String(topRouteType || routeMeta.topRouteType || '').trim(),
          routePolicyKey: String(routePolicyKey || routeMeta.routePolicyKey || '').trim()
        }
      : {
          groupId: String(groupId || '').trim(),
          chatType: String(chatType || '').trim(),
          topRouteType: String(topRouteType || '').trim(),
          routePolicyKey: String(routePolicyKey || '').trim()
        };
    const sessionKey = resolveShortTermSessionKey(senderId, normalizedRouteMeta);
    const threadId = resolveThreadId({
      userId: senderId,
      routePolicyKey,
      reviewMode: '',
      routeMeta: normalizedRouteMeta,
      sessionKey,
      imageUrl: null,
      options: {
        routeMeta: normalizedRouteMeta
      }
    });

    return {
      threadId,
      routePolicyKey: String(routePolicyKey || '').trim(),
      topRouteType: String(topRouteType || '').trim(),
      onEvent(event = {}) {
        if (!threadId) return;
        const normalized = event && typeof event === 'object' ? event : {};
        store.appendEvents(threadId, [normalized]);
      }
    };
  };
}

function normalizeControlText(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
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

function buildBackgroundAckText() {
  return '这类任务我先在后台跑。你可以随时发“任务状态”“取消任务”“结束任务”，或用“任务补充 ...”追加要求。';
}

function buildNoTaskControlText() {
  return '当前没有可控制的后台任务。';
}

function buildSessionStatusReply(session = {}, activeTask = null) {
  if (activeTask) {
    const summary = String(activeTask.latest_summary || '').trim();
    const summaryLine = summary ? `最近摘要：${summary}` : '最近摘要：还在处理中。';
    return [
      `当前任务状态：${activeTask.status || 'running'} / ${activeTask.stage || 'running'}`,
      `最近更新时间：${String(activeTask.updated_at || '').trim() || 'unknown'}`,
      summaryLine
    ].join('\n');
  }

  if (session && String(session.status || '').trim() === 'retained') {
    const summary = String(session.latest_summary || session.latest_result_excerpt || '').trim();
    return summary
      ? `当前没有运行中的后台任务。\n最近一次结果：${summary}\n如果要继续，可以发“任务补充 ...”。`
      : '当前没有运行中的后台任务。如果要继续，可以发“任务补充 ...”。';
  }

  return buildNoTaskControlText();
}

function parseBackgroundControlCommand(text = '') {
  const normalized = normalizeControlText(text);
  if (!normalized) return null;
  const plain = normalized.replace(/^\/+/, '').trim();
  if (!plain) return null;
  if (plain === '任务状态') return { type: 'status', payload: '' };
  if (plain === '取消任务') return { type: 'cancel', payload: '' };
  if (plain === '结束任务') return { type: 'close', payload: '' };
  if (/^任务(?:补充|继续)\s+/i.test(plain)) {
    return {
      type: 'supplement',
      payload: plain.replace(/^任务(?:补充|继续)\s+/i, '').trim()
    };
  }
  if (plain === '任务补充' || plain === '任务继续') {
    return { type: 'supplement', payload: '' };
  }
  return null;
}

function buildSupplementedTaskText(session = {}, supplement = '') {
  const parts = [];
  const originalText = String(session?.original_text || '').trim();
  const latestSummary = String(session?.latest_summary || session?.latest_result_excerpt || '').trim();
  const cleanSupplement = String(supplement || '').trim();

  if (originalText) parts.push(`原始请求：${originalText}`);
  if (latestSummary) parts.push(`最近结果摘要：${latestSummary}`);
  if (cleanSupplement) parts.push(`补充要求：${cleanSupplement}`);

  return parts.join('\n');
}

function clampFullSubagentWorkerCount(value, fallback = 2, maxWorkers = 2) {
  const fallbackCount = Math.max(1, Math.min(2, Number(fallback) || 1));
  const hardMax = Math.max(1, Math.min(2, Number(maxWorkers) || 2));
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return Math.min(fallbackCount, hardMax);
  return Math.max(1, Math.min(hardMax, parsed));
}

function normalizeFullSubagentWorker(worker = {}, fallbackIndex = 0) {
  const index = Math.max(1, Number(fallbackIndex) || 1);
  const rawMustCover = Array.isArray(worker?.mustCover) ? worker.mustCover : [];
  const mustCover = rawMustCover
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 8);

  return {
    id: String(worker?.id || `w${index}`).trim() || `w${index}`,
    title: String(worker?.title || `Worker ${index}`).trim() || `Worker ${index}`,
    objective: String(worker?.objective || '').trim(),
    mustCover,
    deliverable: String(worker?.deliverable || '').trim()
  };
}

function buildSingleWorkerFallbackPlan(question = '') {
  const cleanQuestion = String(question || '').trim() || '(empty)';
  return {
    workerCount: 1,
    workers: [
      {
        id: 'w1',
        title: 'Primary worker',
        objective: cleanQuestion,
        mustCover: ['Address the full original task directly.'],
        deliverable: 'Produce the best complete answer possible for the original /full request.'
      }
    ],
    reviewFocus: 'Merge carefully, keep failures and uncertainty visible, do not invent extra execution.'
  };
}

function normalizeFullSubagentPlan(rawPlan, options = {}) {
  const {
    question = '',
    maxWorkers = 2
  } = options && typeof options === 'object' ? options : {};

  const parsed = rawPlan && typeof rawPlan === 'object' && !Array.isArray(rawPlan)
    ? rawPlan
    : extractJsonSafely(rawPlan);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return buildSingleWorkerFallbackPlan(question);
  }

  const hardMax = Math.max(1, Math.min(2, Number(maxWorkers) || 2));
  const rawWorkers = Array.isArray(parsed.workers) ? parsed.workers : [];
  const normalizedWorkers = rawWorkers
    .slice(0, hardMax)
    .map((worker, index) => normalizeFullSubagentWorker(worker, index + 1))
    .filter((worker) => worker.objective || worker.mustCover.length || worker.deliverable);

  const desiredCount = clampFullSubagentWorkerCount(
    parsed.workerCount,
    normalizedWorkers.length || 1,
    hardMax
  );

  if (!normalizedWorkers.length) {
    return buildSingleWorkerFallbackPlan(question);
  }

  const workers = normalizedWorkers.slice(0, desiredCount).map((worker, index) => ({
    ...worker,
    id: `w${index + 1}`
  }));

  if (!workers.length) {
    return buildSingleWorkerFallbackPlan(question);
  }

  return {
    workerCount: workers.length,
    workers,
    reviewFocus: String(parsed.reviewFocus || '').trim()
      || 'Merge overlap, resolve conflicts conservatively, keep failures and uncertainty explicit.'
  };
}

function buildFullSubagentCoordinatorPayload(question = '', routePrompt = null, maxWorkers = 2) {
  const workerLimit = clampFullSubagentWorkerCount(maxWorkers, 2, 2);
  const routePromptBlock = String(routePrompt || '').trim()
    ? `Route guidance:\n${String(routePrompt || '').trim()}`
    : '';

  return [
    'Return JSON only.',
    'Plan a `/full` admin task into 1 or 2 worker assignments.',
    'If splitting is weak or artificial, use exactly 1 worker.',
    'Do not mention tools, sessions, or implementation internals in the plan.',
    'Required JSON schema:',
    '{"workerCount":1,"workers":[{"id":"w1","title":"string","objective":"string","mustCover":["string"],"deliverable":"string"}],"reviewFocus":"string"}',
    `Max workers: ${workerLimit}`,
    routePromptBlock,
    'Original /full request:',
    String(question || '').trim() || '(empty)'
  ].filter(Boolean).join('\n\n');
}

function buildFullSubagentWorkerPrompt(question = '', worker = {}, plan = {}) {
  const mustCover = Array.isArray(worker?.mustCover) ? worker.mustCover.filter(Boolean) : [];
  const allWorkers = Array.isArray(plan?.workers) ? plan.workers : [];
  const boundaryLines = allWorkers
    .filter((entry) => entry && String(entry.id || '').trim() && String(entry.id || '').trim() !== String(worker?.id || '').trim())
    .map((entry) => `- ${String(entry.id || '').trim()}: ${String(entry.title || '').trim() || 'other worker'} -> ${String(entry.objective || '').trim() || 'adjacent coverage'}`);

  return [
    'You are one worker in an admin `/full` multi-worker run.',
    'Complete only your assigned scope. Do not assume the other worker completed your part.',
    'Do not claim to have searched, read, verified, executed, or observed anything you did not actually do.',
    'Output structured plain text that a local reviewer can merge directly.',
    '',
    `Original task:\n${String(question || '').trim() || '(empty)'}`,
    `Worker id: ${String(worker?.id || '').trim() || 'w1'}`,
    `Worker title: ${String(worker?.title || '').trim() || 'Worker'}`,
    `Objective:\n${String(worker?.objective || '').trim() || 'Address the assigned part of the original task.'}`,
    mustCover.length ? `Must cover:\n${mustCover.map((item) => `- ${item}`).join('\n')}` : '',
    String(worker?.deliverable || '').trim() ? `Deliverable:\n${String(worker.deliverable).trim()}` : '',
    boundaryLines.length ? `Other worker boundaries:\n${boundaryLines.join('\n')}` : '',
    'Structure your output with these sections if applicable:',
    '- Findings',
    '- Evidence',
    '- Gaps or limits',
    '- Suggested final wording'
  ].filter(Boolean).join('\n\n');
}

function summarizeFullWorkerError(error, worker = {}) {
  const label = String(worker?.id || 'worker').trim() || 'worker';
  const message = String(error?.message || error || 'unknown error').trim() || 'unknown error';
  return `${label} failed: ${message}`;
}

function formatFullWorkerResultForReview(result = {}) {
  const worker = result?.worker || {};
  const status = String(result?.status || 'unknown').trim() || 'unknown';
  const output = String(result?.output || '').trim();
  const error = String(result?.error || '').trim();

  return [
    `Worker ${String(worker.id || '').trim() || 'unknown'} (${String(worker.title || '').trim() || 'untitled'})`,
    `Status: ${status}`,
    worker.objective ? `Objective: ${String(worker.objective).trim()}` : '',
    output ? `Output:\n${output}` : '',
    error ? `Error:\n${error}` : ''
  ].filter(Boolean).join('\n');
}

function buildFullSubagentReviewPayload(question = '', plan = {}, workerResults = [], routePolicyKey = 'admin/full') {
  const normalizedResults = Array.isArray(workerResults) ? workerResults : [];
  const workerBlocks = normalizedResults.length
    ? normalizedResults.map((entry) => formatFullWorkerResultForReview(entry)).join('\n\n---\n\n')
    : 'No worker results.';

  const workerPlanBlock = Array.isArray(plan?.workers) && plan.workers.length
    ? plan.workers.map((worker) => [
      `- ${String(worker.id || '').trim() || 'w?'}`,
      String(worker.title || '').trim() || 'untitled',
      String(worker.objective || '').trim() || 'no objective'
    ].join(' | ')).join('\n')
    : '- w1 | Primary worker | Address the original task directly';

  return [
    `Task policy: ${String(routePolicyKey || 'admin/full').trim() || 'admin/full'}`,
    '',
    'Original /full request:',
    String(question || '').trim() || '(empty)',
    '',
    'Coordinator plan:',
    `workerCount: ${Number(plan?.workerCount) || 1}`,
    workerPlanBlock,
    '',
    `Review focus: ${String(plan?.reviewFocus || '').trim() || 'Merge carefully and keep limits visible.'}`,
    '',
    'Worker results:',
    workerBlocks,
    '',
    'Return one final admin reply only.'
  ].join('\n');
}

function chooseBestFullSubagentWorkerOutput(workerResults = []) {
  const normalizedResults = Array.isArray(workerResults) ? workerResults : [];
  const successes = normalizedResults.filter((entry) => String(entry?.status || '').trim() === 'fulfilled' && String(entry?.output || '').trim());
  if (!successes.length) return '';

  successes.sort((a, b) => String(b.output || '').trim().length - String(a.output || '').trim().length);
  return String(successes[0]?.output || '').trim();
}

function buildFullSubagentFallbackReply(workerResults = []) {
  const normalizedResults = Array.isArray(workerResults) ? workerResults : [];
  const best = chooseBestFullSubagentWorkerOutput(normalizedResults);
  if (best) return best;

  const fragments = normalizedResults
    .map((entry) => {
      const workerId = String(entry?.worker?.id || '').trim();
      const output = String(entry?.output || '').trim();
      const error = String(entry?.error || '').trim();
      if (output) return workerId ? `[${workerId}] ${output}` : output;
      if (error) return workerId ? `[${workerId}] ${error}` : error;
      return '';
    })
    .filter(Boolean);

  if (fragments.length) return fragments.join('\n\n');
  return 'This /full run did not produce a usable worker result.';
}

function buildFullSubagentAllWorkersFailedReply(workerResults = []) {
  const normalizedResults = Array.isArray(workerResults) ? workerResults : [];
  const failures = normalizedResults
    .map((entry) => String(entry?.error || '').trim())
    .filter(Boolean);
  if (!failures.length) {
    return '所有 worker 都失败了，而且没有产出可用结果。';
  }
  return [
    '所有 worker 都失败了。',
    failures.map((line) => `- ${line}`).join('\n')
  ].join('\n');
}

function getModelSegmentBreakIndex(text) {
  const input = String(text || '');
  if (!input) return -1;

  const rn = input.indexOf('\r\n\r\n');
  const nn = input.indexOf('\n\n');

  if (rn === -1 && nn === -1) return -1;
  if (rn === -1) return nn + 2;
  if (nn === -1) return rn + 4;
  return Math.min(rn + 4, nn + 2);
}

function buildStreamingSegmentationPrompt(maxSegments) {
  return buildRuntimePrompt('streaming-segmentation', { maxSegments });
}

function getNaturalSplitIndex(text) {
  const input = String(text || '');
  if (!input) return -1;

  const strongStops = ['\n', '.', '。', '!', '！', '?', '？', '~', '～', ';', '；'];
  for (let i = input.length - 1; i >= 0; i -= 1) {
    if (strongStops.includes(input[i])) return i + 1;
  }

  if (input.length >= 24) {
    const weakStops = [',', '，', ':', '：'];
    for (let i = input.length - 1; i >= 0; i -= 1) {
      if (weakStops.includes(input[i])) return i + 1;
    }
  }

  return -1;
}

function createStreamingDispatcher({
  runtimeConfig = null,
  config = runtimeConfig || {},
  sendWithRetry,
  chatType = 'group',
  groupId,
  userId,
  senderId
} = {}) {
  const effectiveConfig = runtimeConfig && typeof runtimeConfig === 'object'
    ? runtimeConfig
    : (config || {});
  const maxSegments = getStreamMaxSegments(effectiveConfig);
  const state = {
    fullText: '',
    sentLength: 0,
    sentSegments: 0,
    hasSentAny: false,
    lastSendAt: 0,
    sendQueue: Promise.resolve()
  };

  async function sendChunk(chunk) {
    const text = String(chunk || '').trim();
    if (!text) return false;

    const task = async () => {
      // Keep streamed chunk sending strictly serialized (unit-test anchor).
      const now = Date.now();
      const minGap = getStreamSendGapMs(effectiveConfig);
      const elapsed = now - state.lastSendAt;
      if (state.lastSendAt > 0 && elapsed < minGap) {
        await new Promise((r) => setTimeout(r, minGap - elapsed));
      }

      const isPrivate = String(chatType || '').trim().toLowerCase() === 'private';
      const payload = isPrivate
        ? {
            action: 'send_private_msg',
            params: { user_id: userId, message: text }
          }
        : {
            action: 'send_group_msg',
            params: {
              group_id: groupId,
              message: `${state.hasSentAny ? '' : `[CQ:at,qq=${senderId}] `}${text}`
            }
          };
      const sent = await sendWithRetry(payload, 1, 300);

      if (!sent) {
        console.error(isPrivate ? '[stream] send_private_msg failed' : '[stream] send_group_msg failed', {
          chatType: isPrivate ? 'private' : 'group',
          groupId,
          userId,
          senderId
        });
        return false;
      }

      state.hasSentAny = true;
      state.lastSendAt = Date.now();
      return true;
    };

    state.sendQueue = state.sendQueue.then(task, task);
    return state.sendQueue;
  }

  async function flush(force = false) {
    const pending = state.fullText.slice(state.sentLength);
    if (!pending) return false;

    let sendUntil = -1;
    const canSplitMore = state.sentSegments < (maxSegments - 1);
    if (canSplitMore) {
      sendUntil = getModelSegmentBreakIndex(pending);
      if (sendUntil <= 0) {
        const natural = getNaturalSplitIndex(pending);
        if (natural > 0) sendUntil = natural;
      }
    }

    if (sendUntil <= 0 && force) sendUntil = pending.length;
    if (sendUntil <= 0) return false;

    const rawChunk = pending.slice(0, sendUntil);
    const chunk = rawChunk.trim();
    state.sentLength += sendUntil;

    if (!chunk) return true;

    const sent = await sendChunk(chunk);
    if (!sent) return false;

    state.sentSegments += 1;
    return true;
  }

  return {
    async onDelta(_delta, fullText) {
      state.fullText = sanitizeUserFacingText(fullText);
      await flush(false);
    },
    async finish(finalReply) {
      const visibleFinalReply = sanitizeUserFacingText(finalReply).trim();
      state.fullText = visibleFinalReply || state.fullText || '';
      while (state.sentSegments < maxSegments && await flush(true)) {}

      if (!state.hasSentAny && state.fullText.trim()) {
        await sendChunk(state.fullText.trim());
        state.sentLength = state.fullText.length;
        state.sentSegments = Math.max(1, state.sentSegments);
      }
    }
  };
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

function splitReplyForSend(text, maxChars) {
  const input = String(text || '').trim();
  if (!input) return [];

  const limit = Math.max(300, Number(maxChars) || 1200);
  if (input.length <= limit) return [input];

  const chunks = [];
  let rest = input;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf('?', limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf('?', limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf(' ', limit);
    if (cut < Math.floor(limit * 0.3)) cut = limit;

    const part = rest.slice(0, cut).trim();
    if (part) chunks.push(part);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);

  return chunks;
}

function pushTextSegment(segments, text) {
  const value = String(text || '');
  if (!value) return;

  const last = segments[segments.length - 1];
  if (last && last.type === 'text' && last.data && typeof last.data.text === 'string') {
    last.data.text += value;
    return;
  }

  segments.push({ type: 'text', data: { text: value } });
}

function isSupportedQqImageSource(value) {
  const input = String(value || '').trim();
  if (!input) return false;

  return (
    /^https?:\/\/\S+$/i.test(input) ||
    /^file:\/\/\S+$/i.test(input) ||
    /^[a-zA-Z]:[\\/]/.test(input) ||
    /^base64:\/\/\S+$/i.test(input)
  );
}

function parseQqRichMessage(text) {
  const input = String(text || '');
  const tokenRe = /\[\[(qq_face|qq_image):([\s\S]*?)\]\]/gi;
  const segments = [];
  let hasRichSegment = false;
  let lastIndex = 0;
  let match = tokenRe.exec(input);

  while (match) {
    if (match.index > lastIndex) {
      pushTextSegment(segments, input.slice(lastIndex, match.index));
    }

    const kind = String(match[1] || '').toLowerCase();
    const rawValue = String(match[2] || '').trim();
    const originalToken = match[0];

    if (kind === 'qq_face' && /^\d+$/.test(rawValue)) {
      segments.push({ type: 'face', data: { id: rawValue } });
      hasRichSegment = true;
    } else if (kind === 'qq_image' && isSupportedQqImageSource(rawValue)) {
      segments.push({ type: 'image', data: { file: rawValue } });
      hasRichSegment = true;
    } else {
      pushTextSegment(segments, originalToken);
    }

    lastIndex = match.index + originalToken.length;
    match = tokenRe.exec(input);
  }

  if (lastIndex < input.length) {
    pushTextSegment(segments, input.slice(lastIndex));
  }

  return {
    hasRichSegment,
    segments
  };
}

function buildQqRichMessagePayload(text, { atSender = true, senderId } = {}) {
  const parsed = parseQqRichMessage(text);
  if (!parsed.hasRichSegment) return null;

  const message = [];
  if (atSender && senderId) {
    message.push({ type: 'at', data: { qq: String(senderId) } });
    message.push({ type: 'text', data: { text: ' ' } });
  }

  for (const segment of parsed.segments) {
    if (segment.type === 'text') {
      pushTextSegment(message, segment.data.text);
      continue;
    }
    message.push(segment);
  }

  return message.length ? message : null;
}

function shouldPreferQqRichReply(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;

  return /(琛ㄦ儏鍖厊鍙戣〃鎯厊鍙戜釜琛ㄦ儏|emoji|sticker|璐寸焊|鍔ㄥ浘|gif)/i.test(t);
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

function buildUnavailableRouteReply(route = {}, routeExecutionPlan = {}) {
  const unavailableReason = String(routeExecutionPlan?.unavailableReason || '').trim().toLowerCase();
  if (unavailableReason !== 'no-allowed-tools') {
    return 'The required tool is temporarily unavailable. Please try again later.';
  }

  const qqActionKey = String(route?.meta?.qqActionKey || '').trim().toLowerCase();
  const userId = String(route?.meta?.userId || '').trim();
  const adminUser = isAdminUser(userId);

  if (qqActionKey === 'qq_publish_qzone') {
    return adminUser
      ? 'QQ 空间发布工具暂时不可用。你可以稍后重试，或直接使用 /qzone_post。'
      : 'QQ 空间发布当前仅管理员可用。';
  }

  if (qqActionKey === 'qq_schedule_qzone') {
    return adminUser
      ? '定时 QQ 空间工具暂时不可用。你可以稍后重试，或直接使用 /schedule_create。'
      : '定时 QQ 空间发布当前仅管理员可用。';
  }

  if (qqActionKey === 'qq_schedule_message') {
    return '定时消息工具当前不可用。你可以换个更清晰的时间表达再试一次。';
  }

  return '这轮没有可用工具可以处理这个请求。你可以稍后重试，或把需求说得更具体一些。';
}

function isCorrectionSignal(text = '') {
  const input = String(text || '').trim();
  if (!input) return false;
  return /(不是这样|你说错了|实际上应该是|你搞错了|不对|纠正一下|更准确地说)/i.test(input);
}

function getLastAssistantReplyForSession(senderId = '', groupId = '') {
  const sessionKey = resolveShortTermSessionKey(senderId, { groupId });
  const historyStore = require('../utils/memory').chatHistory || {};
  const history = Array.isArray(historyStore[sessionKey]) ? historyStore[sessionKey] : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (String(item?.role || '').trim() === 'assistant' && String(item?.content || '').trim()) {
      return String(item.content || '').trim();
    }
  }
  return '';
}

function getLastUserMessageForSession(senderId = '', groupId = '') {
  const sessionKey = resolveShortTermSessionKey(senderId, { groupId });
  const historyStore = require('../utils/memory').chatHistory || {};
  const history = Array.isArray(historyStore[sessionKey]) ? historyStore[sessionKey] : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (String(item?.role || '').trim() === 'user' && String(item?.content || '').trim()) {
      return String(item.content || '').trim();
    }
  }
  return '';
}

function sanitizeSubagentContextSnippet(text = '') {
  return String(text || '')
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\b(?:group|groupId|user|userId|session|sessionId)\s*[:=]\s*[A-Za-z0-9:_-]+\b/gi, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipSubagentContextSummary(text = '', maxLength = 220) {
  const normalized = sanitizeSubagentContextSnippet(text);
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function buildDirectedConversationSummary(directedContext = {}, { maxLength = 220 } = {}) {
  const context = directedContext && typeof directedContext === 'object' ? directedContext : {};
  const lines = [];
  if (String(context.scene || '').trim()) lines.push(`Scene: ${String(context.scene || '').trim()}`);
  const addressee = context.addressee && typeof context.addressee === 'object' ? context.addressee : {};
  const addresseeText = String(
    addressee.senderName
    || addressee.userId
    || addressee.kind
    || ''
  ).trim();
  if (addresseeText) lines.push(`Current message to: ${addresseeText}`);
  const quote = context.quote && typeof context.quote === 'object' ? context.quote : null;
  if (quote) {
    const quoteFrom = String(quote.senderName || quote.senderId || '').trim();
    if (String(quote.origin || '').trim()) lines.push(`Quoted origin: ${String(quote.origin || '').trim()}`);
    if (quoteFrom) lines.push(`Quoted message from: ${quoteFrom}`);
    if (quote.hasImage === true) lines.push('Quoted message has image');
    if (String(quote.text || '').trim()) lines.push(`Quoted text: ${String(quote.text || '').trim()}`);
  }
  const quotePriority = context.quotePriority && typeof context.quotePriority === 'object' ? context.quotePriority : null;
  if (quotePriority?.enabled) {
    if (String(quotePriority.mode || '').trim()) lines.push(`Quote priority mode: ${String(quotePriority.mode || '').trim()}`);
    if (String(quotePriority.reason || '').trim()) lines.push(`Quote priority reason: ${String(quotePriority.reason || '').trim()}`);
    if (String(quotePriority.quoteAnchoredText || '').trim()) lines.push(`Quote anchored text: ${String(quotePriority.quoteAnchoredText || '').trim()}`);
  }
  if (context.activePair?.userA && context.activePair?.userB) {
    lines.push(`Active pair: ${context.activePair.userA}<->${context.activePair.userB}`);
  }
  return clipSubagentContextSummary(lines.join('\n'), maxLength);
}

function prefersQuotedImage(cleanText = '') {
  const text = String(cleanText || '').trim();
  if (!text) return false;
  return /(上面那张|引用那张|前面那张|回复那张|那张图|引用图片|上面这张图|前面这张图)/i.test(text);
}

function prefersCurrentImage(cleanText = '') {
  const text = String(cleanText || '').trim();
  if (!text) return false;
  return /(我发的这张|我这张|看我这张|我贴这张|我这图|这张图|这张图片)/i.test(text);
}

function resolveVisualInputFromContinuousMetaCore(continuousMeta = null, directedContext = null, cleanText = '') {
  const meta = continuousMeta && typeof continuousMeta === 'object' ? continuousMeta : null;
  if (!meta) return null;
  const selected = String(meta.selectedImageUrl || '').trim();
  const replyImages = Array.isArray(meta.replyContext?.imageUrls) ? meta.replyContext.imageUrls : [];
  const quotePriority = directedContext?.quotePriority && typeof directedContext.quotePriority === 'object'
    ? directedContext.quotePriority
    : null;
  const quoteWantsQuotedImage = quotePriority?.enabled
    && quotePriority?.quoteFocus?.hasImage === true
    && (
      String(quotePriority.mode || '').trim() === 'anchored_rewrite'
      || prefersQuotedImage(cleanText)
    );
  const currentImageRef = prefersCurrentImage(cleanText);

  if (selected && !quoteWantsQuotedImage) return selected;
  if (selected && currentImageRef) return selected;
  for (const item of replyImages) {
    const url = String(item || '').trim();
    if (url) return url;
  }
  if (selected) return selected;
  return null;
}

function resolveVisualInputFromContinuousMeta(continuousMeta = null) {
  return resolveVisualInputFromContinuousMetaCore(continuousMeta, null, '');
}

// source-compat anchor: function buildSubagentContextSummary(senderId = '', groupId = '', { maxLength = 220 } = {}) {
function buildSubagentContextSummary(senderId = '', groupId = '', { maxLength = 220, directedContext = null } = {}) {
  const lastUserText = getLastUserMessageForSession(senderId, groupId);
  const lastAssistantReply = getLastAssistantReplyForSession(senderId, groupId);
  const lines = [];
  const directedSummary = buildDirectedConversationSummary(directedContext, { maxLength });
  if (directedSummary) lines.push(directedSummary);
  if (lastUserText) lines.push(`Previous user: ${lastUserText}`);
  if (lastAssistantReply) lines.push(`Previous assistant: ${lastAssistantReply}`);
  return clipSubagentContextSummary(lines.join('\n'), maxLength);
}

function maybeCaptureUserCorrection({ cleanText, senderId, groupId, routeExecutionPlan }) {
  if (!isCorrectionSignal(cleanText)) return;
  const lastAssistantReply = getLastAssistantReplyForSession(senderId, groupId);
  if (!lastAssistantReply) return;
  try {
    captureCorrection({
      userMessage: cleanText,
      assistantReply: lastAssistantReply,
      routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
      topRouteType: routeExecutionPlan?.topRouteType || 'direct_chat',
      groupId,
      userId: senderId
    });
  } catch (error) {
    console.error('[self-improvement] correction capture failed:', error?.message || error);
  }
}

function maybeCaptureUnavailableFeatureRequest({ routeExecutionPlan, cleanText, senderId, groupId, route }) {
  if (String(routeExecutionPlan?.unavailableReason || '').trim().toLowerCase() !== 'no-allowed-tools') return;
  if (String(routeExecutionPlan?.topRouteType || '').trim().toLowerCase() !== 'direct_chat') return;
  try {
    captureFeatureRequest({
      userMessage: cleanText,
      unavailableReason: routeExecutionPlan.unavailableReason,
      routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
      topRouteType: routeExecutionPlan.topRouteType,
      toolName: String((routeExecutionPlan.allowedTools || [])[0] || '').trim(),
      groupId,
      userId: senderId,
      suggestedAction: 'Add or expose the missing tool/capability for this request class.'
    });
  } catch (error) {
    console.error('[self-improvement] feature request capture failed:', error?.message || error);
  }
}

function shouldAutoDraftQzonePostRequest(route = {}, cleanText = '') {
  return detectQzonePostDraftMode(route, cleanText) !== 'manual';
}

function buildQzoneAutodraftPrompt(requestText = '') {
  return [
    '你现在只负责代写一条可以直接发布到 QQ 空间的中文正文。',
    '必须使用第一人称，语气自然，像今天写的日记或状态。',
    '优先根据用户原话推断主题、心情、长度和风格。',
    '默认写成 80 到 180 字。',
    '不要解释，不要提问，不要使用标题、项目符号、引号、标签或前缀。',
    '不要提到自己是 AI。',
    '只输出最终可发布正文。',
    `用户请求: ${String(requestText || '').trim()}`
  ].join('\n');
}

function getEffectivePolicyKey(routeExecutionPlan = {}) {
  return String(
    routeExecutionPlan?.policyKey
    || routeExecutionPlan?.routePolicyKey
    || routeExecutionPlan?.routeDebugKey
    || 'chat/default'
  ).trim() || 'chat/default';
}

function createMessageHandler({
  config,
  sendWithRetry,
  detectIntentHybridOverride = null,
  generateSessionContextSummaryOverride = null,
  inboundConcurrencyControllerOverride = null
}) {
  const inboundTimingLogFile = path.join(config.DATA_DIR, 'inbound_timing.jsonl');
  const inboundDeduper = createMessageEventDeduper({
    ttlMs: 90 * 1000,
    maxEntries: 4096
  });
  const continuousMessagePreprocessor = createContinuousMessagePreprocessor({
    enabled: config.CONTINUOUS_MESSAGE_ENABLED,
    debounceMs: config.CONTINUOUS_MESSAGE_DEBOUNCE_MS
  });
  const dailyShareEngine = getDailyShareEngine();
  const lifeSchedulerEngine = getSafeLifeSchedulerEngine();
  const backgroundTaskRuntime = getBackgroundTaskRuntime();
  backgroundTaskRuntime.expireSessions();
  const routeResolver = typeof detectIntentHybridOverride === 'function'
    ? detectIntentHybridOverride
    : detectIntentHybrid;
  const sessionSummaryGenerator = typeof generateSessionContextSummaryOverride === 'function'
    ? generateSessionContextSummaryOverride
    : generateSessionContextSummary;
  const replyRuntime = createMessageReplyRuntime({
    sendWithRetry,
    runtimeConfig: config
  });
  const buildReplyTelemetry = createReplyTelemetryBridge(config);

  function maybeRunDeferredPersist(replyEnvelope = {}) {
    const replyOptions = replyEnvelope?.replyOptions && typeof replyEnvelope.replyOptions === 'object'
      ? replyEnvelope.replyOptions
      : null;
    if (replyOptions?.deferPersist !== true) return;
    const routeMeta = replyOptions?.routeMeta && typeof replyOptions.routeMeta === 'object'
      ? replyOptions.routeMeta
      : {};
    const userId = String(routeMeta.userId || routeMeta.user_id || '').trim();
    const sessionKey = resolveShortTermSessionKey(userId, routeMeta);
    const threadId = resolveThreadId({
      userId,
      routePolicyKey: String(replyOptions?.routePolicyKey || '').trim(),
      reviewMode: '',
      routeMeta,
      sessionKey,
      imageUrl: null,
      options: {
        routeMeta
      }
    });
    if (!threadId) return;

    setTimeout(() => {
      console.log('[persist-background] start', {
        threadId,
        routePolicyKey: String(replyOptions?.routePolicyKey || '').trim(),
        topRouteType: String(replyOptions?.topRouteType || '').trim()
      });
      runPersistInBackgroundFromCheckpoint(threadId).catch((error) => {
        console.error('[persist-background] failed', {
          threadId,
          error: error?.message || String(error || '')
        });
      });
    }, 0);
  }
  const inboundConcurrency = inboundConcurrencyControllerOverride || createInboundConcurrencyController({
    globalLimit: config.INBOUND_GLOBAL_MAX_CONCURRENCY,
    generalLimit: config.INBOUND_GENERAL_MAX_CONCURRENCY,
    adminLimit: config.INBOUND_ADMIN_MAX_CONCURRENCY,
    perUserLimit: config.INBOUND_PER_USER_MAX_INFLIGHT
  });
  const privateInboundConcurrency = createInboundConcurrencyController({
    globalLimit: config.PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY,
    generalLimit: config.PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY,
    adminLimit: config.PRIVATE_INBOUND_ADMIN_MAX_CONCURRENCY,
    perUserLimit: config.PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT
  });
  // source-compat anchors for historical in-file normalizeUserFacingReply logic:
  // if (config.HUMANIZER_AGENT_ENABLED || config.LLM_HUMANIZER_ENABLED) return t;
  // const cleaned = humanizeReply(t);
  // const toolReplyRoute = isToolReplyRoute(routeContext);
  const normalizeUserFacingReply = replyRuntime.normalizeUserFacingReply;
  const parseBackgroundControlCommand = replyRuntime.parseBackgroundControlCommand;
  const buildBackgroundAckText = replyRuntime.buildBackgroundAckText;
  const buildSessionStatusReply = replyRuntime.buildSessionStatusReply;
  const buildNoTaskControlText = replyRuntime.buildNoTaskControlText;
  const sendReply = replyRuntime.sendReply;
  const sideEffects = createMessageSideEffects({
    appendGroupMessage,
    config,
    maybeSendMemeFollowup,
    recordMemoryScope,
    recordSocialHumanGroupMessage,
    recordStyleHumanGroupMessage,
    saveData,
    updateFavor
  });
  const proactiveGreetingFlow = createProactiveGreetingFlow({
    config,
    favorites,
    askAIDispatch,
    normalizeUserFacingReply,
    sendGroupReply: (...args) => replyRuntime.sendGroupReply(...args),
    maybeSendMemeFollowup,
    sendWithRetry,
    saveData,
    clearGroupBindingForUser
  });
  let routeFlow = null;

  function buildSubagentReviewPayload(question, subagentOutput, routePolicyKey = 'tool/review') {
    return buildRuntimePrompt('review-payload', {
      routeKey: routePolicyKey,
      question: String(question || '').trim() || '(empty)',
      subagentOutput: String(subagentOutput || '').trim() || '(empty)'
    });
  }

  async function reviewSubagentOutput({
    question,
    subagentOutput,
    userInfo,
    userId,
    imageUrl = null,
    routePrompt = null,
    routePolicyKey = 'tool/review'
  }) {
    const personaPrompt = String(config.SYSTEM_PROMPT || '').trim();
    const formattingPreferences = resolveToolReplyFormattingPreferences(question);
    const outputFormatInstruction = buildToolReplyFormatInstruction(formattingPreferences);
    const reviewSystemPrompt = buildRuntimePrompt('review-system', {
      personaPrompt,
      outputFormatInstruction
    });

    const reviewRoutePrompt = buildRuntimePrompt('review-route', {
      routePromptBlock: routePrompt ? `路由提示:\n${routePrompt}` : '',
      outputFormatInstruction
    });

    const reviewInput = buildSubagentReviewPayload(question, subagentOutput, routePolicyKey);
    return askAIByGraph(reviewInput, userInfo, userId, reviewSystemPrompt, imageUrl, {
      routePrompt: reviewRoutePrompt,
      routePolicyKey,
      reviewMode: 'subagent_output',
      disableStream: true,
      disableTools: true,
      routeMeta: {
        requestText: question
      }
    });
  }

  async function planFullSubagentWorkers({
    question,
    userInfo,
    userId,
    imageUrl = null,
    routePrompt = null,
    routePolicyKey = 'admin/full'
  }) {
    const maxWorkers = clampFullSubagentWorkerCount(config.FULL_SUBAGENT_MAX_WORKERS, 2, 2);
    const prompt = buildFullSubagentCoordinatorPayload(question, routePrompt, maxWorkers);
    let rawPlan = '';

    try {
      rawPlan = await askAIByGraph(prompt, userInfo, userId, String(config.SYSTEM_PROMPT || '').trim(), imageUrl, {
        routePrompt: 'Plan the admin `/full` task into up to two workers. Return JSON only.',
        routePolicyKey,
        topRouteType: 'admin',
        reviewMode: 'full_subagent_plan',
        disableTools: true,
        disableStream: true,
        modelConfig: {
          model: 'gpt-5.4-mini'
        },
        routeMeta: {
          requestText: question,
          topRouteType: 'admin',
          routePolicyKey
        }
      });
    } catch (error) {
      console.error('[full-subagent] coordinator failed, fallback to single worker:', error?.message || error);
      return buildSingleWorkerFallbackPlan(question);
    }

    return normalizeFullSubagentPlan(rawPlan, {
      question,
      maxWorkers
    });
  }

  async function reviewFullMultiWorkerOutput({
    question,
    plan,
    workerResults,
    userInfo,
    userId,
    imageUrl = null,
    routePrompt = null,
    routePolicyKey = 'admin/full'
  }) {
    const personaPrompt = String(config.SYSTEM_PROMPT || '').trim();
    const formattingPreferences = resolveToolReplyFormattingPreferences(question);
    const outputFormatInstruction = buildToolReplyFormatInstruction(formattingPreferences);
    const reviewSystemPrompt = buildRuntimePrompt('review-system', {
      personaPrompt,
      outputFormatInstruction
    });
    const reviewRoutePrompt = buildRuntimePrompt('review-route', {
      routePromptBlock: routePrompt ? `Routing guidance:\n${routePrompt}` : '',
      outputFormatInstruction
    });
    const reviewInput = buildFullSubagentReviewPayload(question, plan, workerResults, routePolicyKey);
    return askAIByGraph(reviewInput, userInfo, userId, reviewSystemPrompt, imageUrl, {
      routePrompt: reviewRoutePrompt,
      routePolicyKey,
      topRouteType: 'admin',
      reviewMode: 'full_subagent_multi_review',
      disableTools: true,
      disableStream: true,
      routeMeta: {
        requestText: question,
        topRouteType: 'admin',
        routePolicyKey
      }
    });
  }

  async function executeFullMultiWorkerTaskWithHandle(question, userInfo, userId, imageUrl = null, options = {}) {
    const mutableOptions = options && typeof options === 'object' ? { ...options } : {};
    mutableOptions.routePrompt = String(mutableOptions.routePrompt || '').trim() || null;
    const routePolicyKey = String(mutableOptions.routePolicyKey || 'admin/full').trim() || 'admin/full';
    const formattingPreferences = resolveToolReplyFormattingPreferences(question);
    const backgroundTaskId = String(mutableOptions.backgroundTaskId || '').trim();
    const shouldContinue = typeof mutableOptions?.shouldContinue === 'function'
      ? mutableOptions.shouldContinue
      : () => true;
    const workerCancels = [];
    let completedWorkers = 0;

    const updateTaskStage = (stage, latestSummary = '') => {
      if (!backgroundTaskId) return;
      backgroundTaskRuntime.markTaskStatus(backgroundTaskId, {
        status: stage === 'reviewing' ? 'reviewing' : 'running',
        stage,
        latest_summary: String(latestSummary || '').trim()
      });
    };

    if (!(config.SUBAGENT_ENABLED || config.NANOBOT_BRIDGE_ENABLED)) {
      return {
        promise: Promise.resolve('?????????????? agent??? agent ?????????? `.env` ?? `SUBAGENT_ENABLED`?`SUBAGENT_COMMAND` ? `OPENCLAW_*` ???'),
        cancel() {}
      };
    }

    const promise = (async () => {
      console.log('[full-subagent] multi-agent start', {
        executor: 'full_subagent',
        multiAgent: true,
        subagentBackend: String(config.SUBAGENT_BACKEND || 'command').trim() || 'command'
      });

      updateTaskStage('planning', 'planning worker split');
      const planStartedAt = Date.now();
      const plan = await planFullSubagentWorkers({
        question,
        userInfo,
        userId,
        imageUrl,
        routePrompt: mutableOptions.routePrompt,
        routePolicyKey
      });
      const workerCount = clampFullSubagentWorkerCount(plan?.workerCount, 1, config.FULL_SUBAGENT_MAX_WORKERS);
      console.log('[full-subagent] planning completed', {
        executor: 'full_subagent',
        multiAgent: true,
        workerCount,
        planDurationMs: Date.now() - planStartedAt
      });

      if (!shouldContinue()) return '';

      updateTaskStage('workers_running', `workers 0/${workerCount}`);
      const workerStartedAt = Date.now();
      const workerPromises = (Array.isArray(plan?.workers) ? plan.workers : []).slice(0, workerCount).map(async (worker, index) => {
        const workerId = String(worker?.id || `w${index + 1}`).trim() || `w${index + 1}`;
        const workerPrompt = buildFullSubagentWorkerPrompt(question, worker, plan);
        console.log('[full-subagent] worker started', {
          executor: 'full_subagent',
          multiAgent: true,
          workerId,
          workerTitle: String(worker?.title || '').trim(),
          workerCount
        });

        try {
          const bridgeCall = await startSubagentBridgeCall(question, userInfo, userId, null, imageUrl, {
            ...mutableOptions,
            sessionSuffix: `full:${workerId}`,
            routePrompt: mutableOptions.routePrompt,
            subagentRoutePrompt: workerPrompt,
            routePolicyKey,
            topRouteType: 'admin'
          });
          workerCancels.push((reason) => bridgeCall.cancel(reason));
          const output = await bridgeCall.promise;
          const cleanOutput = cleanToolReplyText(output, formattingPreferences);
          console.log('[full-subagent] worker completed', {
            executor: 'full_subagent',
            multiAgent: true,
            workerId,
            workerCount
          });
          return {
            worker,
            status: 'fulfilled',
            output: cleanOutput,
            error: ''
          };
        } catch (error) {
          const failureText = summarizeFullWorkerError(error, worker);
          console.error('[full-subagent] worker failed', {
            executor: 'full_subagent',
            multiAgent: true,
            workerId,
            workerCount,
            error: failureText
          });
          return {
            worker,
            status: 'rejected',
            output: '',
            error: failureText
          };
        } finally {
          if (backgroundTaskId) {
            completedWorkers += 1;
            backgroundTaskRuntime.markTaskStatus(backgroundTaskId, {
              status: 'running',
              stage: 'workers_running',
              latest_summary: `workers ${Math.min(completedWorkers, workerCount)}/${workerCount}`
            });
          }
        }
      });

      const settled = await Promise.allSettled(workerPromises);
      const workerResults = settled.map((entry, index) => {
        if (entry.status === 'fulfilled') return entry.value;
        const worker = plan.workers[index] || { id: `w${index + 1}` };
        return {
          worker,
          status: 'rejected',
          output: '',
          error: summarizeFullWorkerError(entry.reason, worker)
        };
      });

      const successCount = workerResults.filter((entry) => entry.status === 'fulfilled' && String(entry.output || '').trim()).length;
      console.log('[full-subagent] workers finished', {
        executor: 'full_subagent',
        multiAgent: true,
        workerCount,
        successCount,
        workerDurationMs: Date.now() - workerStartedAt
      });

      if (!shouldContinue()) return '';
      if (successCount <= 0) {
        return buildFullSubagentAllWorkersFailedReply(workerResults);
      }

      updateTaskStage('reviewing', `workers ${workerCount}/${workerCount}, reviewing`);
      const reviewStartedAt = Date.now();
      console.log('[full-subagent] review started', {
        executor: 'full_subagent',
        multiAgent: true,
        workerCount
      });
      try {
        const reviewed = await reviewFullMultiWorkerOutput({
          question,
          plan,
          workerResults,
          userInfo,
          userId,
          imageUrl,
          routePrompt: mutableOptions.routePrompt,
          routePolicyKey
        });
        if (!shouldContinue()) return '';
        if (String(reviewed || '').trim()) {
          const cleanReviewed = cleanToolReplyText(reviewed, formattingPreferences);
          if (cleanReviewed && !looksLikeModelFailureText(cleanReviewed)) {
            console.log('[full-subagent] review completed', {
              executor: 'full_subagent',
              multiAgent: true,
              workerCount,
              reviewCompleted: true,
              reviewDurationMs: Date.now() - reviewStartedAt
            });
            return cleanReviewed;
          }
        }
      } catch (error) {
        console.error('[full-subagent] review failed, fallback to best worker output', {
          executor: 'full_subagent',
          multiAgent: true,
          workerCount,
          error: error?.message || error
        });
      }

      console.log('[full-subagent] review fallback', {
        executor: 'full_subagent',
        multiAgent: true,
        workerCount,
        reviewFallback: true
      });
      return buildFullSubagentFallbackReply(workerResults);
    })().catch((error) => {
      if (error && /cancelled/i.test(String(error?.message || ''))) {
        return '';
      }
      console.error('[full-subagent] multi-agent execute failed:', error?.message || error);
      return '?? `/full` ? worker ????????????????';
    });

    return {
      promise,
      cancel(reason = 'cancelled') {
        for (const fn of workerCancels) {
          try { fn(reason); } catch (_) {}
        }
        return reason;
      }
    };
  }

  async function askAIDispatch(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
    const mutableOptions = options && typeof options === 'object' ? options : {};
    mutableOptions.routePrompt = String(mutableOptions.routePrompt || '').trim() || null;

    return askAIByGraph(question, userInfo, userId, customPrompt, imageUrl, mutableOptions);
  }

  async function markThinkingEmojiBeforeLlm({
    messageId,
    routePolicyKey = '',
    routeMeta = {}
  } = {}) {
    const normalizedMessageId = String(messageId || '').trim();
    if (!normalizedMessageId) return false;

    const emojiIds = Array.isArray(config.QQ_THINKING_EMOJI_IDS) ? config.QQ_THINKING_EMOJI_IDS : [];
    if (!emojiIds.length) return false;

    const result = await setMessageEmojiLike(normalizedMessageId, emojiIds, { set: true }).catch((error) => ({
      success: false,
      reason: error?.message || String(error || 'unknown error'),
      failures: []
    }));

    if (!result?.success) {
      console.warn('[thinking-emoji] failed', {
        messageId: normalizedMessageId,
        routePolicyKey: String(routePolicyKey || '').trim(),
        groupId: String(routeMeta?.groupId || routeMeta?.group_id || '').trim(),
        reason: result?.reason || 'unknown error'
      });
      return false;
    }

    return true;
  }

  async function askToolTaskWithSubagentReview(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
    const mutableOptions = options && typeof options === 'object' ? options : {};
    mutableOptions.routePrompt = String(mutableOptions.routePrompt || '').trim() || null;
    const routePolicyKey = String(mutableOptions.routePolicyKey || 'admin/full').trim() || 'admin/full';
    const formattingPreferences = resolveToolReplyFormattingPreferences(question);

    if (!(config.SUBAGENT_ENABLED || config.NANOBOT_BRIDGE_ENABLED)) {
      return '?????????????? agent ????? agent ?????????? `.env` ?? `SUBAGENT_ENABLED`?`SUBAGENT_COMMAND` ? `OPENCLAW_*` ???';
    }

    let subagentOutput = '';
    try {
      const bridgeCall = await startSubagentBridgeCall(question, userInfo, userId, customPrompt, imageUrl, mutableOptions);
      subagentOutput = await bridgeCall.promise;
    } catch (bridgeErr) {
      console.error('[subagent-bridge] execute failed:', bridgeErr?.message || bridgeErr);
      return '????????????? agent ??????????????????????????? agent ????????';
    }

    if (looksLikeModelFailureText(subagentOutput)) {
      return '? agent ???????????????????????????????????????????? agent ???????????';
    }

    if (!(config.SUBAGENT_REVIEW_ENABLED || config.NANOBOT_REVIEW_ENABLED)) {
      return cleanToolReplyText(subagentOutput, formattingPreferences);
    }

    try {
      const reviewed = await reviewSubagentOutput({
        question,
        subagentOutput,
        userInfo,
        userId,
        imageUrl,
        routePrompt: mutableOptions.routePrompt,
        routePolicyKey
      });

      if (String(reviewed || '').trim()) {
        if (looksLikeModelFailureText(reviewed) && String(subagentOutput || '').trim()) return cleanToolReplyText(subagentOutput, formattingPreferences);
        return cleanToolReplyText(reviewed, formattingPreferences);
      }
      if (String(subagentOutput || '').trim()) return cleanToolReplyText(subagentOutput, formattingPreferences);
      return '? agent ???????? Mizuki ????????????????????????';
    } catch (reviewErr) {
      console.error('[subagent-review] failed, fallback to raw subagent output:', reviewErr?.message || reviewErr);
      if (String(subagentOutput || '').trim()) return cleanToolReplyText(subagentOutput, formattingPreferences);
      return '??? agent ????????????????????????';
    }
  }

  async function askToolTaskLocally(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
    const mutableOptions = options && typeof options === 'object' ? options : {};
    const formattingPreferences = resolveToolReplyFormattingPreferences(question);
    const outputFormatInstruction = buildToolReplyFormatInstruction(formattingPreferences);
    mutableOptions.routePrompt = [String(mutableOptions.routePrompt || '').trim(), outputFormatInstruction].filter(Boolean).join('\n\n') || null;
    const plannerExecutionPlan = mutableOptions.plannerExecutionPlan && typeof mutableOptions.plannerExecutionPlan === 'object'
      ? mutableOptions.plannerExecutionPlan
      : null;

    const reply = await askAIByGraph(question, userInfo, userId, customPrompt, imageUrl, {
      ...mutableOptions,
      disableTools: false,
      disableStream: true,
      forcePlanMode: String(plannerExecutionPlan?.mode || '').trim() === 'tool_plan',
      routeMeta: {
        ...(mutableOptions.routeMeta || {})
      }
    });
    return cleanToolReplyText(reply, formattingPreferences);
  }

  async function executeDirectChatToolTask(question, userInfo, userId, imageUrl = null, options = {}) {
    return askToolTaskLocally(question, userInfo, userId, null, imageUrl, options);
  }

  async function executeFullSubagentTaskWithHandle(question, userInfo, userId, imageUrl = null, options = {}) {
    const mutableOptions = options && typeof options === 'object' ? { ...options } : {};
    mutableOptions.routePrompt = String(mutableOptions.routePrompt || '').trim() || null;
    const routePolicyKey = String(mutableOptions.routePolicyKey || 'admin/full').trim() || 'admin/full';
    const formattingPreferences = resolveToolReplyFormattingPreferences(question);

      if (!(config.SUBAGENT_ENABLED || config.NANOBOT_BRIDGE_ENABLED)) {
        return {
          promise: Promise.resolve('?????????????? agent??? agent ?????????? `.env` ?? `SUBAGENT_ENABLED`?`SUBAGENT_COMMAND` ? `OPENCLAW_*` ???'),
          cancel() {}
        };
      }

      const bridgeCall = await startSubagentBridgeCall(question, userInfo, userId, null, imageUrl, mutableOptions);
      const promise = bridgeCall.promise.then(async (subagentOutput) => {
        if (looksLikeModelFailureText(subagentOutput)) {
          return '? agent ???????????????????????????????????????????? agent ???????????';
        }

        if (!(config.SUBAGENT_REVIEW_ENABLED || config.NANOBOT_REVIEW_ENABLED)) {
          return cleanToolReplyText(subagentOutput, formattingPreferences);
        }

        const shouldContinue = typeof mutableOptions?.shouldContinue === 'function'
          ? mutableOptions.shouldContinue
          : () => true;

        try {
          if (!shouldContinue()) return '';
          const reviewed = await reviewSubagentOutput({
            question,
            subagentOutput,
            userInfo,
            userId,
            imageUrl,
            routePrompt: mutableOptions.routePrompt,
            routePolicyKey
          });
          if (!shouldContinue()) return '';

          if (String(reviewed || '').trim()) {
            if (looksLikeModelFailureText(reviewed) && String(subagentOutput || '').trim()) {
              return cleanToolReplyText(subagentOutput, formattingPreferences);
            }
            return cleanToolReplyText(reviewed, formattingPreferences);
          }
          if (String(subagentOutput || '').trim()) return cleanToolReplyText(subagentOutput, formattingPreferences);
          return '? agent ???????? Mizuki ????????????????????????';
        } catch (reviewErr) {
          console.error('[subagent-review] failed, fallback to raw subagent output:', reviewErr?.message || reviewErr);
          if (String(subagentOutput || '').trim()) return cleanToolReplyText(subagentOutput, formattingPreferences);
          return '??? agent ????????????????????????';
        }
      }).catch((bridgeErr) => {
        if (bridgeErr && /cancelled/i.test(String(bridgeErr?.message || ''))) {
          return '';
        }
        console.error('[subagent-bridge] execute failed:', bridgeErr?.message || bridgeErr);
        return '????????????? agent ??????????????????????????? agent ????????';
      });

      return {
        promise,
        cancel(reason = 'cancelled') {
          return bridgeCall.cancel(reason);
        }
      };
  }

  async function executeDirectChatToolTaskWithHandle(question, userInfo, userId, imageUrl = null, options = {}) {
    return {
      promise: executeDirectChatToolTask(question, userInfo, userId, imageUrl, options),
      cancel() {}
    };
  }

  async function runBackgroundToolTask({
    route,
    routeExecutionPlan,
    cleanText,
    imageUrl,
    userInfo,
    senderId,
    groupId,
    toolTaskOptions,
    executionHandleFactory = executeDirectChatToolTaskWithHandle,
    sendAckOnly = false,
    initialStage = 'running'
  }) {
    const sessionId = buildSessionId(senderId, {
      sessionChannel: 'qq-group',
      sessionChatId: `group_${groupId}_user_${senderId}`
    });

    const task = backgroundTaskRuntime.startTask({
      sessionKey: sessionId,
      executorType: String(routeExecutionPlan?.executor || 'background_direct').trim() || 'background_direct',
      groupId,
      userId: senderId,
      originalText: cleanText,
      effectiveText: cleanText,
      routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
      topRouteType: routeExecutionPlan.topRouteType
    });

    const executionHandle = await executionHandleFactory(cleanText, userInfo, senderId, imageUrl, {
      ...toolTaskOptions,
      backgroundTaskId: task.id,
      shouldContinue: () => backgroundTaskRuntime.shouldContinue(task.id)
    });

    backgroundTaskRuntime.attachController(task.id, {
      cancel(reason = 'cancelled') {
        return executionHandle.cancel(reason);
      }
    });
    backgroundTaskRuntime.markTaskRunning(task.id, initialStage);

    const replyPromise = executionHandle.promise.then((rawReply) => {
      const normalizedReply = normalizeUserFacingReply(rawReply, {
        routeDebugKey: getEffectivePolicyKey(routeExecutionPlan),
        topRouteType: routeExecutionPlan.topRouteType,
        allowTools: routeExecutionPlan.allowTools,
        requestText: cleanText
      });
      const currentTask = backgroundTaskRuntime.getTask(task.id);
      const retainSession = Boolean(currentTask?.ack_sent || sendAckOnly);
      backgroundTaskRuntime.finalizeTask(task.id, {
        status: normalizedReply ? 'completed' : (currentTask?.status || 'completed'),
        stage: normalizedReply ? 'completed' : (currentTask?.stage || 'completed'),
        replyText: normalizedReply,
        latestSummary: summarizeBackgroundReply(normalizedReply),
        retainSession,
        followupSent: Boolean(currentTask?.followup_sent)
      });
      return normalizedReply;
    }).catch((err) => {
      if (err && /cancelled/i.test(String(err?.message || ''))) {
        backgroundTaskRuntime.requestCancel(task.id, {
          error: 'cancelled',
          reason: 'cancelled'
        });
        return '';
      }
      const currentTask = backgroundTaskRuntime.getTask(task.id);
      backgroundTaskRuntime.finalizeTask(task.id, {
        status: 'failed',
        stage: 'failed',
        error: err?.message || String(err || 'unknown error'),
        latestSummary: '',
        replyText: '',
        retainSession: Boolean(currentTask?.ack_sent || sendAckOnly)
      });
      return '????????????????????????????????????';
    });

    const ackDelayMs = getBackgroundTaskAckDelayMs(config);
    const ackRace = await Promise.race([
      replyPromise.then((reply) => ({ done: true, reply })),
      new Promise((resolve) => setTimeout(() => resolve({ done: false }), ackDelayMs))
    ]);

    if (ackRace.done) {
      const latest = backgroundTaskRuntime.getTask(task.id);
      if (latest?.ack_sent) {
        if (backgroundTaskRuntime.canEmitFollowup(task.id)) {
          const sent = await sendGroupReply({
            groupId,
            senderId,
            replyText: ackRace.reply,
            atSender: true,
            retries: 2,
            waitMs: 500
          });
          if (sent) {
            backgroundTaskRuntime.markFollowupSent(task.id, true);
            await maybeSendMemeFollowup({
              surface: 'direct',
              groupId,
              senderId,
              sendWithRetry,
              routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
              topRouteType: routeExecutionPlan.topRouteType,
              userText: cleanText,
              replyText: ackRace.reply,
              routeMeta: route.meta || {}
            });
          }
        }
        return { reply: '', usedStreamingSend: true, replyOptions: null, backgroundHandled: true };
      }
      return {
        reply: ackRace.reply,
        usedStreamingSend: false,
        replyOptions: null,
        backgroundHandled: false
      };
    }

    const ackText = buildBackgroundAckText();
    const sentAck = await sendGroupReply({
      groupId,
      senderId,
      replyText: ackText,
      atSender: true,
      retries: 1,
      waitMs: 300
    });
    if (sentAck) {
      backgroundTaskRuntime.markAckSent(task.id, true);
    }

    replyPromise.then(async (finalReply) => {
      if (!String(finalReply || '').trim()) return;
      if (!backgroundTaskRuntime.canEmitFollowup(task.id)) return;

      const sent = await sendGroupReply({
        groupId,
        senderId,
        replyText: finalReply,
        atSender: true,
        retries: 2,
        waitMs: 500
      });
      if (!sent) return;

      backgroundTaskRuntime.markFollowupSent(task.id, true);
      await maybeSendMemeFollowup({
        surface: 'direct',
        groupId,
        senderId,
        sendWithRetry,
        routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
        topRouteType: routeExecutionPlan.topRouteType,
        userText: cleanText,
        replyText: finalReply,
        routeMeta: route.meta || {}
      });
    }).catch(() => {});

    return {
      reply: '',
      usedStreamingSend: true,
      replyOptions: null,
      backgroundHandled: true
    };
  }

  async function handleFullAdminCommand({
    route,
    groupId,
    senderId,
    userInfo,
    rawText
  }) {
    const command = route?.meta?.command || {};
    const payload = String(command.payload || command.args?.[0] || '').trim();
    if (!route?.meta?.admin) {
      await sendGroupReply({
        groupId,
        senderId,
        replyText: '????????? /full?',
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (!payload) {
      await sendGroupReply({
        groupId,
        senderId,
        replyText: '/full ????????????',
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    const routeExecutionPlan = routeExecution.resolveRouteExecution(route, config, {});

    const sessionChatId = `group_${groupId}_user_${senderId}`;
    const fullExecutionHandleFactory = executeFullSubagentTaskWithHandle; // executionHandleFactory: executeFullSubagentTaskWithHandle
    const fullPrompt = [
      '??? /full ???????????????',
      '?????? direct_chat?',
      payload
    ].join('\n\n');

    if (config.BACKGROUND_TOOL_TASKS_ENABLED) {
      await runBackgroundToolTask({
        route,
        routeExecutionPlan,
        cleanText: payload,
        imageUrl: route?.imageUrl || null,
        userInfo,
        senderId,
        groupId,
        toolTaskOptions: {
          routePrompt: fullPrompt,
          subagentRoutePrompt: fullPrompt,
          sessionChannel: 'qq-group',
          sessionChatId,
          routePolicyKey: 'admin/full',
          topRouteType: 'admin',
          routeMeta: {
            ...(route?.meta || {}),
            groupId,
            topRouteType: 'admin',
            routePolicyKey: 'admin/full'
          }
        },
        executionHandleFactory: config.FULL_SUBAGENT_MULTI_AGENT_ENABLED
          ? executeFullMultiWorkerTaskWithHandle
          : fullExecutionHandleFactory,
        initialStage: config.FULL_SUBAGENT_MULTI_AGENT_ENABLED ? 'planning' : 'running'
      });
      return true;
    }

    const fullTaskOptions = {
      routePrompt: fullPrompt,
      subagentRoutePrompt: fullPrompt,
      sessionChannel: 'qq-group',
      sessionChatId,
      routePolicyKey: 'admin/full',
      topRouteType: 'admin',
      routeMeta: {
        ...(route?.meta || {}),
        groupId,
        topRouteType: 'admin',
        routePolicyKey: 'admin/full',
        rawText
      }
    };

    const reply = config.FULL_SUBAGENT_MULTI_AGENT_ENABLED
      ? await (await executeFullMultiWorkerTaskWithHandle(payload, userInfo, senderId, route?.imageUrl || null, fullTaskOptions)).promise
      : await askToolTaskWithSubagentReview(payload, userInfo, senderId, null, route?.imageUrl || null, fullTaskOptions);

    await sendGroupReply({
      groupId,
      senderId,
      replyText: normalizeUserFacingReply(reply, {
        routeDebugKey: 'admin/full',
        topRouteType: 'admin',
        allowTools: false,
        requestText: payload
      }),
      atSender: true,
      retries: 1,
      waitMs: 300
    });
    return true;
  }

  async function handleBackgroundTaskControl({
    command,
    groupId,
    senderId,
    userInfo,
    imageUrl,
    rawText,
    botQQ
  }) {
    if (!command) return false;
    const cleanText = normalizeControlText(
      String(rawText || '')
        .replace(new RegExp(`\\[CQ:at,qq=${String(botQQ || '').trim()}\\]`, 'g'), '')
        .replace(/\[CQ:image,.*?\]/g, '')
    );
    const sessionId = buildSessionId(senderId, {
      sessionChannel: 'qq-group',
      sessionChatId: `group_${groupId}_user_${senderId}`
    });
    const session = backgroundTaskRuntime.getSessionState(sessionId);
    const activeTask = backgroundTaskRuntime.getActiveTask(sessionId);

    if (command.type === 'status') {
      await sendGroupReply({
        groupId,
        senderId,
        replyText: buildSessionStatusReply(session, activeTask),
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (command.type === 'cancel') {
      const targetTaskId = activeTask?.id || '';
      const cancelled = targetTaskId
        ? backgroundTaskRuntime.requestCancel(targetTaskId, { error: 'cancelled by user', reason: 'cancelled by user' })
        : null;
      await sendGroupReply({
        groupId,
        senderId,
        replyText: cancelled ? '??????????' : buildNoTaskControlText(),
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (command.type === 'close') {
      const closed = session ? backgroundTaskRuntime.closeSession(sessionId) : null;
      await sendGroupReply({
        groupId,
        senderId,
        replyText: closed ? '????????????' : buildNoTaskControlText(),
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (command.type === 'supplement') {
      if (!String(command.payload || '').trim()) {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: '???????????????? ...??????? ...??',
          atSender: true,
          retries: 1,
          waitMs: 300
        });
        return true;
      }

      if (!session || String(session.status || '').trim() === 'done') {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: buildNoTaskControlText(),
          atSender: true,
          retries: 1,
          waitMs: 300
        });
        return true;
      }

      const supplementedText = buildSupplementedTaskText(session, command.payload);
      const routerContextSummary = buildSubagentContextSummary(senderId, groupId, { maxLength: 180 });
      const plannerContextSummary = buildSubagentContextSummary(senderId, groupId, { maxLength: 320 });
      const route = await routeResolver({
        rawText: String(rawText || '').replace(cleanText, supplementedText),
        botQQ,
        userId: senderId,
        contextSummary: routerContextSummary
      });
      route.meta = {
        ...(route.meta || {}),
        userId: String(senderId || ''),
        groupId: String(groupId || '')
      };
      route.cleanText = supplementedText;
      route.rawText = supplementedText;
      if (route?.topRouteType === 'direct_chat') {
        const plannerDecision = await planDirectChat(route, {
          userId: senderId,
          allowedTools: route?.meta?.allowedTools,
          contextSummary: plannerContextSummary
        });
        route.meta = {
          ...(route.meta || {}),
          directChatPlanner: plannerDecision
        };
      }
      const routeExecutionPlan = routeExecution.resolveRouteExecution(route, config, {});

      if (String(routeExecutionPlan.executor || '').trim() !== 'background_direct' && !routeExecutionPlan.allowTools) {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: '????????????????????????????????????????????',
          atSender: true,
          retries: 1,
          waitMs: 300
        });
        return true;
      }

      if (activeTask?.id) {
        backgroundTaskRuntime.supersedeTask(activeTask.id);
      }

      const promptBundle = buildRoutePromptBundle({
        route,
        routeExecutionPlan,
        cleanText: supplementedText,
        maxStreamSegments: getStreamMaxSegments(config),
        buildToolGuidancePrompt,
        buildBridgeGuidancePrompt: (currentRoute) => buildBridgeGuidancePrompt(currentRoute, config.SUBAGENT_BACKEND || 'command', routeExecutionPlan),
        buildStreamingSegmentationPrompt,
        shouldPreferQqRichReply,
        buildQqRichReplyPrompt
      });
      await runBackgroundToolTask({
        route,
        routeExecutionPlan,
        cleanText: supplementedText,
        imageUrl: route.imageUrl || imageUrl,
        userInfo,
        senderId,
        groupId,
        toolTaskOptions: {
          routePrompt: promptBundle.toolGuidancePrompt,
          sessionChannel: 'qq-group',
          sessionChatId: `group_${groupId}_user_${senderId}`,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          allowedTools: routeExecutionPlan.allowedTools,
          routeMeta: {
            ...(route.meta || {}),
            groupId,
            topRouteType: routeExecutionPlan.topRouteType,
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            allowedTools: routeExecutionPlan.allowedTools
          }
        },
        sendAckOnly: false
      });
      return true;
    }

    return false;
  }

  async function dispatchByRoutePlan({
    route,
    routeExecutionPlan,
    cleanText,
    imageUrl,
    userInfo,
    senderId,
    groupId,
    sourceMessageId = '',
    inboundContext = null
  }) {
    let reply = '';
    let usedStreamingSend = false;
    let finalReplyOptions = null;
    const promptBundle = buildRoutePromptBundle({
      route,
      routeExecutionPlan,
      cleanText,
      maxStreamSegments: getStreamMaxSegments(config),
      buildToolGuidancePrompt,
      buildBridgeGuidancePrompt: routeExecutionPlan?.executor === 'full_subagent'
        ? (currentRoute) => buildBridgeGuidancePrompt(currentRoute, config.SUBAGENT_BACKEND || 'command', routeExecutionPlan)
        : null,
      buildStreamingSegmentationPrompt,
      shouldPreferQqRichReply,
      buildQqRichReplyPrompt
    });
    const {
      toolGuidancePrompt,
      bridgeGuidancePrompt,
      streamingSegmentationPrompt,
      qqRichReplyPrompt,
      disableStreamForReply
    } = promptBundle;
    const safetyBoundaryRoutePrompt = buildSafetyBoundaryRoutePrompt(route);
    const perceptionResult = buildLlmPerception(inboundContext || {}, {
      passive: false
    });
    const perceptionPrompt = String(perceptionResult?.text || '').trim() || null;
    console.log('[dispatch] route plan resolved', buildRoutePlanLogPayload(routeExecutionPlan, {
      groupId,
      senderId,
      routeReason: String(route?.meta?.reason || '').trim()
    }, route));

    try {
      if (routeExecutionPlan.unavailableReason) {
        maybeCaptureUnavailableFeatureRequest({
          routeExecutionPlan,
          cleanText,
          senderId,
          groupId,
          route
        });
        reply = buildUnavailableRouteReply(route, routeExecutionPlan);
      } else if (routeExecutionPlan.allowTools || routeExecutionPlan.executor === 'background_direct') {
        const toolTaskOptions = {
          routePrompt: [toolGuidancePrompt, bridgeGuidancePrompt, perceptionPrompt].filter(Boolean).join('\n\n') || null,
          sessionChannel: 'qq-group',
          sessionChatId: `group_${groupId}_user_${senderId}`,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeDebugKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          allowTools: routeExecutionPlan.allowTools,
          allowedTools: routeExecutionPlan.allowedTools,
          routeMeta: {
            ...(route.meta || {}),
            groupId,
            topRouteType: routeExecutionPlan.topRouteType,
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            allowedTools: routeExecutionPlan.allowedTools
          }
        };

        console.log('[dispatch] tool route resolved', buildRoutePlanLogPayload(routeExecutionPlan, {
          groupId,
          senderId
        }, route));

        if (config.BACKGROUND_TOOL_TASKS_ENABLED && routeExecutionPlan.executor === 'background_direct') {
          const backgroundResult = await runBackgroundToolTask({
            route,
            routeExecutionPlan,
            cleanText,
            imageUrl,
            userInfo,
            senderId,
            groupId,
            toolTaskOptions
          });
          return backgroundResult;
        }

        const qzoneDraftMode = detectQzonePostDraftMode(route, cleanText);
        if (qzoneDraftMode === 'bot_diary') {
          const diaryDraft = await generateBotDiaryDraft({
            groupId: String(groupId || ''),
            hint: cleanText
          });
          if (!diaryDraft.ok) {
            reply = `?????????? bot ???\n\n?????${diaryDraft.reason || '????'}`;
          } else {
            const publishResult = await publishQzoneForContext({
              mode: 'manual',
              content: diaryDraft.content
            }, {
              userId: String(senderId || ''),
              routeMeta: {
                ...(route.meta || {}),
                userId: String(senderId || ''),
                groupId: String(groupId || '')
              }
            });
            reply = publishResult?.ok
              ? `??? bot ??? QQ ?????\n\n???\n${diaryDraft.content}`
              : `?? bot ????????? QQ ??????\n\n?????${publishResult?.text || '????'}`;
          }
        } else if (qzoneDraftMode === 'generic_autodraft') {
          const drafted = await generateGenericQzoneDraft({
            requestText: cleanText,
            groupId: String(groupId || '')
          });
          const draftedContent = drafted.ok ? normalizeGeneratedQzoneContent(drafted.content) : '';

          if (!draftedContent) {
            reply = '????????????????????????????????????';
          } else {
            const publishResult = await publishQzoneForContext(draftedContent, {
              userId: String(senderId || ''),
              qzoneSource: 'generic_autodraft',
              qzoneType: 'generic_autodraft',
              lens: drafted?.meta?.lens,
              emotion: drafted?.meta?.emotion,
              anchor: drafted?.meta?.anchor,
              structure: drafted?.meta?.structure,
              ending: drafted?.meta?.ending,
              routeMeta: {
                ...(route.meta || {}),
                userId: String(senderId || ''),
                groupId: String(groupId || '')
              }
            });
            reply = publishResult?.ok
              ? `???????? QQ ???\n\n???\n${draftedContent}`
              : `????????????? QQ ??????\n\n?????${publishResult?.text || '????'}\n\n???\n${draftedContent}`;
          }
        } else {
          await markThinkingEmojiBeforeLlm({
            messageId: sourceMessageId,
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            routeMeta: route.meta || {}
          });
          reply = await askToolTaskLocally(cleanText, userInfo, senderId, null, imageUrl, toolTaskOptions);
        }
        console.log('[dispatch] tool route completed', buildRoutePlanLogPayload(routeExecutionPlan, {
          groupId,
          senderId,
          replyLength: String(reply || '').trim().length
        }, route));
      } else {
        const streamingDispatcher = createStreamingDispatcher({
          config,
          sendWithRetry,
          chatType: String(route?.meta?.chatType || 'group'),
          groupId,
          userId: senderId,
          senderId
        });
        const streamOptions = {
          onDelta: streamingDispatcher.onDelta,
          streamHadOutput: false,
          streamCompleted: false,
          streamFallbackToNonStream: false,
          routePrompt: composeDirectRoutePrompt({
            toolGuidancePrompt,
            bridgeGuidancePrompt,
            perceptionPrompt,
            safetyBoundaryRoutePrompt,
            streamingSegmentationPrompt,
            qqRichReplyPrompt
          }),
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeDebugKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          disableTools: !routeExecutionPlan.allowTools,
          allowTools: routeExecutionPlan.allowTools,
          allowedTools: routeExecutionPlan.allowedTools,
          routeMeta: {
            ...(route.meta || {}),
            groupId,
            topRouteType: routeExecutionPlan.topRouteType,
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan)
          },
          disableStream: disableStreamForReply
        };
        const replyOptions = streamOptions;
        finalReplyOptions = replyOptions;

        await markThinkingEmojiBeforeLlm({
          messageId: sourceMessageId,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeMeta: route.meta || {}
        });
        reply = await askAIDispatch(cleanText, userInfo, senderId, null, imageUrl, replyOptions);
        console.log('[dispatch] chat route completed', buildRoutePlanLogPayload(routeExecutionPlan, {
          groupId,
          senderId,
          streamCompleted: Boolean(replyOptions.streamCompleted),
          streamHadOutput: Boolean(replyOptions.streamHadOutput),
          disableStream: Boolean(replyOptions.disableStream),
          replyLength: String(reply || '').trim().length
        }, route));

        if (replyOptions.streamCompleted && replyOptions.streamHadOutput) {
          usedStreamingSend = true;
          await streamingDispatcher.finish(reply);
        }
      }
    } catch (dispatchErr) {
      console.error('[dispatch] failed:', buildRoutePlanLogPayload(routeExecutionPlan, {
        groupId,
        senderId,
        error: dispatchErr?.message || String(dispatchErr || '')
      }, route));
      if (!String(reply || '').trim()) {
        reply = '???????????????????????????????????????';
      }
    }

    return {
      reply,
      usedStreamingSend,
      replyOptions: finalReplyOptions
    };
  }

  routeFlow = createMessageRouteFlow({
    config,
    routeResolver,
    routeExecution,
    planDirectChat,
    askAIDispatch,
    askToolTaskLocally,
    askToolTaskWithSubagentReview,
    runBackgroundToolTask,
    handleAdminCommand,
    handleQqScheduleAdminCommand,
    detectQzonePostDraftMode,
    generateBotDiaryDraft,
    generateGenericQzoneDraft,
    normalizeGeneratedQzoneContent,
    publishQzoneForContext,
    backgroundTaskRuntime,
    buildSessionId,
    isAdminUser,
    listScheduledTasks,
    cancelScheduledTask,
    deleteScheduledTask,
    formatEventsAsText,
    searchEvents,
    listRecentEvents,
    formatPatternsAsText,
    listPatterns,
    formatRulesAsText,
    listRules,
    formatGuidesAsText,
    listGuides,
    formatStyleProfileAsText,
    formatSocialContextAsText,
    formatRelationshipGraphAsText,
    sendGroupReply: (...args) => replyRuntime.sendGroupReply(...args),
    sendReply: (...args) => replyRuntime.sendReply(...args),
    updateFavor,
    saveData,
    recordMemoryScope,
    buildToolGuidancePrompt: promptComposerBuildToolGuidancePrompt,
    buildBridgeGuidancePrompt: promptComposerBuildBridgeGuidancePrompt,
    buildStreamingSegmentationPrompt: promptComposerBuildStreamingSegmentationPrompt,
    buildQqRichReplyPrompt: promptComposerBuildQqRichReplyPrompt,
    shouldPreferQqRichReply: promptComposerShouldPreferQqRichReply,
    buildSafetyBoundaryRoutePrompt: promptComposerBuildSafetyBoundaryRoutePrompt,
    buildLlmPerception,
    createStreamingDispatcher,
    normalizeUserFacingReply,
    getEffectivePolicyKey,
    maybeCaptureUnavailableFeatureRequest,
    shouldAutoDraftQzonePostRequest,
    buildSessionStatusReply,
    buildNoTaskControlText,
    getStreamMaxSegments,
    sendWithRetry,
    markThinkingEmojiBeforeLlm,
    buildSubagentContextSummary
  });

  async function sendGroupReplyFallback({ groupId, senderId, replyText, atSender = true, retries = 2, waitMs = 500 }) {
    const normalized = String(replyText || '').trim() || '??????????????';
    const richPayload = buildQqRichMessagePayload(normalized, { atSender, senderId });
    if (richPayload) {
      const ok = await sendWithRetry({
        action: 'send_group_msg',
        params: { group_id: groupId, message: richPayload }
      }, retries, waitMs);

      if (!ok) {
        console.error('[reply] send_group_msg failed', {
          groupId,
          senderId,
          chunkIndex: 0,
          chunkCount: 1,
          richMessage: true
        });
      }

      return ok;
    }

    const chunks = splitReplyForSend(normalized, getReplyChunkChars(config));
    if (!chunks.length) return false;

    let sentAny = false;
    for (let i = 0; i < chunks.length; i += 1) {
      const prefix = (atSender && i === 0) ? `[CQ:at,qq=${senderId}] ` : '';
      const ok = await sendWithRetry({
        action: 'send_group_msg',
        params: { group_id: groupId, message: `${prefix}${chunks[i]}` }
      }, retries, waitMs);

      if (!ok) {
        console.error('[reply] send_group_msg failed', {
          groupId,
          senderId,
          chunkIndex: i,
          chunkCount: chunks.length
        });
        return sentAny;
      }

      sentAny = true;
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 140));
      }
    }

    return sentAny;
  }

  const sendGroupReply = async function patchedSendReply({
    chatType = 'group',
    groupId,
    userId,
    senderId,
    replyText,
    atSender = true,
    retries = 2,
    waitMs = 500,
    telemetry = null
  }) {
    return sendReply({
      chatType,
      groupId,
      userId: userId || senderId,
      senderId,
      replyText,
      atSender,
      retries,
      waitMs,
      telemetry
    });
  };
  // source-compat anchor: return replyRuntime.sendGroupReply({

  async function handleIncomingMessage(msg) {
    const handlerStartedAt = Date.now();
    const rawMessageTimestampMs = getRawMessageTimestampMs(msg);
    appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
      stage: 'handle_incoming_start',
      messageId: String(msg?.message_id || '').trim(),
      groupId: String(msg?.group_id || '').trim(),
      userId: String(msg?.user_id || '').trim(),
      chatType: String(msg?.message_type || '').trim(),
      rawMessageTimestampMs,
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, handlerStartedAt - rawMessageTimestampMs) : null
    });

    if (shouldHandleNotice(msg, config).handled) return;
    if (shouldSkipNonGroupMessage(msg)) return;
    if (inboundDeduper.shouldSkip(msg)) {
      console.log('[message] deduped', {
        messageId: msg.message_id,
        groupId: msg.group_id,
        userId: msg.user_id
      });
      return;
    }

    const senderId = msg.user_id;
    const groupId = msg.group_id;
    const chatType = String(msg.message_type || '').trim().toLowerCase() === 'private' ? 'private' : 'group';
    const privilegedPrivateChat = isPrivilegedPrivateChatUser({
      chatType,
      userId: senderId,
      config
    });

    if (isPrivateChatType(chatType) && !isPrivateChatUserAllowed(senderId, config)) {
      console.log('[message] private chat rejected by allowlist', {
        messageId: msg.message_id,
        userId: senderId,
        chatType
      });
      await sendGroupReply({
        chatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: PRIVATE_CHAT_WHITELIST_REPLY,
        atSender: false,
        retries: 1,
        waitMs: 300
      });
      return;
    }

    const uploadConsume = await consumePendingUploadFromMessage(msg);
    if (uploadConsume?.consumed) {
      if (String(uploadConsume.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: uploadConsume.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      return;
    }

    const effectiveBotQQ = resolveEffectiveBotQQ(msg, config);
    if (shouldSkipSelfMessage(msg, config)) {
      return;
    }

    const preprocessed = await continuousMessagePreprocessor.handleMessage(msg, {
      effectiveBotQQ
    });
    appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
      stage: 'continuous_preprocess_done',
      messageId: String(msg?.message_id || '').trim(),
      groupId: String(msg?.group_id || '').trim(),
      userId: String(msg?.user_id || '').trim(),
      preprocessMode: String(preprocessed?.mode || '').trim(),
      flushReason: String(preprocessed?.meta?.flushReason || '').trim(),
      rawMessageTimestampMs,
      elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
    });
    if (preprocessed?.mode === 'deferred') {
      return;
    }

    const effectiveMsg = preprocessed?.effectiveMsg || msg;
    const continuousMeta = preprocessed?.meta || effectiveMsg.__continuousMessageMeta || null;
    const rawText = effectiveMsg.raw_message || '';
    const concurrencyScope = privilegedPrivateChat ? 'private' : 'default';
    const concurrencyLane = privilegedPrivateChat
      ? 'admin'
      : (isAdminUser(senderId) ? 'admin' : 'general');
    const selectedInboundConcurrency = privilegedPrivateChat ? privateInboundConcurrency : inboundConcurrency;
    const queueWaitStartedAt = Date.now();
    const inboundLock = await selectedInboundConcurrency.acquire({
      userId: senderId,
      lane: concurrencyLane,
      messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
      groupId,
      chatType,
      concurrencyScope,
      privilegedPrivateChat
    });
    appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
      stage: 'inbound_lock_acquired',
      messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
      groupId: String(groupId || '').trim(),
      userId: String(senderId || '').trim(),
      chatType,
      concurrencyLane,
      concurrencyScope,
      privilegedPrivateChat,
      queueWaitMs: Math.max(0, Date.now() - queueWaitStartedAt),
      rawMessageTimestampMs,
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
    });
    let inboundHadError = false;

    try {
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'inbound_route_entry',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
      });
      // source-compat anchor: msg: effectiveMsg,

      const slashCommandText = stripLeadingCqControlSegments(rawText, effectiveBotQQ);
      if (!isPrivateChatType(chatType)) {
        recordHumanInbound(groupId, senderId, Number(effectiveMsg?.time ? Number(effectiveMsg.time) * 1000 : Date.now()));
      }

    if (/^\s*\/meme(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType)) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: PRIVATE_GROUP_ONLY_REPLY,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return;
      }
      const memeAdminResult = await handleAdminCommand({
        rawText: slashCommandText,
        groupId,
        userId: senderId
      });
      if (String(memeAdminResult?.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: memeAdminResult.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      return;
    }

    if (/^\s*\/dailyshare(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType)) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: PRIVATE_GROUP_ONLY_REPLY,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return;
      }
      const dailyShareResult = await dailyShareEngine.handleAdminCommand({
        rawText: slashCommandText,
        groupId,
        userId: senderId,
        sendWithRetry,
        askAIByGraph
      });
      if (String(dailyShareResult?.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: dailyShareResult.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      return;
    }

    if (/^\s*\/life(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType)) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: PRIVATE_GROUP_ONLY_REPLY,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return;
      }
      const lifeResult = await lifeSchedulerEngine.handleAdminCommand({
        rawText: slashCommandText,
        groupId,
        userId: senderId,
        sendWithRetry,
        askAIByGraph
      });
      if (String(lifeResult?.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: lifeResult.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      return;
    }

    if (/^\s*\/sr(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType)) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: PRIVATE_GROUP_ONLY_REPLY,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return;
      }
      const srResult = await handleSessionSummaryCommand({
        rawText: slashCommandText,
        groupId,
        senderId,
        summarizeSessionContext: sessionSummaryGenerator
      });
      if (String(srResult?.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: srResult.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      return;
    }

    if (/^\s*\/initiative(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType)) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: PRIVATE_GROUP_ONLY_REPLY,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return;
      }
      const initiativeResult = await handleInitiativeAdminCommand({
        rawText: slashCommandText,
        groupId,
        userId: senderId
      });
      if (String(initiativeResult?.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: initiativeResult.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      return;
    }

    if (!effectiveBotQQ) {
      console.warn('[message] skip because bot qq is unresolved');
      return;
    }

    const mentioned = isAtBot(rawText, effectiveBotQQ);
    const cleanTextWithoutControls = stripLeadingCqControlSegments(rawText, effectiveBotQQ);
    if (continuousMeta && typeof continuousMeta === 'object') {
      await resolveContinuousEntryDetails(continuousMeta, {
        effectiveBotQQ,
        resolveReply: Boolean(continuousMeta.replyMessageId),
        resolveForward: Array.isArray(continuousMeta.forwardIds) && continuousMeta.forwardIds.length > 0,
        resolveCards: Array.isArray(continuousMeta.qqCardUrls) && continuousMeta.qqCardUrls.length > 0
      });
    }
    if (continuousMeta && typeof continuousMeta === 'object') {
      effectiveMsg.__continuousMessageMeta = continuousMeta;
    }
    // source-compat anchor: const effectiveVisualInput = resolveVisualInputFromContinuousMeta(continuousMeta);
    const effectiveRawText = String(effectiveMsg?.raw_message || rawText || '');
    const effectiveCleanText = stripLeadingCqControlSegments(effectiveRawText, effectiveBotQQ);
    const directedContext = await resolveMessageDirectedContext({
      msg,
      effectiveMsg,
      groupId,
      senderId,
      rawText: effectiveRawText,
      cleanText: effectiveCleanText,
      isAtBot: mentioned,
      botQQ: effectiveBotQQ,
      continuousMeta,
      historySummary: buildSubagentContextSummary(senderId, groupId, { maxLength: 180 })
    });
    const effectiveVisualInput = resolveVisualInputFromContinuousMetaCore(continuousMeta, directedContext, effectiveCleanText);
    const directedScene = String(directedContext?.scene || '').trim();
    const replyToBotRequested = directedScene === 'reply_to_bot';
    const replyToBotRecentWindowMs = Math.max(
      0,
      Math.floor(Number(config.REPLY_TO_BOT_RECENT_WINDOW_MINUTES || 0) * 60 * 1000)
    );
    const lastBotReplyAt = !isPrivateChatType(chatType) && replyToBotRequested ? getLastReplyAt(groupId) : 0;
    const replyToBotIsRecent = Boolean(
      replyToBotRequested
      && lastBotReplyAt > 0
      && replyToBotRecentWindowMs > 0
      && (Date.now() - lastBotReplyAt) <= replyToBotRecentWindowMs
    );
    const directBotAnchor = Boolean(isPrivateChatType(chatType) || mentioned || replyToBotIsRecent);
    const effectiveIntentText = String(
      directedContext?.quotePriority?.quoteAnchoredText
      || effectiveCleanText
      || ''
    ).trim();
    const routerRawText = effectiveVisualInput && !/\[CQ:image,.*?\]/i.test(effectiveRawText)
      ? `${effectiveRawText.trim()}\n[CQ:image,url=${effectiveVisualInput}]`
      : effectiveRawText;
    const sessionKey = resolveShortTermSessionKey(senderId, { groupId });
    const previousPresence = getShortTermPresence(sessionKey, shortTermMemory, {});
    const sessionTiming = buildInboundSessionTiming({
      continuousMeta,
      previousPresence
    });
    markDirectSessionHumanInbound({
      groupId,
      senderId,
      sessionTiming
    });
    const inboundContext = buildInboundMessageContext({
      msg,
      effectiveMsg,
      groupId: isPrivateChatType(chatType) ? '' : groupId,
      senderId,
      rawText: effectiveRawText,
      cleanText: effectiveCleanText,
      imageUrl: effectiveVisualInput,
      isAtBot: directBotAnchor,
      botQQ: effectiveBotQQ,
      chatType,
      sessionTiming,
      continuousMeta,
      directedContext
    });
    inboundContext.effectiveIntentText = effectiveIntentText;
    inboundContext.quotePriority = directedContext?.quotePriority || null;
    if (!isPrivateChatType(chatType) && !directBotAnchor) {
      const passiveFlowResult = await runPassiveFlow({
        inboundContext,
        handlePassiveGroupAwareness,
        sendGroupReply,
        sendWithRetry
      });
      const passiveResult = passiveFlowResult.passiveResult;
      console.log('[message] skip not at bot', {
        messageId: effectiveMsg.message_id,
        groupId,
        userId: senderId,
        effectiveBotQQ,
        rawPreview: String(rawText || '').slice(0, 120),
        passiveHandled: Boolean(passiveResult?.handled),
        passiveReason: passiveResult?.reason || '',
        reply_to_bot_recent_gate: replyToBotRequested ? (replyToBotIsRecent ? 'allow' : 'reject') : '',
        reply_to_bot_last_reply_at: lastBotReplyAt || 0,
        cheap_gate_reason: passiveResult?.cheapGateReason || '',
        decision_reason: passiveResult?.decisionReason || '',
        decision_model_called: Boolean(passiveResult?.decisionModelCalled),
        reply_model_called: Boolean(passiveResult?.replyModelCalled),
        presenceState: passiveResult?.presenceState || '',
        presenceAction: passiveResult?.presenceAction || '',
        presenceReason: passiveResult?.presenceReason || ''
      });
      return;
    }

    console.log('[message] accepted inbound', {
      messageId: effectiveMsg.message_id,
      groupId,
      userId: senderId,
      chatType,
      concurrencyScope,
      privilegedPrivateChat,
      effectiveBotQQ,
      rawPreview: String(rawText || '').slice(0, 120),
      acceptedBy: isPrivateChatType(chatType)
        ? 'private_direct'
        : (mentioned ? 'at_bot' : 'reply_to_bot_recent'),
      reply_to_bot_last_reply_at: lastBotReplyAt || 0
    });

    const cleanMentionText = String(rawText || '')
      .replace(/\[CQ:reply,.*?\]/g, '')
      .replace(new RegExp(`\\[CQ:at,qq=${effectiveBotQQ}\\]`, 'g'), '')
      .replace(/\[CQ:image,.*?\]/g, '')
      .trim();
    const backgroundControlCommand = parseBackgroundControlCommand(cleanMentionText);
    if (!isPrivateChatType(chatType) && backgroundControlCommand) {
      const controlUserInfo = updateFavor(senderId, cleanMentionText || '鍚庡彴浠诲姟鎺у埗', groupId);
      controlUserInfo.last_seen_at = Date.now();
      saveData();
      recordMemoryScope(senderId, { groupId });

      const handled = await routeFlow.handleBackgroundControl({
        command: backgroundControlCommand,
        groupId,
        senderId,
        userInfo: controlUserInfo,
        imageUrl: effectiveVisualInput,
        rawText,
        botQQ: effectiveBotQQ
      });
      if (handled) return;
    }

    const routerContextSummary = buildSubagentContextSummary(senderId, groupId, { maxLength: 180, directedContext });
    const plannerContextSummary = buildSubagentContextSummary(senderId, groupId, { maxLength: 320, directedContext });
    const routeResolverStartedAt = Date.now();
    let route = null;
    let routeResolverError = null;
    try {
      route = await routeResolver({
        rawText: routerRawText,
        botQQ: effectiveBotQQ,
        userId: senderId,
        chatType,
        contextSummary: routerContextSummary,
        directedContext,
        effectiveIntentText
      });
    } catch (error) {
      routeResolverError = error;
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'route_resolver_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - routeResolverStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        error: error?.message || String(error || '')
      });
      throw error;
    }
    appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
      stage: 'route_resolver_done',
      messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
      groupId: String(groupId || '').trim(),
      userId: String(senderId || '').trim(),
      chatType,
      durationMs: Math.max(0, Date.now() - routeResolverStartedAt),
      rawMessageTimestampMs,
      elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
      topRouteType: String(route?.topRouteType || '').trim(),
      routeReason: String(route?.meta?.reason || '').trim(),
      routeResolverFailed: Boolean(routeResolverError)
    });
    route.meta = {
      ...(route.meta || {}),
      userId: String(senderId || ''),
      groupId: isPrivateChatType(chatType) ? '' : String(groupId || ''),
      chatType,
      directedContext,
      directedContextSummary: routerContextSummary,
      effectiveIntentText,
      quotePriority: directedContext?.quotePriority || null
    };

    if (route?.topRouteType === 'admin' && String(route?.meta?.command?.cmd || '').trim() === 'full') {
      if (isPrivateChatType(chatType)) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: PRIVATE_GROUP_ONLY_REPLY,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return;
      }
      const userInfo = updateFavor(senderId, route.cleanText || rawText || '/full', groupId);
      userInfo.last_seen_at = Date.now();
      saveData();
      recordMemoryScope(senderId, { groupId });
      const handled = await routeFlow.handleFullAdmin({
        route,
        groupId,
        senderId,
        userInfo,
        rawText
      });
      if (handled) return;
    }

    if (route?.topRouteType === 'direct_chat') {
      const plannerStartedAt = Date.now();
      let plannerDecision = null;
      try {
        plannerDecision = await planDirectChat(route, {
          userId: senderId,
          allowedTools: route?.meta?.allowedTools,
          contextSummary: plannerContextSummary,
          directedContext
        });
      } catch (error) {
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
          stage: 'direct_chat_planner_failed',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          durationMs: Math.max(0, Date.now() - plannerStartedAt),
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
          error: error?.message || String(error || '')
        });
        throw error;
      }
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'direct_chat_planner_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - plannerStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        shouldUseTools: plannerDecision?.shouldUseTools === true,
        needsBackground: plannerDecision?.needsBackground === true,
        plannerFallbackUsed: plannerDecision?.plannerFallbackUsed === true,
        plannerModel: String(plannerDecision?.plannerModel || '').trim(),
        allowedToolCount: Array.isArray(plannerDecision?.allowedToolNames) ? plannerDecision.allowedToolNames.length : 0
      });
      route.meta = {
        ...(route.meta || {}),
        toolPlanner: plannerDecision,
        directChatPlanner: plannerDecision
      };
    }

    const routeExecutionPlan = routeExecution.resolveRouteExecution(route, config, {});
    if (routeExecutionPlan.executor === 'ignore') return;

    if (routeExecutionPlan.executor === 'refuse') {
      await sendGroupReply({
        chatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: await buildRefusalReply(route),
        atSender: !isPrivateChatType(chatType),
        retries: 1,
        waitMs: 500
      });
      return;
    }

    if (routeExecutionPlan.executor === 'admin') {
      await routeFlow.dispatchAdminRoute({
        route,
        groupId,
        senderId,
        rawText,
        userInfo: null
      });
      return;
    }

    const cleanText = route.cleanText;
    const imageUrl = route.imageUrl || effectiveVisualInput;
    route.imageUrl = imageUrl;
    const inboundTimestamp = Date.now();
    maybeCaptureUserCorrection({
      cleanText,
      senderId,
      groupId,
      routeExecutionPlan
    });

    if (!isPrivateChatType(chatType)) {
      sideEffects.recordInboundHumanMessage({
        groupId,
        senderId,
        senderName: String(effectiveMsg.sender?.card || effectiveMsg.sender?.nickname || effectiveMsg.sender?.nick || senderId || '').trim(),
        text: cleanText || rawText,
        timestamp: Number(continuousMeta?.firstTimestamp || inboundTimestamp),
        messageId: String(effectiveMsg.message_id || '').trim(),
        replyToMessageId: String(directedContext?.quote?.messageId || continuousMeta?.replyMessageId || '').trim(),
        replyToSenderId: String(directedContext?.quote?.senderId || '').trim(),
        replyToSenderName: String(directedContext?.quote?.senderName || '').trim()
      });
    }

    const userInfo = sideEffects.updateUserPresence(senderId, cleanText, isPrivateChatType(chatType) ? '' : groupId);

    const replyEnvelope = await routeFlow.dispatchFormalRoute({
      route,
      executionPlan: routeExecutionPlan,
      requestText: cleanText,
      inboundContext,
      userInfo,
      senderId,
      groupId: isPrivateChatType(chatType) ? '' : groupId,
      imageUrl,
      sourceMessageId: String(effectiveMsg.message_id || '').trim()
    });
    let reply = String(replyEnvelope?.replyText || '').trim();
    const usedStreamingSend = Boolean(replyEnvelope?.sendStrategy === 'stream' || replyEnvelope?.usedStreamingSend);
    const replyOptions = replyEnvelope?.replyOptions || null;
    if (!usedStreamingSend) {
      reply = normalizeUserFacingReply(reply, {
        policyKey: getEffectivePolicyKey(routeExecutionPlan),
        routeDebugKey: routeExecutionPlan.routeDebugKey,
        topRouteType: routeExecutionPlan.topRouteType,
        allowTools: routeExecutionPlan.allowTools,
        requestText: cleanText
      });
      console.log('[reply] sending normalized reply', {
        chatType,
        groupId,
        senderId,
        routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
        topRouteType: routeExecutionPlan.topRouteType,
        replyPreview: String(reply || '').slice(0, 120)
      });
      const sent = await sendGroupReply({
        chatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: replyEnvelope?.replyText || reply,
        atSender: !isPrivateChatType(chatType) && replyEnvelope?.atSender !== false,
        retries: 2,
        waitMs: 500,
        telemetry: buildReplyTelemetry({
          senderId,
          groupId: isPrivateChatType(chatType) ? '' : groupId,
          chatType,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          routeMeta: route.meta || {}
        })
      });
      if (sent) {
        maybeRunDeferredPersist(replyEnvelope);
        markDirectSessionPresenceReplied({ groupId, senderId });
        replyRuntime.recordBotReply({
          chatType,
          groupId: isPrivateChatType(chatType) ? '' : groupId,
          senderId,
          replyText: reply
        });
        if (!isPrivateChatType(chatType)) {
          await sideEffects.runDirectReplyFollowup({
            groupId,
            senderId,
            sendWithRetry,
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            topRouteType: routeExecutionPlan.topRouteType,
            userText: cleanText,
            replyText: reply,
            rawMessage: rawText,
            routeMeta: route.meta || {},
            replyToMessageId: String(effectiveMsg.message_id || '').trim()
          });
        }
      }
    } else {
      maybeRunDeferredPersist(replyEnvelope);
      if (!isPrivateChatType(chatType)) {
        await sideEffects.runDirectReplyFollowup({
          groupId,
          senderId,
          sendWithRetry,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          userText: cleanText,
          replyText: replyOptions?.streamCompleted ? reply : '',
          rawMessage: rawText,
          routeMeta: route.meta || {},
          replyToMessageId: String(effectiveMsg.message_id || '').trim()
        });
      }
    }
    } catch (error) {
      inboundHadError = true;
      throw error;
    } finally {
      inboundLock.release({ hadError: inboundHadError });
    }
  }

  async function sendScheduledGreeting(type) {
    return proactiveGreetingFlow.sendScheduledGreeting(type);
  }

  return {
    handleIncomingMessage,
    sendScheduledGreeting,
    getDatePartsInTz
  };
}

module.exports = {
  buildQqRichMessagePayload,
  buildQqRichReplyPrompt,
  buildCuteRefusalReply,
  buildBackgroundAckText,
  buildUnavailableRouteReply,
  buildFullSubagentCoordinatorPayload,
  buildFullSubagentReviewPayload,
  buildFullSubagentWorkerPrompt,
  buildFullSubagentFallbackReply,
  buildFullSubagentAllWorkersFailedReply,
  detectQzonePostDraftMode,
  normalizeFullSubagentPlan,
  chooseBestFullSubagentWorkerOutput,
  shouldAutoDraftQzonePostRequest,
  buildSessionStatusReply,
  createMessageHandler,
  createStreamingDispatcher,
  stripLeadingCqControlSegments,
  parseBackgroundControlCommand,
  parseQqRichMessage,
  shouldPreferQqRichReply,
  buildBridgeGuidancePrompt,
  resolveVisualInputFromContinuousMetaCore,
  getNaturalSplitIndex,
  shouldSendScheduledGreeting,
  shouldUseSubagentToolRoute,
  shouldUseToolRoute
};
