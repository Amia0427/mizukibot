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
      return '[MemOSRecall]\n动态上下文选中的远端知识。';
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
        dynamicPromptPlan: {
          enabledBlockIds: ['memos_recall', 'openviking_recall']
        },
        memosRecall: {
          used: true,
          items: [{ id: 'm1', text: '动态上下文选中的远端知识。' }],
          promptText: '[MemOSRecall]\n动态上下文选中的远端知识。'
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
  assert.ok(dynamicIds.includes('memos_recall'), 'timeout fallback should preserve selected MemOS recall');
  assert.ok(!dynamicIds.includes('openviking_recall'), 'timeout fallback should dedupe OpenViking against local Memory V3');
  assert.ok(promptIds.includes('retrieved_memory_lite'), 'rebuilt prompt snapshot should include fallback memory');
  assert.ok(sentText.includes('[RetrievedMemoryLite]'), 'main reply messages should include retrieved memory text');
  assert.ok(sentText.includes('[DailyJournal]'), 'main reply messages should include daily journal text');
  assert.ok(sentText.includes('[ShortTermContinuity]'), 'main reply messages should include short-term continuity text');
  assert.ok(sentText.includes('[MemOSRecall]'), 'main reply messages should include MemOS recall text');
  assert.ok(!sentText.includes('[OpenVikingRecall]'), 'main reply messages should not include deduped OpenViking recall');

  let plainFallbackContextBuilt = false;
  const plainPrepareNode = createPrepareNode(createDeps({
    buildFallbackMemoryContextImpl(_userId, _question, options = {}) {
      plainFallbackContextBuilt = true;
      return {
        promptRetrievedMemoryText: '旧 profile：用户以前聊过完全无关的话题。',
        promptDailyJournalText: '2026-05-18 无关旧日记。',
        diagnostics: {
          memoryTrace: {
            retrieval_path: 'prepare_fallback_no_rag',
            retrieved_count: 0,
            injected_block_ids: ['retrieved_memory_lite', 'daily_journal'],
            hits: []
          }
        }
      };
    }
  }));
  const plainResult = await plainPrepareNode({
    request: {
      userId: 'u_timeout_plain',
      userInfo: { level: 'friend' },
      question: '区',
      runtimeQuestionText: '区',
      persistUserText: '区',
      routeMeta: {
        chatType: 'group',
        groupId: 'g_timeout_plain'
      },
      sessionKey: 's_timeout_plain',
      allowTools: false,
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat'
    },
    thread: { threadId: 't_timeout_plain' },
    memory: {},
    plan: {},
    execution: { latencyDecision: {} },
    output: {}
  });

  const plainDynamicIds = plainResult.memory.dynamicContextBlocks.map((block) => block.id);
  const plainText = plainResult.memory.mainConversationMessages.map((message) => String(message.content || '')).join('\n');

  assert.strictEqual(plainFallbackContextBuilt, false, 'plain chat fallback should not build ambient memory context');
  assert.ok(!plainDynamicIds.includes('retrieved_memory_lite'), 'plain chat fallback should not inject retrieved memory');
  assert.ok(!plainDynamicIds.includes('daily_journal'), 'plain chat fallback should not inject daily journal');
  assert.ok(!plainText.includes('[RetrievedMemoryLite]'), 'plain chat fallback messages should not include retrieved memory text');
  assert.ok(!plainText.includes('[DailyJournal]'), 'plain chat fallback messages should not include daily journal text');

  console.log('runtimeV2PromptTimeoutMemoryFallback.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
