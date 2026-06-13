const assert = require('assert');
const { createPrepareNode } = require('../api/runtimeV2/nodes/prepare');

(async () => {
  let capturedPromptOptions = null;
  const buildLiveStateForState = async () => ({
    context: '【生活状态补充】\n【与这个用户的关系】\n未建立明确关系；保持礼貌距离，不假设亲密度，根据当前对话逐步建立信任。',
    relationship: { level: 'stranger' },
    tokens: 42,
    durationMs: 3,
    truncated: false
  });
  const prepareNode = createPrepareNode({
    normalizeObject: (value, fallback = {}) => (value && typeof value === 'object' && !Array.isArray(value) ? value : fallback),
    normalizeArray: (value) => (Array.isArray(value) ? value : []),
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    loadCheckpoint: () => null,
    shouldExposeMemoryCli: () => false,
    recordMemoryScope: () => {},
    restoreShortTermBridgeAfterRestartIfNeeded: () => ({ restored: false }),
    rehydrateShortTermMemoryAfterRestartIfNeeded: () => {},
    compressShortTermHistoryIfNeeded: async () => {},
    summarizeShortTermChunk: null,
    buildStructuredCompressionPrompt: () => '',
    postWithRetry: async () => ({}),
    extractMessageContent: (value) => value,
    isChatLikeRoute: () => true,
    persistShortTermBridgeSnapshot: () => {},
    appendMemoryEvent: async () => {},
    materializeMemoryViews: () => null,
    maybeRunAutoContinuityProbe: async () => ({ skipped: true, reason: 'test', events: [], probeResult: null, probeMeta: null }),
    buildContinuityState: () => ({ payload: { source_flags: [] }, text: '', hasSufficientEvidence: false }),
    createMemoryCliTurnState: (value) => value || {},
    computeEffectiveAllowedTools: (request) => request.allowedTools || [],
    runCapabilityPreflight: async () => null,
    buildDynamicPromptImpl: async (userInfo, userId, question, customPrompt, options) => {
      capturedPromptOptions = options;
      return {
        dynamicPrompt: options.liveStateContext,
        stableSystemBlocks: [],
        dynamicContextBlocks: [{
          id: 'live_state_dynamic',
          label: 'Live State Dynamic',
          content: options.liveStateContext,
          stage: 'main',
          priority: 500,
          authority: 'runtime_dynamic',
          kind: 'runtime_context',
          lane: 'dynamic_context',
          meta: { blockId: 'live_state_dynamic' }
        }],
        assistantOnlyContextBlocks: [],
        affinity: null,
        memoryContext: {},
        personaMemoryState: null,
        promptSnapshot: {
          assembledBlocks: [],
          renderedSystemMessages: [],
          tokenUsageByBlock: [],
          trimDecisions: [],
          stableBlockIds: [],
          dynamicBlockIds: ['live_state_dynamic'],
          assistantOnlyBlockIds: []
        },
        promptSegments: {},
        latencyMeta: {}
      };
    },
    buildPreparedMainConversationContext: () => ({ messages: [], assistantOnlyContextMessages: [], signature: 'sig', contextStats: {} }),
    classifyPromptThreat: () => ({ labels: [], score: 0 }),
    getToolPlannerExecutionPlan: () => null,
    isPlannerSingleAuthorityEnabled: () => false,
    normalizePlanForResume: (plan) => plan || {},
    normalizeMode: () => 'chat',
    ensureOutputStream: (output = {}) => ({ ...(output.stream || {}), mode: output.stream?.mode || 'none' }),
    buildLatencyDecision: () => ({ prepareSoftBudgetMs: 1000, memoryBudgetMs: 1, continuityBudgetMs: 1 }),
    withSoftTimeout: async (task) => task(),
    nowTs: () => 1_000,
    saveAndEmit: (state) => state,
    buildLiveStateForState,
    config: { SHORT_TERM_PENDING_SNAPSHOT_ENABLED: false },
    chatHistory: [],
    shortTermMemory: {}
  });

  const out = await prepareNode({
    request: {
      question: '你好',
      runtimeQuestionText: '你好',
      persistUserText: '你好',
      userInfo: { level: 'stranger' },
      userId: 'u_prepare_live_state',
      routePolicyKey: 'direct_chat/main',
      topRouteType: 'direct_chat',
      routeMeta: { chatType: 'private' },
      allowedTools: [],
      allowTools: false,
      resumePolicy: 'fresh'
    },
    thread: { threadId: 't_prepare_live_state', sessionKey: 's' },
    memory: {},
    execution: { memoryCliTurn: {}, latencyDecision: {} },
    output: { stream: {} },
    plan: {},
    messages: [],
    events: []
  });

  assert.ok(capturedPromptOptions.liveStateContext.includes('【生活状态补充】'));
  assert.strictEqual(capturedPromptOptions.request.liveStateMeta.tokens, 42);
  assert.ok(out.request.liveStateContext.includes('保持礼貌距离'));
  assert.strictEqual(out.memory.liveStateInjected, true);

  const fastPathNode = createPrepareNode({
    normalizeObject: (value, fallback = {}) => (value && typeof value === 'object' && !Array.isArray(value) ? value : fallback),
    normalizeArray: (value) => (Array.isArray(value) ? value : []),
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    loadCheckpoint: () => null,
    shouldExposeMemoryCli: () => false,
    recordMemoryScope: () => {},
    restoreShortTermBridgeAfterRestartIfNeeded: () => ({ restored: false }),
    rehydrateShortTermMemoryAfterRestartIfNeeded: () => {},
    compressShortTermHistoryIfNeeded: async () => {},
    isChatLikeRoute: () => true,
    persistShortTermBridgeSnapshot: () => {},
    appendMemoryEvent: async () => {},
    materializeMemoryViews: () => null,
    maybeRunAutoContinuityProbe: async () => ({ skipped: true, reason: 'test', events: [], probeResult: null, probeMeta: null }),
    buildContinuityState: () => ({ payload: { source_flags: [] }, text: '', hasSufficientEvidence: false }),
    createMemoryCliTurnState: (value) => value || {},
    computeEffectiveAllowedTools: (request) => request.allowedTools || [],
    buildDynamicPromptImpl: async () => {
      throw new Error('fast path should not call buildDynamicPromptImpl');
    },
    buildPreparedMainConversationContext: () => ({ messages: [], assistantOnlyContextMessages: [], signature: 'sig', contextStats: {} }),
    classifyPromptThreat: () => ({ labels: [], score: 0 }),
    normalizePlanForResume: (plan) => plan || {},
    normalizeMode: () => 'chat',
    ensureOutputStream: (output = {}) => ({ ...(output.stream || {}), mode: output.stream?.mode || 'none' }),
    buildLatencyDecision: () => ({ prepareSoftBudgetMs: 1000, memoryBudgetMs: 1, continuityBudgetMs: 1 }),
    withSoftTimeout: async (task) => task(),
    nowTs: () => 2_000,
    saveAndEmit: (state) => state,
    buildLiveStateForState,
    config: { SHORT_TERM_PENDING_SNAPSHOT_ENABLED: false, SYSTEM_PROMPT: '' },
    chatHistory: [],
    shortTermMemory: {}
  });
  const fastOut = await fastPathNode({
    request: {
      question: '你好',
      runtimeQuestionText: '你好',
      persistUserText: '你好',
      userInfo: { level: 'stranger' },
      userId: 'u_prepare_live_state_fast',
      routePolicyKey: 'chat/default',
      routeDebugKey: 'direct_chat/text_chat/answer',
      topRouteType: 'direct_chat',
      routeMeta: { chatType: 'private', chatMode: 'text_chat', toolIntent: 'none', responseIntent: 'answer' },
      allowedTools: [],
      allowTools: false,
      resumePolicy: 'fresh'
    },
    thread: { threadId: 't_prepare_live_state_fast', sessionKey: 's' },
    memory: {},
    execution: { memoryCliTurn: {}, latencyDecision: {} },
    output: { stream: {} },
    plan: {},
    messages: [],
    events: []
  });
  assert.ok(fastOut.memory.dynamicContextBlocks.some((item) => item.id === 'live_state_dynamic'));
  assert.ok(fastOut.memory.dynamicPrompt.includes('【生活状态补充】'));

  console.log('prepareLiveStateInjection.test.js passed');
})();
