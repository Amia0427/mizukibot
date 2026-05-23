const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.POST_REPLY_MEMORY_MODE = 'core';
    process.env.POST_REPLY_VECTOR_MAINTENANCE_ENABLED = 'true';
    process.env.POST_REPLY_MEMORY_QUALITY_AUDIT_ENABLED = 'true';
    process.env.POST_REPLY_VECTOR_WATCHDOG_ENABLED = 'false';
    process.env.RESOURCE_PRESSURE_ENABLED = 'true';
    process.env.RESOURCE_PRESSURE_HEAP_USED_MB = '64';
    process.env.RESOURCE_PRESSURE_RSS_MB = '64';
    process.env.BACKGROUND_PRESSURE_DEFER_MS = '1000';
    process.env.POST_REPLY_ENRICH_PRESSURE_PAUSE_ENABLED = 'true';
    process.env.POST_REPLY_CORE_MINIMAL_UNDER_PRESSURE = 'true';
    process.env.POST_REPLY_WORKER_ENABLED = 'true';
    clearProjectCache();

    const memoryExtraction = require('../api/memoryExtraction');
    const dailyJournal = require('../utils/dailyJournal');
    const selfImprovementRuntime = require('../utils/selfImprovementRuntime');
    const config = require('../config');
    const {
      createPostReplyJobQueue
    } = require('../utils/postReplyJobQueue');
    const {
      createPostReplyWorkerRuntime,
      processPostReplyJob
    } = require('../utils/postReplyWorkerRuntime');

    const calls = [];
    const originalLearnSomethingNew = memoryExtraction.learnSomethingNew;
    const originalAppendDailyJournalEntry = dailyJournal.appendDailyJournalEntry;
    const originalLearnSelfImprovement = selfImprovementRuntime.learnSelfImprovement;

    memoryExtraction.learnSomethingNew = async () => {
      calls.push('memory');
    };
    dailyJournal.appendDailyJournalEntry = async () => {
      calls.push('journal');
    };
    selfImprovementRuntime.learnSelfImprovement = async () => {
      calls.push('self');
      return [];
    };

    config.MEMORY_V3_ENABLED = true;
    config.POST_REPLY_VECTOR_MAINTENANCE_ENABLED = true;
    config.POST_REPLY_MEMORY_QUALITY_AUDIT_ENABLED = true;
    config.MEMORY_PROFILE_MAINTENANCE_ENABLED = true;

    const updatedJobs = [];
    const minimalResult = await processPostReplyJob({
      jobId: 'pressure_minimal_core_job',
      phase: 'core',
      userId: 'u1',
      question: 'q',
      finalReply: 'r',
      postReplyPressureMode: 'minimal',
      tasks: {
        memoryLearning: true,
        selfImprovement: true,
        dailyJournal: true
      }
    }, {
      queue: {
        updateProcessingJob(job, patch = {}) {
          const next = { ...job, ...patch };
          updatedJobs.push(next);
          return next;
        }
      },
      scheduleMaterializeMemoryViews: async () => ({ scheduled: true }),
      runVectorMaintenance: async () => {
        calls.push('vector');
        return { ok: true };
      },
      runMemoryQualityAudit: async () => {
        calls.push('audit');
        return { ok: true };
      },
      runProfileMaintenance: async () => {
        calls.push('profile');
        return { ok: true };
      }
    });

    assert.strictEqual(minimalResult.ok, true);
    assert.ok(calls.includes('memory'), 'minimal core should keep core memory learning');
    assert.ok(calls.includes('journal'), 'minimal core should keep daily journal');
    assert.ok(!calls.includes('self'), 'minimal core should skip self improvement LLM work');
    assert.ok(!calls.includes('vector'), 'minimal core should skip vector maintenance');
    assert.ok(!calls.includes('audit'), 'minimal core should skip memory quality audit');
    assert.ok(!calls.includes('profile'), 'minimal core should skip profile maintenance');
    assert.strictEqual(minimalResult.job.taskStates.selfImprovement.status, 'skipped');
    assert.strictEqual(minimalResult.job.taskStates.vectorMaintenance.status, 'skipped');
    assert.strictEqual(minimalResult.job.taskStates.memoryQualityAudit.status, 'skipped');
    assert.strictEqual(minimalResult.job.taskStates.profileMaintenance.status, 'skipped');
    assert.ok(updatedJobs.some((item) => item.taskStates?.selfImprovement?.status === 'skipped'), 'skip state should persist');

    const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-pressure-'));
    const queue = createPostReplyJobQueue({ queueDir });
    queue.enqueue({
      jobId: 'enrich_pressure_job',
      phase: 'enrich',
      userId: 'u1',
      question: 'eq',
      finalReply: 'er',
      availableAt: '2026-05-23T12:00:00.000Z'
    });
    queue.enqueue({
      jobId: 'core_pressure_job',
      phase: 'core',
      userId: 'u2',
      question: 'cq',
      finalReply: 'cr',
      availableAt: '2026-05-23T12:00:00.000Z'
    });

    const processed = [];
    const runtime = createPostReplyWorkerRuntime({
      queue,
      pollMs: 1000,
      concurrency: 1,
      processJob: async (job) => {
        processed.push(job);
        return { ok: true, job };
      }
    });

    runtime.start();
    for (let i = 0; i < 20 && processed.length === 0; i += 1) {
      await delay(50);
    }
    runtime.stop();

    assert.strictEqual(processed.length, 1);
    assert.strictEqual(processed[0].jobId, 'core_pressure_job', 'pressure mode should defer enrich and claim core first');
    assert.strictEqual(processed[0].postReplyPressureMode, 'minimal');
    assert.strictEqual(queue.listJobs(['queued']).some((job) => job.jobId === 'enrich_pressure_job'), true, 'enrich should remain queued under pressure');
    assert.strictEqual(runtime.getStats().pressureBackoff.active, true);

    memoryExtraction.learnSomethingNew = originalLearnSomethingNew;
    dailyJournal.appendDailyJournalEntry = originalAppendDailyJournalEntry;
    selfImprovementRuntime.learnSelfImprovement = originalLearnSelfImprovement;

    console.log('postReplyPressurePolicy.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
