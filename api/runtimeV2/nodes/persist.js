const {
  detectPostReplyLearningIntent,
  isExplicitRememberText
} = require('../../../utils/postReplyWorker/learningIntent');
const {
  isPostReplyRecapText
} = require('../../../utils/postReplyWorker/recapPolicy');
const { isUnsafeUserFacingReply } = require('../../../utils/userFacingReplyGuards');

function createPersistNode(deps = {}) {
  const normalizeObject = typeof deps.normalizeObject === 'function'
    ? deps.normalizeObject
    : ((value, fallback = {}) => (value && typeof value === 'object' ? value : fallback));
  const normalizeArray = typeof deps.normalizeArray === 'function'
    ? deps.normalizeArray
    : ((value) => (Array.isArray(value) ? value : []));
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const isReviewMode = typeof deps.isReviewMode === 'function'
    ? deps.isReviewMode
    : (() => false);
  const isChatLikeRoute = typeof deps.isChatLikeRoute === 'function'
    ? deps.isChatLikeRoute
    : (() => false);
  const shouldAppendDailyJournalForV2 = typeof deps.shouldAppendDailyJournalForV2 === 'function'
    ? deps.shouldAppendDailyJournalForV2
    : (() => false);
  const shouldQueueMemoryLearningForV2 = typeof deps.shouldQueueMemoryLearningForV2 === 'function'
    ? deps.shouldQueueMemoryLearningForV2
    : (() => false);
  const shouldLearnSelfImprovement = typeof deps.shouldLearnSelfImprovement === 'function'
    ? deps.shouldLearnSelfImprovement
    : (() => false);
  const compressShortTermHistoryIfNeeded = typeof deps.compressShortTermHistoryIfNeeded === 'function'
    ? deps.compressShortTermHistoryIfNeeded
    : (async () => ({ compressed: false }));
  const summarizeShortTermChunk = typeof deps.summarizeShortTermChunk === 'function'
    ? deps.summarizeShortTermChunk
    : null;
  const getSessionSummaryCooldownStatus = typeof deps.getSessionSummaryCooldownStatus === 'function'
    ? deps.getSessionSummaryCooldownStatus
    : (() => ({ limited: false, remainingMs: 0 }));
  const saveSessionContextSummary = typeof deps.saveSessionContextSummary === 'function'
    ? deps.saveSessionContextSummary
    : (() => ({ saved: false }));
  const generateSessionContextSummary = typeof deps.generateSessionContextSummary === 'function'
    ? deps.generateSessionContextSummary
    : (async () => ({ ok: false, summary: '', structured: null }));
  const appendShortTermHistory = typeof deps.appendShortTermHistory === 'function'
    ? deps.appendShortTermHistory
    : () => {};
  const persistShortTermBridgeSnapshot = typeof deps.persistShortTermBridgeSnapshot === 'function'
    ? deps.persistShortTermBridgeSnapshot
    : () => {};
  const recordPersonaMemoryOutcome = typeof deps.recordPersonaMemoryOutcome === 'function'
    ? deps.recordPersonaMemoryOutcome
    : (async () => ({ persisted: false, updatedSlots: {} }));
  const appendMemoryEvent = typeof deps.appendMemoryEvent === 'function'
    ? deps.appendMemoryEvent
    : (async () => {});
  const materializeMemoryViews = typeof deps.materializeMemoryViews === 'function'
    ? deps.materializeMemoryViews
    : (() => null);
  const addProfileItem = typeof deps.addProfileItem === 'function'
    ? deps.addProfileItem
    : () => {};
  const pickRouteMetaForPostReplyJob = typeof deps.pickRouteMetaForPostReplyJob === 'function'
    ? deps.pickRouteMetaForPostReplyJob
    : ((routeMeta) => routeMeta || {});
  const stableHash = typeof deps.stableHash === 'function'
    ? deps.stableHash
    : ((value) => JSON.stringify(value || {}));
  const postReplyJobQueue = deps.postReplyJobQueue && typeof deps.postReplyJobQueue.enqueue === 'function'
    ? deps.postReplyJobQueue
    : { enqueue() { return { enqueued: false, job: null }; } };
  const appendRequestTraceEvent = typeof deps.appendRequestTraceEvent === 'function'
    ? deps.appendRequestTraceEvent
    : (() => {});
  const normalizeRequestTrace = typeof deps.normalizeRequestTrace === 'function'
    ? deps.normalizeRequestTrace
    : ((value) => (value && typeof value === 'object' && String(value.requestId || value.request_id || '').trim() ? value : null));
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);
  const config = normalizeObject(deps.config, {});
  const chatHistory = deps.chatHistory;
  const shortTermMemory = deps.shortTermMemory;
  const logPostReplyEnqueueError = typeof deps.logPostReplyEnqueueError === 'function'
    ? deps.logPostReplyEnqueueError
    : (() => {});
  const recordVisualContextImages = typeof deps.recordVisualContextImages === 'function'
    ? deps.recordVisualContextImages
    : ((visualContext, context) => {
        try {
          return require('../../../utils/imageMemoryIndex').recordVisualContextImages(visualContext, context);
        } catch (_) {
          return [];
        }
      });
  const ingestOpenVikingTurnAsync = typeof deps.ingestOpenVikingTurnAsync === 'function'
    ? deps.ingestOpenVikingTurnAsync
    : ((input = {}) => {
        try {
          return require('../../../utils/openVikingMemory/ingest').ingestTurnAsync(input);
        } catch (_) {
          return undefined;
        }
      });
  const postReplyLastEnqueueAtByUser = new Map();

  function normalizeText(value) {
    return String(value || '').trim();
  }

  function buildCoreAggregateKey({ userId, sessionKey, groupId }) {
    return ['core', normalizeText(userId) || 'unknown', normalizeText(sessionKey) || 'unknown', normalizeText(groupId) || 'nogroup'].join('|');
  }

  function buildAggregateAvailableAt(firstQueuedAt, lastMergedAt) {
    const aggregateWindowMs = Math.max(0, Number(config.POST_REPLY_AGGREGATE_WINDOW_MS) || 0);
    const idleFlushMs = Math.max(0, Number(config.POST_REPLY_IDLE_FLUSH_MS) || 0);
    const firstTs = Date.parse(String(firstQueuedAt || ''));
    const lastTs = Date.parse(String(lastMergedAt || ''));
    const candidates = [];
    if (Number.isFinite(firstTs) && aggregateWindowMs > 0) candidates.push(firstTs + aggregateWindowMs);
    if (Number.isFinite(lastTs) && idleFlushMs > 0) candidates.push(lastTs + idleFlushMs);
    if (candidates.length === 0) return normalizeText(lastMergedAt) || normalizeText(firstQueuedAt) || new Date().toISOString();
    return new Date(Math.min(...candidates)).toISOString();
  }

  function buildPostReplyTurnId({ routeMeta = {}, sessionKey = '', createdAt = '', userContent = '', finalReply = '' } = {}) {
    const explicit = normalizeText(routeMeta.messageId || routeMeta.message_id);
    if (explicit) return explicit;
    return stableHash({
      sessionKey: normalizeText(sessionKey),
      createdAt: normalizeText(createdAt),
      userContent: String(userContent || '').slice(0, 1000),
      finalReply: String(finalReply || '').slice(0, 1000)
    });
  }

  function buildPostReplyTurnEvidence({ routeMeta = {}, userContent = '', finalReply = '', createdAt = '', routePolicyKey = '', topRouteType = '' } = {}) {
    return {
      userText: String(userContent || '').slice(0, 500),
      assistantText: String(finalReply || '').slice(0, 500),
      createdAt: normalizeText(createdAt),
      routePolicyKey: normalizeText(routePolicyKey),
      topRouteType: normalizeText(topRouteType || routeMeta.topRouteType),
      messageId: normalizeText(routeMeta.messageId || routeMeta.message_id)
    };
  }

  function buildPersistGateReasons({
    request,
    state,
    userContent,
    finalReply,
    routeGroupId,
    allowedPostReplyGroupIds,
    hasEnoughPostReplyContent,
    postReplyCooldownReady,
    shouldAllowPostReplyForGroup,
    explicitPostReplyMemoryBypassGroup,
    postReplyRecapQuery
  }) {
    const reasons = [];
    if (request.systemInitiated) reasons.push('system_initiated');
    if (state.output?.failure) reasons.push('output_failure');
    if (isUnsafeUserFacingReply(finalReply)) reasons.push('unsafe_user_facing_reply');
    if (!userContent) reasons.push('empty_user_content');
    if (!finalReply) reasons.push('empty_final_reply');
    if (isReviewMode(request.reviewMode)) reasons.push('review_mode');
    if (String(request.customPrompt || '').trim()) reasons.push('custom_prompt');
    if (!hasEnoughPostReplyContent) reasons.push('post_reply_min_chars');
    if (!postReplyCooldownReady) reasons.push('post_reply_cooldown');
    if (postReplyRecapQuery) reasons.push('post_reply_recap_query');
    if (!routeGroupId && !explicitPostReplyMemoryBypassGroup) reasons.push('post_reply_no_group');
    if (allowedPostReplyGroupIds.length === 0 && !explicitPostReplyMemoryBypassGroup) reasons.push('post_reply_no_group_allowlist');
    if (routeGroupId && allowedPostReplyGroupIds.length > 0 && !shouldAllowPostReplyForGroup && !explicitPostReplyMemoryBypassGroup) {
      reasons.push('post_reply_group_not_allowed');
    }
    return reasons;
  }

  return async function persistNode(state) {
    const request = normalizeObject(state.request, {});
    const requestTrace = normalizeRequestTrace(request.requestTrace)
      || normalizeRequestTrace(request.routeMeta?.requestTrace);
    const persistStartedAt = Date.now();
    const emitPersistTrace = (stage = '', payload = {}) => {
      if (!requestTrace) return;
      const buildTracePayload = typeof deps.nextTracePhase === 'function'
        ? deps.nextTracePhase
        : ((trace, phase, value = {}) => ({
            requestId: String(trace?.requestId || trace?.request_id || '').trim(),
            phaseSeq: Number.isFinite(Number(trace?.phaseSeq || trace?.phase_seq))
              ? Math.max(0, Math.floor(Number(trace.phaseSeq || trace.phase_seq)))
              : null,
            tracePhase: phase,
            ...value
          }));
      appendRequestTraceEvent(buildTracePayload(requestTrace, stage || 'persist', {
        tracePhase: stage || 'persist',
        stage: stage || 'persist',
        source: 'runtimeV2.persist',
        userId: String(request.userId || '').trim(),
        routePolicyKey: String(request.routePolicyKey || request.routeMeta?.routePolicyKey || '').trim(),
        topRouteType: String(request.topRouteType || request.routeMeta?.topRouteType || '').trim(),
        durationMs: Math.max(0, Date.now() - persistStartedAt),
        ...payload
      }));
    };
    emitPersistTrace('persist_start');
    const finalReply = String(state.output?.finalReply || state.output?.draftReply || '').trim();
    const latencyDecision = normalizeObject(state.execution?.latencyDecision, {});
    const persistMode = String(config.FAST_REPLY_PERSIST_MODE || '').trim().toLowerCase();
    const fastCommitMode = persistMode === 'fast_commit';
    const userContent = String(
      request.persistUserText
      || request.runtimeQuestionText
      || (request.imageUrl ? (request.question || '[shared an image]') : (request.question || ''))
    ).trim();
    const shouldPersistChatArtifacts = (
      !request.systemInitiated
      && !state.output?.failure
      && userContent
      && finalReply
      && !isUnsafeUserFacingReply(finalReply)
      && !isReviewMode(request.reviewMode)
    );
    const explicitPostReplyMemoryRequest = isExplicitRememberText(userContent);
    const postReplyRecapQuery = !explicitPostReplyMemoryRequest && isPostReplyRecapText(userContent);
    const shouldPersistBridge = shouldPersistChatArtifacts
      && isChatLikeRoute(request);
    const shouldPersistJournal = shouldPersistChatArtifacts
      && !postReplyRecapQuery
      && shouldAppendDailyJournalForV2(request, finalReply);
    const shouldLearn = shouldPersistChatArtifacts
      && !postReplyRecapQuery
      && shouldQueueMemoryLearningForV2(request, finalReply);
    const shouldLearnSelfImprovementValue = shouldPersistChatArtifacts
      && !postReplyRecapQuery
      && shouldLearnSelfImprovement(request, finalReply);
    const normalizedUserId = String(request.userId || '').trim();
    const visualContext = normalizeObject(request.visualContext || request.routeMeta?.visualContext, null);
    if (visualContext?.hasVisualInput === true) {
      recordVisualContextImages(visualContext, {
        userId: normalizedUserId,
        groupId: String(request.routeMeta?.groupId || request.routeMeta?.group_id || '').trim(),
        sessionKey: String(request.sessionKey || '').trim(),
        messageId: String(request.routeMeta?.messageId || request.routeMeta?.message_id || '').trim(),
        userText: userContent
      });
    }
    const postReplyContentChars = Array.from(`${userContent}\n${finalReply}`.replace(/\s+/g, '')).length;
    const minPostReplyContentChars = Math.max(0, Number(config.POST_REPLY_MIN_CONTENT_CHARS) || 0);
    const hasEnoughPostReplyContent = postReplyContentChars >= minPostReplyContentChars;
    const postReplyUserCooldownMs = Math.max(0, Number(config.POST_REPLY_USER_COOLDOWN_MS) || 0);
    const lastPostReplyEnqueueAt = Math.max(0, Number(postReplyLastEnqueueAtByUser.get(normalizedUserId) || 0) || 0);
    const now = Date.now();
    const postReplyCooldownReady = !normalizedUserId
      || !postReplyUserCooldownMs
      || !lastPostReplyEnqueueAt
      || (now - lastPostReplyEnqueueAt) >= postReplyUserCooldownMs;
    const routeGroupId = String(request.routeMeta?.groupId || request.routeMeta?.group_id || '').trim();
    const allowedPostReplyGroupIds = Array.isArray(config.POST_REPLY_WORKER_GROUP_IDS)
      ? config.POST_REPLY_WORKER_GROUP_IDS.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const shouldAllowPostReplyForGroup = routeGroupId
      && allowedPostReplyGroupIds.length > 0
      && allowedPostReplyGroupIds.includes(routeGroupId);
    const explicitPostReplyMemoryBypassGroup = Boolean(
      config.POST_REPLY_EXPLICIT_MEMORY_BYPASS_GROUP_ALLOWLIST === true
      && explicitPostReplyMemoryRequest
    );
    const shouldRunGroupScopedPostReplyTasks = Boolean(
      shouldAllowPostReplyForGroup
      || explicitPostReplyMemoryBypassGroup
    );
    const shouldQueuePostReplyMemoryTasks = shouldRunGroupScopedPostReplyTasks
      && (shouldLearn || shouldLearnSelfImprovementValue);
    const shouldQueuePostReplyJournalTask = Boolean(shouldPersistJournal);
    const shouldEnqueuePostReplyJob = shouldPersistChatArtifacts
      && hasEnoughPostReplyContent
      && postReplyCooldownReady
      && (shouldQueuePostReplyMemoryTasks || shouldQueuePostReplyJournalTask);
    const persistDecisionPayload = {
      userId: normalizedUserId,
      sessionKey: String(request.sessionKey || '').trim(),
      groupId: routeGroupId,
      channelId: String(request.routeMeta?.channelId || request.routeMeta?.channel_id || '').trim(),
      sessionId: String(request.routeMeta?.sessionId || request.routeMeta?.session_id || '').trim(),
      threadId: String(state.thread?.threadId || '').trim(),
      routePolicyKey: String(request.routePolicyKey || '').trim(),
      topRouteType: String(request.topRouteType || request.routeMeta?.topRouteType || '').trim(),
      saved: Boolean(shouldPersistChatArtifacts),
      shouldPersistBridge: Boolean(shouldPersistBridge),
      shouldPersistJournal: Boolean(shouldPersistJournal),
      shouldLearn: Boolean(shouldLearn),
      shouldLearnSelfImprovement: Boolean(shouldLearnSelfImprovementValue),
      shouldQueuePostReplyMemoryTasks: Boolean(shouldQueuePostReplyMemoryTasks),
      shouldQueuePostReplyJournalTask: Boolean(shouldQueuePostReplyJournalTask),
      shouldEnqueuePostReplyJob: Boolean(shouldEnqueuePostReplyJob),
      postReplyRecapQuery: Boolean(postReplyRecapQuery),
      userContentChars: Array.from(userContent).length,
      finalReplyChars: Array.from(finalReply).length,
      gateReasons: buildPersistGateReasons({
        request,
        state,
        userContent,
        finalReply,
        routeGroupId,
        allowedPostReplyGroupIds,
        hasEnoughPostReplyContent,
        postReplyCooldownReady,
        shouldAllowPostReplyForGroup,
        explicitPostReplyMemoryBypassGroup,
        postReplyRecapQuery
      })
    };
    let enqueuedPostReplyJob = null;
    const pendingReplySnapshot = {
      finalReply,
      activeTopic: String(state.memory?.continuityState?.payload?.active_topic || '').trim(),
      openLoops: normalizeArray(state.memory?.continuityState?.payload?.open_loops),
      assistantCommitments: normalizeArray(state.memory?.continuityState?.payload?.assistant_commitments),
      userConstraints: normalizeArray(state.memory?.continuityState?.payload?.user_constraints),
      toolSummary: normalizeArray(state.plan?.finalExecLogs)
        .map((item) => {
          const action = String(item?.action || '').trim();
          const ok = item?.ok === true ? 'ok' : 'fail';
          return action ? `${action}:${ok}` : '';
        })
        .filter(Boolean)
        .join(', ')
    };

    if (latencyDecision.deferPersist === true || request.deferPersist === true) {
      console.log('[memory-write] persist deferred', {
        ...persistDecisionPayload,
        deferPersist: true
      });
      const deferredEvents = [
        createEvent('node_start', { node: 'persist' }),
        createEvent('persist_deferred', {
          node: 'persist',
          ...persistDecisionPayload,
          finalReplyPreview: finalReply.slice(0, 180)
        }),
        createEvent('node_complete', { node: 'persist' })
      ];
      emitPersistTrace('persist_deferred', {
        saved: Boolean(shouldPersistChatArtifacts),
        shouldPersistBridge: Boolean(shouldPersistBridge),
        shouldLearn: Boolean(shouldLearn),
        gateReasons: persistDecisionPayload.gateReasons
      });
      return saveAndEmit({
        ...state,
        execution: {
          ...state.execution,
          currentNode: 'persist',
          pendingReplySnapshot,
          deferredJobs: normalizeArray(state.execution?.deferredJobs).concat([{
            type: 'persist',
            status: 'queued',
            queuedAt: new Date(now).toISOString()
          }])
        },
        memory: {
          ...state.memory,
          pendingReplySnapshot
        },
        events: deferredEvents
      }, 'persist', 'completed', deferredEvents);
    }

    console.log('[memory-write] persist decision', persistDecisionPayload);

    if (shouldPersistChatArtifacts) {
      try {
        ingestOpenVikingTurnAsync({
          userId: request.userId,
          senderId: request.routeMeta?.senderId || request.routeMeta?.sender_id || request.userId,
          groupId: routeGroupId,
          channelId: request.routeMeta?.channelId || request.routeMeta?.channel_id || '',
          sessionKey: request.sessionKey,
          sessionId: request.routeMeta?.sessionId || request.routeMeta?.session_id || '',
          platform: request.routeMeta?.platform || request.routeMeta?.channel || 'qq',
          routePolicyKey: request.routePolicyKey,
          topRouteType: request.topRouteType,
          senderName: request.userInfo?.name || request.userInfo?.nickname || request.routeMeta?.senderName || request.routeMeta?.sender_name || '',
          userText: userContent,
          assistantText: finalReply
        });
      } catch (_) {}
      if (config.MEMORY_V3_ENABLED) {
        await appendMemoryEvent({
          type: 'turn_replied',
          userId: request.userId,
          sessionKey: request.sessionKey,
          groupId: request.routeMeta?.groupId || request.routeMeta?.group_id || '',
          channelId: request.routeMeta?.channelId || request.routeMeta?.channel_id || '',
          sessionId: request.routeMeta?.sessionId || request.routeMeta?.session_id || '',
          routePolicyKey: request.routePolicyKey,
          topRouteType: request.topRouteType,
          scopeType: (request.routeMeta?.groupId || request.routeMeta?.group_id) ? 'group' : 'personal',
          source: 'runtime_v2_persist',
          text: finalReply,
          payload: {
            question: userContent,
            continuitySnapshot: {
              activeTopic: String(state.memory?.continuityState?.payload?.active_topic || '').trim(),
              openLoops: normalizeArray(state.memory?.continuityState?.payload?.open_loops),
              assistantCommitments: normalizeArray(state.memory?.continuityState?.payload?.assistant_commitments),
              userConstraints: normalizeArray(state.memory?.continuityState?.payload?.user_constraints),
              carryOverUserTurn: String(state.memory?.continuityState?.payload?.carry_over_user_turn || '').trim()
            }
          }
        });
        if (!fastCommitMode) {
          materializeMemoryViews();
        }
      }
      appendShortTermHistory(request.userId, userContent, finalReply, request.userInfo, {
        chatHistory,
        shortTermMemory,
        routeMeta: request.routeMeta,
        sessionKey: request.sessionKey
      });

      if (typeof summarizeShortTermChunk === 'function') {
        await compressShortTermHistoryIfNeeded(request.userId, request.userInfo, {
          chatHistory,
          shortTermMemory,
          routeMeta: request.routeMeta,
          sessionKey: request.sessionKey,
          summarizeChunk: (payload = {}) => summarizeShortTermChunk({
            ...payload,
            request
          })
        });
      }

      if (shouldPersistBridge) {
        if (config.MEMORY_V3_ENABLED) {
          const stateSlice = shortTermMemory?.[request.sessionKey] || {};
          const historySlice = Array.isArray(chatHistory?.[request.sessionKey]) ? chatHistory[request.sessionKey] : [];
          const summarySource = String(stateSlice.summarySource || '').trim().toLowerCase();
          const sessionRecentMessagesLimit = Math.max(1, Math.floor(Number(config.MEMORY_V3_SESSION_RECENT_MESSAGES || 64) || 64));
          const persistedSummary = summarySource === 'restart_recall'
            ? ''
            : String(stateSlice.summary || '').trim();
          const persistedActiveTopic = summarySource === 'restart_recall'
            ? ''
            : String(stateSlice.activeTopic || '').trim();
          await appendMemoryEvent({
            type: 'session_checkpoint',
            userId: request.userId,
            sessionKey: request.sessionKey,
            groupId: request.routeMeta?.groupId || request.routeMeta?.group_id || '',
            channelId: request.routeMeta?.channelId || request.routeMeta?.channel_id || '',
            sessionId: request.routeMeta?.sessionId || request.routeMeta?.session_id || '',
            routePolicyKey: request.routePolicyKey,
            topRouteType: request.topRouteType,
            scopeType: 'session',
            source: 'runtime_v2_persist',
            payload: {
              snapshotType: 'post_reply',
              activeTopic: persistedActiveTopic,
              summary: persistedSummary,
              carryOverUserTurn: String(stateSlice.carryOverUserTurn || '').trim(),
              openLoops: normalizeArray(stateSlice.openLoops),
              assistantCommitments: normalizeArray(stateSlice.assistantCommitments),
              userConstraints: normalizeArray(stateSlice.userConstraints),
              recentMessages: historySlice.slice(-sessionRecentMessagesLimit)
            }
          });
          if (!fastCommitMode) {
            materializeMemoryViews();
          }
        }
        persistShortTermBridgeSnapshot(request.userId, {
          chatHistory,
          shortTermMemory,
          routeMeta: request.routeMeta,
          sessionKey: request.sessionKey,
          scope: state.thread?.sessionScope,
          snapshotType: 'post_reply'
        });
      }

      if (shouldPersistBridge && !fastCommitMode) {
        const summaryCooldown = getSessionSummaryCooldownStatus(request.sessionKey, now);
        if (!summaryCooldown.limited) {
          try {
            const summaryResult = await generateSessionContextSummary({
              userId: request.userId,
              sessionKey: request.sessionKey,
              routeMeta: request.routeMeta,
              chatHistory,
              shortTermMemory
            });
            const summaryText = String(summaryResult?.summary || '').trim();
            if (summaryText) {
              saveSessionContextSummary({
                sessionKey: request.sessionKey,
                userId: request.userId,
                groupId: routeGroupId,
                trigger: 'auto_post_reply',
                summary: summaryText,
                structured: summaryResult?.structured || null
              }, {
                now
              });
            }
          } catch (_) {}
        }
      }

      if (!fastCommitMode) await recordPersonaMemoryOutcome('direct_chat', {
        state: state.memory?.personaMemoryState,
        request,
        routeMeta: request.routeMeta,
        userId: request.userId,
        sessionKey: request.sessionKey,
        groupId: request.routeMeta?.groupId || request.routeMeta?.group_id || '',
        routePolicyKey: request.routePolicyKey,
        topRouteType: request.topRouteType,
        summary: String(shortTermMemory?.[request.sessionKey]?.summary || '').trim(),
        activeTopic: String(shortTermMemory?.[request.sessionKey]?.activeTopic || '').trim(),
        openLoops: normalizeArray(shortTermMemory?.[request.sessionKey]?.openLoops),
        assistantCommitments: normalizeArray(shortTermMemory?.[request.sessionKey]?.assistantCommitments),
        userConstraints: normalizeArray(shortTermMemory?.[request.sessionKey]?.userConstraints),
        carryOverUserTurn: String(shortTermMemory?.[request.sessionKey]?.carryOverUserTurn || '').trim(),
        recentMessages: Array.isArray(chatHistory?.[request.sessionKey])
          ? chatHistory[request.sessionKey].slice(-Math.max(1, Math.floor(Number(config.MEMORY_V3_SESSION_RECENT_MESSAGES || 64) || 64)))
          : []
      });

      addProfileItem(request.userId, 'recent_topics', String(request.question || '').slice(0, 20), 12);
      if (shouldEnqueuePostReplyJob) {
        const routeMeta = pickRouteMetaForPostReplyJob(request.routeMeta);
        const createdAtIso = new Date(now).toISOString();
        const routeMessageId = normalizeText(routeMeta.messageId || routeMeta.message_id);
        const sourceMessageIds = [routeMessageId].filter(Boolean);
        const aggregateKey = buildCoreAggregateKey({
          userId: normalizedUserId,
          sessionKey: String(request.sessionKey || '').trim(),
          groupId: routeGroupId
        });
        const coreTurn = {
          turnId: buildPostReplyTurnId({
            routeMeta,
            sessionKey: request.sessionKey,
            createdAt: createdAtIso,
            userContent,
            finalReply
          }),
          question: userContent,
          finalReply,
          createdAt: createdAtIso,
          evidence: buildPostReplyTurnEvidence({
            routeMeta,
            userContent,
            finalReply,
            createdAt: createdAtIso,
            routePolicyKey: request.routePolicyKey,
            topRouteType: request.topRouteType
          }),
          sourceSessionId: normalizeText(routeMeta.sessionId || routeMeta.session_id || request.sessionKey),
          routeMeta,
          continuitySnapshot: {
            activeTopic: String(state.memory?.continuityState?.payload?.active_topic || '').trim(),
            openLoops: normalizeArray(state.memory?.continuityState?.payload?.open_loops),
            assistantCommitments: normalizeArray(state.memory?.continuityState?.payload?.assistant_commitments),
            userConstraints: normalizeArray(state.memory?.continuityState?.payload?.user_constraints),
            carryOverUserTurn: String(state.memory?.continuityState?.payload?.carry_over_user_turn || '').trim()
          },
          contextStats: {
            usageRatio: Number(state.memory?.contextStats?.usageRatio || state.memory?.mainConversationSnapshot?.snapshotMeta?.compactionDiagnostics?.usageRatio || 0) || 0,
            compactionLevel: String(state.memory?.contextStats?.compactionLevel || state.memory?.mainConversationSnapshot?.snapshotMeta?.compactionDiagnostics?.level || 'normal').trim() || 'normal'
          }
        };
        const traceId = stableHash({
          aggregateKey,
          turnId: coreTurn.turnId,
          threadId: String(state.thread?.threadId || '').trim(),
          createdAt: createdAtIso
        });
        const learningIntent = detectPostReplyLearningIntent({
          question: userContent,
          finalReply,
          turns: [coreTurn],
          tasks: {
            memoryLearning: shouldRunGroupScopedPostReplyTasks && shouldLearn,
            selfImprovement: shouldRunGroupScopedPostReplyTasks && shouldLearnSelfImprovementValue,
            dailyJournal: shouldQueuePostReplyJournalTask
          }
        });
        try {
          const existingQueuedCoreJob = typeof postReplyJobQueue.findQueuedJobByAggregateKey === 'function'
            ? postReplyJobQueue.findQueuedJobByAggregateKey(aggregateKey, 'core')
            : null;
          const enqueueResult = existingQueuedCoreJob
            ? {
                enqueued: false,
                job: typeof postReplyJobQueue.mergeQueuedJob === 'function'
                  ? postReplyJobQueue.mergeQueuedJob(existingQueuedCoreJob, {
                      routeMeta,
                      continuitySnapshot: coreTurn.continuitySnapshot,
                      contextStats: coreTurn.contextStats,
                      lastMergedAt: coreTurn.createdAt,
                      turns: [coreTurn],
                      traceId: existingQueuedCoreJob.traceId || traceId,
                      learningIntent,
                      sourceMessageIds: Array.from(new Set(normalizeArray(existingQueuedCoreJob.sourceMessageIds).concat(sourceMessageIds))),
                      tags: Array.from(new Set(normalizeArray(existingQueuedCoreJob.tags).concat(['runtime_v2_persist', 'core']))),
                      tasks: {
                        memoryLearning: Boolean(existingQueuedCoreJob.tasks?.memoryLearning) || (shouldRunGroupScopedPostReplyTasks && shouldLearn),
                        selfImprovement: Boolean(existingQueuedCoreJob.tasks?.selfImprovement) || (shouldRunGroupScopedPostReplyTasks && shouldLearnSelfImprovementValue),
                        dailyJournal: Boolean(existingQueuedCoreJob.tasks?.dailyJournal) || shouldQueuePostReplyJournalTask
                      },
                      userInfo: normalizeObject(request.userInfo, {})
                    }, {
                      aggregateWindowMs: Number(config.POST_REPLY_AGGREGATE_WINDOW_MS) || 0,
                      idleFlushMs: Number(config.POST_REPLY_IDLE_FLUSH_MS) || 0
                    })
                  : existingQueuedCoreJob
              }
            : postReplyJobQueue.enqueue({
                type: 'post_reply',
                phase: 'core',
                aggregateKey,
                dedupeKey: stableHash({
                  aggregateKey,
                  firstTurnAt: coreTurn.createdAt
                }),
                userId: String(request.userId || '').trim(),
                userInfo: normalizeObject(request.userInfo, {}),
                question: userContent,
                finalReply,
                routePolicyKey: String(request.routePolicyKey || '').trim(),
                topRouteType: String(request.topRouteType || routeMeta.topRouteType || '').trim(),
                routeMeta,
                traceId,
                sourceMessageIds,
                learningIntent,
                priority: shouldLearn ? 10 : 0,
                tags: ['runtime_v2_persist', 'core'],
                sessionKey: String(request.sessionKey || '').trim(),
                continuitySnapshot: coreTurn.continuitySnapshot,
                contextStats: coreTurn.contextStats,
                execLogs: normalizeArray(state.plan?.finalExecLogs),
                turns: [coreTurn],
                firstQueuedAt: coreTurn.createdAt,
                lastMergedAt: coreTurn.createdAt,
                mergeCount: 1,
                availableAt: buildAggregateAvailableAt(coreTurn.createdAt, coreTurn.createdAt),
                tasks: {
                  memoryLearning: shouldRunGroupScopedPostReplyTasks && shouldLearn,
                  selfImprovement: shouldRunGroupScopedPostReplyTasks && shouldLearnSelfImprovementValue,
                  dailyJournal: shouldQueuePostReplyJournalTask
                },
                threadId: String(state.thread?.threadId || '').trim()
              });
          console.log('[post-reply] enqueued', {
            jobId: enqueueResult.job?.jobId || '',
            aggregateKey,
            userId: String(request.userId || '').trim(),
            enqueued: Boolean(enqueueResult.enqueued)
          });
          if (enqueueResult.enqueued && normalizedUserId) {
            postReplyLastEnqueueAtByUser.set(normalizedUserId, now);
          }
          enqueuedPostReplyJob = {
            jobId: enqueueResult.job?.jobId || '',
            dedupeKey: String(enqueueResult.job?.dedupeKey || ''),
            enqueued: Boolean(enqueueResult.enqueued)
          };
        } catch (error) {
          emitPersistTrace('persist_post_reply_enqueue_failed', {
            finalErrorCode: 'post_reply_enqueue_failed',
            error: String(error?.message || error || '').slice(0, 400)
          });
          logPostReplyEnqueueError(error);
        }
      }
    }

    const events = [
      createEvent('node_start', { node: 'persist' }),
      createEvent('persist_write_decision', {
        node: 'persist',
        ...persistDecisionPayload,
        postReplyJobId: enqueuedPostReplyJob?.jobId || '',
        postReplyEnqueued: Boolean(enqueuedPostReplyJob?.enqueued)
      }),
      createEvent('persist_complete', {
        saved: shouldPersistChatArtifacts,
        shouldPersistBridge,
        shouldPersistJournal,
        shouldLearn,
        shouldEnqueuePostReplyJob,
        gateReasons: persistDecisionPayload.gateReasons,
        finalReplyPreview: finalReply.slice(0, 180),
        postReplyJobId: enqueuedPostReplyJob?.jobId || '',
        postReplyEnqueued: Boolean(enqueuedPostReplyJob?.enqueued)
      }),
      createEvent('node_complete', { node: 'persist' })
    ];
    emitPersistTrace('persist_complete', {
      saved: Boolean(shouldPersistChatArtifacts),
      shouldPersistBridge: Boolean(shouldPersistBridge),
      shouldPersistJournal: Boolean(shouldPersistJournal),
      shouldLearn: Boolean(shouldLearn),
      shouldEnqueuePostReplyJob: Boolean(shouldEnqueuePostReplyJob),
      postReplyJobId: enqueuedPostReplyJob?.jobId || ''
    });

    return saveAndEmit({
      ...state,
      memory: {
        ...state.memory,
        persisted: true,
        learningQueued: Boolean(enqueuedPostReplyJob?.jobId)
      },
      execution: {
        ...state.execution,
        currentNode: 'persist',
        status: state.output?.failure ? 'failed' : 'completed',
        pendingReplySnapshot
      },
      memory: {
        ...state.memory,
        persisted: true,
        learningQueued: Boolean(enqueuedPostReplyJob?.jobId),
        pendingReplySnapshot
      },
      events
    }, 'persist', state.output?.failure ? 'failed' : 'completed', events);
  };
}

module.exports = {
  createPersistNode
};
