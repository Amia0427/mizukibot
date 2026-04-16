const assert = require('assert');

const { createPersistNode } = require('../api/runtimeV2/nodes/persist');

module.exports = (async () => {
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
    async appendMemoryEvent() {},
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
    chatHistory: {},
    shortTermMemory: {},
    config: {
      MEMORY_V3_ENABLED: false
    },
    saveAndEmit(state) {
      return state;
    }
  });

  const result = await persistNode({
    request: {
      userId: 'u1',
      question: 'hello',
      routeMeta: {},
      sessionKey: 's1',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat'
    },
    output: {
      finalReply: 'world'
    },
    memory: {},
    thread: {},
    plan: {}
  });

  assert.strictEqual(result.execution.status, 'completed');
  console.log('persistNodeConfig.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
