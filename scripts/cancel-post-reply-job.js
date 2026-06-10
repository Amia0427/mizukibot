const { getPostReplyJobQueue } = require('../utils/postReplyJobQueue');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    jobId: '',
    reason: 'manual_cancel',
    dryRun: true
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = normalizeText(argv[i]);
    if (arg === '--job-id' && argv[i + 1]) {
      out.jobId = normalizeText(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--job-id=')) {
      out.jobId = normalizeText(arg.slice('--job-id='.length));
    } else if (arg === '--reason' && argv[i + 1]) {
      out.reason = normalizeText(argv[i + 1]) || out.reason;
      i += 1;
    } else if (arg.startsWith('--reason=')) {
      out.reason = normalizeText(arg.slice('--reason='.length)) || out.reason;
    } else if (arg === '--apply') {
      out.dryRun = false;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (!arg.startsWith('--') && !out.jobId) {
      out.jobId = arg;
    }
  }
  return out;
}

function findCancelableJob(queue, jobId = '') {
  const target = normalizeText(jobId);
  if (!target) return null;
  return queue.listJobs(['queued', 'processing'])
    .find((job) => normalizeText(job.jobId) === target) || null;
}

function buildCancelReport(queue, args = {}) {
  const jobId = normalizeText(args.jobId);
  const report = {
    generatedAt: new Date().toISOString(),
    queueDir: queue.queueDir,
    jobId,
    reason: normalizeText(args.reason) || 'manual_cancel',
    dryRun: args.dryRun !== false,
    found: false,
    applied: false,
    job: null
  };
  const current = findCancelableJob(queue, jobId);
  if (!current) return report;
  report.found = true;
  report.currentStatus = current.status;
  if (report.dryRun) {
    report.job = {
      ...current,
      cancelRequested: true,
      cancelReason: report.reason
    };
    return report;
  }
  report.job = queue.cancelJob(jobId, report.reason);
  report.applied = Boolean(report.job);
  return report;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.jobId) {
    console.error('Usage: node scripts/cancel-post-reply-job.js --job-id <jobId> [--reason <text>] [--dry-run|--apply]');
    process.exit(2);
  }
  const queue = getPostReplyJobQueue();
  const report = buildCancelReport(queue, args);
  console.log(JSON.stringify(report, null, 2));
  if (!report.found) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  buildCancelReport,
  findCancelableJob,
  parseArgs
};
