const assert = require('assert');

const { createPersistNode } = require('../api/runtimeV2/nodes/persist');

module.exports = (async () => {
  const deferredPersistNode = createPersistNode({
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
      return true;
    },
    shouldQueueMemoryLearningForV2() {
      return true;
    },
    shouldLearnSelfImprovement() {
      return true;
    },
    appendShortTermHistory() {
      throw new Error('deferred persist should not synchronously append short-term history');
    },
    persistShortTermBridgeSnapshot() {
      throw new Error('deferred persist should not synchronously persist bridge snapshot');
    },
    async appendMemoryEvent() {
      throw new Error('deferred persist should not synchronously append memory event');
    },
    materializeMemoryViews() {
      throw new Error('deferred persist should not synchronously materialize memory views');
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
        throw new Error('deferred persist should not synchronously enqueue post-reply work');
      }
    },
    chatHistory: {},
    shortTermMemory: {},
    config: {
      MEMORY_V3_ENABLED: true
    },
    saveAndEmit(state) {
      return state;
    }
  });

  const deferredResult = await deferredPersistNode({
    request: {
      userId: 'u1',
      question: '我们刚才聊到哪了',
      runtimeQuestionText: '我们刚才聊到哪了',
      persistUserText: '我们刚才聊到哪了',
      routeMeta: { groupId: 'g1' },
      sessionKey: 's1',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat',
      deferPersist: true
    },
    output: {
      finalReply: '我们刚才聊到旅行计划。'
    },
    memory: {
      continuityState: {
        payload: {
          active_topic: '旅行计划',
          open_loops: ['订酒店'],
          assistant_commitments: ['明天继续补攻略'],
          user_constraints: ['预算有限']
        }
      }
    },
    execution: {
      latencyDecision: {
        deferPersist: true
      },
      deferredJobs: []
    },
    thread: { threadId: 't_deferred' },
    plan: {
      finalExecLogs: [{ action: 'memory_cli', ok: true }]
    }
  });

  assert.strictEqual(deferredResult.execution.currentNode, 'persist');
  assert.strictEqual(deferredResult.execution.pendingReplySnapshot.activeTopic, '旅行计划');
  assert.deepStrictEqual(deferredResult.execution.pendingReplySnapshot.openLoops, ['订酒店']);
  assert.strictEqual(Array.isArray(deferredResult.execution.deferredJobs), true);
  assert.strictEqual(deferredResult.execution.deferredJobs.length, 1);
  assert.ok((deferredResult.events || []).some((item) => item.type === 'persist_deferred'));
  const deferredEvent = (deferredResult.events || []).find((item) => item.type === 'persist_deferred');
  assert.strictEqual(deferredEvent.shouldPersistBridge, true);
  assert.strictEqual(deferredEvent.shouldPersistJournal, true);
  assert.strictEqual(deferredEvent.shouldLearn, true);

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
  const writeDecision = (result.events || []).find((item) => item.type === 'persist_write_decision');
  assert.ok(writeDecision, 'persist should emit an auditable write decision event');
  assert.strictEqual(writeDecision.saved, true);
  assert.strictEqual(writeDecision.shouldPersistBridge, true);
  assert.strictEqual(writeDecision.shouldPersistJournal, false);
  assert.strictEqual(writeDecision.shouldLearn, false);
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

  let enqueueCount = 0;
  let mergeCount = 0;
  let queuedJob = null;
  const persistNodeWithPostReplyGate = createPersistNode({
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
      return true;
    },
    shouldQueueMemoryLearningForV2() {
      return true;
    },
    shouldLearnSelfImprovement() {
      return true;
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
      findQueuedJobByAggregateKey() {
        return queuedJob;
      },
      mergeQueuedJob(job, patch) {
        mergeCount += 1;
        queuedJob = {
          ...job,
          ...patch,
          turns: [...(Array.isArray(job.turns) ? job.turns : []), ...(Array.isArray(patch.turns) ? patch.turns : [])]
        };
        return queuedJob;
      },
      enqueue() {
        enqueueCount += 1;
        queuedJob = {
          jobId: 'job_1',
          dedupeKey: 'dedupe_1',
          tasks: {},
          turns: []
        };
        return { enqueued: true, job: queuedJob };
      }
    },
    chatHistory: {},
    shortTermMemory: {},
    config: {
      MEMORY_V3_ENABLED: false,
      POST_REPLY_WORKER_GROUP_IDS: ['1083095371'],
      POST_REPLY_MIN_CONTENT_CHARS: 10,
      POST_REPLY_USER_COOLDOWN_MS: 300000
    },
    saveAndEmit(state) {
      return state;
    }
  });

  const gatedState = {
    request: {
      userId: 'u1',
      question: 'hello there',
      runtimeQuestionText: 'hello there',
      persistUserText: 'hello there',
      routeMeta: { groupId: '1083095371' },
      sessionKey: 's1',
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat'
    },
    output: {
      finalReply: 'reply text'
    },
    memory: {},
    thread: { threadId: 't1' },
    plan: {}
  };

  await persistNodeWithPostReplyGate(gatedState);
  await persistNodeWithPostReplyGate(gatedState);
  assert.strictEqual(enqueueCount, 1, 'post-reply enqueue should respect per-user cooldown');
  assert.strictEqual(mergeCount, 0, 'cooldown should prevent merge in the strict cooldown case');

  let aggregateEnqueueCount = 0;
  let aggregateMergeCount = 0;
  let aggregateQueuedJob = null;
  const persistNodeWithAggregate = createPersistNode({
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
      return true;
    },
    shouldQueueMemoryLearningForV2() {
      return true;
    },
    shouldLearnSelfImprovement() {
      return true;
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
      findQueuedJobByAggregateKey() {
        return aggregateQueuedJob;
      },
      mergeQueuedJob(job, patch) {
        aggregateMergeCount += 1;
        aggregateQueuedJob = {
          ...job,
          ...patch,
          turns: [...(Array.isArray(job.turns) ? job.turns : []), ...(Array.isArray(patch.turns) ? patch.turns : [])]
        };
        return aggregateQueuedJob;
      },
      enqueue(job) {
        aggregateEnqueueCount += 1;
        aggregateQueuedJob = {
          ...job,
          jobId: 'agg_job_1',
          dedupeKey: 'agg_dedupe_1'
        };
        return { enqueued: true, job: aggregateQueuedJob };
      }
    },
    chatHistory: {},
    shortTermMemory: {},
    config: {
      MEMORY_V3_ENABLED: false,
      POST_REPLY_WORKER_GROUP_IDS: ['1083095371'],
      POST_REPLY_MIN_CONTENT_CHARS: 10,
      POST_REPLY_USER_COOLDOWN_MS: 0,
      POST_REPLY_AGGREGATE_WINDOW_MS: 300000,
      POST_REPLY_IDLE_FLUSH_MS: 90000
    },
    saveAndEmit(state) {
      return state;
    }
  });

  await persistNodeWithAggregate(gatedState);
  await persistNodeWithAggregate(gatedState);
  assert.strictEqual(aggregateEnqueueCount, 1, 'windowed aggregate should enqueue once');
  assert.strictEqual(aggregateMergeCount, 1, 'second turn in window should merge into queued core job');
  assert.strictEqual(Array.isArray(aggregateQueuedJob.turns) ? aggregateQueuedJob.turns.length : 0, 2);
  console.log('persistNodeConfig.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
