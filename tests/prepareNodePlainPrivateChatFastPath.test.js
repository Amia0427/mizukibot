const assert = require('assert');

const { createPrepareNode } = require('../api/runtimeV2/nodes/prepare');

function createDeps(overrides = {}) {
  let now = 1000;
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
    recordMemoryScope() {
      throw new Error('memory scope should not be recorded for plain private chat');
    },
    restoreShortTermBridgeAfterRestartIfNeeded() {
      throw new Error('short-term bridge restore should be skipped for plain private chat');
    },
    rehydrateShortTermMemoryAfterRestartIfNeeded() {
      throw new Error('short-term rehydrate should be skipped for plain private chat');
    },
    compressShortTermHistoryIfNeeded: async () => {
      throw new Error('short-term compression should be skipped for plain private chat');
    },
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
    persistShortTermBridgeSnapshot() {
      throw new Error('pending snapshot should be skipped for plain private chat');
    },
    appendMemoryEvent: async () => {},
    materializeMemoryViews() {},
    maybeRunAutoContinuityProbe: async () => {
      throw new Error('continuity probe should be skipped for plain private chat');
    },
    buildContinuityState() {
      return {
        payload: null,
        text: '',
        hasSufficientEvidence: false
      };
    },
    createMemoryCliTurnState(value) {
      return value || {};
    },
    computeEffectiveAllowedTools() {
      return [];
    },
    runCapabilityPreflight: async () => null,
    buildDynamicPromptImpl: async () => {
      throw new Error('dynamic prompt should be skipped for plain private chat');
    },
    buildPreparedMainConversationContext(state) {
      return {
        messages: state.memory.stableSystemBlocks
          .map((block) => ({ role: 'system', content: block.content }))
          .concat([{ role: 'user', content: state.request.question }]),
        assistantOnlyContextMessages: [],
        canonicalSegments: {},
        compactionPlan: {},
        mainConversationSnapshot: {},
        contextStats: {},
        signature: 'plain-fast'
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
        prepareSoftBudgetMs: 600,
        memoryBudgetMs: 300,
        continuityBudgetMs: 250,
        deferPersist: true
      };
    },
    withSoftTimeout(task) {
      return task();
    },
    nowTs() {
      now += 1;
      return now;
    },
    saveAndEmit(state) {
      return state;
    },
    config: {
      SYSTEM_PROMPT: 'Test persona stays present.',
      SHORT_TERM_PENDING_SNAPSHOT_ENABLED: true
    },
    chatHistory: {},
    shortTermMemory: {},
    runtimeOptions: {},
    ...overrides
  };
}

function createState(overrides = {}) {
  return {
    request: {
      userId: 'u_plain_private',
      userInfo: { level: 'friend' },
      question: '今晚就这么睡吧',
      runtimeQuestionText: '今晚就这么睡吧',
      persistUserText: '今晚就这么睡吧',
      routeMeta: {
        chatType: 'private',
        topRouteType: 'direct_chat',
        chatMode: 'text_chat',
        toolIntent: 'none',
        responseIntent: 'answer',
        facets: { sourceScope: 'none' },
        intent: { needsMemory: false, needsPlanning: false }
      },
      sessionKey: 'direct:u_plain_private',
      allowTools: false,
      allowedTools: [],
      routePolicyKey: 'chat/default',
      routeDebugKey: 'direct_chat/text_chat/answer',
      topRouteType: 'direct_chat',
      ...overrides
    },
    thread: { threadId: 't_plain_private' },
    memory: {},
    plan: {},
    execution: { latencyDecision: {} },
    output: {}
  };
}

module.exports = (async () => {
  const prepareNode = createPrepareNode(createDeps());
  const result = await prepareNode(createState());

  const stableIds = result.memory.stableSystemBlocks.map((block) => block.id);
  assert.ok(stableIds.includes('main_persona_system'));
  assert.deepStrictEqual(result.memory.dynamicContextBlocks, []);
  assert.strictEqual(result.memory.context, null);
  assert.strictEqual(result.execution.latencyBreakdown.prepare.fast_path, 'plain_private_chat');
  assert.ok(result.events.some((event) => event.type === 'latency_profile' && event.fastPath === 'plain_private_chat'));
  assert.ok(result.events.some((event) => event.type === 'continuity_probe_skipped' && event.reason === 'plain_private_chat'));
  assert.ok(result.memory.mainConversationMessages.some((message) => String(message.content || '').includes('今晚就这么睡吧')));

  const notebookChatOnlyPrepareNode = createPrepareNode(createDeps());
  const notebookChatOnlyResult = await notebookChatOnlyPrepareNode(createState({
    question: 'check my notebook for LangGraph notes',
    runtimeQuestionText: 'check my notebook for LangGraph notes',
    persistUserText: 'check my notebook for LangGraph notes',
    routePolicyKey: 'lookup/notebook-answer',
    routeMeta: {
      chatType: 'private',
      topRouteType: 'direct_chat',
      chatMode: 'text_chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer',
      facets: { sourceScope: 'notebook' },
      intent: { needsMemory: false, needsPlanning: false },
      directChatPlanner: {
        decisionSource: 'rule_preflight_notebook_chat_only',
        executionPlan: { mode: 'chat_only', steps: [] },
        allowedToolNames: []
      }
    }
  }));
  assert.strictEqual(notebookChatOnlyResult.execution.latencyBreakdown.prepare.fast_path, 'notebook_chat_only');
  assert.ok(notebookChatOnlyResult.events.some((event) => event.type === 'latency_profile' && event.fastPath === 'notebook_chat_only'));
  assert.ok(notebookChatOnlyResult.events.some((event) => event.type === 'continuity_probe_skipped' && event.reason === 'notebook_chat_only'));

  let dynamicPromptCalled = false;
  const memoryRecallPrepareNode = createPrepareNode(createDeps({
    restoreShortTermBridgeAfterRestartIfNeeded() {
      return { restored: false };
    },
    rehydrateShortTermMemoryAfterRestartIfNeeded() {},
    compressShortTermHistoryIfNeeded: async () => ({ compressed: false }),
    persistShortTermBridgeSnapshot() {},
    maybeRunAutoContinuityProbe: async () => ({
      skipped: true,
      reason: 'disabled',
      events: [],
      probeResult: null,
      probeMeta: null
    }),
    buildDynamicPromptImpl: async () => {
      dynamicPromptCalled = true;
      return {
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
      };
    }
  }));
  await memoryRecallPrepareNode(createState({
    question: '你还记得我之前说什么吗',
    runtimeQuestionText: '你还记得我之前说什么吗',
    persistUserText: '你还记得我之前说什么吗',
    routeMeta: {
      chatType: 'private',
      topRouteType: 'direct_chat',
      chatMode: 'text_chat',
      toolIntent: 'maybe_tools',
      responseIntent: 'answer',
      facets: { sourceScope: 'notebook' },
      intent: { needsMemory: true, needsPlanning: false },
      needsMemoryReason: 'recent_continuity'
    }
  }));
  assert.strictEqual(dynamicPromptCalled, true, 'memory recall private chat must keep the full prepare path');

  console.log('prepareNodePlainPrivateChatFastPath.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
