const fs = require('fs');
const path = require('path');
const { getPostReplyJobQueue } = require('../utils/postReplyJobQueue');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    dryRun: true,
    transientOnly: true,
    limit: 20
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (arg === '--apply') out.dryRun = false;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--all') out.transientOnly = false;
    else if (arg === '--transient-only') out.transientOnly = true;
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
  const error = String(job.lastError || '').toLowerCase();
  return /(429|rate limit|too many requests|408|425|500|502|503|504|timeout|timed out|temporarily unavailable|econnreset|etimedout|network)/.test(error);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function main() {
  const args = parseArgs();
  const queue = getPostReplyJobQueue();
  const failed = queue.listJobs(['failed'])
    .filter((job) => !args.transientOnly || isTransient(job))
    .slice(0, args.limit);
  const planned = failed.map((job) => ({
    jobId: job.jobId,
    phase: job.phase || 'core',
    transient: isTransient(job),
    lastError: String(job.lastError || '').slice(0, 240)
  }));
  if (!args.dryRun) {
    for (const job of failed) {
      const next = {
        ...job,
        status: 'queued',
        updatedAt: new Date().toISOString(),
        failedAt: '',
        availableAt: new Date().toISOString(),
        nextRetryAt: '',
        retryDelayMs: 0
      };
      const failedPath = path.join(queue.queueDir, 'failed', `${job.jobId}.json`);
      const queuedPath = path.join(queue.queueDir, 'queued', `${job.jobId}.json`);
      writeJson(queuedPath, next);
      try {
        if (fs.existsSync(failedPath)) fs.unlinkSync(failedPath);
      } catch (error) {
        console.warn('[post-reply-requeue] failed to remove old failed job file:', error?.message || error);
      }
    }
  }
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    transientOnly: args.transientOnly,
    count: planned.length,
    jobs: planned
  }, null, 2));
}

main();
