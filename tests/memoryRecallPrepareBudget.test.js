const assert = require('assert');

const { createInitialState } = require('../api/runtimeV2/host');
const { createPrepareNode } = require('../api/runtimeV2/nodes/prepare');

module.exports = (async () => {
  const recallState = createInitialState(
    '我们昨天都聊了什么',
    { points: 999 },
    'u_recall_budget',
    null,
    null,
    {
      routePolicyKey: 'lookup/notebook-answer',
      topRouteType: 'direct_chat',
      disableTools: true,
      routeMeta: { groupId: 'g_recall_budget' }
    }
  );
  assert.ok(
    Number(recallState.execution?.latencyDecision?.memoryBudgetMs || 0) >= 6000,
    'memory recall questions should get enough memory retrieval budget'
  );
  assert.ok(
    Number(recallState.execution?.latencyDecision?.prepareSoftBudgetMs || 0) >= 8000,
    'memory recall questions should not be cut off by prepare soft timeout'
  );

  let capturedPreparedState = null;
  let continuityMemoryContext = null;
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
    buildContinuityState(options = {}) {
      continuityMemoryContext = options.memoryContext || null;
      return {
        payload: { active_topic: '昨天回忆', source_flags: ['test'] },
        text: '[ContinuityState] 昨天回忆',
        hasSufficientEvidence: true
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
      dynamicPrompt: '[DailyJournal]\n2026-04-26 昨天有可回忆内容',
      stableSystemBlocks: [],
      dynamicContextBlocks: [
        { id: 'daily_journal', content: '[DailyJournal]\n2026-04-26 昨天有可回忆内容' }
      ],
      assistantOnlyContextBlocks: [],
      affinity: null,
      memoryContext: {
        promptDailyJournalText: '2026-04-26 昨天有可回忆内容',
        segments: {
          dailyJournal: [
            { role: 'system', content: '[DailyJournal]\n2026-04-26 昨天有可回忆内容' }
          ]
        }
      },
      personaMemoryState: null,
      promptSnapshot: {
        dynamicPromptPlan: {
          enabledBlockIds: ['daily_journal', 'continuity_state']
        }
      },
      promptSegments: null,
      latencyMeta: {}
    }),
    buildPreparedMainConversationContext(state) {
      capturedPreparedState = state;
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
        prepareSoftBudgetMs: 8000,
        memoryBudgetMs: 6000,
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
    chatHistory: {},
    shortTermMemory: {},
    runtimeOptions: {}
  });

  await prepareNode({
    request: {
      userId: 'u_recall_budget',
      userInfo: { level: '亲密伙伴' },
      question: '我们昨天都聊了什么',
      runtimeQuestionText: '我们昨天都聊了什么',
      persistUserText: '我们昨天都聊了什么',
      routeMeta: {},
      sessionKey: 's_recall_budget',
      allowTools: false,
      routePolicyKey: 'lookup/notebook-answer',
      topRouteType: 'direct_chat'
    },
    thread: { threadId: 't_recall_budget' },
    memory: {},
    plan: {},
    execution: { latencyDecision: {} },
    output: {}
  });

  assert.ok(capturedPreparedState, 'prepare should build main conversation context');
  assert.strictEqual(
    capturedPreparedState.memory?.continuityState?.text,
    '[ContinuityState] 昨天回忆',
    'prepared context should see continuity state built in the same prepare pass'
  );
  assert.ok(
    capturedPreparedState.memory?.context?.segments?.dailyJournal?.length > 0,
    'prepared context should see memory context built in the same prepare pass'
  );
  assert.strictEqual(
    continuityMemoryContext,
    capturedPreparedState.memory?.context,
    'continuity state should reuse the memory context already built during prepare'
  );

  console.log('memoryRecallPrepareBudget.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
