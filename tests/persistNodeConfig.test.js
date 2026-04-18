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
      runtimeQuestionText: 'hello\nVisionCaptionJSON:{}',
      persistUserText: 'hello\n视觉摘要：一张猫图',
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
  const appendCalls = [];
  const persistNodeWithSpy = createPersistNode({
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
    appendShortTermHistory(userId, question) {
      appendCalls.push({ userId, question });
    },
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

  await persistNodeWithSpy({
    request: {
      userId: 'u1',
      question: 'hello',
      runtimeQuestionText: 'hello\nVisionCaptionJSON:{"summary":"cat"}',
      persistUserText: 'hello\n视觉摘要：cat',
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

  assert.strictEqual(appendCalls.length, 1);
  assert.strictEqual(appendCalls[0].question, 'hello\n视觉摘要：cat');
  console.log('persistNodeConfig.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
