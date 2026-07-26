process.env.MIZUKIBOT_RUNTIME_ROLE = process.env.MIZUKIBOT_RUNTIME_ROLE || 'post_reply_worker';

const config = require('../config');
const { createPostReplyWorkerRuntime } = require('../utils/postReplyWorkerRuntime');
const { acquirePostReplyWorkerSingleInstance } = require('../utils/postReplyWorker/singleInstance');
const { startResourceSnapshotLoop } = require('../utils/perfRuntime');
const { flushAllHotStoresSync } = require('../utils/jsonHotStore');
const { closeLoadedSqliteConnections } = require('../utils/sqliteRuntime');
const { writePostReplyWorkerState } = require('../utils/postReplyWorker/readiness');
const path = require('path');

config.validateRequiredConfig();

const PID_FILE = process.env.MIZUKIBOT_POST_REPLY_WORKER_PID_FILE
  || path.join(__dirname, '..', '.mizukibot-postreply-worker.pid');
const INSTANCE_LOCK_FILE = process.env.MIZUKIBOT_POST_REPLY_WORKER_LOCK_FILE
  || path.join(__dirname, '..', '.mizukibot-postreply-worker.lock');
const STATE_FILE = process.env.MIZUKIBOT_POST_REPLY_WORKER_STATE_FILE
  || path.join(config.DATA_DIR, 'runtime', 'post-reply-worker', 'worker-state.json');
const READINESS_HEARTBEAT_MS = Math.max(1000, Number(process.env.POST_REPLY_WORKER_READINESS_HEARTBEAT_MS || 15000) || 15000);
const SHUTDOWN_DRAIN_MS = Math.max(1000, Number(process.env.POST_REPLY_WORKER_SHUTDOWN_DRAIN_MS || config.RUNTIME_SHUTDOWN_TIMEOUT_MS || 15000) || 15000);
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
let shutdownInProgress = false;
let readinessHeartbeat = null;
const startedAt = new Date().toISOString();

function writeRuntimeState(stage, extra = {}) {
  const stats = runtime?.getStats?.() || {};
  try {
    writePostReplyWorkerState(STATE_FILE, {
      stage,
      pid: process.pid,
      startedAt,
      heartbeatAt: new Date().toISOString(),
      activeCount: Math.max(0, Number(stats.activeCount || 0) || 0),
      ...extra
    });
  } catch (error) {
    console.error('[post-reply-worker] failed to write runtime state:', error?.message || error);
  }
}

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
    setTimeout(() => void shutdown(75, 'rss_recycle'), 0);
  }
});
const resourceSnapshotLoop = startResourceSnapshotLoop(() => ({
  component: 'post_reply_worker',
  postReplyActiveUserIds: runtime.getActiveUserIds().length,
  postReplyConcurrency: runtime.concurrency,
  postReplyPollMs: runtime.pollMs
}));

async function shutdown(code = 0, reason = 'shutdown') {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  if (readinessHeartbeat) {
    clearInterval(readinessHeartbeat);
    readinessHeartbeat = null;
  }
  writeRuntimeState('draining', { reason });
  let drain;
  try {
    drain = await runtime.drainAndStop({ timeoutMs: SHUTDOWN_DRAIN_MS, source: reason });
  } catch (error) {
    drain = { timedOut: false, flushed: false, error: error?.message || String(error) };
    console.error('[post-reply-worker] drain failed:', drain.error);
  }
  try { resourceSnapshotLoop.stop(); } catch (_) {}
  flushAllHotStoresSync();
  closeLoadedSqliteConnections();
  try { singleInstance.cleanup(); } catch (error) {
    console.error('[post-reply-worker] failed to clear instance files:', error?.message || error);
  }
  writeRuntimeState('stopped', { reason, drain });
  process.exit(code);
}

writeRuntimeState('starting');
runtime.start();
writeRuntimeState('ready');
readinessHeartbeat = setInterval(() => writeRuntimeState('ready'), READINESS_HEARTBEAT_MS);
readinessHeartbeat.unref?.();

const POST_REPLY_WORKER_SIGNAL_HOOK_KEY = '__mizuki_post_reply_worker_signal_hooks_registered__';
if (!process[POST_REPLY_WORKER_SIGNAL_HOOK_KEY]) {
  process[POST_REPLY_WORKER_SIGNAL_HOOK_KEY] = true;
  process.on('exit', () => {
    try { singleInstance.cleanup(); } catch (_) {}
  });
  process.on('SIGINT', () => void shutdown(130, 'SIGINT'));
  process.on('SIGTERM', () => void shutdown(143, 'SIGTERM'));
}
