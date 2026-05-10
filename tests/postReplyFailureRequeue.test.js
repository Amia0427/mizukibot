const assert = require('assert');

const {
  parseArgs,
  classifyPostReplyJobError,
  isTransient,
  isTerminal,
  planRequeueJobs,
  shouldApplyRequeue
} = require('../scripts/requeue-post-reply-failed');

assert.strictEqual(classifyPostReplyJobError({ lastError: '429 rate limit' }), 'transient');
assert.strictEqual(classifyPostReplyJobError({ lastError: '503 temporarily unavailable' }), 'transient');
assert.strictEqual(classifyPostReplyJobError({ lastError: '401 unauthorized' }), 'terminal');
assert.strictEqual(classifyPostReplyJobError({ lastError: '403 forbidden' }), 'terminal');
assert.strictEqual(classifyPostReplyJobError({ lastError: '404 not found' }), 'terminal');
assert.strictEqual(isTransient({ lastError: 'timeout' }), true);
assert.strictEqual(isTerminal({ lastError: 'unsupported model' }), true);

const jobs = [
  { jobId: 'transient_1', phase: 'core', lastError: '429 too many requests' },
  { jobId: 'terminal_1', phase: 'core', lastError: '403 forbidden' },
  { jobId: 'unknown_1', phase: 'core', lastError: 'weird failure' }
];

const transientPlan = planRequeueJobs(jobs, { transientOnly: true, limit: 10 });
assert.deepStrictEqual(transientPlan.map((item) => item.jobId), ['transient_1']);
assert.strictEqual(transientPlan[0].requeueSafe, true);

const allPlan = planRequeueJobs(jobs, { transientOnly: false, limit: 10 });
assert.deepStrictEqual(allPlan.map((item) => item.errorClass), ['transient', 'terminal', 'unknown_error']);
assert.strictEqual(allPlan.find((item) => item.jobId === 'terminal_1').requeueSafe, false);

assert.deepStrictEqual(parseArgs(['--apply', '--force', '--all', '--limit', '2']), {
  dryRun: false,
  transientOnly: false,
  force: true,
  limit: 2
});

assert.strictEqual(shouldApplyRequeue({ dryRun: true, force: true }), false);
assert.strictEqual(shouldApplyRequeue({ dryRun: false, force: true }), true);

console.log('postReplyFailureRequeue.test.js passed');
