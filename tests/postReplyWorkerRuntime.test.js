const assert = require('assert');

function clearProjectCache() {
  const projectRoot = require('path').resolve(__dirname, '..') + require('path').sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.POST_REPLY_MEMORY_MODE = 'core';
    process.env.POST_REPLY_DAILY_JOURNAL_SEGMENT_NOW = 'false';
    process.env.POST_REPLY_ENRICH_ENABLED = 'true';
    process.env.POST_REPLY_ENRICH_DELAY_MS = '300000';
    process.env.POST_REPLY_ENRICH_MIN_TURNS = '2';
    process.env.POST_REPLY_ENRICH_MIN_CONTENT_CHARS = '120';
    clearProjectCache();

    const memoryExtraction = require('../api/memoryExtraction');
    const dailyJournal = require('../utils/dailyJournal');
    const selfImprovementRuntime = require('../utils/selfImprovementRuntime');
    const memory = require('../utils/memory');
    const taskMemory = require('../utils/taskMemory');
    const groupMemory = require('../utils/groupMemory');
    const vectorMemory = require('../utils/vectorMemory');

    const calls = [];
    const originalLearnSomethingNew = memoryExtraction.learnSomethingNew;
    const originalExtractPostReplyEnrichment = memoryExtraction.extractPostReplyEnrichment;
    const originalAppendDailyJournalEntry = dailyJournal.appendDailyJournalEntry;
    const originalMaybeSegmentJournalByThreshold = dailyJournal.maybeSegmentJournalByThreshold;
    const originalLearnSelfImprovement = selfImprovementRuntime.learnSelfImprovement;
    const originalStoreExtractedSelfImprovementItems = selfImprovementRuntime.storeExtractedSelfImprovementItems;
    const originalApplyAffinityProposal = memory.applyAffinityProposal;
    const originalAddTaskMemory = taskMemory.addTaskMemory;
    const originalAddTaskMemoryWithVectorBackfill = taskMemory.addTaskMemoryWithVectorBackfill;
    const originalAddGroupMemory = groupMemory.addGroupMemory;
    const originalAddGroupMemoryWithVectorBackfill = groupMemory.addGroupMemoryWithVectorBackfill;
    const originalAddMemoryItemsBatch = vectorMemory.addMemoryItemsBatch;
    const originalAddMemoryItemsBatchWithVectorBackfill = vectorMemory.addMemoryItemsBatchWithVectorBackfill;

    memoryExtraction.learnSomethingNew = async (...args) => {
      calls.push({ type: 'memory', options: args[3] || {} });
      return null;
    };
    memoryExtraction.extractPostReplyEnrichment = async (...args) => {
      calls.push({ type: 'enrich', turns: args[1] || [] });
      return {
        affinity: { relationship: '亲密伙伴', attitude: '稳定亲近', favor_delta: 1, trust_delta: 0, reason: 'test', confidence: 0.9 },
        task_memory: { task_type: 'chat', trigger: 'multi-turn', strategy: 'merge', avoid: '', outcome: 'success', confidence: 0.8 },
        group_memory: { shared_facts: ['群里最近在聊音游'], shared_goals: [], shared_topics: ['音游'], confidence: 0.8 },
        style_memory: { style_patterns: ['回复偏简短直接'], style_avoid: [], confidence: 0.8 },
        jargon_memory: { jargon_terms: ['视奸=潜水围观'], jargon_patterns: [], confidence: 0.8 },
        self_improvement: { items: [{ kind: 'strategy', summary: 'test', details: 'detail', suggested_action: 'act', confidence: 0.9, evidence: ['e1'] }] }
      };
    };
    dailyJournal.appendDailyJournalEntry = async (...args) => {
      calls.push({ type: 'journal', options: args[4] || {} });
      return true;
    };
    dailyJournal.maybeSegmentJournalByThreshold = async (...args) => {
      calls.push({ type: 'segment', args });
      return true;
    };
    selfImprovementRuntime.learnSelfImprovement = async (...args) => {
      calls.push({ type: 'self', options: args[3] || {} });
      return [];
    };
    selfImprovementRuntime.storeExtractedSelfImprovementItems = (...args) => {
      calls.push({ type: 'self_store', args });
      return [];
    };
    memory.applyAffinityProposal = (...args) => {
      calls.push({ type: 'affinity', args });
      return { applied: true };
    };
    taskMemory.addTaskMemory = (...args) => {
      calls.push({ type: 'task', args });
    };
    taskMemory.addTaskMemoryWithVectorBackfill = async (...args) => {
      calls.push({ type: 'task_vector', args });
      return { ids: [] };
    };
    groupMemory.addGroupMemory = (...args) => {
      calls.push({ type: 'group', args });
    };
    groupMemory.addGroupMemoryWithVectorBackfill = async (...args) => {
      calls.push({ type: 'group_vector', args });
      return { ids: [] };
    };
    vectorMemory.addMemoryItemsBatch = (...args) => {
      calls.push({ type: 'vector', args });
      return [];
    };
    vectorMemory.addMemoryItemsBatchWithVectorBackfill = async (...args) => {
      calls.push({ type: 'vector_backfill', args });
      return { ids: [] };
    };

    delete require.cache[require.resolve('../utils/postReplyWorkerRuntime')];
    const {
      processPostReplyJob,
      createPostReplyWorkerRuntime,
      schedulePostReplyMaterialize,
      flushPostReplyMaterialize
    } = require('../utils/postReplyWorkerRuntime');

    await processPostReplyJob({
      userId: 'u1',
      question: 'hello world',
      finalReply: 'reply text',
      sessionKey: 's1',
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        groupId: '1083095371'
      },
      tasks: {
        memoryLearning: true,
        selfImprovement: true,
        dailyJournal: true
      }
    });

    const memoryCall = calls.find((item) => item.type === 'memory');
    const journalCall = calls.find((item) => item.type === 'journal');
    const selfCall = calls.find((item) => item.type === 'self');
    assert.ok(memoryCall, 'memory learning should run');
    assert.ok(journalCall, 'daily journal should run');
    assert.ok(selfCall, 'self improvement should run');
    assert.strictEqual(memoryCall.options.postReplyMemoryMode, 'core');
    assert.strictEqual(journalCall.options.segmentNow, false);
    await flushPostReplyMaterialize({ force: true, source: 'test_cleanup' });

    const materializeFirst = schedulePostReplyMaterialize({ delayMs: 60000 });
    const materializeSecond = schedulePostReplyMaterialize({ delayMs: 60000 });
    assert.strictEqual(materializeFirst.scheduled, true);
    assert.strictEqual(materializeFirst.coalesced, false);
    assert.strictEqual(materializeSecond.scheduled, true);
    assert.strictEqual(materializeSecond.coalesced, true);
    assert.strictEqual(materializeSecond.pendingCount, 2);
    await flushPostReplyMaterialize({ force: true, source: 'test_flush' });

    const queued = [];
    const runtime = createPostReplyWorkerRuntime({
      queue: {
        recoverStaleProcessingJobs() {
          return [];
        },
        claimNextJob() {
          return null;
        },
        markDone(job) {
          return job;
        },
        markFailed(job) {
          return job;
        },
        retryOrFail(job) {
          return { job, retried: true };
        },
        findQueuedJobByAggregateKey() {
          return null;
        },
        enqueue(job) {
          queued.push(job);
          return {
            enqueued: true,
            job: {
              ...job,
              jobId: 'enrich_job_1'
            }
          };
        }
      },
      processJob: async () => {}
    });

    await runtime.runOneJob({
      jobId: 'core_job_1',
      phase: 'core',
      userId: 'u1',
      question: 'hello world',
      finalReply: 'reply text',
      sessionKey: 's1',
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        groupId: '1083095371'
      },
      turns: [
        { question: 'q1', finalReply: 'r1', createdAt: new Date().toISOString(), routeMeta: { groupId: '1083095371' }, continuitySnapshot: {}, contextStats: {} },
        { question: 'q2', finalReply: 'r2', createdAt: new Date().toISOString(), routeMeta: { groupId: '1083095371' }, continuitySnapshot: {}, contextStats: {} }
      ],
      tasks: {
        memoryLearning: true,
        selfImprovement: true,
        dailyJournal: true
      }
    });

    assert.strictEqual(queued.length, 1, 'core completion should schedule one enrich job when thresholds pass');
    assert.strictEqual(queued[0].phase, 'enrich');

    calls.length = 0;
    await processPostReplyJob({
      userId: 'u1',
      question: 'hello world',
      finalReply: 'reply text',
      sessionKey: 's1',
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        groupId: '1083095371'
      },
      phase: 'enrich',
      turns: [
        { question: 'q1', finalReply: 'r1', createdAt: '2026-04-18T10:00:00.000Z', routeMeta: { groupId: '1083095371' }, continuitySnapshot: {}, contextStats: {} },
        { question: 'q2', finalReply: 'r2', createdAt: '2026-04-18T10:02:00.000Z', routeMeta: { groupId: '1083095371' }, continuitySnapshot: {}, contextStats: {} }
      ],
      tasks: {
        memoryLearning: true,
        selfImprovement: true,
        dailyJournal: true
      }
    });

    assert.ok(calls.some((item) => item.type === 'enrich'), 'enrich phase should use merged extractor');
    assert.ok(calls.some((item) => item.type === 'affinity'), 'enrich phase should apply affinity');
    assert.ok(calls.some((item) => item.type === 'task_vector'), 'enrich phase should store task memory with vector backfill');
    assert.ok(calls.some((item) => item.type === 'group_vector'), 'enrich phase should store group memory with vector backfill');
    assert.ok(calls.some((item) => item.type === 'vector_backfill'), 'enrich phase should store style/jargon vectors with backfill');
    assert.ok(calls.some((item) => item.type === 'self_store'), 'enrich phase should store self-improvement items');
    assert.ok(calls.some((item) => item.type === 'segment'), 'enrich phase should trigger threshold segmentation');

    const circuitQueue = {
      recoverStaleProcessingJobs() {
        return [];
      },
      claimNextJob() {
        return null;
      },
      markDone(job, patch = {}) {
        return { ...job, ...patch, status: 'done' };
      },
      markFailed(job, error) {
        return { ...job, status: 'failed', lastError: error };
      },
      retryOrFail(job, error) {
        return { job: { ...job, status: 'queued', lastError: error }, retried: true };
      },
      findQueuedJobByAggregateKey() {
        return null;
      },
      enqueue(job) {
        return { enqueued: true, job };
      }
    };
    const failingRuntime = createPostReplyWorkerRuntime({
      queue: circuitQueue,
      processJob: async (job) => {
        if (job.phase === 'enrich') throw new Error('Request failed with status code 429');
        throw new Error('Request failed with status code 403');
      }
    });

    const terminal = await failingRuntime.runOneJob({
      jobId: 'terminal_job',
      phase: 'core',
      userId: 'u1',
      question: 'q',
      finalReply: 'r',
      tasks: {}
    });
    assert.strictEqual(terminal.status, 'failed', '403 should be terminal for post-reply phase');

    const retried = await failingRuntime.runOneJob({
      jobId: 'retry_job',
      phase: 'enrich',
      userId: 'u1',
      question: 'q',
      finalReply: 'r',
      tasks: {}
    });
    assert.strictEqual(retried.status, 'queued', '429 should remain retryable for post-reply phase');
    assert.ok(Number(retried.retryDelayMs || 0) >= 1000 || /429/.test(String(retried.lastError || '')));

    calls.length = 0;
    let firstPartialRun = true;
    const partialQueue = {
      updatedJobs: [],
      recoverStaleProcessingJobs() {
        return [];
      },
      claimNextJob() {
        return null;
      },
      updateProcessingJob(job, patch = {}) {
        const next = { ...job, ...patch };
        this.updatedJobs.push(next);
        return next;
      },
      markDone(job) {
        return { ...job, status: 'done' };
      },
      markFailed(job, error) {
        return { ...job, status: 'failed', lastError: error };
      },
      retryOrFail(job, error) {
        return { job: { ...job, status: 'queued', lastError: error }, retried: true };
      },
      findQueuedJobByAggregateKey() {
        return null;
      },
      enqueue(job) {
        return { enqueued: true, job };
      }
    };
    const partialRuntime = createPostReplyWorkerRuntime({
      queue: partialQueue,
      processJob: async (job, deps) => {
        const result = await processPostReplyJob(job, deps);
        if (firstPartialRun) {
          firstPartialRun = false;
          throw new Error('Request failed with status code 503');
        }
        return result;
      }
    });
    const partialFirst = await partialRuntime.runOneJob({
      jobId: 'partial_retry_job',
      phase: 'core',
      userId: 'u1',
      question: 'hello world',
      finalReply: 'reply text',
      sessionKey: 's1',
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        groupId: '1083095371'
      },
      tasks: {
        memoryLearning: true,
        selfImprovement: true,
        dailyJournal: true
      }
    });
    assert.strictEqual(partialFirst.status, 'queued');
    assert.ok(partialFirst.completedTasks.memoryLearning, 'completed memory task should be persisted before retry');
    assert.ok(partialFirst.completedTasks.selfImprovement, 'completed self task should be persisted before retry');
    assert.ok(partialFirst.completedTasks.dailyJournal, 'completed journal task should be persisted before retry');

    calls.length = 0;
    const partialSecond = await partialRuntime.runOneJob(partialFirst);
    assert.strictEqual(partialSecond.status, 'done');
    assert.ok(!calls.some((item) => item.type === 'memory'), 'retry should not rerun completed memory learning');
    assert.ok(!calls.some((item) => item.type === 'self'), 'retry should not rerun completed self improvement');
    assert.ok(!calls.some((item) => item.type === 'journal'), 'retry should not rerun completed daily journal');

    calls.length = 0;
    const materializeResumeCalls = [];
    const materializeResumeQueue = {
      updatedJobs: [],
      updateProcessingJob(job, patch = {}) {
        const next = { ...job, ...patch };
        this.updatedJobs.push(next);
        return next;
      }
    };
    const materializeResume = await processPostReplyJob({
      jobId: 'materialize_resume_job',
      phase: 'core',
      userId: 'u1',
      question: 'hello world',
      finalReply: 'reply text',
      sessionKey: 's1',
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        groupId: '1083095371'
      },
      tasks: {},
      completedTasks: {
        memoryEvent: true
      }
    }, {
      queue: materializeResumeQueue,
      scheduleMaterializeMemoryViews: async (options = {}) => {
        materializeResumeCalls.push(options);
        return { scheduled: true, coalesced: false, delayMs: 1, pendingCount: 1 };
      }
    });
    assert.strictEqual(materializeResumeCalls.length, 1, 'retry should still schedule materialize when only memory event completed');
    assert.strictEqual(materializeResume.job.completedTasks.memoryEvent, true);
    assert.strictEqual(materializeResume.job.completedTasks.materialize, true);
    assert.ok(!calls.some((item) => item.type === 'memory'), 'materialize resume should not rerun heavy memory learning');

    memoryExtraction.learnSomethingNew = originalLearnSomethingNew;
    memoryExtraction.extractPostReplyEnrichment = originalExtractPostReplyEnrichment;
    dailyJournal.appendDailyJournalEntry = originalAppendDailyJournalEntry;
    dailyJournal.maybeSegmentJournalByThreshold = originalMaybeSegmentJournalByThreshold;
    selfImprovementRuntime.learnSelfImprovement = originalLearnSelfImprovement;
    selfImprovementRuntime.storeExtractedSelfImprovementItems = originalStoreExtractedSelfImprovementItems;
    memory.applyAffinityProposal = originalApplyAffinityProposal;
    taskMemory.addTaskMemory = originalAddTaskMemory;
    taskMemory.addTaskMemoryWithVectorBackfill = originalAddTaskMemoryWithVectorBackfill;
    groupMemory.addGroupMemory = originalAddGroupMemory;
    groupMemory.addGroupMemoryWithVectorBackfill = originalAddGroupMemoryWithVectorBackfill;
    vectorMemory.addMemoryItemsBatch = originalAddMemoryItemsBatch;
    vectorMemory.addMemoryItemsBatchWithVectorBackfill = originalAddMemoryItemsBatchWithVectorBackfill;

    console.log('postReplyWorkerRuntime.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
