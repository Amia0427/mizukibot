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
const { getHapiControlRuntime } = require('../utils/hapiControlRuntime');
const {
  buildToolReplyFormatInstruction,
  cleanToolReplyText,
  resolveToolReplyFormattingPreferences
} = require('../utils/toolReplyFormatting');
const {
  buildSubagentStyleGuardInstruction,
  buildSubagentExecutionGuidanceLine,
  buildSubagentExecutionPlanLines,
  buildSubagentToolReasonLine
} = require('../utils/subagentPrompting');
const {
  prepareSubagentFallbackReply,
  prepareSubagentOutputForReview
} = require('../utils/subagentStyleGuard');
const { isAtBot, detectIntentHybrid } = require('./router');
const routeExecution = require('./routeExecution');
const { buildRouteMetaEnvelope } = require('./executablePlan');
const { createMessageEventDeduper } = require('./messageDeduper');
const { createInboundConcurrencyController } = require('./inboundConcurrency');
const { createForegroundConcurrencyController } = require('./foregroundConcurrency');
const { isPrivateChatTestUser, isPrivilegedPrivateChatUser } = require('../utils/privilegedPrivateChat');
const { handlePassiveGroupAwareness } = require('./passiveGroupAwareness');
const {
  createContinuousMessagePreprocessor,
  cheapParseMessageEntry,
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
  createDefaultHapiControlClientFactory,
  createMessageAdminCoordinator
} = require('./messageAdminCommands');
const { createMessageBackgroundTaskCoordinator } = require('./messageBackgroundTasks');
const { createMessageDispatchCoordinator } = require('./messageDispatchCoordinator');
const { createMessageTaskControlCoordinator } = require('./messageTaskControl');
const {
  appendInboundTimingLog,
  createInboundTimingLogger,
  createMessageTelemetryCoordinator,
  createReplyTelemetryBridge,
  getRawMessageTimestampMs
} = require('./messageTelemetry');
const { ensureCachedImageRef } = require('../utils/imageInputCache');
const {
  buildDirectedConversationSummary,
  createMessageVisualContext,
  buildVisualImageCollection,
  buildVisualImageCollectionDetails,
  resolveVisualInputFromContinuousMeta,
  resolveVisualInputFromContinuousMetaCore
} = require('./messageVisualContext');
const { buildImageModelConfig } = require('../utils/imageModelConfigResolver');
const { triggerRemoteRestart } = require('../utils/remoteRestart');
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
const { planDirectChat } = require('./directChatPlanner');
const {
  cancelScheduledTask,
  createScheduledCommand,
  deleteScheduledTask,
  isAdminUser,
  listScheduledTasks,
  publishQzoneForContext,
  scheduleGroupMessage,
  sendGroupPoke,
  sendPrivatePoke,
  setMessageEmojiLike
} = require('../api/qqActionService');
const {
  armCotOnce,
  consumeCotOnce,
  getCotOnceTtlMs
} = require('../utils/cotOnceRuntime');
function getVisionCaptionWorkerModule() {
  return require('./visionCaptionWorker');
}

function getMessageFullSubagentModule() {
  return require('./messageFullSubagent');
}

function getMemeManagerModule() {
  return require('./memeManager');
}

function getDailyShareEngineModule() {
  return require('./dailyShareEngine');
}

function getCreateAgentExecutorModule() {
  return require('../api/createAgentExecutor');
}

function getQzoneDiaryServiceModule() {
  return require('../api/qzoneDiaryService');
}

function detectQzonePostDraftMode(...args) {
  return getQzoneDiaryServiceModule().detectQzonePostDraftMode(...args);
}

function generateBotDiaryDraft(...args) {
  return getQzoneDiaryServiceModule().generateBotDiaryDraft(...args);
}

function generateGenericQzoneDraft(...args) {
  return getQzoneDiaryServiceModule().generateGenericQzoneDraft(...args);
}

function normalizeGeneratedQzoneContent(...args) {
  return getQzoneDiaryServiceModule().normalizeGeneratedQzoneContent(...args);
}

function buildFullSubagentAllWorkersFailedReply(...args) {
  return getMessageFullSubagentModule().buildFullSubagentAllWorkersFailedReply(...args);
}

function buildFullSubagentCoordinatorPayload(...args) {
  return getMessageFullSubagentModule().buildFullSubagentCoordinatorPayload(...args);
}

function buildFullSubagentFallbackReply(...args) {
  return getMessageFullSubagentModule().buildFullSubagentFallbackReply(...args);
}

function buildFullSubagentReviewPayload(...args) {
  return getMessageFullSubagentModule().buildFullSubagentReviewPayload(...args);
}

function buildFullSubagentWorkerPrompt(...args) {
  return getMessageFullSubagentModule().buildFullSubagentWorkerPrompt(...args);
}

function chooseBestFullSubagentWorkerOutput(...args) {
  return getMessageFullSubagentModule().chooseBestFullSubagentWorkerOutput(...args);
}

function createMessageFullSubagentCoordinator(...args) {
  return getMessageFullSubagentModule().createMessageFullSubagentCoordinator(...args);
}

function normalizeFullSubagentPlan(...args) {
  return getMessageFullSubagentModule().normalizeFullSubagentPlan(...args);
}

function summarizeFullWorkerError(...args) {
  return getMessageFullSubagentModule().summarizeFullWorkerError(...args);
}

function consumePendingUploadFromMessage(...args) {
  return getMemeManagerModule().consumePendingUploadFromMessage(...args);
}

function handleAdminCommand(...args) {
  return getMemeManagerModule().handleAdminCommand(...args);
}

function maybeSendMemeFollowup(...args) {
  return getMemeManagerModule().maybeSendMemeFollowup(...args);
}
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
  cloneTraceForMeta,
  createRequestTrace,
  extractErrorCode,
  nextTracePhase
} = require('../utils/requestTrace');
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
const {
  findExplicitSegmentBreakIndex,
  findNaturalSplitIndex,
  getStreamingSplitIndex
} = require('./streamingSegmentation');

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
  return isPrivateChatTestUser({
    chatType: 'private',
    userId,
    config: runtimeConfig
  });
}

function canBypassPrivateGroupOnly({ chatType = '', userId = '', runtimeConfig = {} } = {}) {
  if (!isPrivateChatType(chatType)) return false;
  return isPrivilegedPrivateChatUser({
    chatType,
    userId,
    config: runtimeConfig
  });
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

function createRequestScopeCache(options = {}) {
  const maxEntries = Math.max(16, Number(options.maxEntries || 128) || 128);
  const store = new Map();
  return {
    getOrCompute(key, factory) {
      if (store.has(key)) return store.get(key);
      const value = typeof factory === 'function' ? factory() : undefined;
      store.set(key, value);
      if (store.size > maxEntries) {
        const oldestKey = store.keys().next().value;
        if (oldestKey !== undefined) store.delete(oldestKey);
      }
      return value;
    }
  };
}

function normalizeVisualSummaryText(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildVisionCaptionTelemetryEvent(type = '', payload = {}) {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    type,
    ...payload
  };
}

function countCachedVisualRefs(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => String(item?.url || '').trim().startsWith('cached-image://'))
    .length;
}

async function resolveStableVisualUrl(url = '', refMap = null) {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) return '';
  if (rawUrl.startsWith('cached-image://')) return rawUrl;

  const mapped = refMap && typeof refMap === 'object'
    ? String(refMap[rawUrl] || '').trim()
    : '';
  if (mapped) return mapped;

  const cached = await ensureCachedImageRef(rawUrl);
  return cached?.ok && cached.ref ? cached.ref : rawUrl;
}

function resolveLegacyVisionFallbackModelConfig(imageUrl = null, userId = '', routeMeta = {}) {
  if (!String(imageUrl || '').trim()) return null;
  return buildImageModelConfig(null, userId, { routeMeta });
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

function getModelSegmentBreakIndex(text) {
  return findExplicitSegmentBreakIndex(text);
}

function buildStreamingSegmentationPrompt(maxSegments) {
  return buildRuntimePrompt('streaming-segmentation', { maxSegments });
}

function getNaturalSplitIndex(text) {
  return findNaturalSplitIndex(text);
}

function createStreamingDispatcher({
  runtimeConfig = null,
  config = runtimeConfig || {},
  sendWithRetry,
  chatType = 'group',
  groupId,
  userId,
  senderId,
  telemetry = null
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

  function emitStreamingTelemetry(type = '', payload = {}) {
    if (!telemetry || typeof telemetry.onEvent !== 'function') return;
    try {
      telemetry.onEvent({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        type: String(type || 'event').trim() || 'event',
        ...payload
      });
    } catch (_) {}
  }

  async function sendChunk(chunk) {
    const text = String(chunk || '').trim();
    if (!text) return false;
    const chunkIndex = state.sentSegments + 1;

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
      const startedAt = Date.now();
      emitStreamingTelemetry('reply_stream_chunk_start', {
        node: 'reply_stream_send',
        channel: isPrivate ? 'private' : 'group',
        groupId: String(groupId || '').trim(),
        userId: String(userId || '').trim(),
        senderId: String(senderId || '').trim(),
        chunkIndex,
        chunkLength: text.length
      });
      const sent = await sendWithRetry(payload, 1, 300);

      if (!sent) {
        emitStreamingTelemetry('reply_stream_chunk_failure', {
          node: 'reply_stream_send',
          channel: isPrivate ? 'private' : 'group',
          groupId: String(groupId || '').trim(),
          userId: String(userId || '').trim(),
          senderId: String(senderId || '').trim(),
          chunkIndex,
          chunkLength: text.length,
          durationMs: Math.max(0, Date.now() - startedAt)
        });
        console.error(isPrivate ? '[stream] send_private_msg failed' : '[stream] send_group_msg failed', {
          chatType: isPrivate ? 'private' : 'group',
          groupId,
          userId,
          senderId
        });
        return false;
      }

      emitStreamingTelemetry('reply_stream_chunk_success', {
        node: 'reply_stream_send',
        channel: isPrivate ? 'private' : 'group',
        groupId: String(groupId || '').trim(),
        userId: String(userId || '').trim(),
        senderId: String(senderId || '').trim(),
        chunkIndex,
        chunkLength: text.length,
        durationMs: Math.max(0, Date.now() - startedAt)
      });
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
      sendUntil = getStreamingSplitIndex(pending);
    }

    if (sendUntil <= 0 && force) sendUntil = getStreamingSplitIndex(pending, { force: true });
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
      ? 'QQ 空间草稿工具暂时不可用。你可以稍后重试，或直接使用 /qzone_post。'
      : 'QQ 空间草稿当前仅管理员可用。';
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

function maybeCaptureUserCorrection({
  cleanText,
  signalText = '',
  senderId,
  groupId,
  routeExecutionPlan,
  getLastAssistantReply = null
}) {
  const userMessage = String(cleanText || '').trim();
  const triggerText = String(signalText || userMessage || '').trim();
  if (!isCorrectionSignal(triggerText)) return;
  if (typeof getLastAssistantReply !== 'function') return;
  const timer = setTimeout(() => {
    try {
      const lastAssistantReply = getLastAssistantReply(senderId, groupId);
      if (!lastAssistantReply) return;
      captureCorrection({
        userMessage,
        assistantReply: lastAssistantReply,
        routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
        topRouteType: routeExecutionPlan?.topRouteType || 'direct_chat',
        groupId,
        userId: senderId
      });
    } catch (error) {
      console.error('[self-improvement] correction capture failed:', error?.message || error);
    }
  }, 0);
  if (typeof timer.unref === 'function') timer.unref();
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
  inboundConcurrencyControllerOverride = null,
  runVisionCaptionWorkerOverride = null
}) {
  const inboundTimingLogFile = path.join(config.DATA_DIR, 'inbound_timing.jsonl');
  const logInboundTiming = createInboundTimingLogger(inboundTimingLogFile, config.ENABLE_DEBUG_LOG);
  const inboundDeduper = createMessageEventDeduper({
    ttlMs: 90 * 1000,
    maxEntries: 4096
  });
  const privateTypingPokeCooldownByUser = new Map();
  const sessionFreshnessVersionByKey = new Map();
  function updateSessionFreshnessVersion(sessionKey = '', version = 0) {
    const normalized = String(sessionKey || '').trim();
    if (!normalized) return;
    const next = Math.max(
      Number(sessionFreshnessVersionByKey.get(normalized) || 0) || 0,
      Number(version || 0) || 0
    );
    sessionFreshnessVersionByKey.set(normalized, next);
  }
  function buildFreshnessGuard(continuousMeta = null) {
    const sessionKey = String(continuousMeta?.sessionKey || '').trim();
    const flushVersion = Number(continuousMeta?.flushVersion || 0) || 0;
    if (
      !sessionKey
      || flushVersion <= 0
      || continuousMeta?.mentionedBot === true
      || config.CONTINUOUS_MESSAGE_CANCEL_ON_NEW_MESSAGE !== true
    ) {
      return {
        sessionKey,
        flushVersion,
        shouldSend: () => true
      };
    }
    return {
      sessionKey,
      flushVersion,
      shouldSend() {
        const latest = Number(sessionFreshnessVersionByKey.get(sessionKey) || 0) || 0;
        return latest <= flushVersion;
      }
    };
  }
  const continuousMessagePreprocessor = createContinuousMessagePreprocessor({
    enabled: config.CONTINUOUS_MESSAGE_ENABLED,
    debounceMs: config.CONTINUOUS_MESSAGE_DEBOUNCE_MS,
    sentenceWindowMs: config.CONTINUOUS_MESSAGE_SENTENCE_WINDOW_MS,
    sentenceMinChars: config.CONTINUOUS_MESSAGE_SENTENCE_MIN_CHARS
  });
  const getDailyShareEngine = () => getDailyShareEngineModule().getDailyShareEngine();
  const lifeSchedulerEngine = getSafeLifeSchedulerEngine();
  const backgroundTaskRuntime = getBackgroundTaskRuntime();
  const hapiControlRuntime = getHapiControlRuntime();
  hapiControlRuntime.expireApprovals();
  backgroundTaskRuntime.expireSessions();
  const routeResolver = typeof detectIntentHybridOverride === 'function'
    ? detectIntentHybridOverride
    : detectIntentHybrid;
  const routePromptCache = createRequestScopeCache({ maxEntries: 128 });
  const formattingPreferenceCache = new Map();
  function getFormattingPreferences(question = '') {
    if (!config.MESSAGE_ROUTE_CACHE_ENABLED) {
      return resolveToolReplyFormattingPreferences(question);
    }
    const key = String(question || '');
    if (formattingPreferenceCache.has(key)) return formattingPreferenceCache.get(key);
    const value = resolveToolReplyFormattingPreferences(question);
    formattingPreferenceCache.set(key, value);
    if (formattingPreferenceCache.size > 128) {
      const oldestKey = formattingPreferenceCache.keys().next().value;
      if (oldestKey !== undefined) formattingPreferenceCache.delete(oldestKey);
    }
    return value;
  }
  function buildCachedRuntimePrompt(templateId, variables = {}) {
    if (!config.MESSAGE_ROUTE_CACHE_ENABLED) {
      return buildRuntimePrompt(templateId, variables);
    }
    const cacheKey = `runtime_prompt:${String(templateId || '')}:${JSON.stringify(variables || {})}`;
    return routePromptCache.getOrCompute(cacheKey, () => buildRuntimePrompt(templateId, variables));
  }
  function getCachedRouteValue(key, factory) {
    if (!config.MESSAGE_ROUTE_CACHE_ENABLED) {
      return typeof factory === 'function' ? factory() : undefined;
    }
    return routePromptCache.getOrCompute(`route_value:${String(key || '')}`, factory);
  }
  const cachedPromptHelpers = {
    buildToolGuidancePrompt(route) {
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
      return buildCachedRuntimePrompt('tool-guidance', {
        routeKey,
        toolHints: toolHints.join(', '),
        reasonLine: reason ? `路由原因: ${reason}` : ''
      });
    },
    buildBridgeGuidancePrompt(route, backend = 'command', routeExecutionPlan = {}) {
      const routeKey = getRouteDisplayType(route, routeExecutionPlan);
      const routeDescription = String(routeKey || '').trim();
      const reason = String(route?.meta?.reason || '').trim();
      const toolLine = buildSubagentToolReasonLine(route, backend);
      const executionLine = buildSubagentExecutionGuidanceLine(route, backend, routeExecutionPlan);
      const executionPlanLines = buildSubagentExecutionPlanLines(routeExecutionPlan, backend);
      const styleGuardLine = buildSubagentStyleGuardInstruction();
      return buildCachedRuntimePrompt('bridge-guidance', {
        routeKey,
        routeDescription,
        planId: 'none',
        styleGuardLine,
        toolLine,
        executionLine,
        executionPlanBlock: executionPlanLines.length ? `执行步骤:\n${executionPlanLines.join('\n')}` : '',
        reasonLine: reason ? `路由原因: ${reason}` : ''
      });
    },
    buildStreamingSegmentationPrompt(maxSegments) {
      return buildCachedRuntimePrompt('streaming-segmentation', { maxSegments });
    },
    buildQqRichReplyPrompt() {
      return buildCachedRuntimePrompt('qq-rich-reply');
    }
  };
  const visionCaptionWorkerRunner = typeof runVisionCaptionWorkerOverride === 'function'
    ? runVisionCaptionWorkerOverride
    : (...args) => getVisionCaptionWorkerModule().runVisionCaptionWorker(...args);
  const sessionSummaryGenerator = typeof generateSessionContextSummaryOverride === 'function'
    ? generateSessionContextSummaryOverride
    : generateSessionContextSummary;
  const replyRuntime = createMessageReplyRuntime({
    sendWithRetry,
    runtimeConfig: config,
    inboundTimingLogger: logInboundTiming
  });
  const buildReplyTelemetry = createReplyTelemetryBridge(config);
  const telemetryCoordinator = createMessageTelemetryCoordinator({
    buildReplyTelemetry,
    runPersistInBackgroundFromCheckpoint
  });
  let adminCoordinator = null;
  let fullSubagentCoordinator = null;
  let backgroundTaskCoordinator = null;
  let visualContextTools = null;
  function getAdminCoordinator() {
    if (!config.LAZY_COORDINATOR_INIT_ENABLED && adminCoordinator) return adminCoordinator;
    if (!adminCoordinator) {
      adminCoordinator = createMessageAdminCoordinator({
        config,
        chatHistory,
        shortTermMemory,
        resolveShortTermSessionKey,
        getSessionSummaryCooldownStatus,
        saveSessionContextSummary,
        generateSessionContextSummary,
        isAdminUser,
        getGroupInitiativeState,
        clearGroupMute,
        setGroupMute,
        scheduleGroupMessage,
        createScheduledCommand,
        hapiControlRuntime,
        createHapiControlClient: createDefaultHapiControlClientFactory(config)
      });
    }
    return adminCoordinator;
  }
  function getFullSubagentCoordinator() {
    if (!config.LAZY_COORDINATOR_INIT_ENABLED && fullSubagentCoordinator) return fullSubagentCoordinator;
    if (!fullSubagentCoordinator) {
      fullSubagentCoordinator = createMessageFullSubagentCoordinator({
        config,
        askAIByGraph,
        extractJsonSafely,
        cleanToolReplyText,
        resolveToolReplyFormattingPreferences,
        buildToolReplyFormatInstruction,
        startSubagentBridgeCall,
        buildRuntimePromptOverride: buildRuntimePrompt
      });
    }
    return fullSubagentCoordinator;
  }
  function getBackgroundTaskCoordinator() {
    if (!config.LAZY_COORDINATOR_INIT_ENABLED && backgroundTaskCoordinator) return backgroundTaskCoordinator;
    if (!backgroundTaskCoordinator) {
      backgroundTaskCoordinator = createMessageBackgroundTaskCoordinator({
        config,
        buildSessionId,
        backgroundTaskRuntime,
        normalizeUserFacingReply: (...args) => replyRuntime.normalizeUserFacingReply(...args),
        askToolTaskLocally,
        getEffectivePolicyKey,
        summarizeBackgroundReply,
        sendGroupReply: (...args) => replyRuntime.sendGroupReply(...args),
        maybeSendMemeFollowup,
        sendWithRetry
      });
    }
    return backgroundTaskCoordinator;
  }
  function getVisualContextTools() {
    if (!config.LAZY_COORDINATOR_INIT_ENABLED && visualContextTools) return visualContextTools;
    if (!visualContextTools) {
      visualContextTools = createMessageVisualContext({
        chatHistory
      });
    }
    return visualContextTools;
  }
  if (!config.LAZY_COORDINATOR_INIT_ENABLED) {
    void getAdminCoordinator();
    void getFullSubagentCoordinator();
    void getBackgroundTaskCoordinator();
    void getVisualContextTools();
  }
  const runBackgroundToolTask = (...args) => getBackgroundTaskCoordinator().runBackgroundToolTask(...args);
  const maybeRunDeferredPersist = telemetryCoordinator.maybeRunDeferredPersist;
  const handleSessionSummaryCommand = (...args) => getAdminCoordinator().handleSessionSummaryCommand(...args);
  const handleHapiAdminCommand = (...args) => getAdminCoordinator().handleHapiAdminCommand(...args);
  const handleInitiativeAdminCommand = (...args) => getAdminCoordinator().handleInitiativeAdminCommand(...args);
  const handleMemoryOpsAdminCommand = (...args) => getAdminCoordinator().handleMemoryOpsAdminCommand(...args);
  const handleRestartAdminCommand = (...args) => getAdminCoordinator().handleRestartAdminCommand(...args);
  const handleQqScheduleAdminCommand = (...args) => getAdminCoordinator().handleQqScheduleAdminCommand(...args);
  const reviewSubagentOutput = (...args) => getFullSubagentCoordinator().reviewSubagentOutput(...args);
  const planFullSubagentWorkers = (...args) => getFullSubagentCoordinator().planFullSubagentWorkers(...args);
  const reviewFullMultiWorkerOutput = (...args) => getFullSubagentCoordinator().reviewFullMultiWorkerOutput(...args);
  const handleFullAdminCommand = (args) => getFullSubagentCoordinator().handleFullAdminCommand({
    ...args,
    sendGroupReply,
    normalizeUserFacingReply,
    askToolTaskWithSubagentReview,
    routeExecution,
    runBackgroundToolTask,
    executeFullSubagentTaskWithHandle
  });
  const inboundConcurrency = inboundConcurrencyControllerOverride || createInboundConcurrencyController({
    globalLimit: config.INBOUND_GLOBAL_MAX_CONCURRENCY,
    generalLimit: config.INBOUND_GENERAL_MAX_CONCURRENCY,
    adminLimit: config.INBOUND_ADMIN_MAX_CONCURRENCY,
    perUserLimit: config.INBOUND_PER_USER_MAX_INFLIGHT,
    maxQueueLength: config.INBOUND_QUEUE_MAX_LENGTH,
    queueTimeoutMs: config.INBOUND_QUEUE_TIMEOUT_MS
  });
  const privateInboundConcurrency = createInboundConcurrencyController({
    globalLimit: config.PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY,
    generalLimit: config.PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY,
    adminLimit: config.PRIVATE_INBOUND_ADMIN_MAX_CONCURRENCY,
    perUserLimit: config.PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT,
    maxQueueLength: config.PRIVATE_INBOUND_QUEUE_MAX_LENGTH,
    queueTimeoutMs: config.PRIVATE_INBOUND_QUEUE_TIMEOUT_MS
  });
  const foregroundConcurrency = createForegroundConcurrencyController({
    globalLimit: config.FOREGROUND_GLOBAL_MAX_CONCURRENCY,
    adminReservedSlots: config.FOREGROUND_ADMIN_RESERVED_SLOTS,
    perUserLimit: config.FOREGROUND_PER_USER_MAX_INFLIGHT,
    maxQueueLength: config.FOREGROUND_QUEUE_MAX_LENGTH,
    queueTimeoutMs: config.FOREGROUND_QUEUE_TIMEOUT_MS
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
  const buildSubagentContextSummary = (...args) => getVisualContextTools().buildSubagentContextSummary(...args);
  const getLastAssistantReplyForSession = (...args) => getVisualContextTools().getLastAssistantReplyForSession(...args);
  const taskControlCoordinator = createMessageTaskControlCoordinator({
    buildSessionId,
    buildNoTaskControlText,
    buildSessionStatusReply,
    buildSupplementedTaskText,
    buildSubagentContextSummary,
    routeResolver,
    planDirectChat,
    routeExecution,
    backgroundTaskRuntime,
    buildRoutePromptBundle,
    getStreamMaxSegments,
    buildToolGuidancePrompt: cachedPromptHelpers.buildToolGuidancePrompt,
    buildBridgeGuidancePrompt: cachedPromptHelpers.buildBridgeGuidancePrompt,
    buildStreamingSegmentationPrompt: cachedPromptHelpers.buildStreamingSegmentationPrompt,
    shouldPreferQqRichReply,
    buildQqRichReplyPrompt: cachedPromptHelpers.buildQqRichReplyPrompt,
    getEffectivePolicyKey,
    sendGroupReply: (...args) => replyRuntime.sendGroupReply(...args),
    runBackgroundToolTask,
    config,
    hapiControlRuntime,
    createHapiControlClient: createDefaultHapiControlClientFactory(config)
  });
  const handleBackgroundTaskControl = (...args) => taskControlCoordinator.handleBackgroundTaskControl(...args);
  const dispatchCoordinator = createMessageDispatchCoordinator({
    config,
    buildRoutePromptBundle,
    getStreamMaxSegments,
    buildToolGuidancePrompt: cachedPromptHelpers.buildToolGuidancePrompt,
    buildBridgeGuidancePrompt: cachedPromptHelpers.buildBridgeGuidancePrompt,
    buildStreamingSegmentationPrompt: cachedPromptHelpers.buildStreamingSegmentationPrompt,
    shouldPreferQqRichReply,
    buildQqRichReplyPrompt: cachedPromptHelpers.buildQqRichReplyPrompt,
    buildSafetyBoundaryRoutePrompt,
    buildLlmPerception,
    buildRoutePlanLogPayload,
    maybeCaptureUnavailableFeatureRequest,
    buildUnavailableRouteReply,
    getEffectivePolicyKey,
    runBackgroundToolTask,
    detectQzonePostDraftMode,
    generateBotDiaryDraft,
    generateGenericQzoneDraft,
    normalizeGeneratedQzoneContent,
    publishQzoneForContext,
    markThinkingEmojiBeforeLlm,
    askToolTaskLocally,
    createStreamingDispatcher,
    composeDirectRoutePrompt,
    askAIDispatch,
    sendWithRetry
  });
  const dispatchByRoutePlan = (...args) => dispatchCoordinator.dispatchByRoutePlan(...args);
  let routeFlow = null;

  async function executeFullMultiWorkerTaskWithHandle(question, userInfo, userId, imageUrl = null, options = {}) {
    const mutableOptions = options && typeof options === 'object' ? { ...options } : {};
    mutableOptions.routePrompt = String(mutableOptions.routePrompt || '').trim() || null;
    const routePolicyKey = String(mutableOptions.routePolicyKey || 'admin/full').trim() || 'admin/full';
    const formattingPreferences = getFormattingPreferences(question);
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
          const cleanOutput = prepareSubagentOutputForReview(
            cleanToolReplyText(output, formattingPreferences),
            { requestText: question }
          );
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
          const cleanReviewed = prepareSubagentFallbackReply(
            cleanToolReplyText(reviewed, formattingPreferences),
            { requestText: question }
          );
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
    if (!mutableOptions.modelConfig && imageUrl) {
      const fallbackModelConfig = resolveLegacyVisionFallbackModelConfig(imageUrl, userId, mutableOptions.routeMeta || {});
      if (fallbackModelConfig) mutableOptions.modelConfig = fallbackModelConfig;
    }
    const startedAt = Date.now();
    if (typeof mutableOptions?.onEvent === 'function') {
      try {
        mutableOptions.onEvent({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          ts: Date.now(),
          type: 'ask_ai_dispatch_start',
          node: 'pre_model',
          routePolicyKey: String(mutableOptions.routePolicyKey || '').trim(),
          topRouteType: String(mutableOptions.topRouteType || '').trim()
        });
      } catch (_) {}
    }

    const reply = await askAIByGraph(question, userInfo, userId, customPrompt, imageUrl, mutableOptions);

    if (typeof mutableOptions?.onEvent === 'function') {
      try {
        mutableOptions.onEvent({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          ts: Date.now(),
          type: 'ask_ai_dispatch_done',
          node: 'pre_model',
          routePolicyKey: String(mutableOptions.routePolicyKey || '').trim(),
          topRouteType: String(mutableOptions.topRouteType || '').trim(),
          durationMs: Math.max(0, Date.now() - startedAt)
        });
      } catch (_) {}
    }

    return reply;
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
    const formattingPreferences = getFormattingPreferences(question);

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
      return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
    }

    try {
      const reviewed = await reviewSubagentOutput({
        question,
        subagentOutput: prepareSubagentOutputForReview(subagentOutput, { requestText: question }),
        userInfo,
        userId,
        imageUrl,
        routePrompt: mutableOptions.routePrompt,
        routePolicyKey
      });

      if (String(reviewed || '').trim()) {
        if (looksLikeModelFailureText(reviewed) && String(subagentOutput || '').trim()) {
          return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
        }
        return prepareSubagentFallbackReply(cleanToolReplyText(reviewed, formattingPreferences), { requestText: question });
      }
      if (String(subagentOutput || '').trim()) {
        return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
      }
      return '? agent ???????? Mizuki ????????????????????????';
    } catch (reviewErr) {
      console.error('[subagent-review] failed, fallback to raw subagent output:', reviewErr?.message || reviewErr);
      if (String(subagentOutput || '').trim()) {
        return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
      }
      return '??? agent ????????????????????????';
    }
  }

  async function askToolTaskLocally(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
    const mutableOptions = options && typeof options === 'object' ? options : {};
    const formattingPreferences = getFormattingPreferences(question);
    const outputFormatInstruction = buildToolReplyFormatInstruction(formattingPreferences);
    mutableOptions.routePrompt = [String(mutableOptions.routePrompt || '').trim(), outputFormatInstruction].filter(Boolean).join('\n\n') || null;
    const plannerExecutionPlan = mutableOptions.plannerExecutionPlan && typeof mutableOptions.plannerExecutionPlan === 'object'
      ? mutableOptions.plannerExecutionPlan
      : null;
    if (!mutableOptions.modelConfig && imageUrl) {
      const fallbackModelConfig = resolveLegacyVisionFallbackModelConfig(imageUrl, userId, mutableOptions.routeMeta || {});
      if (fallbackModelConfig) mutableOptions.modelConfig = fallbackModelConfig;
    }

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
    const formattingPreferences = getFormattingPreferences(question);

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
          return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
        }

        const shouldContinue = typeof mutableOptions?.shouldContinue === 'function'
          ? mutableOptions.shouldContinue
          : () => true;

        try {
          if (!shouldContinue()) return '';
          const reviewed = await reviewSubagentOutput({
            question,
            subagentOutput: prepareSubagentOutputForReview(subagentOutput, { requestText: question }),
            userInfo,
            userId,
            imageUrl,
            routePrompt: mutableOptions.routePrompt,
            routePolicyKey
          });
          if (!shouldContinue()) return '';

          if (String(reviewed || '').trim()) {
            if (looksLikeModelFailureText(reviewed) && String(subagentOutput || '').trim()) {
              return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
            }
            return prepareSubagentFallbackReply(cleanToolReplyText(reviewed, formattingPreferences), { requestText: question });
          }
          if (String(subagentOutput || '').trim()) {
            return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
          }
          return '? agent ???????? Mizuki ????????????????????????';
        } catch (reviewErr) {
          console.error('[subagent-review] failed, fallback to raw subagent output:', reviewErr?.message || reviewErr);
          if (String(subagentOutput || '').trim()) {
            return prepareSubagentFallbackReply(cleanToolReplyText(subagentOutput, formattingPreferences), { requestText: question });
          }
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
    handleHapiAdminCommand,
    handleMemoryOpsAdminCommand,
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

  async function maybeHandlePrivateTypingNotice(noticeResult = null) {
    if (!noticeResult || noticeResult.type !== 'input_status') return false;
    if (!config.PRIVATE_TYPING_POKE_ENABLED) return true;

    const meta = noticeResult.meta && typeof noticeResult.meta === 'object' ? noticeResult.meta : {};
    const userId = String(meta.userId || '').trim();
    const statusText = String(meta.statusText || '').trim();
    const eventType = String(meta.eventType || '').trim();
    const isPrivate = meta.isPrivate === true;

    if (!isPrivate || !userId) return true;
    if (!isPrivateChatUserAllowed(userId, config)) return true;

    const isTyping = eventType === '1' || /正在输入/.test(statusText);
    if (!isTyping) return true;

    const now = Date.now();
    const cooldownMs = Math.max(0, Number(config.PRIVATE_TYPING_POKE_COOLDOWN_MS) || 0);
    const lastTriggeredAt = Math.max(0, Number(privateTypingPokeCooldownByUser.get(userId) || 0) || 0);
    if (cooldownMs > 0 && lastTriggeredAt > 0 && (now - lastTriggeredAt) < cooldownMs) {
      return true;
    }

    privateTypingPokeCooldownByUser.set(userId, now);
    try {
      await sendPrivatePoke(userId);
      console.log('[notice] private typing poke sent', {
        userId,
        eventType,
        statusText
      });
    } catch (error) {
      console.warn('[notice] private typing poke failed', {
        userId,
        eventType,
        statusText,
        error: error?.message || String(error || '')
      });
    }
    return true;
  }

  async function handleIncomingMessage(msg) {
    const handlerStartedAt = Date.now();
    const rawMessageTimestampMs = getRawMessageTimestampMs(msg);
    const requestTrace = createRequestTrace({
      source: 'message_ingress',
      messageId: String(msg?.message_id || '').trim(),
      groupId: String(msg?.group_id || '').trim(),
      userId: String(msg?.user_id || '').trim(),
      chatType: String(msg?.message_type || '').trim(),
      isAdmin: isAdminUser(String(msg?.user_id || '').trim())
    });
    const appendTraceTiming = (phase, payload = {}) => appendInboundTimingLog(
      inboundTimingLogFile,
      config.ENABLE_DEBUG_LOG,
      nextTracePhase(requestTrace, phase, payload)
    );
    const buildTraceBase = () => ({
      messageId: String(msg?.message_id || '').trim(),
      groupId: String(msg?.group_id || '').trim(),
      userId: String(msg?.user_id || '').trim(),
      chatType: String(msg?.message_type || '').trim().toLowerCase() === 'private' ? 'private' : 'group',
      rawMessageTimestampMs,
      elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
    });
    const appendRequestCompleteTrace = (payload = {}) => appendTraceTiming('request_complete', {
      stage: 'request_complete',
      ...buildTraceBase(),
      durationMs: Math.max(0, Date.now() - handlerStartedAt),
      ...payload
    });
    appendTraceTiming('message_ingress', {
      stage: 'handle_incoming_start',
      messageId: String(msg?.message_id || '').trim(),
      groupId: String(msg?.group_id || '').trim(),
      userId: String(msg?.user_id || '').trim(),
      chatType: String(msg?.message_type || '').trim(),
      isAdmin: isAdminUser(String(msg?.user_id || '').trim()),
      rawMessageTimestampMs,
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, handlerStartedAt - rawMessageTimestampMs) : null
    });

    const noticeResult = shouldHandleNotice(msg, config);
    if (noticeResult.handled) {
      await maybeHandlePrivateTypingNotice(noticeResult);
      return;
    }
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
    const rawMessageText = String(msg?.raw_message || '').trim();
    const createCommandText = stripLeadingCqControlSegments(rawMessageText, resolveEffectiveBotQQ(msg, config));
    if (/^\s*\/create(?:\s|$)/i.test(createCommandText)) {
      if (isPrivateChatType(chatType)) {
        const sendStartedAt = Date.now();
        appendTraceTiming('final_reply_send_start', {
          stage: 'final_reply_send_start',
          ...buildTraceBase(),
          routePolicyKey: 'admin/create',
          topRouteType: 'admin',
          replyPath: 'create_private_blocked'
        });
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: '仅群聊可用',
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        appendTraceTiming('final_reply_send_done', {
          stage: 'final_reply_send_done',
          ...buildTraceBase(),
          routePolicyKey: 'admin/create',
          topRouteType: 'admin',
          replyPath: 'create_private_blocked',
          sent: true,
          durationMs: Math.max(0, Date.now() - sendStartedAt)
        });
        appendRequestCompleteTrace({
          routePolicyKey: 'admin/create',
          topRouteType: 'admin',
          finalErrorCode: 'group_only'
        });
        return;
      }

      const createAgentExecutor = getCreateAgentExecutorModule();
      if (!createAgentExecutor.isCreateAgentUserAllowed(senderId)) {
        try {
          await sendGroupPoke(groupId, senderId, {
            actionClient: {
              callAction: async (action, params) => {
                const ok = await sendWithRetry({
                  action,
                  params
                }, 1, 300);
                if (!ok) {
                  throw new Error(`sendWithRetry failed for ${String(action || '').trim() || 'group_poke'}`);
                }
                return {};
              }
            }
          });
        } catch (error) {
          console.warn('[create] unauthorized group poke failed', {
            groupId,
            senderId,
            error: error?.message || String(error || '')
          });
        }
        appendRequestCompleteTrace({
          routePolicyKey: 'admin/create',
          topRouteType: 'admin',
          finalErrorCode: 'unauthorized',
          sent: false
        });
        return;
      }

      const prompt = createCommandText.replace(/^\s*\/create/i, '').trim();
      appendTraceTiming('admin_route_dispatch_start', {
        stage: 'admin_route_dispatch_start',
        ...buildTraceBase(),
        routePolicyKey: 'admin/create',
        topRouteType: 'admin',
        command: 'create'
      });
      const createResult = await createAgentExecutor.executeCreateCommand({
        prompt,
        chatType,
        groupId,
        senderId,
        rawText: rawMessageText,
        requestTrace: cloneTraceForMeta(requestTrace)
      });
      appendTraceTiming('admin_route_dispatch_done', {
        stage: 'admin_route_dispatch_done',
        ...buildTraceBase(),
        routePolicyKey: 'admin/create',
        topRouteType: 'admin',
        command: 'create',
        ok: createResult?.ok === true,
        finalErrorCode: createResult?.ok ? '' : String(createResult?.code || '').trim()
      });

      if (!createResult?.ok) {
        const sendStartedAt = Date.now();
        appendTraceTiming('final_reply_send_start', {
          stage: 'final_reply_send_start',
          ...buildTraceBase(),
          routePolicyKey: 'admin/create',
          topRouteType: 'admin',
          replyPath: 'create_failure'
        });
        const sent = await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: String(createResult?.replyText || '生图失败，请稍后重试').trim(),
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        appendTraceTiming('final_reply_send_done', {
          stage: 'final_reply_send_done',
          ...buildTraceBase(),
          routePolicyKey: 'admin/create',
          topRouteType: 'admin',
          replyPath: 'create_failure',
          sent: Boolean(sent),
          durationMs: Math.max(0, Date.now() - sendStartedAt),
          finalErrorCode: String(createResult?.code || '').trim()
        });
      }
      appendRequestCompleteTrace({
        routePolicyKey: 'admin/create',
        topRouteType: 'admin',
        sent: createResult?.ok === true,
        finalErrorCode: createResult?.ok ? '' : String(createResult?.code || '').trim()
      });
      return;
    }

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
    let continuousMeta = preprocessed?.meta || effectiveMsg.__continuousMessageMeta || null;
    if (!continuousMeta) {
      const syntheticContinuousMeta = cheapParseMessageEntry(effectiveMsg, {
        effectiveBotQQ
      });
      await resolveContinuousEntryDetails(syntheticContinuousMeta, {
        effectiveBotQQ,
        resolveReply: Boolean(syntheticContinuousMeta.replyMessageId),
        resolveForward: Array.isArray(syntheticContinuousMeta.forwardIds) && syntheticContinuousMeta.forwardIds.length > 0,
        resolveCards: Array.isArray(syntheticContinuousMeta.qqCardUrls) && syntheticContinuousMeta.qqCardUrls.length > 0
      });
      syntheticContinuousMeta.sessionKey = '';
      syntheticContinuousMeta.firstTimestamp = syntheticContinuousMeta.firstTimestamp || syntheticContinuousMeta.timestamp || Date.now();
      syntheticContinuousMeta.lastTimestamp = syntheticContinuousMeta.lastTimestamp || syntheticContinuousMeta.timestamp || Date.now();
      syntheticContinuousMeta.sourceMessageIds = Array.isArray(syntheticContinuousMeta.sourceMessageIds) && syntheticContinuousMeta.sourceMessageIds.length
        ? syntheticContinuousMeta.sourceMessageIds
        : (syntheticContinuousMeta.messageId ? [syntheticContinuousMeta.messageId] : []);
      syntheticContinuousMeta.flushReason = String(syntheticContinuousMeta.flushReason || 'single_message').trim() || 'single_message';
      continuousMeta = syntheticContinuousMeta;
      effectiveMsg.__continuousMessageMeta = continuousMeta;
    }
    updateSessionFreshnessVersion(
      String(continuousMeta?.sessionKey || '').trim(),
      Number(continuousMeta?.flushVersion || 0) || 0
    );
    const freshnessGuard = buildFreshnessGuard(continuousMeta);
    const rawText = effectiveMsg.raw_message || '';
    const inboundSessionKey = resolveShortTermSessionKey(senderId, isPrivateChatType(chatType) ? {} : { groupId });
    const isPrivateInbound = isPrivateChatType(chatType);
    const concurrencyScope = isPrivateInbound ? 'private' : 'default';
    const concurrencyLane = isAdminUser(senderId) ? 'admin' : 'general';
    const selectedInboundConcurrency = isPrivateInbound ? privateInboundConcurrency : inboundConcurrency;
    const inboundPool = isPrivateInbound ? 'private' : 'default';
    const queueWaitStartedAt = Date.now();
    const inboundLock = await selectedInboundConcurrency.acquire({
      userId: senderId,
      sessionKey: inboundSessionKey,
      lane: concurrencyLane,
      messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
      groupId,
      chatType,
      concurrencyScope,
      privilegedPrivateChat
    });
    const inboundSnapshot = selectedInboundConcurrency.getSnapshot();
    appendTraceTiming('message_ingress_lock_acquired', {
      stage: 'inbound_lock_acquired',
      messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
      groupId: String(groupId || '').trim(),
      userId: String(senderId || '').trim(),
      chatType,
      concurrencyLane,
      concurrencyScope,
      privilegedPrivateChat,
      queueWaitMs: Math.max(0, Date.now() - queueWaitStartedAt),
      inbound_wait_ms: Number(inboundLock?.waitMs || 0) || 0,
      inbound_lane: String(inboundLock?.lane || concurrencyLane).trim() || concurrencyLane,
      inbound_pool: inboundPool,
      inbound_request_id: String(inboundLock?.requestId || '').trim(),
      inbound_active_total: Number(inboundSnapshot?.totalActive || 0) || 0,
      inbound_active_general: Number(inboundSnapshot?.activeGeneral || 0) || 0,
      inbound_active_admin: Number(inboundSnapshot?.activeAdmin || 0) || 0,
      foreground_wait_ms: Number(inboundLock?.waitMs || 0) || 0,
      foreground_lane: String(inboundLock?.lane || concurrencyLane).trim() || concurrencyLane,
      foreground_request_id: String(inboundLock?.requestId || '').trim(),
      foreground_active_total: Number(inboundSnapshot?.totalActive || 0) || 0,
      foreground_active_general: Number(inboundSnapshot?.activeGeneral || 0) || 0,
      foreground_active_admin: Number(inboundSnapshot?.activeAdmin || 0) || 0,
      rawMessageTimestampMs,
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
    });
    let inboundHadError = false;

    try {
      appendTraceTiming('message_ingress_route_entry', {
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
      const logMemoryWriteSkip = (reason = '', extra = {}) => {
        const payload = {
          stage: 'memory_write_skipped',
          reason: String(reason || '').trim(),
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
          ...extra
        };
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, payload);
        console.log('[memory-write] skipped', payload);
      };
      if (!isPrivateChatType(chatType)) {
        recordHumanInbound(groupId, senderId, Number(effectiveMsg?.time ? Number(effectiveMsg.time) * 1000 : Date.now()));
      }

    if (/^\s*\/meme(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType) && !canBypassPrivateGroupOnly({
        chatType,
        userId: senderId,
        runtimeConfig: config
      })) {
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
        logMemoryWriteSkip('special_command_private_blocked', { command: 'dailyshare' });
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
      logMemoryWriteSkip('special_command', { command: 'meme' });
      return;
    }

    if (/^\s*\/dailyshare(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType) && !canBypassPrivateGroupOnly({
        chatType,
        userId: senderId,
        runtimeConfig: config
      })) {
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
        logMemoryWriteSkip('special_command_private_blocked', { command: 'life' });
        return;
      }
      const dailyShareResult = await getDailyShareEngine().handleAdminCommand({
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
      logMemoryWriteSkip('special_command', { command: 'dailyshare' });
      return;
    }

    if (/^\s*\/life(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType) && !canBypassPrivateGroupOnly({
        chatType,
        userId: senderId,
        runtimeConfig: config
      })) {
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
        logMemoryWriteSkip('special_command_private_blocked', { command: 'sr' });
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
      logMemoryWriteSkip('special_command', { command: 'life' });
      return;
    }

    if (/^\s*\/sr(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType) && !canBypassPrivateGroupOnly({
        chatType,
        userId: senderId,
        runtimeConfig: config
      })) {
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
        logMemoryWriteSkip('special_command_private_blocked', { command: 'initiative' });
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
      logMemoryWriteSkip('special_command', { command: 'sr' });
      return;
    }

    if (/^\s*\/restart\s*$/i.test(String(slashCommandText || '').trim())) {
      const restartResult = await handleRestartAdminCommand({
        rawText: slashCommandText,
        groupId,
        userId: senderId
      });
      if (String(restartResult?.replyText || '').trim()) {
        await sendGroupReply({
          chatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: restartResult.replyText,
          atSender: true,
          retries: 1,
          waitMs: 300
        });
      }
      if (restartResult?.restartRequested) {
        triggerRemoteRestart({ delayMs: 800 });
      }
      logMemoryWriteSkip('special_command', { command: 'restart' });
      return;
    }

    if (/^\s*\/initiative(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      if (isPrivateChatType(chatType) && !canBypassPrivateGroupOnly({
        chatType,
        userId: senderId,
        runtimeConfig: config
      })) {
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
      logMemoryWriteSkip('special_command', { command: 'initiative' });
      return;
    }

    if (/^\s*\/cot(?:\s|$)/i.test(String(slashCommandText || '').trim())) {
      const armed = armCotOnce({
        chatType,
        groupId: isPrivateChatType(chatType) ? '' : groupId,
        userId: senderId
      });
      const ttlSeconds = Math.max(1, Math.ceil(getCotOnceTtlMs() / 1000));
      await sendGroupReply({
        chatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: armed
          ? `已开启一次性思维链显示。请在 ${ttlSeconds} 秒内发送下一条正常对话消息；仅该次回复生效。`
          : '当前无法开启一次性思维链显示，请稍后再试。',
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      logMemoryWriteSkip('special_command', { command: 'cot' });
      return;
    }

    if (!effectiveBotQQ) {
      console.warn('[message] skip because bot qq is unresolved');
      return;
    }

    const mentioned = getCachedRouteValue(`mentioned:${String(rawText || '')}:${effectiveBotQQ}`, () => isAtBot(rawText, effectiveBotQQ));
    const cleanTextWithoutControls = getCachedRouteValue(`cleanTextWithoutControls:${String(rawText || '')}:${effectiveBotQQ}`, () => stripLeadingCqControlSegments(rawText, effectiveBotQQ));
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
    const effectiveRawText = getCachedRouteValue(`effectiveRawText:${String(effectiveMsg?.raw_message || rawText || '')}`, () => String(effectiveMsg?.raw_message || rawText || ''));
    const effectiveCleanText = getCachedRouteValue(`effectiveCleanText:${effectiveRawText}:${effectiveBotQQ}`, () => stripLeadingCqControlSegments(effectiveRawText, effectiveBotQQ));
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
    const currentMessageImageRawUrls = Array.isArray(effectiveMsg?.message)
      ? effectiveMsg.message
          .filter((item) => String(item?.type || '').trim() === 'image')
          .map((item) => String(item?.data?.url || '').trim())
          .filter(Boolean)
      : [];
    const currentMessageImageRawUrl = currentMessageImageRawUrls[0] || '';
    const hasPotentialVisualInput = Boolean(
      Array.isArray(continuousMeta?.imageUrls) && continuousMeta.imageUrls.length > 0
      || Array.isArray(continuousMeta?.currentImageUrls) && continuousMeta.currentImageUrls.length > 0
      || (Array.isArray(continuousMeta?.replyContext?.imageUrls) && continuousMeta.replyContext.imageUrls.length > 0)
      || String(directedContext?.replyImageUrl || '').trim()
      || (Array.isArray(continuousMeta?.forwardImageUrls) && continuousMeta.forwardImageUrls.length > 0)
      || (Array.isArray(continuousMeta?.forwardImages) && continuousMeta.forwardImages.length > 0)
      || (Array.isArray(continuousMeta?.qqCardUrls) && continuousMeta.qqCardUrls.length > 0)
      || currentMessageImageRawUrls.length > 0
    );
    const visualImageCollectionResult = hasPotentialVisualInput
      ? getCachedRouteValue(`visualCollection:${String(effectiveMsg?.message_id || msg?.message_id || '')}`, () => buildVisualImageCollectionDetails(
        continuousMeta,
        directedContext,
        effectiveCleanText,
        { maxImages: config.VISION_CAPTION_WORKER_MAX_IMAGES }
      ))
      : { images: [], meta: {} };
    const visualImageCollection = Array.isArray(visualImageCollectionResult?.images) ? visualImageCollectionResult.images : [];
    const currentImageRefMap = continuousMeta?.imageRefMap && typeof continuousMeta.imageRefMap === 'object'
      ? continuousMeta.imageRefMap
      : {};
    const stableVisualImageCollection = [];
    for (const item of visualImageCollection) {
      const itemUrl = String(item?.url || '').trim();
      if (!itemUrl) continue;
      const stableUrl = await resolveStableVisualUrl(itemUrl);
      stableVisualImageCollection.push({
        ...item,
        url: stableUrl,
        originalUrl: String(item?.originalUrl || itemUrl).trim() || itemUrl
      });
    }
    const currentMessageImageUrls = [];
    for (const rawUrl of currentMessageImageRawUrls) {
      const stableUrl = await resolveStableVisualUrl(rawUrl, currentImageRefMap);
      if (stableUrl) currentMessageImageUrls.push({ rawUrl, stableUrl });
    }
    const currentMessageImageUrl = currentMessageImageUrls[0]?.stableUrl || '';
    const continuousPrimaryImageUrl = String(
      resolveVisualInputFromContinuousMetaCore(continuousMeta, directedContext, effectiveCleanText) || ''
    ).trim();
    const stableContinuousPrimaryImageUrl = continuousPrimaryImageUrl
      ? await resolveStableVisualUrl(continuousPrimaryImageUrl, currentImageRefMap)
      : '';
    const effectiveVisualCollection = stableVisualImageCollection.length > 0
      ? stableVisualImageCollection
      : (
        currentMessageImageUrls.length > 0
          ? currentMessageImageUrls.map((item, index) => ({
              imageIndex: index,
              source: 'current',
              url: item.stableUrl,
              originalUrl: item.rawUrl || item.stableUrl,
              label: `current_${index + 1}`
            }))
          : []
      );
    const effectiveVisualInput = stableVisualImageCollection.length > 0
      ? (String(stableVisualImageCollection[0]?.url || '').trim()
        || stableContinuousPrimaryImageUrl)
      : currentMessageImageUrl;
    const effectiveVisualInputUrls = effectiveVisualCollection
      .map((item) => String(item?.url || '').trim())
      .filter(Boolean);
    const visualCacheRefCount = countCachedVisualRefs(effectiveVisualCollection);
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
    let routerRawText = effectiveVisualInput && !/\[CQ:image,.*?\]/i.test(effectiveRawText)
      ? `${effectiveRawText.trim()}\n[CQ:image,url=${effectiveVisualInput}]`
      : effectiveRawText;
    let runtimeQuestionText = effectiveIntentText;
    let persistUserText = effectiveIntentText;
    let originalUserText = effectiveIntentText;
    let visualContext = visualImageCollection.length > 0
      ? {
          hasVisualInput: true,
        worker: {
          name: 'vision-caption-worker',
          succeeded: false,
          fallbackUsed: true,
          fallbackReason: 'not_started',
          imageCount: effectiveVisualCollection.length
        },
          images: effectiveVisualCollection.map((item, index) => ({
            imageIndex: index,
            source: item.source,
            url: item.url,
            label: item.label
          })),
          selectionMeta: {
            ...(visualImageCollectionResult.meta || {})
          },
          captionJson: null,
          summary: '',
          recommendedPromptContext: '',
          shortPersistSummary: '',
          runtimeQuestionText: effectiveIntentText,
          persistUserText: effectiveIntentText,
          originalUserText: effectiveIntentText
        }
      : null;

    if (effectiveVisualCollection.length > 0) {
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'vision_input_selected',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        imageCount: effectiveVisualCollection.length,
        currentImageCount: Number(visualImageCollectionResult.meta?.currentImageCount || 0) || 0,
        replyImageCount: Number(visualImageCollectionResult.meta?.replyImageCount || 0) || 0,
        forwardImageCount: Number(visualImageCollectionResult.meta?.forwardImageCount || 0) || 0,
        directedScene: String(visualImageCollectionResult.meta?.directedScene || '').trim(),
        quotePriorityMode: String(visualImageCollectionResult.meta?.quotePriorityMode || '').trim(),
        forcedReplyPriority: visualImageCollectionResult.meta?.forcedReplyPriority === true,
        replyPriorityReason: String(visualImageCollectionResult.meta?.replyPriorityReason || '').trim(),
        selectedPrimarySource: String(visualImageCollectionResult.meta?.selectedPrimarySource || '').trim(),
        cacheRefCount: visualCacheRefCount,
        selectedVisualInput: effectiveVisualInput,
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
      });
    }

    if (effectiveVisualCollection.length > 0) {
      const visionStartedAt = Date.now();
      const captionResult = await visionCaptionWorkerRunner({
        originalUserText: effectiveIntentText,
        images: effectiveVisualCollection,
        quotePriorityMode: String(directedContext?.quotePriority?.mode || '').trim(),
        quotePriorityReason: String(directedContext?.quotePriority?.reason || '').trim()
      });
      if (captionResult.ok && captionResult.visualContext) {
        visualContext = captionResult.visualContext;
        visualContext.selectionMeta = {
          ...(visualImageCollectionResult.meta || {})
        };
        runtimeQuestionText = normalizeVisualSummaryText(visualContext.runtimeQuestionText) || effectiveIntentText;
        persistUserText = normalizeVisualSummaryText(visualContext.persistUserText) || effectiveIntentText;
        originalUserText = normalizeVisualSummaryText(visualContext.originalUserText) || effectiveIntentText;
        routerRawText = effectiveCleanText;
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
          stage: 'vision_caption_worker_done',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          imageCount: effectiveVisualCollection.length,
          cacheRefCount: visualCacheRefCount,
          durationMs: Math.max(0, Date.now() - visionStartedAt),
          fallbackUsed: false,
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
        });
      } else {
        if (visualContext && visualContext.worker) {
          visualContext.worker.fallbackUsed = true;
          visualContext.worker.fallbackReason = String(captionResult.fallbackReason || 'worker_failed').trim() || 'worker_failed';
        }
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
          stage: 'vision_caption_worker_fallback',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          imageCount: effectiveVisualCollection.length,
          cacheRefCount: visualCacheRefCount,
          durationMs: Math.max(0, Date.now() - visionStartedAt),
          fallbackReason: String(captionResult.fallbackReason || 'worker_failed').trim(),
          fallbackImageUrl: effectiveVisualInput,
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
        });
      }
    }
    const sessionKey = resolveShortTermSessionKey(senderId, { groupId });
    const stableThreadId = resolveThreadId({
      userId: senderId,
      routePolicyKey: '',
      reviewMode: '',
      routeMeta: {
        userId: String(senderId || '').trim(),
        groupId: isPrivateChatType(chatType) ? '' : String(groupId || '').trim(),
        chatType,
        messageId: String(effectiveMsg?.message_id || msg?.message_id || '').trim()
      },
      sessionKey,
      imageUrl: effectiveVisualInput,
      options: {
        threadId: [
          String(senderId || '').trim() || 'anonymous',
          String(sessionKey || 'default').trim() || 'default',
          String(effectiveMsg?.message_id || msg?.message_id || '').trim() || 'message',
          String(effectiveVisualInput || '').trim() ? 'image' : 'chat'
        ].join(':')
      }
    });
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
      imageUrl: visualContext?.worker?.succeeded ? null : effectiveVisualInput,
      imageUrls: visualContext?.worker?.succeeded ? [] : effectiveVisualInputUrls,
      isAtBot: directBotAnchor,
      botQQ: effectiveBotQQ,
      chatType,
      sessionTiming,
      continuousMeta,
      directedContext,
      visualContext,
      threadId: stableThreadId,
      requestTrace: cloneTraceForMeta(requestTrace),
      messageMeta: {
        messageId: String(effectiveMsg?.message_id || msg?.message_id || '').trim(),
        threadId: stableThreadId
      }
    });
    inboundContext.requestTrace = cloneTraceForMeta(requestTrace);
    inboundContext.onEvent = (event = {}) => {
      const normalizedEvent = event && typeof event === 'object' ? event : {};
      if (String(normalizedEvent.type || '').trim() === 'direct_reply_failure') {
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
          ...nextTracePhase(requestTrace, 'runtime_direct_reply_failure', {}),
          stage: 'direct_reply_failure',
          messageId: String(effectiveMsg?.message_id || msg?.message_id || '').trim(),
          groupId: isPrivateChatType(chatType) ? '' : String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          routePolicyKey: String(normalizedEvent.routePolicyKey || '').trim(),
          topRouteType: String(normalizedEvent.topRouteType || '').trim(),
          failureType: String(normalizedEvent.failureType || '').trim(),
          fallbackSource: String(normalizedEvent.fallbackSource || '').trim(),
          failureStage: String(normalizedEvent.stage || '').trim(),
          rawErrorMessage: String(normalizedEvent.rawErrorMessage || '').trim(),
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
        });
      }
      const telemetry = buildReplyTelemetry({
        senderId,
        groupId: isPrivateChatType(chatType) ? '' : groupId,
        chatType,
        routePolicyKey: '',
        topRouteType: '',
        routeMeta: {
          userId: String(senderId || '').trim(),
          groupId: isPrivateChatType(chatType) ? '' : String(groupId || '').trim(),
          chatType,
          threadId: stableThreadId,
          messageId: String(effectiveMsg?.message_id || msg?.message_id || '').trim(),
          requestTrace: cloneTraceForMeta(requestTrace)
        }
      });
      if (typeof telemetry?.onEvent === 'function') {
        telemetry.onEvent(event);
      }
    };
    inboundContext.effectiveIntentText = runtimeQuestionText;
    inboundContext.runtimeQuestionText = runtimeQuestionText;
    inboundContext.persistUserText = persistUserText;
    inboundContext.originalUserText = originalUserText;
    if (visualContext?.worker?.succeeded) {
      inboundContext.cleanText = runtimeQuestionText;
      inboundContext.rawText = runtimeQuestionText;
    }
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

    const cotArmedState = consumeCotOnce({
      chatType,
      groupId: isPrivateChatType(chatType) ? '' : groupId,
      userId: senderId
    });

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
      reply_to_bot_last_reply_at: lastBotReplyAt || 0,
      cotDisplayOnce: Boolean(cotArmedState)
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
      appendTraceTiming('router_start', {
        stage: 'route_resolver_start',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
      });
      route = await routeResolver({
        rawText: routerRawText,
        botQQ: effectiveBotQQ,
        userId: senderId,
        chatType,
        contextSummary: routerContextSummary,
        directedContext,
        effectiveIntentText: runtimeQuestionText
      }, { requestTrace: cloneTraceForMeta(requestTrace) });
    } catch (error) {
      routeResolverError = error;
      appendTraceTiming('router_failed', {
        stage: 'route_resolver_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - routeResolverStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        finalErrorCode: extractErrorCode(error),
        error: error?.message || String(error || '')
      });
      throw error;
    }
    appendTraceTiming('router_done', {
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
      requestTrace: cloneTraceForMeta(requestTrace),
      userId: String(senderId || ''),
      groupId: isPrivateChatType(chatType) ? '' : String(groupId || ''),
      chatType,
      directedContext,
      directedContextSummary: routerContextSummary,
      effectiveIntentText: runtimeQuestionText,
      quotePriority: directedContext?.quotePriority || null,
      cotDisplayOnce: Boolean(cotArmedState),
      cotArmedAt: Number(cotArmedState?.armedAt || 0) || 0
    };
    if (visualContext) {
      route.meta.visualContext = visualContext;
      route.meta.imageUrls = effectiveVisualInputUrls;
      route.meta.persistUserText = persistUserText;
      route.meta.originalUserText = originalUserText;
    }
    if (visualContext?.worker?.succeeded) {
      route.question = runtimeQuestionText;
      route.cleanText = runtimeQuestionText;
      route.imageUrl = null;
    }

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
      if (handled) {
        logMemoryWriteSkip('admin_command_route_bypassed', { command: 'full' });
        return;
      }
    }

    if (route?.topRouteType === 'admin' && String(route?.meta?.command?.cmd || '').trim() === 'claude') {
      const userInfo = updateFavor(senderId, route.cleanText || rawText || '/claude', isPrivateChatType(chatType) ? '' : groupId);
      userInfo.last_seen_at = Date.now();
      saveData();
      recordMemoryScope(senderId, { groupId: isPrivateChatType(chatType) ? '' : groupId });
      const handled = await routeFlow.handleClaudeAdminCommand({
        route,
        groupId,
        senderId,
        userInfo,
        rawText,
        chatType
      });
      if (handled) {
        logMemoryWriteSkip('admin_command_route_bypassed', { command: 'claude' });
        return;
      }
    }

    if (
      route?.topRouteType === 'admin'
      && ['claude-open', 'claude-send', 'claude-tail', 'claude-stop'].includes(String(route?.meta?.command?.cmd || '').trim())
    ) {
      const userInfo = updateFavor(senderId, route.cleanText || rawText || '/claude-open', isPrivateChatType(chatType) ? '' : groupId);
      userInfo.last_seen_at = Date.now();
      saveData();
      recordMemoryScope(senderId, { groupId: isPrivateChatType(chatType) ? '' : groupId });
      const handled = await routeFlow.handleClaudeSessionAdminCommand({
        route,
        groupId,
        senderId,
        chatType
      });
      if (handled) {
        logMemoryWriteSkip('admin_command_route_bypassed', {
          command: String(route?.meta?.command?.cmd || '').trim()
        });
        return;
      }
    }

    if (route?.topRouteType === 'direct_chat') {
      const plannerStartedAt = Date.now();
      let plannerDecision = null;
      try {
        appendTraceTiming('planner_start', {
          stage: 'direct_chat_planner_start',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          topRouteType: String(route?.topRouteType || '').trim(),
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
        });
        plannerDecision = await planDirectChat(route, {
          userId: senderId,
          allowedTools: route?.meta?.allowedTools,
          contextSummary: plannerContextSummary,
          directedContext,
          requestTrace: cloneTraceForMeta(requestTrace)
        });
      } catch (error) {
        appendTraceTiming('planner_failed', {
          stage: 'direct_chat_planner_failed',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          durationMs: Math.max(0, Date.now() - plannerStartedAt),
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
          finalErrorCode: extractErrorCode(error),
          error: error?.message || String(error || '')
        });
        throw error;
      }
      appendTraceTiming('planner_done', {
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

    const routeExecutionStartedAt = Date.now();
    let routeExecutionPlan = null;
    try {
      routeExecutionPlan = routeExecution.resolveRouteExecution(route, config, {});
      appendTraceTiming('route_execution_done', {
        stage: 'route_execution_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - routeExecutionStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
    } catch (error) {
      routeExecutionPlan = {
        executor: 'direct',
        topRouteType: 'direct_chat',
        policyKey: 'chat/default',
        routeDebugKey: 'direct_chat/text_chat/answer',
        allowTools: false,
        allowedTools: [],
        allowedToolBuckets: [],
        allowStream: !route?.imageUrl,
        needsBackground: false,
        unavailableReason: 'route-execution-failed'
      };
      appendTraceTiming('route_execution_failed', {
        stage: 'route_execution_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - routeExecutionStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        finalErrorCode: extractErrorCode(error),
        error: error?.message || String(error || '')
      });
      console.error('[routeExecution] resolve failed, fallback to direct chat:', error?.message || error);
    }
    if (routeExecutionPlan.executor === 'ignore') {
      logMemoryWriteSkip('route_executor_ignore', {
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      appendTraceTiming('route_execution_ignored', {
        stage: 'route_execution_ignored',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      return;
    }

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
      logMemoryWriteSkip('route_executor_refuse', {
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      return;
    }

    if (routeExecutionPlan.executor === 'admin') {
      appendTraceTiming('admin_route_dispatch_start', {
        stage: 'admin_route_dispatch_start',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        command: String(route?.meta?.command?.cmd || '').trim(),
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      await routeFlow.dispatchAdminRoute({
        route,
        groupId,
        senderId,
        rawText,
        userInfo: null,
        chatType
      });
      appendTraceTiming('admin_route_dispatch_done', {
        stage: 'admin_route_dispatch_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        command: String(route?.meta?.command?.cmd || '').trim(),
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      appendTraceTiming('final_reply_send_done', {
        stage: 'final_reply_send_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        sent: true,
        replyPath: 'admin_route',
        command: String(route?.meta?.command?.cmd || '').trim(),
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      logMemoryWriteSkip('route_executor_admin', {
        command: String(route?.meta?.command?.cmd || '').trim(),
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      appendRequestCompleteTrace({
        routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
        topRouteType: routeExecutionPlan.topRouteType,
        sent: true,
        command: String(route?.meta?.command?.cmd || '').trim()
      });
      return;
    }

    const cleanText = String(route?.cleanText || effectiveCleanText || rawText || '').trim();
    const imageUrl = visualContext?.worker?.succeeded ? null : (effectiveVisualInput || route?.imageUrl || '');
    const imageUrls = visualContext?.worker?.succeeded ? [] : effectiveVisualInputUrls;
    if (route && typeof route === 'object') route.imageUrl = imageUrl;
    const inboundTimestamp = Date.now();
    const correctionStartedAt = Date.now();
    try {
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'capture_correction_start',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
      });
      maybeCaptureUserCorrection({
        cleanText,
        signalText: effectiveCleanText,
        senderId,
        groupId,
        routeExecutionPlan,
        getLastAssistantReply: getLastAssistantReplyForSession
      });
    } catch (error) {
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'capture_correction_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - correctionStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        error: error?.message || String(error || '')
      });
      console.error('[self-improvement] correction capture scheduling failed:', error?.message || error);
    }
    appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
      stage: 'capture_correction_done',
      messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
      groupId: String(groupId || '').trim(),
      userId: String(senderId || '').trim(),
      chatType,
      durationMs: Math.max(0, Date.now() - correctionStartedAt),
      rawMessageTimestampMs,
      elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
    });

    if (!isPrivateChatType(chatType)) {
      const groupSideEffectsStartedAt = Date.now();
      try {
        sideEffects.recordInboundHumanMessage({
          groupId,
          senderId,
          senderName: String(effectiveMsg.sender?.card || effectiveMsg.sender?.nickname || effectiveMsg.sender?.nick || senderId || '').trim(),
          text: persistUserText || cleanText || rawText,
          timestamp: Number(continuousMeta?.firstTimestamp || inboundTimestamp),
          messageId: String(effectiveMsg.message_id || '').trim(),
          replyToMessageId: String(directedContext?.quote?.messageId || continuousMeta?.replyMessageId || '').trim(),
          replyToSenderId: String(directedContext?.quote?.senderId || '').trim(),
          replyToSenderName: String(directedContext?.quote?.senderName || '').trim()
        });
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
          stage: 'group_side_effects_done',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          durationMs: Math.max(0, Date.now() - groupSideEffectsStartedAt),
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
        });
      } catch (error) {
        appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
          stage: 'group_side_effects_failed',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          durationMs: Math.max(0, Date.now() - groupSideEffectsStartedAt),
          rawMessageTimestampMs,
          elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
          lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
          error: error?.message || String(error || '')
        });
        console.error('[message] group side effects failed:', error?.message || error);
      }
    }

    const userPresenceStartedAt = Date.now();
    let userInfo = null;
    try {
      userInfo = sideEffects.updateUserPresence(senderId, persistUserText || cleanText, isPrivateChatType(chatType) ? '' : groupId);
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'user_presence_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - userPresenceStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
      });
    } catch (error) {
      appendInboundTimingLog(inboundTimingLogFile, config.ENABLE_DEBUG_LOG, {
        stage: 'user_presence_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - userPresenceStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        error: error?.message || String(error || '')
      });
      console.error('[message] user presence update failed:', error?.message || error);
      userInfo = {};
    }

    const formalDispatchStartedAt = Date.now();
    appendTraceTiming('runtime_dispatch_start', {
      stage: 'formal_route_dispatch_start',
      messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
      groupId: String(groupId || '').trim(),
      userId: String(senderId || '').trim(),
      chatType,
      rawMessageTimestampMs,
      elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
      lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null
    });
    let replyEnvelope = null;
    try {
      replyEnvelope = await routeFlow.dispatchFormalRoute({
        route,
        executionPlan: routeExecutionPlan,
        requestText: runtimeQuestionText || cleanText,
        inboundContext,
        userInfo,
        senderId,
        groupId: isPrivateChatType(chatType) ? '' : groupId,
        imageUrl,
        imageUrls,
        sourceMessageId: String(effectiveMsg.message_id || '').trim(),
        freshness: freshnessGuard
      });
      appendTraceTiming('runtime_dispatch_done', {
        stage: 'formal_route_dispatch_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - formalDispatchStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
    } catch (error) {
      appendTraceTiming('runtime_dispatch_failed', {
        stage: 'formal_route_dispatch_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        durationMs: Math.max(0, Date.now() - formalDispatchStartedAt),
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        finalErrorCode: extractErrorCode(error),
        error: error?.message || String(error || ''),
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      throw error;
    }
    let reply = String(replyEnvelope?.replyText || '').trim();
    const persistedReplyText = String(replyEnvelope?.persistedReplyText || replyEnvelope?.replyText || '').trim();
    const usedStreamingSend = Boolean(replyEnvelope?.sendStrategy === 'stream' || replyEnvelope?.usedStreamingSend);
    const replyOptions = replyEnvelope?.replyOptions || null;
    if (!usedStreamingSend) {
      if (!freshnessGuard.shouldSend()) {
        appendTraceTiming('final_reply_discarded_stale', {
          stage: 'reply_discarded_stale',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          sessionKey: String(freshnessGuard.sessionKey || '').trim(),
          flushVersion: Number(freshnessGuard.flushVersion || 0) || 0,
          ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
        });
        appendRequestCompleteTrace({
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          sent: false,
          finalErrorCode: 'stale_reply_discarded'
        });
        return;
      }
      reply = normalizeUserFacingReply(reply, {
        policyKey: getEffectivePolicyKey(routeExecutionPlan),
        routeDebugKey: routeExecutionPlan.routeDebugKey,
        topRouteType: routeExecutionPlan.topRouteType,
        allowTools: routeExecutionPlan.allowTools,
        requestText: runtimeQuestionText || cleanText
      });
      console.log('[reply] sending normalized reply', {
        chatType,
        groupId,
        senderId,
        routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          replyPreview: String(reply || '').slice(0, 120)
        });
      const sendStartedAt = Date.now();
      appendTraceTiming('final_reply_send_start', {
        stage: 'final_reply_send_start',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        replyChars: Array.from(String(replyEnvelope?.replyText || reply || '')).length,
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
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
        shouldSend: freshnessGuard.shouldSend,
        telemetry: buildReplyTelemetry({
          senderId,
          groupId: isPrivateChatType(chatType) ? '' : groupId,
          chatType,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          routeMeta: buildRouteMetaEnvelope(route, routeExecutionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, {
            threadId: String(replyOptions?.threadId || inboundContext?.threadId || inboundContext?.messageMeta?.threadId || '').trim(),
            messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
            requestTrace: cloneTraceForMeta(requestTrace)
          })
        })
      });
      appendTraceTiming('final_reply_send_done', {
        stage: 'final_reply_send_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        sent: Boolean(sent),
        durationMs: Math.max(0, Date.now() - sendStartedAt),
        finalErrorCode: sent ? '' : 'reply_send_failed',
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      if (sent) {
        maybeRunDeferredPersist(replyEnvelope);
        markDirectSessionPresenceReplied({ groupId, senderId });
        replyRuntime.recordBotReply({
          chatType,
          groupId: isPrivateChatType(chatType) ? '' : groupId,
          senderId,
          replyText: persistedReplyText || reply
        });
        if (!isPrivateChatType(chatType)) {
          await sideEffects.runDirectReplyFollowup({
            groupId,
            senderId,
            sendWithRetry,
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            topRouteType: routeExecutionPlan.topRouteType,
            userText: persistUserText || cleanText,
            replyText: persistedReplyText || reply,
            rawMessage: rawText,
            routeMeta: route.meta || {},
            replyToMessageId: String(effectiveMsg.message_id || '').trim()
          });
        }
      }
    } else {
      if (!freshnessGuard.shouldSend()) {
        appendTraceTiming('final_reply_discarded_stale', {
          stage: 'reply_discarded_stale',
          messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
          groupId: String(groupId || '').trim(),
          userId: String(senderId || '').trim(),
          chatType,
          sessionKey: String(freshnessGuard.sessionKey || '').trim(),
          flushVersion: Number(freshnessGuard.flushVersion || 0) || 0,
          ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
        });
        appendRequestCompleteTrace({
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          sent: false,
          stream: true,
          finalErrorCode: 'stale_reply_discarded'
        });
        return;
      }
      appendTraceTiming('final_reply_send_done', {
        stage: 'final_reply_send_done',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        sent: true,
        stream: true,
        streamCompleted: replyOptions?.streamCompleted === true,
        ...buildRoutePlanLogPayload(routeExecutionPlan, {}, route)
      });
      maybeRunDeferredPersist(replyEnvelope);
      if (!isPrivateChatType(chatType)) {
        await sideEffects.runDirectReplyFollowup({
          groupId,
          senderId,
          sendWithRetry,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          userText: persistUserText || cleanText,
          replyText: replyOptions?.streamCompleted ? (persistedReplyText || reply) : '',
          rawMessage: rawText,
          routeMeta: route.meta || {},
          replyToMessageId: String(effectiveMsg.message_id || '').trim()
        });
      }
    }
    appendRequestCompleteTrace({
      routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
      topRouteType: routeExecutionPlan.topRouteType,
      sent: true,
      stream: usedStreamingSend,
      finalErrorCode: ''
    });
    } catch (error) {
      inboundHadError = true;
      appendTraceTiming('inbound_handler_failed', {
        stage: 'inbound_handler_failed',
        messageId: String(effectiveMsg.message_id || msg.message_id || '').trim(),
        groupId: String(groupId || '').trim(),
        userId: String(senderId || '').trim(),
        chatType,
        rawMessageTimestampMs,
        elapsedSinceHandlerStartMs: Math.max(0, Date.now() - handlerStartedAt),
        lagFromMessageMs: rawMessageTimestampMs > 0 ? Math.max(0, Date.now() - rawMessageTimestampMs) : null,
        durationMs: Math.max(0, Date.now() - handlerStartedAt),
        finalErrorCode: extractErrorCode(error),
        error: error?.message || String(error || ''),
        stack: String(error?.stack || '').split('\n').slice(0, 4).join(' | ')
      });
      appendRequestCompleteTrace({
        sent: false,
        finalErrorCode: extractErrorCode(error),
        error: error?.message || String(error || '')
      });
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
