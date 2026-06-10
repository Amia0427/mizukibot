const assert = require('assert');

const { createPrepareNode } = require('../api/runtimeV2/nodes/prepare');

function createBaseDeps(overrides = {}) {
  return {
    normalizeObject(value, fallback = {}) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
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
    compressShortTermHistoryIfNeeded: async () => ({ compressed: false }),
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
      return { labels: [], reasons: [], score: 0 };
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
      return { mode: 'none', completed: false };
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
    withSoftTimeout(task, _timeoutMs, fallbackValue) {
      return task();
    },
    nowTs() {
      return Date.now();
    },
    saveAndEmit(state) {
      return state;
    },
    config: {
      SYSTEM_PROMPT: 'Test persona must stay present.',
      SHORT_TERM_PENDING_SNAPSHOT_ENABLED: false
    },
    chatHistory: {},
    shortTermMemory: {},
    runtimeOptions: {},
    ...overrides
  };
}

function createState() {
  return {
    request: {
      userId: 'u_prepare_stable_fallback',
      userInfo: { level: '普通朋友' },
      question: '你是谁',
      runtimeQuestionText: '你是谁',
      persistUserText: '你是谁',
      routeMeta: {},
      sessionKey: 's_prepare_stable_fallback',
      allowTools: true,
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat'
    },
    thread: { threadId: 't_prepare_stable_fallback' },
    memory: {},
    plan: {},
    execution: { latencyDecision: {} },
    output: {}
  };
}

module.exports = (async () => {
  let capturedTimeoutState = null;
  const timeoutPrepareNode = createPrepareNode(createBaseDeps({
    buildDynamicPromptImpl: async () => {
      throw new Error('should use timeout fallback');
    },
    withSoftTimeout(_task, _timeoutMs, fallbackValue) {
      return fallbackValue;
    },
    buildPreparedMainConversationContext(state) {
      capturedTimeoutState = state;
      return {
        messages: [],
        assistantOnlyContextMessages: [],
        canonicalSegments: {},
        compactionPlan: {},
        mainConversationSnapshot: {},
        contextStats: {},
        signature: ''
      };
    }
  }));

  const timeoutResult = await timeoutPrepareNode(createState());
  const timeoutIds = capturedTimeoutState.memory.stableSystemBlocks.map((block) => block.id);
  assert.ok(timeoutIds.includes('security_contract'));
  assert.ok(timeoutIds.includes('main_persona_system'));
  assert.ok(timeoutIds.includes('core_baseline_patch'));
  assert.ok(timeoutResult.memory.promptSnapshot.assembledBlocks.some((block) => block.id === 'main_persona_system'));
  assert.ok(timeoutResult.memory.promptSegments.stableSystemBlocks.some((block) => block.id === 'security_contract'));
  assert.strictEqual(timeoutResult.execution.latencyBreakdown.prepare.timedOut, true);
  assert.ok(timeoutResult.events.some((event) => event.type === 'prompt_stable_guard_applied'));

  let capturedEmptyState = null;
  const emptyPrepareNode = createPrepareNode(createBaseDeps({
    buildPreparedMainConversationContext(state) {
      capturedEmptyState = state;
      return {
        messages: [],
        assistantOnlyContextMessages: [],
        canonicalSegments: {},
        compactionPlan: {},
        mainConversationSnapshot: {},
        contextStats: {},
        signature: ''
      };
    }
  }));

  await emptyPrepareNode(createState());
  const emptyIds = capturedEmptyState.memory.stableSystemBlocks.map((block) => block.id);
  assert.ok(emptyIds.includes('security_contract'));
  assert.ok(emptyIds.includes('main_persona_system'));
  assert.ok(emptyIds.includes('core_baseline_patch'));

  console.log('prepareNodeStablePromptFallback.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
