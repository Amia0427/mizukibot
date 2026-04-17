const config = require('../config');
const { createPostReplyWorkerRuntime } = require('../utils/postReplyWorkerRuntime');

config.validateRequiredConfig();

const runtime = createPostReplyWorkerRuntime();

function shutdown(code = 0) {
  runtime.stop();
  process.exit(code);
}

runtime.start();

const POST_REPLY_WORKER_SIGNAL_HOOK_KEY = '__mizuki_post_reply_worker_signal_hooks_registered__';
if (!process[POST_REPLY_WORKER_SIGNAL_HOOK_KEY]) {
  process[POST_REPLY_WORKER_SIGNAL_HOOK_KEY] = true;
  process.on('SIGINT', () => shutdown(130));
  process.on('SIGTERM', () => shutdown(143));
}
