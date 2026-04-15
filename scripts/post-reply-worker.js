const config = require('../config');
const { createPostReplyWorkerRuntime } = require('../utils/postReplyWorkerRuntime');

config.validateRequiredConfig();

const runtime = createPostReplyWorkerRuntime();

function shutdown(code = 0) {
  runtime.stop();
  process.exit(code);
}

runtime.start();

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
