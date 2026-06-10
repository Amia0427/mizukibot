const assert = require('assert');

const { createPrepareNode } = require('../api/runtimeV2/nodes/prepare');

function createDeps(overrides = {}) {
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
    buildContinuityState(options = {}) {
      return {
        payload: { active_topic: options.memoryContext?.promptRetrievedMemoryText ? 'fallback memory' : '' },
        text: '',
        hasSufficientEvidence: Boolean(options.memoryContext?.promptRetrievedMemoryText)
      };
    },
    createMemoryCliTurnState() {
      return {};
    },
    computeEffectiveAllowedTools() {
      return [];
    },
    runCapabilityPreflight: async () => null,
    buildDynamicPromptImpl: async () => {
      throw new Error('force soft timeout fallback');
    },
    buildPreparedMainConversationContext(state) {
      const messages = [
        ...state.memory.stableSystemBlocks.map((block) => ({ role: 'system', content: block.content })),
        ...state.memory.dynamicContextBlocks.map((block) => ({ role: 'system', content: block.content })),
        { role: 'user', content: state.request.question }
      ];
      return {
        messages,
        assistantOnlyContextMessages: [],
        canonicalSegments: {},
        compactionPlan: {},
        mainConversationSnapshot: {},
        contextStats: {},
        signature: 'test'
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
        prepareSoftBudgetMs: 1,
        memoryBudgetMs: 1,
        continuityBudgetMs: 1,
        deferPersist: true
      };
    },
    withSoftTimeout(_task, _timeoutMs, fallbackValue) {
      return typeof fallbackValue === 'function' ? fallbackValue() : fallbackValue;
    },
    nowTs() {
      return Date.now();
    },
    saveAndEmit(state) {
      return state;
    },
    config: {
      SYSTEM_PROMPT: 'Test persona stays present.',
      SHORT_TERM_PENDING_SNAPSHOT_ENABLED: false,
      MEMORY_RECALL_FORCE_LOCAL_RAG: true
    },
    chatHistory: {},
    shortTermMemory: {},
    runtimeOptions: {},
    buildFallbackMemoryContextImpl(_userId, _question, options = {}) {
      assert.strictEqual(options.ragEnabled, true, 'recall soft-timeout fallback should force local RAG');
      assert.strictEqual(options.forceMemoryContext, true, 'recall soft-timeout fallback should mark memory context forced');
      return {
        promptRetrievedMemoryText: '之前约定先排查 prompt 拼装。',
        promptDailyJournalText: '2026-05-21 主回复 prompt 需要验证记忆注入。',
        promptSummaryText: '正在修复主回复上下文。',
        segments: {
          retrievedMemory: [
            { role: 'system', content: '[RetrievedMemory]\n之前约定先排查 prompt 拼装。' }
          ],
          dailyJournal: [
            { role: 'system', content: '[DailyJournal]\n2026-05-21 主回复 prompt 需要验证记忆注入。' }
          ]
        }
      };
    },
    buildSharedShortTermContextMessages() {
      return {
        sessionKey: 's_timeout_fallback',
        recentHistory: [
          { role: 'user', content: '先看提示词有没有丢。' },
          { role: 'assistant', content: '我会检查 prepare fallback。' }
        ]
      };
    },
    getMemosRecallPromptText() {
      return '[MemOSRecall]\nplanner 选中的远端知识。';
    },
    ...overrides
  };
}

module.exports = (async () => {
  const prepareNode = createPrepareNode(createDeps());
  const result = await prepareNode({
    request: {
      userId: 'u_timeout_fallback',
      userInfo: { level: 'friend' },
      question: '你还记得刚才要查什么吗',
      runtimeQuestionText: '你还记得刚才要查什么吗',
      persistUserText: '你还记得刚才要查什么吗',
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            enabledBlockIds: ['memos_recall', 'openviking_recall']
          },
          memosRecall: {
            used: true,
            items: [{ id: 'm1', text: 'planner 选中的远端知识。' }],
            promptText: '[MemOSRecall]\nplanner 选中的远端知识。'
          },
          openVikingRecall: {
            used: true,
            items: [
              {
                id: 'ov_timeout_dup',
                text: '之前约定先排查 prompt 组装。',
                score: 0.93
              }
            ],
            promptText: '[OpenVikingRecall]\n1. source=openviking score=0.93 之前约定先排查 prompt 组装。'
          }
        }
      },
      sessionKey: 's_timeout_fallback',
      allowTools: false,
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat'
    },
    thread: { threadId: 't_timeout_fallback' },
    memory: {},
    plan: {},
    execution: { latencyDecision: {} },
    output: {}
  });

  const stableIds = result.memory.stableSystemBlocks.map((block) => block.id);
  const dynamicIds = result.memory.dynamicContextBlocks.map((block) => block.id);
  const promptIds = result.memory.promptSnapshot.assembledBlocks.map((block) => block.id);
  const sentText = result.memory.mainConversationMessages.map((message) => String(message.content || '')).join('\n');

  assert.ok(stableIds.includes('main_persona_system'), 'stable persona system should still be present');
  assert.ok(dynamicIds.includes('retrieved_memory_lite'), 'timeout fallback should inject retrieved memory block');
  assert.ok(dynamicIds.includes('daily_journal'), 'timeout fallback should inject daily journal block');
  assert.ok(dynamicIds.includes('short_term_continuity'), 'timeout fallback should inject short-term continuity block');
  assert.ok(dynamicIds.includes('memos_recall'), 'timeout fallback should preserve planner-selected MemOS recall');
  assert.ok(!dynamicIds.includes('openviking_recall'), 'timeout fallback should dedupe OpenViking against local Memory V3');
  assert.ok(promptIds.includes('retrieved_memory_lite'), 'rebuilt prompt snapshot should include fallback memory');
  assert.ok(sentText.includes('[RetrievedMemoryLite]'), 'main reply messages should include retrieved memory text');
  assert.ok(sentText.includes('[DailyJournal]'), 'main reply messages should include daily journal text');
  assert.ok(sentText.includes('[ShortTermContinuity]'), 'main reply messages should include short-term continuity text');
  assert.ok(sentText.includes('[MemOSRecall]'), 'main reply messages should include MemOS recall text');
  assert.ok(!sentText.includes('[OpenVikingRecall]'), 'main reply messages should not include deduped OpenViking recall');

  console.log('runtimeV2PromptTimeoutMemoryFallback.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
