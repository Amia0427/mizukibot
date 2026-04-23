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
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);
  const config = normalizeObject(deps.config, {});
  const chatHistory = deps.chatHistory;
  const shortTermMemory = deps.shortTermMemory;
  const logPostReplyEnqueueError = typeof deps.logPostReplyEnqueueError === 'function'
    ? deps.logPostReplyEnqueueError
    : (() => {});
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

  return async function persistNode(state) {
    const request = normalizeObject(state.request, {});
    const finalReply = String(state.output?.finalReply || state.output?.draftReply || '').trim();
    const latencyDecision = normalizeObject(state.execution?.latencyDecision, {});
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
      && !isReviewMode(request.reviewMode)
    );
    const shouldPersistBridge = shouldPersistChatArtifacts
      && isChatLikeRoute(request);
    const shouldPersistJournal = shouldPersistChatArtifacts
      && shouldAppendDailyJournalForV2(request, finalReply);
    const shouldLearn = shouldPersistChatArtifacts
      && shouldQueueMemoryLearningForV2(request, finalReply);
    const shouldLearnSelfImprovementValue = shouldPersistChatArtifacts
      && shouldLearnSelfImprovement(request, finalReply);
    const normalizedUserId = String(request.userId || '').trim();
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
    const shouldEnqueuePostReplyJob = shouldPersistChatArtifacts
      && hasEnoughPostReplyContent
      && postReplyCooldownReady
      && shouldAllowPostReplyForGroup
      && (shouldLearn || shouldLearnSelfImprovementValue || shouldPersistJournal);
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
      const deferredEvents = [
        createEvent('node_start', { node: 'persist' }),
        createEvent('persist_deferred', {
          node: 'persist',
          finalReplyPreview: finalReply.slice(0, 180)
        }),
        createEvent('node_complete', { node: 'persist' })
      ];
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

    if (shouldPersistChatArtifacts) {
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
        materializeMemoryViews();
      }
      appendShortTermHistory(request.userId, userContent, finalReply, request.userInfo, {
        chatHistory,
        shortTermMemory,
        routeMeta: request.routeMeta,
        sessionKey: request.sessionKey
      });

      if (shouldPersistBridge) {
        if (config.MEMORY_V3_ENABLED) {
          const stateSlice = shortTermMemory?.[request.sessionKey] || {};
          const historySlice = Array.isArray(chatHistory?.[request.sessionKey]) ? chatHistory[request.sessionKey] : [];
          const summarySource = String(stateSlice.summarySource || '').trim().toLowerCase();
          const persistedSummary = summarySource === 'restart_recall'
            ? ''
            : String(stateSlice.summary || '').trim();
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
              activeTopic: String(stateSlice.activeTopic || '').trim(),
              summary: persistedSummary,
              carryOverUserTurn: String(stateSlice.carryOverUserTurn || '').trim(),
              openLoops: normalizeArray(stateSlice.openLoops),
              assistantCommitments: normalizeArray(stateSlice.assistantCommitments),
              userConstraints: normalizeArray(stateSlice.userConstraints),
              recentMessages: historySlice.slice(-6)
            }
          });
          materializeMemoryViews();
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

      await recordPersonaMemoryOutcome('direct_chat', {
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
        recentMessages: Array.isArray(chatHistory?.[request.sessionKey]) ? chatHistory[request.sessionKey].slice(-6) : []
      });

      addProfileItem(request.userId, 'recent_topics', String(request.question || '').slice(0, 20), 12);
      if (shouldEnqueuePostReplyJob) {
        const routeMeta = pickRouteMetaForPostReplyJob(request.routeMeta);
        const aggregateKey = buildCoreAggregateKey({
          userId: normalizedUserId,
          sessionKey: String(request.sessionKey || '').trim(),
          groupId: routeGroupId
        });
        const coreTurn = {
          question: userContent,
          finalReply,
          createdAt: new Date(now).toISOString(),
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
                      tasks: {
                        memoryLearning: Boolean(existingQueuedCoreJob.tasks?.memoryLearning) || shouldLearn,
                        selfImprovement: Boolean(existingQueuedCoreJob.tasks?.selfImprovement) || shouldLearnSelfImprovementValue,
                        dailyJournal: Boolean(existingQueuedCoreJob.tasks?.dailyJournal) || shouldPersistJournal
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
                  memoryLearning: shouldLearn,
                  selfImprovement: shouldLearnSelfImprovementValue,
                  dailyJournal: shouldPersistJournal
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
          logPostReplyEnqueueError(error);
        }
      }
    }

    const events = [
      createEvent('node_start', { node: 'persist' }),
      createEvent('persist_complete', {
        saved: shouldPersistChatArtifacts,
        finalReplyPreview: finalReply.slice(0, 180),
        postReplyJobId: enqueuedPostReplyJob?.jobId || '',
        postReplyEnqueued: Boolean(enqueuedPostReplyJob?.enqueued)
      }),
      createEvent('node_complete', { node: 'persist' })
    ];

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
