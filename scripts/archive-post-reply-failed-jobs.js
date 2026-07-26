const fs = require('fs');
const path = require('path');
const { getPostReplyJobQueue } = require('../utils/postReplyJobQueue');
const {
  classifyPostReplyJobError,
  isRequeueSafePostReplyError,
  isTerminalPostReplyError
} = require('../utils/postReplyWorker/errorClassifier');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function parseCsv(value = '') {
  return normalizeText(value)
    .split(',')
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    dryRun: true,
    all: false,
    jobIds: [],
    archiveName: '',
    reason: 'historical_failed_post_reply_jobs',
    updatedBefore: ''
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = normalizeText(argv[i]);
    if (arg === '--apply') out.dryRun = false;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--job-id' && argv[i + 1]) {
      out.jobIds.push(normalizeText(argv[i + 1]));
      i += 1;
    } else if (arg.startsWith('--job-id=')) {
      out.jobIds.push(normalizeText(arg.slice('--job-id='.length)));
    } else if (arg === '--job-ids' && argv[i + 1]) {
      out.jobIds.push(...parseCsv(argv[i + 1]));
      i += 1;
    } else if (arg.startsWith('--job-ids=')) {
      out.jobIds.push(...parseCsv(arg.slice('--job-ids='.length)));
    } else if (arg === '--archive-name' && argv[i + 1]) {
      out.archiveName = normalizeText(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--archive-name=')) {
      out.archiveName = normalizeText(arg.slice('--archive-name='.length));
    } else if (arg === '--reason' && argv[i + 1]) {
      out.reason = normalizeText(argv[i + 1]) || out.reason;
      i += 1;
    } else if (arg.startsWith('--reason=')) {
      out.reason = normalizeText(arg.slice('--reason='.length)) || out.reason;
    } else if (arg === '--updated-before' && argv[i + 1]) {
      out.updatedBefore = normalizeText(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--updated-before=')) {
      out.updatedBefore = normalizeText(arg.slice('--updated-before='.length));
    }
  }
  out.jobIds = Array.from(new Set(out.jobIds.filter(Boolean)));
  return out;
}

function formatArchiveName(now = new Date()) {
  const stamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `failed-history-${stamp}`;
}

function isSafeJobId(jobId = '') {
  return /^[A-Za-z0-9_.-]+$/.test(normalizeText(jobId));
}

function ensureSafeJobIds(jobIds = []) {
  for (const jobId of jobIds) {
    if (!isSafeJobId(jobId)) {
      throw new Error(`unsafe post-reply job id: ${jobId}`);
    }
  }
}

function classifyArchiveDecision(job = {}) {
  const lastError = normalizeText(job.lastError || job.error);
  const lowerError = lastError.toLowerCase();
  const errorClass = classifyPostReplyJobError(job);
  const phase = normalizeText(job.phase || 'core') || 'core';
  if (phase === 'enrich' && /status code 400|\b400\b/.test(lowerError)) {
    return {
      bucket: 'enrich_http_400',
      outcome: 'permanent_failure',
      action: 'archive',
      errorClass,
      requeueSafe: false
    };
  }
  if (lowerError === 'worker-recovered-stale-processing-job') {
    return {
      bucket: 'stale_processing_recovery_marker',
      outcome: 'archive_ignore',
      action: 'archive',
      errorClass,
      requeueSafe: false
    };
  }
  if (isRequeueSafePostReplyError(job)) {
    return {
      bucket: 'transient_upstream_error',
      outcome: 'safe_to_retry',
      action: 'archive_historical',
      errorClass,
      requeueSafe: true
    };
  }
  if (isTerminalPostReplyError(job)) {
    return {
      bucket: errorClass,
      outcome: 'permanent_failure',
      action: 'archive',
      errorClass,
      requeueSafe: false
    };
  }
  return {
    bucket: 'unknown_non_retryable',
    outcome: 'archive_ignore',
    action: 'archive',
    errorClass,
    requeueSafe: false
  };
}

function countBy(items = [], key) {
  return items.reduce((acc, item) => {
    const value = normalizeText(item[key]) || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function isUpdatedBefore(job = {}, updatedBefore = '') {
  const cutoff = Date.parse(updatedBefore);
  if (!Number.isFinite(cutoff)) return true;
  const updatedAt = Date.parse(normalizeText(job.updatedAt || job.failedAt || job.createdAt));
  return Number.isFinite(updatedAt) && updatedAt < cutoff;
}

function toArchiveEntry(queue, archiveDir, job = {}) {
  const jobId = normalizeText(job.jobId || job.id);
  const decision = classifyArchiveDecision(job);
  return {
    jobId,
    phase: normalizeText(job.phase || 'core') || 'core',
    attempt: Math.max(0, Number(job.attempt || 0) || 0),
    updatedAt: normalizeText(job.updatedAt),
    failedAt: normalizeText(job.failedAt),
    lastError: normalizeText(job.lastError || job.error).slice(0, 240),
    ...decision,
    sourcePath: path.join(queue.queueDir, 'failed', `${jobId}.json`),
    archivePath: path.join(archiveDir, `${jobId}.json`)
  };
}

function publicEntry(entry = {}) {
  return {
    jobId: entry.jobId,
    phase: entry.phase,
    attempt: entry.attempt,
    updatedAt: entry.updatedAt,
    failedAt: entry.failedAt,
    bucket: entry.bucket,
    outcome: entry.outcome,
    action: entry.action,
    errorClass: entry.errorClass,
    requeueSafe: entry.requeueSafe,
    lastError: entry.lastError
  };
}

function buildArchivePlan(queue, args = {}, now = new Date()) {
  if (args.all !== true && (!Array.isArray(args.jobIds) || args.jobIds.length === 0)) {
    throw new Error('pass --all or at least one --job-id');
  }
  ensureSafeJobIds(args.jobIds || []);
  const archiveName = normalizeText(args.archiveName) || formatArchiveName(now);
  if (!isSafeJobId(archiveName)) throw new Error(`unsafe archive name: ${archiveName}`);
  const failedJobs = queue.listJobs(['failed']);
  const requested = new Set(args.jobIds || []);
  const selected = failedJobs
    .filter((job) => args.all === true || requested.has(normalizeText(job.jobId || job.id)))
    .filter((job) => isUpdatedBefore(job, args.updatedBefore));
  const found = new Set(selected.map((job) => normalizeText(job.jobId || job.id)));
  const missingJobIds = Array.from(requested).filter((jobId) => !found.has(jobId));
  const archiveDir = path.join(queue.queueDir, 'archive', 'failed-post-reply-jobs', archiveName);
  const jobs = selected.map((job) => toArchiveEntry(queue, archiveDir, job));
  return {
    generatedAt: now.toISOString(),
    dryRun: args.dryRun !== false,
    queueDir: queue.queueDir,
    archiveDir,
    reason: normalizeText(args.reason) || 'historical_failed_post_reply_jobs',
    requestedCount: args.all === true ? failedJobs.length : requested.size,
    selectedCount: jobs.length,
    missingJobIds,
    summary: {
      byOutcome: countBy(jobs, 'outcome'),
      byBucket: countBy(jobs, 'bucket'),
      byErrorClass: countBy(jobs, 'errorClass'),
      requeueSafe: jobs.filter((job) => job.requeueSafe).length
    },
    jobs
  };
}

function writeManifest(plan = {}, applyResult = {}) {
  const manifestPath = path.join(plan.archiveDir, 'manifest.json');
  const payload = {
    generatedAt: plan.generatedAt,
    appliedAt: new Date().toISOString(),
    reason: plan.reason,
    queueDir: plan.queueDir,
    archiveDir: plan.archiveDir,
    selectedCount: plan.selectedCount,
    summary: plan.summary,
    applyResult,
    jobs: plan.jobs.map(publicEntry)
  };
  fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2), 'utf8');
  return manifestPath;
}

function applyArchivePlan(queue, plan = {}) {
  if (plan.dryRun) {
    return { applied: false, reason: 'dry_run', moved: 0 };
  }
  fs.mkdirSync(plan.archiveDir, { recursive: true });
  let moved = 0;
  for (const job of plan.jobs) {
    if (!fs.existsSync(job.sourcePath)) continue;
    if (fs.existsSync(job.archivePath)) {
      throw new Error(`archive target already exists: ${job.archivePath}`);
    }
    fs.renameSync(job.sourcePath, job.archivePath);
    moved += 1;
  }
  const applyResult = { applied: true, moved };
  applyResult.manifestPath = writeManifest(plan, applyResult);
  if (typeof queue.rebuildIndex === 'function') {
    queue.rebuildIndex({ dryRun: false });
    applyResult.indexRebuilt = true;
  }
  return applyResult;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const queue = getPostReplyJobQueue();
  const plan = buildArchivePlan(queue, args);
  const applyResult = applyArchivePlan(queue, plan);
  console.log(JSON.stringify({
    ...plan,
    applyResult,
    jobs: plan.jobs.map(publicEntry)
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  classifyArchiveDecision,
  buildArchivePlan,
  applyArchivePlan,
  main
};
