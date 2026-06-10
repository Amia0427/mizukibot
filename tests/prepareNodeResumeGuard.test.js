const assert = require('assert');

const { createPrepareNode } = require('../api/runtimeV2/nodes/prepare');

module.exports = (async () => {
  let normalizePlanForResumeCalls = 0;

  const prepareNode = createPrepareNode({
    normalizeObject(value, fallback = {}) {
      return value && typeof value === 'object' ? value : fallback;
    },
    normalizeArray(value) {
      return Array.isArray(value) ? value : [];
    },
    createEvent(type, payload = {}) {
      return { type, ...payload };
    },
    loadCheckpoint() {
      return {
        status: 'running',
        node: 'validate',
        state: {
          request: {
            requestTrace: { requestId: 'req_old' },
            routeMeta: {
              requestTrace: { requestId: 'req_old' }
            },
            allowedTools: ['get_context_stats']
          },
          thread: {
            checkpointStatus: 'resumed',
            resumeUsed: true
          },
          memory: {},
          plan: {
            status: 'needs_repair',
            steps: [{ id: 'old_step', tool: 'memory_cli', status: 'failed' }]
          },
          execution: {
            mode: 'tool_plan',
            memoryCliTurn: {
              mustAnswer: true,
              searchCount: 1,
              openCount: 0,
              successfulCount: 1,
              lastSuccessCommand: 'search',
              lastResultHadHits: true,
              lastErrorType: 'tool_error'
            }
          },
          output: {}
        }
      };
    },
    shouldExposeMemoryCli() {
      return true;
    },
    recordMemoryScope() {},
    restoreShortTermBridgeAfterRestartIfNeeded() {
      return { restored: false };
    },
    rehydrateShortTermMemoryAfterRestartIfNeeded() {},
    compressShortTermHistoryIfNeeded: async () => {},
    summarizeShortTermChunk: async () => '',
    buildStructuredCompressionPrompt() {
      return '';
    },
    postWithRetry: async () => ({}),
    extractMessageContent(value) {
      return value;
    },
    isChatLikeRoute() {
      return true;
    },
    persistShortTermBridgeSnapshot() {},
    appendMemoryEvent: async () => {},
    materializeMemoryViews() {},
    maybeRunAutoContinuityProbe: async () => ({
      skipped: true,
      reason: 'disabled',
      events: [],
      probeResult: null,
      probeMeta: null
    }),
    buildContinuityState() {
      return {
        payload: null,
        text: '',
        hasSufficientEvidence: false
      };
    },
    createMemoryCliTurnState(value) {
      return value
        ? { ...value }
        : {
            searchCount: 0,
            openCount: 0,
            successfulCount: 0,
            mustAnswer: false,
            lastSuccessCommand: '',
            lastResultHadHits: false,
            lastErrorType: 'none'
          };
    },
    computeEffectiveAllowedTools(request = {}, memoryCliTurn = {}) {
      const base = Array.isArray(request.allowedTools) ? [...request.allowedTools] : [];
      if (memoryCliTurn.mustAnswer) return base.filter((item) => item !== 'memory_cli');
      return base;
    },
    runCapabilityPreflight: async () => null,
    buildDynamicPromptImpl: async () => ({
      dynamicPrompt: '',
      stableSystemBlocks: [],
      dynamicContextBlocks: [],
      assistantOnlyContextBlocks: [],
      affinity: null,
      memoryContext: null,
      personaMemoryState: null,
      promptSnapshot: {},
      promptSegments: {},
      latencyMeta: {}
    }),
    buildFallbackMemoryContextImpl() {
      return {};
    },
    buildSharedShortTermContextMessages() {
      return {};
    },
    getMemosRecallPromptText() {
      return '';
    },
    getOpenVikingRecallPromptText() {
      return '';
    },
    dedupeOpenVikingRecall(openVikingRecall = {}) {
      return openVikingRecall;
    },
    buildPreparedMainConversationContext(inputState = {}) {
      return {
        messages: [],
        assistantOnlyContextMessages: [],
        canonicalSegments: null,
        compactionPlan: null,
        mainConversationSnapshot: null,
        contextStats: null,
        signature: 'sig',
        seenAllowedTools: inputState.request?.allowedTools || []
      };
    },
    classifyPromptThreat() {
      return { labels: [], reasons: [], score: 0 };
    },
    getToolPlannerExecutionPlan() {
      return null;
    },
    isPlannerSingleAuthorityEnabled() {
      return false;
    },
    normalizePlanForResume(plan = {}) {
      normalizePlanForResumeCalls += 1;
      return plan;
    },
    normalizeMode() {
      return 'tool_plan';
    },
    ensureOutputStream(output = {}, mode = 'none') {
      return {
        ...(output.stream || {}),
        mode
      };
    },
    nowTs() {
      return 1;
    },
    buildLatencyDecision() {
      return {
        profile: 'tool_fast',
        prepareSoftBudgetMs: 1000,
        memoryBudgetMs: 1000,
        continuityBudgetMs: 1000,
        preflightBudgetMs: 1000,
        humanizeBudgetMs: 1000,
        humanizeMode: 'auto',
        deferPersist: true
      };
    },
    withSoftTimeout: async (task, _ms, _fallback) => task(),
    saveAndEmit(state) {
      return state;
    },
    buildPromptSnapshot() {
      return {};
    },
    runtimeOptions: {},
    config: {},
    chatHistory: {},
    shortTermMemory: {}
  });

  const result = await prepareNode({
    request: {
      question: '新消息',
      runtimeQuestionText: '新消息',
      persistUserText: '新消息',
      userId: '1960901788',
      userInfo: {},
      routePolicyKey: 'lookup/notebook-answer',
      topRouteType: 'direct_chat',
      allowTools: true,
      allowedTools: ['memory_cli'],
      routeMeta: {
        requestTrace: { requestId: 'req_new' }
      },
      requestTrace: { requestId: 'req_new' },
      sessionKey: 'direct:1960901788',
      customPrompt: ''
    },
    thread: {
      threadId: '1960901788_direct_1960901788_lookup_notebook-answer',
      sessionKey: 'direct:1960901788'
    },
    memory: {},
    plan: {},
    execution: {
      memoryCliTurn: null,
      latencyDecision: {}
    },
    output: {}
  });

  assert.strictEqual(result.thread.resumeUsed, false, 'new request should not resume old checkpoint state');
  assert.deepStrictEqual(result.request.allowedTools, ['memory_cli'], 'new request should keep its own tool allowlist');
  assert.strictEqual(result.execution.memoryCliTurn.mustAnswer, false, 'old mustAnswer state should not leak into new request');
  assert.strictEqual(normalizePlanForResumeCalls, 0, 'resume plan normalization should not run for a different request');

  console.log('prepareNodeResumeGuard.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
