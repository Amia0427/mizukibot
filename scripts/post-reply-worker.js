process.env.MIZUKIBOT_RUNTIME_ROLE = process.env.MIZUKIBOT_RUNTIME_ROLE || 'post_reply_worker';

const config = require('../config');
const { createPostReplyWorkerRuntime } = require('../utils/postReplyWorkerRuntime');
const { acquirePostReplyWorkerSingleInstance } = require('../utils/postReplyWorker/singleInstance');
const { startResourceSnapshotLoop } = require('../utils/perfRuntime');
const path = require('path');

config.validateRequiredConfig();

const PID_FILE = path.join(__dirname, '..', '.mizukibot-postreply-worker.pid');
const INSTANCE_LOCK_FILE = path.join(__dirname, '..', '.mizukibot-postreply-worker.lock');
const singleInstance = acquirePostReplyWorkerSingleInstance({
  pidFile: PID_FILE,
  lockFile: INSTANCE_LOCK_FILE
});

if (!singleInstance.acquired) {
  console.warn('[post-reply-worker] already running, skip duplicate start', {
    reason: singleInstance.reason,
    ownerPid: singleInstance.ownerPid || 0
  });
  process.exit(0);
}

let recycling = false;
const runtime = createPostReplyWorkerRuntime({
  forceStart: true,
  onRecycle(info = {}) {
    if (recycling) return;
    recycling = true;
    console.warn('[post-reply-worker] idle RSS recycle requested', {
      reason: info.reason || 'rss_high',
      rssMb: Math.round((Number(info.rssBytes || 0) / 1024 / 1024) * 10) / 10,
      thresholdMb: Math.round((Number(info.thresholdBytes || 0) / 1024 / 1024) * 10) / 10,
      idleMs: Number(info.idleMs || 0) || 0
    });
    setTimeout(() => shutdown(75), 0);
  }
});
const resourceSnapshotLoop = startResourceSnapshotLoop(() => ({
  component: 'post_reply_worker',
  postReplyActiveUserIds: runtime.getActiveUserIds().length,
  postReplyConcurrency: runtime.concurrency,
  postReplyPollMs: runtime.pollMs
}));

function shutdown(code = 0) {
  runtime.stop();
  try { resourceSnapshotLoop.stop(); } catch (_) {}
  try { singleInstance.cleanup(); } catch (error) {
    console.error('[post-reply-worker] failed to clear instance files:', error?.message || error);
  }
  process.exit(code);
}

runtime.start();

const POST_REPLY_WORKER_SIGNAL_HOOK_KEY = '__mizuki_post_reply_worker_signal_hooks_registered__';
if (!process[POST_REPLY_WORKER_SIGNAL_HOOK_KEY]) {
  process[POST_REPLY_WORKER_SIGNAL_HOOK_KEY] = true;
  process.on('exit', () => {
    try { singleInstance.cleanup(); } catch (_) {}
  });
  process.on('SIGINT', () => shutdown(130));
  process.on('SIGTERM', () => shutdown(143));
}
