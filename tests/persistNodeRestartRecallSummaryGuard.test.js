const assert = require('assert');

const { createPersistNode } = require('../api/runtimeV2/nodes/persist');

module.exports = (async () => {
  const events = [];
  let materializeSnapshot = null;
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
    appendShortTermHistory() {},
    persistShortTermBridgeSnapshot() {},
    async appendMemoryEvent(event) {
      events.push(event);
    },
    materializeMemoryViews() {
      const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
      materializeSnapshot = materializeMemoryViews();
      return materializeSnapshot;
    },
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
    chatHistory: {
      s_restart_guard: [
        { role: 'user', content: '我们刚才聊到哪了' },
        { role: 'assistant', content: '刚才在聊部署。' }
      ]
    },
    shortTermMemory: {
      s_restart_guard: {
        summary: '[KnownSummary] 这是重启恢复的长期记忆摘要',
        summarySource: 'restart_recall',
        activeTopic: '部署',
        carryOverUserTurn: '你还没回答 systemd',
        openLoops: ['补充 systemd'],
        assistantCommitments: [],
        userConstraints: []
      }
    },
    config: {
      MEMORY_V3_ENABLED: true
    },
    saveAndEmit(state) {
      return state;
    }
  });

  await persistNode({
    request: {
      userId: 'u_guard',
      question: '我们刚才聊到哪了',
      runtimeQuestionText: '我们刚才聊到哪了',
      persistUserText: '我们刚才聊到哪了',
      routeMeta: {},
      sessionKey: 's_restart_guard',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat'
    },
    output: {
      finalReply: '刚才在聊部署。'
    },
    memory: {
      continuityState: {
        payload: {
          active_topic: '部署',
          open_loops: ['补充 systemd'],
          assistant_commitments: [],
          user_constraints: [],
          carry_over_user_turn: '你还没回答 systemd'
        }
      }
    },
    thread: {},
    plan: {}
  });

  const checkpoint = events.find((event) => event.type === 'session_checkpoint');
  assert.ok(checkpoint);
  assert.strictEqual(String(checkpoint.payload?.summary || ''), '');
  assert.strictEqual(String(checkpoint.payload?.activeTopic || ''), '');
  assert.strictEqual(String(materializeSnapshot?.sessionProjection?.sessions?.s_restart_guard?.summary || ''), '');
  assert.strictEqual(String(materializeSnapshot?.sessionProjection?.sessions?.s_restart_guard?.activeTopic || ''), '');
  console.log('persistNodeRestartRecallSummaryGuard.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
