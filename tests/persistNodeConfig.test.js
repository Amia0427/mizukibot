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

  let unsafeAppendCalled = false;
  const unsafePersistNode = createPersistNode({
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
      unsafeAppendCalled = true;
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
        throw new Error('unsafe reply should not enqueue post-reply work');
      }
    },
    chatHistory: {},
    shortTermMemory: {},
    config: {
      MEMORY_V3_ENABLED: false,
      POST_REPLY_WORKER_GROUP_IDS: ['g1']
    },
    saveAndEmit(state) {
      return state;
    }
  });

  const unsafePersistResult = await unsafePersistNode({
    request: {
      userId: 'u1',
      question: '喂猪50一天去不去',
      runtimeQuestionText: '喂猪50一天去不去',
      persistUserText: '喂猪50一天去不去',
      routeMeta: { groupId: 'g1' },
      sessionKey: 's1',
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat'
    },
    output: {
      finalReply: 'I\'ll search for "[Context for assistant only] [ContinuityState] [ActiveTopic] 喂猪50一天去不去"'
    },
    memory: {},
    thread: {},
    plan: {}
  });
  const unsafeDecision = (unsafePersistResult.events || []).find((item) => item.type === 'persist_write_decision');
  assert.strictEqual(unsafeAppendCalled, false);
  assert.strictEqual(unsafeDecision.saved, false);
  assert.ok(unsafeDecision.gateReasons.includes('unsafe_user_facing_reply'));

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
  const workerWakeCalls = [];
  const workerWakeTraceEvents = [];
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
    ensurePostReplyWorkerRunning(info) {
      workerWakeCalls.push(info);
      return { started: true, reason: 'started', pid: 1234 };
    },
    appendRequestTraceEvent(event) {
      workerWakeTraceEvents.push(event);
    },
    normalizeRequestTrace(value) {
      return value && value.requestId ? value : null;
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
      requestTrace: { requestId: 'trace-post-reply-wake' },
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
  assert.strictEqual(workerWakeCalls.length, 1, 'post-reply worker should be woken after a queued job is written');
  assert.strictEqual(workerWakeCalls[0].jobId, 'job_1');
  assert.ok(workerWakeTraceEvents.some((event) => event.stage === 'persist_post_reply_worker_wake' && event.workerStarted === true));

  let recapEnqueueCalled = false;
  let recapBridgeCalled = false;
  const persistNodeWithRecapGate = createPersistNode({
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
    persistShortTermBridgeSnapshot() {
      recapBridgeCalled = true;
    },
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
        recapEnqueueCalled = true;
        throw new Error('recap reply should not enqueue post-reply work');
      }
    },
    ensurePostReplyWorkerRunning(info) {
      workerWakeCalls.push(info);
      return { started: true, reason: 'started', pid: 1234 };
    },
    appendRequestTraceEvent(event) {
      workerWakeTraceEvents.push(event);
    },
    normalizeRequestTrace(value) {
      return value && value.requestId ? value : null;
    },
    chatHistory: {},
    shortTermMemory: {},
    config: {
      MEMORY_V3_ENABLED: false,
      POST_REPLY_WORKER_GROUP_IDS: ['1083095371'],
      POST_REPLY_MIN_CONTENT_CHARS: 10,
      POST_REPLY_USER_COOLDOWN_MS: 0
    },
    saveAndEmit(state) {
      return state;
    }
  });

  const recapResult = await persistNodeWithRecapGate({
    request: {
      userId: 'u_recap',
      question: '宝说一下我们今天聊的',
      runtimeQuestionText: '宝说一下我们今天聊的',
      persistUserText: '宝说一下我们今天聊的',
      routeMeta: { groupId: '1083095371' },
      sessionKey: 's_recap',
      routePolicyKey: 'lookup/notebook-answer',
      topRouteType: 'direct_chat'
    },
    output: {
      finalReply: '今天聊了音游抽卡和前面的几件事。'
    },
    memory: {},
    thread: { threadId: 't_recap' },
    plan: {}
  });
  const recapDecision = (recapResult.events || []).find((item) => item.type === 'persist_write_decision');
  assert.strictEqual(recapEnqueueCalled, false, 'recap replies should not enqueue post-reply work');
  assert.strictEqual(recapBridgeCalled, true, 'recap replies should still preserve short-term bridge continuity');
  assert.strictEqual(recapDecision.postReplyRecapQuery, true);
  assert.strictEqual(recapDecision.shouldQueuePostReplyJournalTask, false);
  assert.strictEqual(recapDecision.shouldQueuePostReplyMemoryTasks, false);
  assert.ok(recapDecision.gateReasons.includes('post_reply_recap_query'));

  let directChatQueuedJob = null;
  const persistNodeWithDirectJournal = createPersistNode({
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
        return null;
      },
      enqueue(job) {
        directChatQueuedJob = {
          ...job,
          jobId: 'direct_journal_job',
          dedupeKey: 'direct_journal_dedupe'
        };
        return { enqueued: true, job: directChatQueuedJob };
      }
    },
    chatHistory: {},
    shortTermMemory: {},
    config: {
      MEMORY_V3_ENABLED: false,
      POST_REPLY_WORKER_GROUP_IDS: ['allowed_group'],
      POST_REPLY_MIN_CONTENT_CHARS: 10,
      POST_REPLY_USER_COOLDOWN_MS: 0
    },
    saveAndEmit(state) {
      return state;
    }
  });

  const directJournalResult = await persistNodeWithDirectJournal({
    request: {
      userId: 'u_direct',
      question: 'direct chat daily journal input',
      runtimeQuestionText: 'direct chat daily journal input',
      persistUserText: 'direct chat daily journal input',
      routeMeta: {},
      sessionKey: 's_direct',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat'
    },
    output: {
      finalReply: 'direct chat daily journal reply'
    },
    memory: {},
    thread: { threadId: 't_direct' },
    plan: {}
  });
  assert.ok(directChatQueuedJob, 'direct_chat should enqueue journal even without group allowlist');
  assert.strictEqual(directChatQueuedJob.tasks.dailyJournal, true);
  assert.strictEqual(directChatQueuedJob.tasks.memoryLearning, false);
  assert.strictEqual(directChatQueuedJob.tasks.selfImprovement, false);
  const directDecision = (directJournalResult.events || []).find((item) => item.type === 'persist_write_decision');
  assert.strictEqual(directDecision.shouldQueuePostReplyJournalTask, true);
  assert.strictEqual(directDecision.shouldQueuePostReplyMemoryTasks, false);

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
