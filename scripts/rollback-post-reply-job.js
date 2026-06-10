const {
  rollbackPostReplyLearning
} = require('../utils/memoryGovernance');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function parseList(value = '') {
  return String(value || '')
    .split(',')
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    dryRun: true,
    jobId: '',
    postReplyJobId: '',
    turnId: '',
    turnIds: [],
    userId: '',
    reason: ''
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = normalizeText(argv[i]);
    if (arg === '--apply') out.dryRun = false;
    else if (arg === '--dry-run') out.dryRun = true;
    else if ((arg === '--job-id' || arg === '--jobId') && argv[i + 1]) {
      out.jobId = normalizeText(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--job-id=')) {
      out.jobId = normalizeText(arg.slice('--job-id='.length));
    } else if (arg.startsWith('--jobId=')) {
      out.jobId = normalizeText(arg.slice('--jobId='.length));
    } else if ((arg === '--post-reply-job-id' || arg === '--postReplyJobId') && argv[i + 1]) {
      out.postReplyJobId = normalizeText(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--post-reply-job-id=')) {
      out.postReplyJobId = normalizeText(arg.slice('--post-reply-job-id='.length));
    } else if (arg.startsWith('--postReplyJobId=')) {
      out.postReplyJobId = normalizeText(arg.slice('--postReplyJobId='.length));
    } else if ((arg === '--turn-id' || arg === '--turnId') && argv[i + 1]) {
      out.turnId = normalizeText(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--turn-id=')) {
      out.turnId = normalizeText(arg.slice('--turn-id='.length));
    } else if (arg.startsWith('--turnId=')) {
      out.turnId = normalizeText(arg.slice('--turnId='.length));
    } else if ((arg === '--turn-ids' || arg === '--turnIds') && argv[i + 1]) {
      out.turnIds = parseList(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--turn-ids=')) {
      out.turnIds = parseList(arg.slice('--turn-ids='.length));
    } else if (arg.startsWith('--turnIds=')) {
      out.turnIds = parseList(arg.slice('--turnIds='.length));
    } else if ((arg === '--user-id' || arg === '--userId') && argv[i + 1]) {
      out.userId = normalizeText(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--user-id=')) {
      out.userId = normalizeText(arg.slice('--user-id='.length));
    } else if (arg.startsWith('--userId=')) {
      out.userId = normalizeText(arg.slice('--userId='.length));
    } else if (arg === '--reason' && argv[i + 1]) {
      out.reason = normalizeText(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--reason=')) {
      out.reason = normalizeText(arg.slice('--reason='.length));
    } else if (!arg.startsWith('--') && !out.jobId) {
      out.jobId = arg;
    }
  }
  return out;
}

function buildRollbackReport(args = {}) {
  const result = rollbackPostReplyLearning({
    jobId: args.jobId,
    postReplyJobId: args.postReplyJobId,
    turnId: args.turnId,
    turnIds: args.turnIds,
    userId: args.userId,
    reason: args.reason,
    dryRun: args.dryRun
  });
  return {
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    criteria: {
      jobId: args.jobId,
      postReplyJobId: args.postReplyJobId,
      turnId: args.turnId,
      turnIds: args.turnIds,
      userId: args.userId,
      reason: args.reason || 'post_reply_learning_rollback'
    },
    result
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.jobId && !args.postReplyJobId && !args.turnId && args.turnIds.length === 0) {
    console.error('Usage: node scripts/rollback-post-reply-job.js --job-id <id> [--turn-id <id>|--turn-ids a,b] [--dry-run|--apply] [--reason <text>]');
    process.exit(2);
  }
  const report = buildRollbackReport(args);
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  buildRollbackReport,
  parseArgs
};
