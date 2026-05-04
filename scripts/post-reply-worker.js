const config = require('../config');
const { createPostReplyWorkerRuntime } = require('../utils/postReplyWorkerRuntime');
const { startResourceSnapshotLoop } = require('../utils/perfRuntime');
const fs = require('fs');
const path = require('path');

config.validateRequiredConfig();

const runtime = createPostReplyWorkerRuntime();
const resourceSnapshotLoop = startResourceSnapshotLoop(() => ({
  component: 'post_reply_worker',
  postReplyActiveUserIds: runtime.getActiveUserIds().length,
  postReplyConcurrency: runtime.concurrency,
  postReplyPollMs: runtime.pollMs
}));
const PID_FILE = path.join(__dirname, '..', '.mizukibot-postreply-worker.pid');

function writePidFile() {
  try {
    fs.writeFileSync(PID_FILE, `${process.pid}\n`, 'utf8');
  } catch (error) {
    console.error('[post-reply-worker] failed to write pid file:', error?.message || error);
  }
}

function clearPidFile() {
  try {
    if (!fs.existsSync(PID_FILE)) return;
    const recordedPid = Number.parseInt(String(fs.readFileSync(PID_FILE, 'utf8') || '').trim(), 10);
    if (recordedPid === process.pid) {
      fs.unlinkSync(PID_FILE);
    }
  } catch (error) {
    console.error('[post-reply-worker] failed to clear pid file:', error?.message || error);
  }
}

function shutdown(code = 0) {
  runtime.stop();
  try { resourceSnapshotLoop.stop(); } catch (_) {}
  clearPidFile();
  process.exit(code);
}

writePidFile();
runtime.start();

const POST_REPLY_WORKER_SIGNAL_HOOK_KEY = '__mizuki_post_reply_worker_signal_hooks_registered__';
if (!process[POST_REPLY_WORKER_SIGNAL_HOOK_KEY]) {
  process[POST_REPLY_WORKER_SIGNAL_HOOK_KEY] = true;
  process.on('exit', () => clearPidFile());
  process.on('SIGINT', () => shutdown(130));
  process.on('SIGTERM', () => shutdown(143));
}
