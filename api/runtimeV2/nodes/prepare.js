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
  const classifyPromptThreat = typeof deps.classifyPromptThreat === 'function'
    ? deps.classifyPromptThreat
    : (() => ({ labels: [], reasons: [], score: 0 }));
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
  const buildLatencyDecision = typeof deps.buildLatencyDecision === 'function'
    ? deps.buildLatencyDecision
    : ((request = {}) => normalizeObject(request.latencyDecision, {}));
  const withSoftTimeout = typeof deps.withSoftTimeout === 'function'
    ? deps.withSoftTimeout
    : (async (task) => task());
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);
  const config = deps.config || {};
  const chatHistory = deps.chatHistory;
  const shortTermMemory = deps.shortTermMemory;
  const runtimeOptions = normalizeObject(deps.runtimeOptions, {});

  return async function prepareNode(state) {
    const startedAt = nowTs();
    const request = normalizeObject(state.request, {});
    const routeMeta = normalizeObject(request.routeMeta, {});
    const requestQuestionText = String(request.runtimeQuestionText || request.question || '').trim();
    const persistUserText = String(request.persistUserText || request.runtimeQuestionText || request.question || '').trim();
    const threadId = String(state.thread?.threadId || '').trim();
    const latencyDecision = buildLatencyDecision(request, state.execution?.latencyDecision || {});
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

    let bridgeRestored = false;
    if (
      !request.systemInitiated
      && !String(request.customPrompt || '').trim()
      && String(request.userId || '').trim()
      && persistUserText
    ) {
      const bridgeRestore = restoreShortTermBridgeAfterRestartIfNeeded(request.userId, {
        chatHistory,
        shortTermMemory,
        routeMeta,
        sessionKey: request.sessionKey
      });
      bridgeRestored = Boolean(bridgeRestore.restored);
      if (!bridgeRestore.restored) {
        rehydrateShortTermMemoryAfterRestartIfNeeded(request.userId, persistUserText, request.userInfo, {
          chatHistory,
          shortTermMemory,
          routeMeta,
          sessionKey: request.sessionKey
        });
      }
    }

    const restoredState = resumeUsed ? normalizeObject(restored?.state, {}) : {};

    if (
      config.SHORT_TERM_PENDING_SNAPSHOT_ENABLED
      && !request.systemInitiated
      && String(request.userId || '').trim()
      && persistUserText
      && !String(request.customPrompt || '').trim()
      && isChatLikeRoute(request)
    ) {
      persistShortTermBridgeSnapshot(request.userId, {
        chatHistory,
        shortTermMemory,
        routeMeta,
        sessionKey: request.sessionKey,
        scope: state.thread?.sessionScope,
        snapshotType: 'pre_reply',
        shortTermState: {
          carryOverUserTurn: persistUserText || (request.imageUrl ? '[shared an image]' : '')
        }
      });
      events.push(createEvent('checkpoint', {
        node: 'prepare',
        stage: 'pre_reply',
        threadId
      }));
    }

    const continuityProbe = await withSoftTimeout(
      () => maybeRunAutoContinuityProbe({
        ...state,
        execution: {
          ...state.execution,
          latencyDecision
        }
      }),
      latencyDecision.continuityBudgetMs,
      {
        skipped: true,
        reason: 'soft_timeout',
        events: [createEvent('continuity_probe_skipped', { node: 'prepare', reason: 'soft_timeout' })],
        probeResult: null,
        probeMeta: null
      }
    );
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
    const globalPreflight = {
      skipped: true,
      reason: 'deferred_to_dispatch',
      results: [],
      evidenceMessage: '',
      memoryCliTurn: nextMemoryCliTurn
    };
    const preflightMemoryCliTurn = createMemoryCliTurnState(nextMemoryCliTurn);
    const executionMemoryCliTurn = createMemoryCliTurnState(nextMemoryCliTurn);
    const executionAllowedTools = computeEffectiveAllowedTools(request, executionMemoryCliTurn);
    const threatMeta = classifyPromptThreat(requestQuestionText || '', {
      routePolicyKey: request.routePolicyKey,
      topRouteType: request.topRouteType
    });

    const {
      dynamicPrompt,
      stableSystemBlocks,
      dynamicContextBlocks,
      assistantOnlyContextBlocks,
      affinity,
      memoryContext,
      personaMemoryState,
      promptSnapshot,
      promptSegments
    } = await withSoftTimeout(
      () => buildDynamicPromptImpl(
        request.userInfo,
        request.userId,
        requestQuestionText,
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
          securityLabels: normalizeArray(threatMeta.labels),
          chatHistory,
          shortTermMemory,
          sessionKey: request.sessionKey,
          latencyDecision
        }
      ),
      latencyDecision.prepareSoftBudgetMs,
      {
        dynamicPrompt: String(state.memory?.dynamicPrompt || ''),
        stableSystemBlocks: normalizeArray(state.memory?.stableSystemBlocks),
        dynamicContextBlocks: normalizeArray(state.memory?.dynamicContextBlocks),
        assistantOnlyContextBlocks: normalizeArray(state.memory?.assistantOnlyContextBlocks),
        affinity: state.memory?.affinity || null,
        memoryContext: state.memory?.context || null,
        personaMemoryState: state.memory?.personaMemoryState || null,
        promptSnapshot: state.memory?.promptSnapshot || null,
        promptSegments: state.memory?.promptSegments || null,
        freshness: {
          stableSystem: 'cache',
          sessionContext: 'partial',
          continuity: 'skipped'
        },
        cacheMeta: {
          stableKey: '',
          sessionKey: '',
          hit: false
        },
        criticalBlocks: [],
        optionalBlocks: []
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
        stableSystemBlocks: normalizeArray(stableSystemBlocks),
        dynamicContextBlocks: normalizeArray(dynamicContextBlocks),
        assistantOnlyContextBlocks: normalizeArray(assistantOnlyContextBlocks),
        promptSnapshot: promptSnapshot || null,
        promptSegments: promptSegments || null,
        securityLabels: normalizeArray(threatMeta.labels),
        blockedLearningEvents: normalizeArray(restoredState.memory?.blockedLearningEvents),
        redactionEvents: normalizeArray(restoredState.memory?.redactionEvents),
        affinity,
        context: memoryContext || null,
        personaMemoryState: personaMemoryState || null,
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
        memoryCliTurn: executionMemoryCliTurn,
        latencyDecision,
        cacheStats: {
          ...normalizeObject(restoredState.execution?.cacheStats, state.execution?.cacheStats),
          promptCacheHit: Boolean(promptSnapshot?.cacheMeta?.hit || promptSegments?.cacheMeta?.hit),
          memoryCacheHit: Boolean(memoryContext?.cacheMeta?.hit),
          toolCacheHitCount: Number(restoredState.execution?.cacheStats?.toolCacheHitCount || 0) || 0
        },
        latencyBreakdown: {
          ...normalizeObject(restoredState.execution?.latencyBreakdown, state.execution?.latencyBreakdown),
          prepare: {
            durationMs: Math.max(0, nowTs() - startedAt),
            timedOut: Boolean(String(promptSnapshot?.freshness?.sessionContext || promptSegments?.freshness?.sessionContext || '').trim() === 'partial'),
            deferred: true
          }
        }
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
      createEvent('prompt_security_labels', {
        node: 'prepare',
        labels: normalizeArray(threatMeta.labels),
        score: Number(threatMeta.score || 0) || 0
      }),
      createEvent('continuity_state_built', {
        node: 'prepare',
        hasText: Boolean(String(continuityBuilt.text || '').trim()),
        sourceFlags: normalizeArray(continuityBuilt.payload?.source_flags)
      }),
      createEvent('effectiveAllowedTools', {
        node: 'prepare',
        allowedTools: executionAllowedTools
      }),
      createEvent('latency_profile', {
        node: 'prepare',
        profile: latencyDecision.profile,
        deferPersist: Boolean(latencyDecision.deferPersist)
      }),
      createEvent('memoryCliTurn', {
        node: 'prepare',
        memoryCliTurn: executionMemoryCliTurn
      }),
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
