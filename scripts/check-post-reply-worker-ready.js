#!/usr/bin/env node
const path = require('path');

const config = require('../config');
const { inspectPostReplyWorkerReadiness } = require('../utils/postReplyWorker/readiness');

function main() {
  const stateFile = process.env.MIZUKIBOT_POST_REPLY_WORKER_STATE_FILE
    || path.join(config.DATA_DIR, 'runtime', 'post-reply-worker', 'worker-state.json');
  const result = inspectPostReplyWorkerReadiness(stateFile, {
    maxAgeMs: Number(process.env.POST_REPLY_WORKER_READINESS_MAX_AGE_MS || 60000)
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ready) process.exitCode = 1;
  return result;
}

if (require.main === module) main();

module.exports = { main };
