const { getPostReplyJobQueue } = require('../utils/postReplyJobQueue');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    rebuildIndex: false,
    dryRun: true
  };
  for (const raw of argv) {
    const arg = String(raw || '').trim();
    if (arg === '--rebuild-index') out.rebuildIndex = true;
    else if (arg === '--apply') out.dryRun = false;
    else if (arg === '--dry-run') out.dryRun = true;
  }
  return out;
}

function buildRepairReport(queue, args = {}) {
  const report = {
    generatedAt: new Date().toISOString(),
    queueDir: queue.queueDir,
    dryRun: args.dryRun !== false,
    actions: []
  };
  if (args.rebuildIndex) {
    const result = queue.rebuildIndex({
      dryRun: report.dryRun
    });
    report.actions.push({
      action: 'rebuild_index',
      indexPath: queue.indexPath,
      count: result.count,
      applied: report.dryRun === false
    });
  }
  if (report.actions.length === 0) {
    report.actions.push({
      action: 'none',
      reason: 'no_action_requested'
    });
  }
  return report;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const queue = getPostReplyJobQueue();
  const report = buildRepairReport(queue, args);
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  buildRepairReport,
  parseArgs
};
