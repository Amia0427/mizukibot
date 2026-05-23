const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getPostReplyJobQueue } = require('../utils/postReplyJobQueue');
const {
  classifyPostReplyJobError,
  isRequeueSafePostReplyError,
  isTerminalPostReplyError,
  isTransientPostReplyError
} = require('../utils/postReplyWorker/errorClassifier');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    dryRun: true,
    transientOnly: true,
    force: false,
    limit: 20
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (arg === '--apply') out.dryRun = false;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--all') out.transientOnly = false;
    else if (arg === '--transient-only') out.transientOnly = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--limit' && argv[i + 1]) {
      out.limit = Math.max(1, Number(argv[i + 1]) || out.limit);
      i += 1;
    } else if (arg.startsWith('--limit=')) {
      out.limit = Math.max(1, Number(arg.slice('--limit='.length)) || out.limit);
    }
  }
  return out;
}

function isTransient(job = {}) {
  return isTransientPostReplyError(job);
}

function isTerminal(job = {}) {
  return isTerminalPostReplyError(job);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function planRequeueJobs(jobs = [], args = {}) {
  const transientOnly = args.transientOnly !== false;
  const limit = Math.max(1, Number(args.limit || 20) || 20);
  const candidates = (Array.isArray(jobs) ? jobs : [])
    .map((job) => ({
      job,
      errorClass: classifyPostReplyJobError(job)
    }))
    .filter((item) => !transientOnly || item.errorClass === 'transient')
    .slice(0, limit);
  return candidates.map(({ job, errorClass }) => ({
    jobId: job.jobId,
    phase: job.phase || 'core',
    errorClass,
    transient: errorClass === 'transient',
    terminal: errorClass === 'terminal',
    requeueSafe: isRequeueSafePostReplyError(job),
    lastError: String(job.lastError || '').slice(0, 240),
    job
  }));
}

function shouldApplyRequeue(args = {}) {
  return args.dryRun !== true
    && (args.force === true || config.POST_REPLY_FAILED_TRANSIENT_REQUEUE_ENABLED === true);
}

function buildQueuedJob(job = {}, now = new Date()) {
  const iso = now.toISOString();
  return {
    ...job,
    status: 'queued',
    updatedAt: iso,
    failedAt: '',
    availableAt: iso,
    nextRetryAt: '',
    retryDelayMs: 0
  };
}

function requeuePlannedJobs(queue, planned = [], args = {}) {
  if (!shouldApplyRequeue(args)) return { applied: false, reason: args.dryRun ? 'dry_run' : 'disabled' };
  let requeued = 0;
  for (const item of planned) {
    if (!item.requeueSafe) continue;
    const job = item.job;
    const next = buildQueuedJob(job);
    const failedPath = path.join(queue.queueDir, 'failed', `${job.jobId}.json`);
    const queuedPath = path.join(queue.queueDir, 'queued', `${job.jobId}.json`);
    writeJson(queuedPath, next);
    try {
      if (fs.existsSync(failedPath)) fs.unlinkSync(failedPath);
    } catch (error) {
      console.warn('[post-reply-requeue] failed to remove old failed job file:', error?.message || error);
    }
    requeued += 1;
  }
  return { applied: true, requeued };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const queue = getPostReplyJobQueue();
  const failed = queue.listJobs(['failed'])
    .filter((job) => args.transientOnly !== false ? !isTerminal(job) : true);
  const planned = planRequeueJobs(failed, args);
  const applyResult = requeuePlannedJobs(queue, planned, args);
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    transientOnly: args.transientOnly,
    applyEnabled: shouldApplyRequeue(args),
    applyResult,
    count: planned.length,
    jobs: planned.map(({ job, ...item }) => item)
  }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  classifyPostReplyJobError,
  isTransient,
  isTerminal,
  planRequeueJobs,
  shouldApplyRequeue,
  buildQueuedJob,
  main
};
