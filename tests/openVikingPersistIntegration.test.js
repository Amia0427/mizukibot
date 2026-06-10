const assert = require('assert');

const { createPersistNode } = require('../api/runtimeV2/nodes/persist');

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
    appendMemoryEvent: async () => {},
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
    },
    ...overrides
  };
}

module.exports = (async () => {
  const calls = [];
  const persistNode = createPersistNode(createDeps({
    ingestOpenVikingTurnAsync(input) {
      calls.push(input);
      return new Promise(() => {});
    }
  }));

  const result = await persistNode({
    request: {
      userId: 'u1',
      question: 'hello',
      runtimeQuestionText: 'hello',
      persistUserText: 'hello',
      routeMeta: {
        groupId: 'g1',
        senderId: 's1',
        channel: 'qq',
        senderName: 'Alice'
      },
      sessionKey: 'session-1',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat'
    },
    output: {
      finalReply: 'world'
    },
    memory: {},
    execution: { latencyDecision: {} },
    thread: {},
    plan: {
      finalExecLogs: [{ action: 'secret_tool', ok: true, raw: 'do not persist' }]
    }
  });

  assert.strictEqual(result.execution.status, 'completed');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], {
    userId: 'u1',
    senderId: 's1',
    groupId: 'g1',
    channelId: '',
    sessionKey: 'session-1',
    sessionId: '',
    platform: 'qq',
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat',
    senderName: 'Alice',
    userText: 'hello',
    assistantText: 'world'
  });
  assert.ok(!JSON.stringify(calls[0]).includes('do not persist'), 'raw tool output must not be sent to OpenViking ingest');

  const blockedCalls = [];
  const blockedPersistNode = createPersistNode(createDeps({
    isReviewMode(value) {
      return value === true;
    },
    ingestOpenVikingTurnAsync(input) {
      blockedCalls.push(input);
    }
  }));
  await blockedPersistNode({
    request: {
      userId: 'u1',
      question: 'hello',
      runtimeQuestionText: 'hello',
      persistUserText: 'hello',
      routeMeta: {},
      sessionKey: 'session-1',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat',
      reviewMode: true
    },
    output: { finalReply: 'world' },
    memory: {},
    execution: { latencyDecision: {} },
    thread: {},
    plan: {}
  });
  assert.strictEqual(blockedCalls.length, 0, 'unsafe persist branches should not ingest OpenViking');

  console.log('openVikingPersistIntegration.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
