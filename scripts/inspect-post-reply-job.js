const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getPostReplyJobQueue } = require('../utils/postReplyJobQueue');
const { summarizePostReplyJobTrace } = require('../utils/postReplyWorker/jobTrace');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function findJob(queue, jobId = '') {
  const target = normalizeText(jobId);
  if (!target) return null;
  return queue.listJobs(['queued', 'processing', 'failed', 'done'])
    .find((job) => normalizeText(job.jobId) === target) || null;
}

function buildJobInspection(jobId = '', options = {}) {
  const queue = options.queue || getPostReplyJobQueue();
  const job = findJob(queue, jobId);
  const trace = summarizePostReplyJobTrace(jobId, {
    traceDir: options.traceDir || config.POST_REPLY_TRACE_DIR
  });
  return {
    generatedAt: new Date().toISOString(),
    jobId: normalizeText(jobId),
    queueDir: queue.queueDir,
    found: Boolean(job),
    job,
    trace: {
      tracePath: trace.tracePath,
      eventCount: trace.eventCount,
      firstEventAt: trace.firstEventAt,
      lastEventAt: trace.lastEventAt,
      countsByEvent: trace.countsByEvent,
      events: trace.events
    }
  };
}

function main(argv = process.argv.slice(2)) {
  const jobId = normalizeText(argv[0]);
  if (!jobId) {
    console.error('Usage: node scripts/inspect-post-reply-job.js <jobId>');
    process.exit(2);
  }
  const report = buildJobInspection(jobId);
  if (report.trace.tracePath && !fs.existsSync(report.trace.tracePath)) {
    report.trace.missing = true;
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  buildJobInspection,
  findJob
};
