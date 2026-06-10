const fs = require('fs');
const path = require('path');
const { getPostReplyJobQueue } = require('../utils/postReplyJobQueue');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    apply: false,
    olderThanDays: 7
  };
  for (const raw of argv) {
    const arg = String(raw || '').trim();
    if (arg === '--apply') out.apply = true;
    else if (arg.startsWith('--days=')) {
      const days = parseInt(arg.split('=')[1], 10);
      if (!isNaN(days) && days > 0) out.olderThanDays = days;
    }
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const queue = getPostReplyJobQueue();
  const failedJobs = queue.listJobs(['failed']);
  const cutoffTime = Date.now() - (args.olderThanDays * 24 * 60 * 60 * 1000);

  console.log(`Scanning ${failedJobs.length} failed jobs older than ${args.olderThanDays} days...`);
  console.log(`Cutoff time: ${new Date(cutoffTime).toISOString()}`);
  console.log(`Dry run: ${!args.apply}\n`);

  const toDelete = [];

  for (const job of failedJobs) {
    const jobTime = parseInt(job.jobId.split('_')[2], 10);
    if (!isNaN(jobTime) && jobTime < cutoffTime) {
      toDelete.push(job);
    }
  }

  console.log(`Found ${toDelete.length} old failed jobs to delete:\n`);

  for (const job of toDelete) {
    const jobTime = parseInt(job.jobId.split('_')[2], 10);
    const age = Math.floor((Date.now() - jobTime) / (24 * 60 * 60 * 1000));
    console.log(`  ${job.jobId} (${age} days old) - ${job.lastError || 'no error'}`);
  }

  if (args.apply) {
    console.log(`\nDeleting ${toDelete.length} jobs...`);
    let deleted = 0;
    for (const job of toDelete) {
      try {
        const failedPath = path.join(queue.queueDir, 'failed', `${job.jobId}.json`);
        if (fs.existsSync(failedPath)) {
          fs.unlinkSync(failedPath);
          deleted++;
        }
      } catch (error) {
        console.error(`Failed to delete ${job.jobId}:`, error.message);
      }
    }

    // Rebuild index after deletion
    queue.rebuildIndex({ dryRun: false });
    console.log(`\nDeleted ${deleted} jobs and rebuilt index.`);
  } else {
    console.log(`\nRun with --apply to delete these jobs.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, parseArgs };
