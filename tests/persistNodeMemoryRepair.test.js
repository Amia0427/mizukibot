const assert = require('assert');

const { createPersistNode } = require('../api/runtimeV2/nodes/persist');

module.exports = (async () => {
  let compressed = 0;
  let generated = 0;
  let savedSummary = null;
  let sessionCheckpoint = null;

  const chatHistory = {
    s_memory_fix: []
  };
  const shortTermMemory = {
    s_memory_fix: {
      summary: '',
      summarySource: '',
      activeTopic: '部署',
      openLoops: [],
      assistantCommitments: [],
      userConstraints: [],
      carryOverUserTurn: ''
    }
  };

  const persistNode = createPersistNode({
    normalizeObject(value, fallback = {}) {
      return value && typeof value === 'object' ? value : fallback;
    },
    normalizeArray(value) {
      return Array.isArray(value) ? value : [];
    },
    createEvent(type, payload = {}) {
      return { type, ...payload };
    },
    isReviewMode() {
      return false;
    },
    isChatLikeRoute() {
      return true;
    },
    shouldAppendDailyJournalForV2() {
      return false;
    },
    shouldQueueMemoryLearningForV2() {
      return false;
    },
    shouldLearnSelfImprovement() {
      return false;
    },
    compressShortTermHistoryIfNeeded: async (_userId, _userInfo, deps = {}) => {
      compressed += 1;
      assert.strictEqual(typeof deps.summarizeChunk, 'function');
      shortTermMemory.s_memory_fix.summary = '压缩后的短期摘要';
      shortTermMemory.s_memory_fix.summarySource = 'compression';
      shortTermMemory.s_memory_fix.openLoops = ['补充 systemd'];
      return {
        compressed: true,
        summary: shortTermMemory.s_memory_fix.summary
      };
    },
    summarizeShortTermChunk: async () => '压缩后的短期摘要',
    getSessionSummaryCooldownStatus() {
      return {
        limited: false,
        remainingMs: 0
      };
    },
    generateSessionContextSummary: async () => {
      generated += 1;
      return {
        ok: true,
        summary: '自动会话总结',
        structured: {
          activeTopic: '部署'
        }
      };
    },
    saveSessionContextSummary(item) {
      savedSummary = item;
      return {
        saved: true,
        duplicate: false,
        cooldownLimited: false,
        item
      };
    },
    appendShortTermHistory() {
      chatHistory.s_memory_fix = [
        { role: 'user', content: '继续上次部署' },
        { role: 'assistant', content: '先补 systemd 配置。' }
      ];
    },
    persistShortTermBridgeSnapshot() {},
    recordPersonaMemoryOutcome: async () => ({ persisted: false, updatedSlots: {} }),
    appendMemoryEvent: async (event) => {
      if (event.type === 'session_checkpoint') {
        sessionCheckpoint = event;
      }
    },
    materializeMemoryViews() {},
    addProfileItem() {},
    pickRouteMetaForPostReplyJob(routeMeta) {
      return routeMeta || {};
    },
    stableHash(value) {
      return JSON.stringify(value || {});
    },
    postReplyJobQueue: {
      enqueue() {
        return { enqueued: false, job: null };
      }
    },
    saveAndEmit(state) {
      return state;
    },
    config: {
      MEMORY_V3_ENABLED: true
    },
    chatHistory,
    shortTermMemory
  });

  await persistNode({
    request: {
      userId: 'u_memory_fix',
      userInfo: { level: '普通朋友' },
      question: '继续上次部署',
      runtimeQuestionText: '继续上次部署',
      persistUserText: '继续上次部署',
      routeMeta: {},
      sessionKey: 's_memory_fix',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat'
    },
    output: {
      finalReply: '先补 systemd 配置。'
    },
    memory: {
      continuityState: {
        payload: {
          active_topic: '部署',
          open_loops: ['补充 systemd'],
          assistant_commitments: [],
          user_constraints: [],
          carry_over_user_turn: ''
        }
      }
    },
    execution: {},
    thread: {
      sessionScope: {
        sessionKey: 's_memory_fix',
        userId: 'u_memory_fix'
      }
    },
    plan: {}
  });

  assert.strictEqual(compressed, 1);
  assert.strictEqual(generated, 1);
  assert.ok(savedSummary);
  assert.strictEqual(savedSummary.summary, '自动会话总结');
  assert.ok(sessionCheckpoint);
  assert.strictEqual(sessionCheckpoint.payload.summary, '压缩后的短期摘要');

  console.log('persistNodeMemoryRepair.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
