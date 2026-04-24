const assert = require('assert');

const { createPrepareNode } = require('../api/runtimeV2/nodes/prepare');

module.exports = (async () => {
  let compressed = 0;

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
      return null;
    },
    shouldExposeMemoryCli() {
      return false;
    },
    recordMemoryScope() {},
    restoreShortTermBridgeAfterRestartIfNeeded() {
      return { restored: false };
    },
    rehydrateShortTermMemoryAfterRestartIfNeeded() {},
    compressShortTermHistoryIfNeeded: async (_userId, _userInfo, deps = {}) => {
      compressed += 1;
      assert.strictEqual(typeof deps.summarizeChunk, 'function');
      return { compressed: true };
    },
    summarizeShortTermChunk: async () => '压缩摘要',
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
    createMemoryCliTurnState() {
      return {};
    },
    computeEffectiveAllowedTools() {
      return [];
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
      promptSnapshot: null,
      promptSegments: null,
      latencyMeta: {}
    }),
    buildPreparedMainConversationContext() {
      return {
        messages: [],
        assistantOnlyContextMessages: [],
        canonicalSegments: {},
        compactionPlan: {},
        mainConversationSnapshot: {},
        contextStats: {},
        signature: ''
      };
    },
    classifyPromptThreat() {
      return {
        labels: [],
        reasons: [],
        score: 0
      };
    },
    getToolPlannerExecutionPlan() {
      return null;
    },
    isPlannerSingleAuthorityEnabled() {
      return false;
    },
    normalizePlanForResume(plan = {}) {
      return plan;
    },
    normalizeMode() {
      return 'chat';
    },
    ensureOutputStream() {
      return {
        mode: 'none',
        completed: false
      };
    },
    buildLatencyDecision() {
      return {
        profile: 'chat_fast',
        prepareSoftBudgetMs: 100,
        memoryBudgetMs: 100,
        continuityBudgetMs: 50,
        deferPersist: true
      };
    },
    withSoftTimeout(task) {
      return task();
    },
    nowTs() {
      return Date.now();
    },
    saveAndEmit(state) {
      return state;
    },
    config: {
      SHORT_TERM_PENDING_SNAPSHOT_ENABLED: false
    },
    chatHistory: {
      s_prepare_fix: [
        { role: 'user', content: '前情' },
        { role: 'assistant', content: '回复' }
      ]
    },
    shortTermMemory: {
      s_prepare_fix: {}
    },
    runtimeOptions: {}
  });

  await prepareNode({
    request: {
      userId: 'u_prepare_fix',
      userInfo: { level: '普通朋友' },
      question: '继续聊',
      runtimeQuestionText: '继续聊',
      persistUserText: '继续聊',
      routeMeta: {},
      sessionKey: 's_prepare_fix',
      allowTools: true,
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat'
    },
    thread: {
      threadId: 't_prepare_fix'
    },
    memory: {},
    plan: {},
    execution: {
      latencyDecision: {}
    },
    output: {}
  });

  assert.strictEqual(compressed, 1);
  console.log('prepareNodeShortTermCompression.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
