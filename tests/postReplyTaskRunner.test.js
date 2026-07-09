const assert = require('assert');

const {
  TASK_DEFINITIONS,
  listTaskDefinitions
} = require('../utils/postReplyWorker/taskRegistry');
const {
  createPostReplyTaskRunner
} = require('../utils/postReplyWorker/taskRunner');

module.exports = (async () => {
  const keys = listTaskDefinitions().map((item) => item.key);
  assert.deepStrictEqual(keys, [
    'memoryLearning',
    'selfImprovement',
    'dailyJournal',
    'memoryEvent',
    'materialize',
    'vectorMaintenance',
    'memoryQualityAudit',
    'profileMaintenance',
    'enrich'
  ]);
  assert.strictEqual(TASK_DEFINITIONS.vectorMaintenance.failurePolicy, 'nonfatal');
  assert.deepStrictEqual(TASK_DEFINITIONS.materialize.dependsOn, ['memoryEvent']);
  assert.strictEqual(TASK_DEFINITIONS.selfImprovement.upstreamFailurePolicy, 'degrade');
  assert.strictEqual(TASK_DEFINITIONS.enrich.upstreamFailurePolicy, 'degrade');

  const persisted = [];
  const runner = createPostReplyTaskRunner({
    job: {
      jobId: 'runner_job',
      completedTasks: {},
      taskStates: {}
    },
    deps: {
      queue: {
        updateProcessingJob(job) {
          persisted.push(job);
          return job;
        }
      }
    }
  });

  await runner.runTask('memoryEvent', async () => ({ ok: true }));
  await runner.runTask('materialize', async () => ({ ok: true }));
  let job = runner.getJob();
  assert.strictEqual(job.completedTasks.memoryEvent, true);
  assert.strictEqual(job.taskStates.memoryEvent.status, 'done');
  assert.strictEqual(job.completedTasks.materialize, true);
  assert.strictEqual(job.taskStates.materialize.status, 'done');
  assert.ok(job.taskStates.memoryEvent.durationMs >= 0);
  assert.deepStrictEqual(job.taskStates.materialize.result, { ok: true });

  await runner.runTask('vectorMaintenance', async () => {
    throw new Error('vector failed');
  });
  job = runner.getJob();
  assert.strictEqual(job.completedTasks.vectorMaintenance, true);
  assert.strictEqual(job.taskStates.vectorMaintenance.status, 'failed_nonfatal');
  assert.match(job.taskStates.vectorMaintenance.lastError, /vector failed/);

  const dependencyRunner = createPostReplyTaskRunner({
    job: {
      jobId: 'dependency_job',
      completedTasks: {},
      taskStates: {}
    }
  });
  await dependencyRunner.runTask('materialize', async () => {
    throw new Error('should not run');
  });
  const dependencyJob = dependencyRunner.getJob();
  assert.strictEqual(dependencyJob.completedTasks.materialize, true);
  assert.strictEqual(dependencyJob.taskStates.materialize.status, 'skipped');
  assert.strictEqual(dependencyJob.taskStates.materialize.lastError, 'dependency_incomplete:memoryEvent');

  const fatalRunner = createPostReplyTaskRunner({
    job: {
      jobId: 'fatal_job',
      completedTasks: {},
      taskStates: {}
    }
  });
  await assert.rejects(
    () => fatalRunner.runTask('memoryLearning', async () => {
      throw new Error('fatal failed');
    }),
    /fatal failed/
  );
  assert.strictEqual(fatalRunner.getJob().completedTasks.memoryLearning, false);
  assert.strictEqual(fatalRunner.getJob().taskStates.memoryLearning.status, 'failed');
  assert.ok(persisted.length >= 2, 'runner should persist task transitions when queue is available');

  const retryable495Runner = createPostReplyTaskRunner({
    job: {
      jobId: 'retryable_495_job',
      phase: 'core',
      attempt: 0,
      completedTasks: {},
      taskStates: {}
    }
  });
  await assert.rejects(
    () => retryable495Runner.runTask('selfImprovement', async () => {
      throw new Error('Request failed with status code 495');
    }),
    /495/
  );
  assert.strictEqual(retryable495Runner.getJob().taskStates.selfImprovement.status, 'failed');

  const final495Runner = createPostReplyTaskRunner({
    job: {
      jobId: 'final_495_job',
      phase: 'core',
      attempt: 1,
      completedTasks: {},
      taskStates: {}
    }
  });
  await final495Runner.runTask('selfImprovement', async () => {
    throw new Error('Request failed with status code 495');
  });
  const final495Job = final495Runner.getJob();
  assert.strictEqual(final495Job.completedTasks.selfImprovement, true);
  assert.strictEqual(final495Job.taskStates.selfImprovement.status, 'skipped');
  assert.strictEqual(final495Job.taskStates.selfImprovement.lastError, 'upstream_495_degraded');

  console.log('postReplyTaskRunner.test.js passed');
})();
