const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createPostReplyJobQueue
} = require('../utils/postReplyJobQueue');
const {
  normalizeJob
} = require('../utils/postReplyJobQueue/jobShape');
const {
  isTaskCompleted,
  markTaskCompleted,
  markTaskFailedNonFatal,
  markTaskStarted,
  normalizeCompletedTasks,
  normalizeTaskStates
} = require('../utils/postReplyWorker/common');

module.exports = (() => {
  const legacyJob = normalizeJob({
    jobId: 'legacy_task_state_job',
    userId: 'u1',
    question: 'q',
    finalReply: 'r',
    completedTasks: {
      memoryLearning: true,
      selfImprovement: false
    }
  });
  assert.strictEqual(legacyJob.completedTasks.memoryLearning, true);
  assert.strictEqual(legacyJob.taskStates.memoryLearning.status, 'done');
  assert.strictEqual(isTaskCompleted(legacyJob, 'memoryLearning'), true);
  assert.strictEqual(isTaskCompleted(legacyJob, 'selfImprovement'), false);

  const structuredJob = normalizeJob({
    jobId: 'structured_task_state_job',
    userId: 'u1',
    question: 'q',
    finalReply: 'r',
    taskStates: {
      dailyJournal: {
        status: 'done',
        attempt: 2,
        durationMs: 12
      }
    }
  });
  assert.strictEqual(structuredJob.completedTasks.dailyJournal, true);
  assert.strictEqual(structuredJob.taskStates.dailyJournal.attempt, 2);
  assert.strictEqual(isTaskCompleted(structuredJob, 'dailyJournal'), true);

  const updates = [];
  const queue = {
    updateProcessingJob(job, patch = {}) {
      const next = { ...job, ...patch };
      updates.push(next);
      return next;
    }
  };
  let runningJob = markTaskStarted({
    jobId: 'running_task_state_job',
    completedTasks: {},
    taskStates: {}
  }, { queue }, 'memoryLearning', {
    startedAt: '2026-05-23T12:00:00.000Z',
    step: 'learnSomethingNew'
  });
  assert.strictEqual(runningJob.taskStates.memoryLearning.status, 'running');
  assert.strictEqual(runningJob.taskStates.memoryLearning.attempt, 1);
  assert.strictEqual(runningJob.completedTasks.memoryLearning, false);

  runningJob = markTaskCompleted(runningJob, { queue }, 'memoryLearning', {
    startedAt: '2026-05-23T12:00:00.000Z',
    completedAt: '2026-05-23T12:00:01.000Z',
    durationMs: 1000,
    step: 'learnSomethingNew'
  });
  assert.strictEqual(runningJob.taskStates.memoryLearning.status, 'done');
  assert.strictEqual(runningJob.completedTasks.memoryLearning, true);
  assert.strictEqual(runningJob.taskStates.memoryLearning.durationMs, 1000);

  const nonFatalJob = markTaskFailedNonFatal(runningJob, { queue }, 'memoryQualityAudit', new Error('audit failed'), {
    startedAt: '2026-05-23T12:01:00.000Z',
    completedAt: '2026-05-23T12:01:01.000Z',
    durationMs: 1000,
    step: 'runMemoryQualityAudit'
  });
  assert.strictEqual(nonFatalJob.taskStates.memoryQualityAudit.status, 'failed_nonfatal');
  assert.strictEqual(nonFatalJob.completedTasks.memoryQualityAudit, true);
  assert.strictEqual(nonFatalJob.taskStates.memoryQualityAudit.lastError, 'audit failed');
  assert.ok(updates.length >= 3, 'task progress should persist through queue.updateProcessingJob');

  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-task-state-'));
  const aggregateQueue = createPostReplyJobQueue({ queueDir });
  const first = aggregateQueue.enqueue({
    jobId: 'merge_task_states',
    userId: 'u2',
    aggregateKey: 'core|u2|s2|g2',
    routeMeta: { groupId: 'g2' },
    completedTasks: {
      memoryLearning: true,
      memoryQualityAudit: true
    },
    taskStates: {
      memoryLearning: {
        status: 'done',
        attempt: 1,
        durationMs: 5,
        result: { learned: 1 }
      },
      memoryQualityAudit: {
        status: 'failed_nonfatal',
        attempt: 1,
        lastError: 'old audit failure',
        durationMs: 5
      }
    },
    turns: [{ turnId: 't1', question: 'q1', finalReply: 'r1' }]
  });
  const merged = aggregateQueue.mergeQueuedJob(first.job, {
    tasks: {
      memoryLearning: true
    },
    turns: [{ turnId: 't2', question: 'q2', finalReply: 'r2' }]
  });
  assert.strictEqual(merged.completedTasks.memoryLearning, false);
  assert.strictEqual(merged.taskStates.memoryLearning.status, 'pending');
  assert.strictEqual(merged.taskStates.memoryLearning.lastError, '');
  assert.deepStrictEqual(merged.taskStates.memoryLearning.result, {});
  assert.strictEqual(merged.completedTasks.memoryQualityAudit, false);
  assert.strictEqual(merged.taskStates.memoryQualityAudit.status, 'pending');

  assert.deepStrictEqual(normalizeCompletedTasks({
    profileMaintenance: {
      status: 'failed_nonfatal'
    }
  }), {
    profileMaintenance: true
  });
  assert.strictEqual(normalizeTaskStates({
    enrich: {
      status: 'done',
      durationMs: 3
    }
  }).enrich.status, 'done');

  console.log('postReplyTaskState.test.js passed');
})();
