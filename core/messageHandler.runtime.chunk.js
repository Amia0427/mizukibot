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
  backgroundTaskRuntime.expireSessions();
  const routeResolver = typeof detectIntentHybridOverride === 'function'
    ? detectIntentHybridOverride
    : detectIntentHybrid;
  function buildSessionId(userId, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const explicitSessionId = String(opts.sessionId || opts.session_id || opts.sessionKey || opts.session_key || '').trim();
    if (explicitSessionId) return explicitSessionId;

    const senderId = String(userId || opts.userId || opts.user_id || '').trim();
    const sessionChatId = String(opts.sessionChatId || opts.session_chat_id || opts.chatId || opts.chat_id || '').trim();
    const groupMatch = /^group_(.+)_user_(.+)$/.exec(sessionChatId);
    if (groupMatch) {
      return resolveShortTermSessionKey(groupMatch[2] || senderId, { groupId: groupMatch[1] });
    }

    const directMatch = /^direct_(.+)$/.exec(sessionChatId);
    if (directMatch) {
      return resolveShortTermSessionKey(directMatch[1], {});
    }

    const groupId = String(opts.groupId || opts.group_id || '').trim();
    const channelId = String(opts.channelId || opts.channel_id || '').trim();
    const routeMeta = {};
    if (groupId) routeMeta.groupId = groupId;
    if (channelId) routeMeta.channelId = channelId;
    return resolveShortTermSessionKey(senderId, routeMeta) || [opts.sessionChannel, sessionChatId, senderId].filter(Boolean).join(':');
  }
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
        createScheduledCommand
      });
    }
    return adminCoordinator;
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
    void getBackgroundTaskCoordinator();
    void getVisualContextTools();
  }
  const runBackgroundToolTask = (...args) => getBackgroundTaskCoordinator().runBackgroundToolTask(...args);
  const maybeRunDeferredPersist = telemetryCoordinator.maybeRunDeferredPersist;
  const handleSessionSummaryCommand = (...args) => getAdminCoordinator().handleSessionSummaryCommand(...args);
  const handleInitiativeAdminCommand = (...args) => getAdminCoordinator().handleInitiativeAdminCommand(...args);
  const handleMemoryOpsAdminCommand = (...args) => getAdminCoordinator().handleMemoryOpsAdminCommand(...args);
  const handleRestartAdminCommand = (...args) => getAdminCoordinator().handleRestartAdminCommand(...args);
  const handleQqScheduleAdminCommand = (...args) => getAdminCoordinator().handleQqScheduleAdminCommand(...args);
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
    buildStreamingSegmentationPrompt: cachedPromptHelpers.buildStreamingSegmentationPrompt,
    shouldPreferQqRichReply,
    buildQqRichReplyPrompt: cachedPromptHelpers.buildQqRichReplyPrompt,
    getEffectivePolicyKey,
    sendGroupReply: (...args) => replyRuntime.sendGroupReply(...args),
    runBackgroundToolTask,
    config
  });
  const handleBackgroundTaskControl = (...args) => taskControlCoordinator.handleBackgroundTaskControl(...args);
  const dispatchCoordinator = createMessageDispatchCoordinator({
    config,
    buildRoutePromptBundle,
    getStreamMaxSegments,
    buildToolGuidancePrompt: cachedPromptHelpers.buildToolGuidancePrompt,
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
