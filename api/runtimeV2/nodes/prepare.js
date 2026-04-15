function createPrepareNode(deps = {}) {
  const normalizeObject = typeof deps.normalizeObject === 'function'
    ? deps.normalizeObject
    : ((value, fallback = {}) => (value && typeof value === 'object' ? value : fallback));
  const normalizeArray = typeof deps.normalizeArray === 'function'
    ? deps.normalizeArray
    : ((value) => (Array.isArray(value) ? value : []));
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const loadCheckpoint = typeof deps.loadCheckpoint === 'function'
    ? deps.loadCheckpoint
    : (() => null);
  const shouldExposeMemoryCli = typeof deps.shouldExposeMemoryCli === 'function'
    ? deps.shouldExposeMemoryCli
    : (() => false);
  const recordMemoryScope = typeof deps.recordMemoryScope === 'function'
    ? deps.recordMemoryScope
    : () => {};
  const restoreShortTermBridgeAfterRestartIfNeeded = typeof deps.restoreShortTermBridgeAfterRestartIfNeeded === 'function'
    ? deps.restoreShortTermBridgeAfterRestartIfNeeded
    : (() => ({ restored: false }));
  const rehydrateShortTermMemoryAfterRestartIfNeeded = typeof deps.rehydrateShortTermMemoryAfterRestartIfNeeded === 'function'
    ? deps.rehydrateShortTermMemoryAfterRestartIfNeeded
    : () => {};
  const compressShortTermHistoryIfNeeded = typeof deps.compressShortTermHistoryIfNeeded === 'function'
    ? deps.compressShortTermHistoryIfNeeded
    : (async () => {});
  const buildStructuredCompressionPrompt = typeof deps.buildStructuredCompressionPrompt === 'function'
    ? deps.buildStructuredCompressionPrompt
    : (() => '');
  const postWithRetry = typeof deps.postWithRetry === 'function'
    ? deps.postWithRetry
    : (async () => ({}));
  const extractMessageContent = typeof deps.extractMessageContent === 'function'
    ? deps.extractMessageContent
    : ((value) => value);
  const isChatLikeRoute = typeof deps.isChatLikeRoute === 'function'
    ? deps.isChatLikeRoute
    : (() => false);
  const persistShortTermBridgeSnapshot = typeof deps.persistShortTermBridgeSnapshot === 'function'
    ? deps.persistShortTermBridgeSnapshot
    : () => {};
  const appendMemoryEvent = typeof deps.appendMemoryEvent === 'function'
    ? deps.appendMemoryEvent
    : (async () => {});
  const materializeMemoryViews = typeof deps.materializeMemoryViews === 'function'
    ? deps.materializeMemoryViews
    : (() => null);
  const maybeRunAutoContinuityProbe = typeof deps.maybeRunAutoContinuityProbe === 'function'
    ? deps.maybeRunAutoContinuityProbe
    : (async () => ({ skipped: true, reason: 'disabled', events: [], probeResult: null, probeMeta: null }));
  const buildContinuityState = typeof deps.buildContinuityState === 'function'
    ? deps.buildContinuityState
    : (() => ({ payload: null, text: '', hasSufficientEvidence: false }));
  const createMemoryCliTurnState = typeof deps.createMemoryCliTurnState === 'function'
    ? deps.createMemoryCliTurnState
    : ((value) => value || null);
  const computeEffectiveAllowedTools = typeof deps.computeEffectiveAllowedTools === 'function'
    ? deps.computeEffectiveAllowedTools
    : (() => []);
  const runCapabilityPreflight = typeof deps.runCapabilityPreflight === 'function'
    ? deps.runCapabilityPreflight
    : (async () => null);
  const buildDynamicPromptImpl = typeof deps.buildDynamicPromptImpl === 'function'
    ? deps.buildDynamicPromptImpl
    : (async () => ({ dynamicPrompt: '', affinity: null, memoryContext: null }));
  const getToolPlannerExecutionPlan = typeof deps.getToolPlannerExecutionPlan === 'function'
    ? deps.getToolPlannerExecutionPlan
    : (() => null);
  const isPlannerSingleAuthorityEnabled = typeof deps.isPlannerSingleAuthorityEnabled === 'function'
    ? deps.isPlannerSingleAuthorityEnabled
    : (() => false);
  const normalizePlanForResume = typeof deps.normalizePlanForResume === 'function'
    ? deps.normalizePlanForResume
    : ((plan) => plan || {});
  const normalizeMode = typeof deps.normalizeMode === 'function'
    ? deps.normalizeMode
    : (() => 'chat');
  const ensureOutputStream = typeof deps.ensureOutputStream === 'function'
    ? deps.ensureOutputStream
    : ((output = {}, mode = 'none') => ({ ...(output.stream || {}), mode }));
  const nowTs = typeof deps.nowTs === 'function'
    ? deps.nowTs
    : (() => Date.now());
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);
  const config = deps.config || {};
  const chatHistory = deps.chatHistory;
  const shortTermMemory = deps.shortTermMemory;
  const runtimeOptions = normalizeObject(deps.runtimeOptions, {});

  return async function prepareNode(state) {
    const request = normalizeObject(state.request, {});
    const routeMeta = normalizeObject(request.routeMeta, {});
    const threadId = String(state.thread?.threadId || '').trim();
    const events = [createEvent('node_start', { node: 'prepare', threadId })];

    let resumeUsed = false;
    let restored = null;
    if (request.resumePolicy !== 'fresh') {
      restored = loadCheckpoint(threadId);
      if (restored && restored.state && String(restored.status || '').trim() !== 'completed') {
        resumeUsed = true;
      }
    }

    const shouldExposeMemoryCliInPrepare = shouldExposeMemoryCli({
      ...request,
      customPrompt: request.customPrompt,
      disableTools: !request.allowTools,
      memoryCliTurn: state.execution?.memoryCliTurn
    });

    if (shouldExposeMemoryCliInPrepare) {
      recordMemoryScope(request.userId, routeMeta);
    }

    if (
      config.MEMORY_V3_ENABLED
      && !request.systemInitiated
      && String(request.userId || '').trim()
      && String(request.question || '').trim()
    ) {
      await appendMemoryEvent({
        type: 'turn_received',
        userId: request.userId,
        sessionKey: request.sessionKey,
        groupId: routeMeta.groupId || routeMeta.group_id || '',
        channelId: routeMeta.channelId || routeMeta.channel_id || '',
        sessionId: routeMeta.sessionId || routeMeta.session_id || '',
        routePolicyKey: request.routePolicyKey,
        topRouteType: request.topRouteType,
        scopeType: (routeMeta.groupId || routeMeta.group_id) ? 'group' : 'personal',
        source: 'runtime_v2_prepare',
        text: request.question,
        payload: {
          imageUrl: request.imageUrl || '',
          customPrompt: Boolean(String(request.customPrompt || '').trim())
        }
      });
      materializeMemoryViews();
    }

    let bridgeRestored = false;
    if (
      !request.systemInitiated
      && !String(request.customPrompt || '').trim()
      && String(request.userId || '').trim()
      && String(request.question || '').trim()
    ) {
      const bridgeRestore = restoreShortTermBridgeAfterRestartIfNeeded(request.userId, {
        chatHistory,
        shortTermMemory,
        routeMeta,
        sessionKey: request.sessionKey
      });
      bridgeRestored = Boolean(bridgeRestore.restored);
      if (!bridgeRestore.restored) {
        rehydrateShortTermMemoryAfterRestartIfNeeded(request.userId, request.question, request.userInfo, {
          chatHistory,
          shortTermMemory,
          routeMeta,
          sessionKey: request.sessionKey
        });
      }
    }

    await compressShortTermHistoryIfNeeded(request.userId, request.userInfo, {
      chatHistory,
      shortTermMemory,
      routeMeta,
      sessionKey: request.sessionKey,
      summarizeChunk: async ({ existingSummary, existingState, chunkText, summaryTokens }) => {
        const memoryUrl = String(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '').replace(/\/+$/, '');
        const completionsUrl = /\/chat\/completions$/i.test(memoryUrl)
          ? memoryUrl
          : (/\/v\d+$/i.test(memoryUrl) ? `${memoryUrl}/chat/completions` : memoryUrl);
        const resp = await postWithRetry(
          completionsUrl,
          {
            model: String(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4',
            temperature: 0.2,
            top_p: 0.9,
            messages: [
              {
                role: 'system',
                content: [
                  buildStructuredCompressionPrompt(existingState || { summary: existingSummary }, summaryTokens),
                  '濡傛灉鏃犳硶绋冲畾杈撳嚭 JSON锛岄€€鍥炶緭鍑虹函鏂囨湰鐭湡鎽樿銆?'
                ].join('\n')
              },
              { role: 'user', content: chunkText }
            ],
            max_tokens: Math.max(96, Math.min(400, summaryTokens)),
            stream: false
          },
          Math.max(0, Number(config.AI_RETRIES) || 0),
          String(config.MEMORY_API_KEY || config.API_KEY || '').trim()
        );
        const msg = extractMessageContent(resp);
        return String(msg?.content || msg?.text || '').trim();
      }
    });

    const restoredState = resumeUsed ? normalizeObject(restored?.state, {}) : {};

    if (
      config.SHORT_TERM_PENDING_SNAPSHOT_ENABLED
      && !request.systemInitiated
      && String(request.userId || '').trim()
      && String(request.question || '').trim()
      && !String(request.customPrompt || '').trim()
      && isChatLikeRoute(request)
    ) {
      if (config.MEMORY_V3_ENABLED) {
        await appendMemoryEvent({
          type: 'session_checkpoint',
          userId: request.userId,
          sessionKey: request.sessionKey,
          groupId: routeMeta.groupId || routeMeta.group_id || '',
          channelId: routeMeta.channelId || routeMeta.channel_id || '',
          sessionId: routeMeta.sessionId || routeMeta.session_id || '',
          routePolicyKey: request.routePolicyKey,
          topRouteType: request.topRouteType,
          scopeType: 'session',
          source: 'runtime_v2_prepare',
          payload: {
            snapshotType: 'pre_reply',
            carryOverUserTurn: request.imageUrl ? (request.question || '[shared an image]') : (request.question || '')
          }
        });
        materializeMemoryViews();
      }
      persistShortTermBridgeSnapshot(request.userId, {
        chatHistory,
        shortTermMemory,
        routeMeta,
        sessionKey: request.sessionKey,
        scope: state.thread?.sessionScope,
        snapshotType: 'pre_reply',
        shortTermState: {
          carryOverUserTurn: request.imageUrl ? (request.question || '[shared an image]') : (request.question || '')
        }
      });
      events.push(createEvent('checkpoint', {
        node: 'prepare',
        stage: 'pre_reply',
        threadId
      }));
    }

    const continuityProbe = await maybeRunAutoContinuityProbe(state);
    const continuityBuilt = buildContinuityState({
      request,
      thread: state.thread,
      shortTermMemory,
      chatHistory,
      continuityProbeResult: continuityProbe.probeResult,
      maxChars: config.CONTINUITY_STATE_PROMPT_MAX_CHARS
    });

    const restoredExecution = normalizeObject(restoredState.execution, state.execution);
    const nextMemoryCliTurn = createMemoryCliTurnState(restoredExecution.memoryCliTurn);
    const effectiveAllowedTools = computeEffectiveAllowedTools(request, nextMemoryCliTurn);
    const plannerExecutionPlan = getToolPlannerExecutionPlan(request.routeMeta);
    const plannerOwnsToolExecution = isPlannerSingleAuthorityEnabled()
      && normalizeArray(plannerExecutionPlan?.steps).length > 0;
    const globalPreflight = plannerOwnsToolExecution
      ? {
          skipped: true,
          reason: 'planner_single_authority',
          results: [],
          evidenceMessage: '',
          memoryCliTurn: nextMemoryCliTurn
        }
      : await runCapabilityPreflight(request.question || '', {
          userId: request.userId,
          routePolicyKey: request.routePolicyKey,
          topRouteType: request.topRouteType,
          routePrompt: request.routePrompt,
          routeMeta: request.routeMeta,
          reviewMode: request.reviewMode,
          allowedGlobalTools: effectiveAllowedTools,
          memoryCliTurn: nextMemoryCliTurn,
          toolExecutors: deps.toolExecutors,
          postWithRetry: runtimeOptions.postWithRetry,
          policy: {
            allowGlobalTools: Boolean(request.allowTools),
            allowedGlobalTools: effectiveAllowedTools
          }
        });
    const preflightMemoryCliTurn = createMemoryCliTurnState(globalPreflight?.memoryCliTurn || nextMemoryCliTurn);
    const executionMemoryCliTurn = createMemoryCliTurnState(nextMemoryCliTurn);
    const executionAllowedTools = computeEffectiveAllowedTools(request, executionMemoryCliTurn);
    const { dynamicPrompt, affinity, memoryContext } = await buildDynamicPromptImpl(
      request.userInfo,
      request.userId,
      request.question,
      request.customPrompt,
      {
        routePrompt: request.routePrompt,
        routePolicyKey: request.routePolicyKey,
        topRouteType: request.topRouteType,
        reviewMode: request.reviewMode,
        routeMeta: request.routeMeta,
        customPrompt: request.customPrompt,
        disableTools: !request.allowTools,
        modelConfig: request.modelConfig,
        memoryCliTurn: executionMemoryCliTurn,
        chatHistory,
        shortTermMemory,
        sessionKey: request.sessionKey
      }
    );

    const nextState = {
      ...state,
      request: {
        ...normalizeObject(restoredState.request, {}),
        ...state.request,
        allowedTools: executionAllowedTools
      },
      thread: {
        ...normalizeObject(restoredState.thread, state.thread),
        ...state.thread,
        checkpointStatus: resumeUsed ? 'resumed' : 'fresh',
        resumeUsed,
        currentNode: 'prepare',
        updatedAt: nowTs()
      },
      memory: {
        ...normalizeObject(restoredState.memory, state.memory),
        dynamicPrompt,
        affinity,
        context: memoryContext || null,
        dirty: false,
        restoredBridge: bridgeRestored,
        memoryScopeRecorded: shouldExposeMemoryCliInPrepare,
        persisted: false,
        globalToolEvidence: String(globalPreflight?.evidenceMessage || '').trim(),
        globalToolResults: normalizeArray(globalPreflight?.results).map((item) => ({ ...normalizeObject(item, {}) })),
        globalToolMemoryCliTurn: preflightMemoryCliTurn,
        continuityState: {
          payload: continuityBuilt.payload,
          text: continuityBuilt.text,
          probe: continuityProbe.probeMeta
            ? {
                facet: continuityProbe.probeMeta.facet,
                skipped: Boolean(continuityProbe.skipped),
                reason: continuityProbe.reason
              }
            : null,
          hasSufficientEvidence: continuityBuilt.hasSufficientEvidence
        }
      },
      plan: resumeUsed
        ? normalizePlanForResume({
            ...state.plan,
            ...normalizeObject(restoredState.plan, {})
          })
        : state.plan,
      execution: {
        ...restoredExecution,
        mode: resumeUsed && String(restoredState.execution?.mode || '').trim()
          ? String(restoredState.execution.mode).trim()
          : normalizeMode(request),
        currentNode: 'prepare',
        resumedFromNode: resumeUsed ? String(restored?.node || '').trim() : '',
        retryQueue: normalizeArray(restoredState.execution?.retryQueue),
        memoryCliTurn: executionMemoryCliTurn
      },
      output: resumeUsed && restoredState.output
        ? {
            ...state.output,
            ...normalizeObject(restoredState.output, {}),
            stream: {
              ...ensureOutputStream(state.output),
              ...ensureOutputStream(normalizeObject(restoredState.output, {}), state.output?.stream?.mode || 'none')
            }
          }
        : {
            ...state.output,
            stream: ensureOutputStream(state.output)
          }
    };

    const nextEvents = events.concat([
      ...normalizeArray(continuityProbe.events),
      createEvent('continuity_state_built', {
        node: 'prepare',
        hasText: Boolean(String(continuityBuilt.text || '').trim()),
        sourceFlags: normalizeArray(continuityBuilt.payload?.source_flags)
      }),
      createEvent('effectiveAllowedTools', {
        node: 'prepare',
        allowedTools: executionAllowedTools
      }),
      createEvent('memoryCliTurn', {
        node: 'prepare',
        memoryCliTurn: executionMemoryCliTurn
      }),
      ...(String(globalPreflight?.evidenceMessage || '').trim() || globalPreflight?.memoryCliTurn
        ? [createEvent('global_tool_memoryCliTurn', {
            node: 'prepare',
            memoryCliTurn: preflightMemoryCliTurn
          })]
        : []),
      ...(String(globalPreflight?.evidenceMessage || '').trim()
        ? [createEvent('global_tool_preflight', {
            node: 'prepare',
            resultCount: normalizeArray(globalPreflight?.results).length
          })]
        : []),
      createEvent('checkpoint', { node: 'prepare', resumeUsed, threadId }),
      createEvent('node_complete', { node: 'prepare', threadId })
    ]);

    return saveAndEmit({
      ...nextState,
      events: nextEvents
    }, 'prepare', 'running', nextEvents);
  };
}

module.exports = {
  createPrepareNode
};
