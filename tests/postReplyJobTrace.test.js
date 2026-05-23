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

module.exports = (() => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-trace-'));
  try {
    process.env.DATA_DIR = tempDir;
    process.env.POST_REPLY_QUEUE_DIR = path.join(tempDir, 'post_reply_jobs');
    process.env.POST_REPLY_TRACE_DIR = path.join(tempDir, 'post_reply_traces');
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    clearProjectCache();

    const { createPostReplyJobQueue } = require('../utils/postReplyJobQueue');
    const { appendPostReplyJobTrace, summarizePostReplyJobTrace } = require('../utils/postReplyWorker/jobTrace');
    const { buildJobInspection } = require('../scripts/inspect-post-reply-job');

    const queue = createPostReplyJobQueue({ queueDir: process.env.POST_REPLY_QUEUE_DIR });
    const created = queue.enqueue({
      jobId: 'trace_job',
      traceId: 'trace-id-1',
      userId: 'u_trace',
      question: 'q',
      finalReply: 'r'
    }).job;
    appendPostReplyJobTrace(created, 'job_started', {
      apiKey: 'secret',
      detail: 'visible'
    });
    appendPostReplyJobTrace(created, 'job_done', {
      ok: true
    });

    const summary = summarizePostReplyJobTrace('trace_job');
    assert.strictEqual(summary.eventCount, 2);
    assert.strictEqual(summary.countsByEvent.job_started, 1);
    assert.strictEqual(summary.events[0].payload.apiKey, '[redacted]');
    assert.strictEqual(summary.events[0].payload.detail, 'visible');

    const inspection = buildJobInspection('trace_job', { queue });
    assert.strictEqual(inspection.found, true);
    assert.strictEqual(inspection.job.jobId, 'trace_job');
    assert.strictEqual(inspection.trace.eventCount, 2);

    console.log('postReplyJobTrace.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})();
