const { getPostReplyJobQueue } = require('../utils/postReplyJobQueue');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    failedOnly: false,
    json: false,
    limit: 50
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (arg === '--failed') out.failedOnly = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--limit' && argv[i + 1]) {
      out.limit = Math.max(1, Number(argv[i + 1]) || out.limit);
      i += 1;
    } else if (arg.startsWith('--limit=')) {
      out.limit = Math.max(1, Number(arg.slice('--limit='.length)) || out.limit);
    }
  }
  return out;
}

function classifyJob(job = {}) {
  const error = String(job.lastError || '').toLowerCase();
  if (/(429|rate limit|too many requests|408|425|500|502|503|504|timeout|timed out|temporarily unavailable|econnreset|etimedout|network)/.test(error)) {
    return 'transient';
  }
  if (/(401|403|404|forbidden|unauthorized|not found|model not supported|unsupported model)/.test(error)) {
    return 'terminal';
  }
  return error ? 'unknown_error' : 'no_error';
}

function summarizeJob(job = {}) {
  return {
    jobId: String(job.jobId || '').trim(),
    status: String(job.status || '').trim(),
    phase: String(job.phase || 'core').trim() || 'core',
    userId: String(job.userId || '').trim(),
    sessionKey: String(job.sessionKey || '').trim(),
    attempt: Number(job.attempt || 0) || 0,
    availableAt: String(job.availableAt || '').trim(),
    nextRetryAt: String(job.nextRetryAt || '').trim(),
    updatedAt: String(job.updatedAt || '').trim(),
    lastError: String(job.lastError || '').trim(),
    errorClass: classifyJob(job),
    completedTasks: job.completedTasks && typeof job.completedTasks === 'object' ? job.completedTasks : {}
  };
}

function main() {
  const args = parseArgs();
  const queue = getPostReplyJobQueue();
  const statuses = args.failedOnly ? ['failed'] : ['queued', 'processing', 'failed'];
  const jobs = queue.listJobs(statuses)
    .map(summarizeJob)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, args.limit);
  const counts = jobs.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    acc[job.errorClass] = (acc[job.errorClass] || 0) + 1;
    return acc;
  }, {});
  const payload = {
    generatedAt: new Date().toISOString(),
    queueDir: queue.queueDir,
    statuses,
    count: jobs.length,
    counts,
    jobs
  };
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`post-reply jobs: ${payload.count} queue=${payload.queueDir}`);
  console.log(`counts: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ') || 'none'}`);
  for (const job of jobs) {
    console.log([
      job.status,
      job.errorClass,
      job.phase,
      job.jobId,
      `attempt=${job.attempt}`,
      job.lastError ? `error=${job.lastError.slice(0, 160)}` : ''
    ].filter(Boolean).join(' | '));
  }
}

main();
