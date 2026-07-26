const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPostReplyJobQueue } = require('../utils/postReplyJobQueue');
const {
  applyArchivePlan,
  buildArchivePlan,
  classifyArchiveDecision,
  parseArgs
} = require('../scripts/archive-post-reply-failed-jobs');

function writeFailedJob(queueDir, job) {
  const failedDir = path.join(queueDir, 'failed');
  fs.mkdirSync(failedDir, { recursive: true });
  fs.writeFileSync(
    path.join(failedDir, `${job.jobId}.json`),
    JSON.stringify({ status: 'failed', ...job }, null, 2),
    'utf8'
  );
}

const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-archive-'));
const queue = createPostReplyJobQueue({ queueDir });

writeFailedJob(queueDir, {
  jobId: 'transient_job',
  phase: 'core',
  attempt: 2,
  updatedAt: '2026-05-12T00:00:00.000Z',
  failedAt: '2026-05-12T00:00:00.000Z',
  lastError: 'Request failed with status code 503'
});
writeFailedJob(queueDir, {
  jobId: 'bad_enrich_job',
  phase: 'enrich',
  attempt: 3,
  updatedAt: '2026-06-12T00:00:00.000Z',
  failedAt: '2026-06-12T00:00:00.000Z',
  lastError: 'Request failed with status code 400'
});
writeFailedJob(queueDir, {
  jobId: 'stale_marker_job',
  phase: 'core',
  attempt: 2,
  updatedAt: '2026-06-23T00:00:00.000Z',
  failedAt: '2026-06-23T00:00:00.000Z',
  lastError: 'worker-recovered-stale-processing-job'
});
fs.writeFileSync(path.join(queueDir, 'failed', 'stale_marker_job.json.repaired-old.old'), '{}', 'utf8');
queue.rebuildIndex({ dryRun: false });

assert.deepStrictEqual(parseArgs(['--apply', '--job-ids', 'a,b', '--archive-name', 'archive_1']), {
  dryRun: false,
  all: false,
  jobIds: ['a', 'b'],
  archiveName: 'archive_1',
  reason: 'historical_failed_post_reply_jobs',
  updatedBefore: ''
});
assert.strictEqual(classifyArchiveDecision({ phase: 'enrich', lastError: 'Request failed with status code 400' }).outcome, 'permanent_failure');
assert.strictEqual(classifyArchiveDecision({ lastError: 'timeout of 180000ms exceeded' }).outcome, 'safe_to_retry');
assert.strictEqual(classifyArchiveDecision({ lastError: 'worker-recovered-stale-processing-job' }).outcome, 'archive_ignore');

const dryPlan = buildArchivePlan(queue, parseArgs([
  '--job-ids',
  'transient_job,missing_job',
  '--archive-name',
  'dry_archive'
]), new Date('2026-07-05T00:00:00.000Z'));
assert.strictEqual(dryPlan.dryRun, true);
assert.strictEqual(dryPlan.selectedCount, 1);
assert.deepStrictEqual(dryPlan.missingJobIds, ['missing_job']);
assert.strictEqual(fs.existsSync(path.join(queueDir, 'failed', 'transient_job.json')), true);

const applyPlan = buildArchivePlan(queue, parseArgs([
  '--all',
  '--apply',
  '--archive-name',
  'applied_archive',
  '--updated-before',
  '2026-07-01T00:00:00.000Z'
]), new Date('2026-07-05T00:00:00.000Z'));
assert.strictEqual(applyPlan.selectedCount, 3);
assert.deepStrictEqual(applyPlan.summary.byOutcome, {
  safe_to_retry: 1,
  permanent_failure: 1,
  archive_ignore: 1
});

const applyResult = applyArchivePlan(queue, applyPlan);
assert.strictEqual(applyResult.applied, true);
assert.strictEqual(applyResult.moved, 3);
assert.strictEqual(queue.listJobs(['failed']).length, 0);
assert.strictEqual(fs.existsSync(path.join(queueDir, 'failed', 'stale_marker_job.json.repaired-old.old')), true);
assert.strictEqual(fs.existsSync(path.join(applyPlan.archiveDir, 'transient_job.json')), true);
assert.strictEqual(fs.existsSync(path.join(applyPlan.archiveDir, 'manifest.json')), true);

console.log('postReplyFailedArchive.test.js passed');
