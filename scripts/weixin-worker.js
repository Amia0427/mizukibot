process.env.MIZUKIBOT_RUNTIME_ROLE = process.env.MIZUKIBOT_RUNTIME_ROLE || 'weixin_worker';

const fs = require('fs');
const path = require('path');

const config = require('../config');
const { createWeixinStore } = require('../src/platforms/weixin/store');
const { createWeixinWorkerRuntime } = require('../src/platforms/weixin/worker-runtime');
const { cleanupWeixinMediaCache } = require('../src/platforms/weixin/media');
const { acquireWeixinWorkerSingleInstance } = require('../utils/weixinWorkerSupervisor');

if (config.WEIXIN_ENABLED !== true) {
  console.log('[weixin-worker] disabled');
  process.exit(0);
}

const projectRoot = path.resolve(process.env.MIZUKIBOT_PROJECT_ROOT || path.join(__dirname, '..'));
const pidFile = path.resolve(config.WEIXIN_WORKER_PID_FILE);
const lockFile = path.resolve(config.WEIXIN_WORKER_LOCK_FILE);
const stateFile = path.resolve(config.WEIXIN_WORKER_STATE_FILE);
const startedAt = new Date().toISOString();
const singleInstance = acquireWeixinWorkerSingleInstance({ pidFile, lockFile });

if (!singleInstance.acquired) {
  console.warn('[weixin-worker] already running, skip duplicate start', {
    reason: singleInstance.reason,
    ownerPid: singleInstance.ownerPid
  });
  process.exit(0);
}

function writeState(snapshot) {
  const state = {
    ...snapshot,
    pid: process.pid,
    startedAt,
    heartbeatAt: new Date(Number(snapshot.heartbeatAt || Date.now())).toISOString()
  };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, stateFile);
}

const store = createWeixinStore({
  databaseFile: config.WEIXIN_DB_FILE,
  masterKey: config.WEIXIN_CREDENTIAL_MASTER_KEY
});
const runtime = createWeixinWorkerRuntime({
  store,
  fetch: globalThis.fetch,
  allowedOutboundRoots: config.WEIXIN_OUTBOUND_ALLOWED_ROOTS,
  mediaCacheDir: config.WEIXIN_MEDIA_CACHE_DIR,
  cycleIntervalMs: config.WEIXIN_INBOX_POLL_INTERVAL_MS,
  heartbeatIntervalMs: config.WEIXIN_WORKER_HEARTBEAT_MS,
  onState: writeState
});
let mediaCleanupTimer = null;

let shutdownInProgress = false;
async function shutdown(code, reason) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  try {
    await runtime.drainAndStop();
  } catch (error) {
    console.error('[weixin-worker] drain failed', error?.message || error);
  }
  if (mediaCleanupTimer) clearInterval(mediaCleanupTimer);
  store.close();
  singleInstance.cleanup();
  process.exit(code);
}

process.on('exit', () => singleInstance.cleanup());
process.on('SIGINT', () => void shutdown(130, 'SIGINT'));
process.on('SIGTERM', () => void shutdown(143, 'SIGTERM'));

void cleanupWeixinMediaCache({
  cacheDir: config.WEIXIN_MEDIA_CACHE_DIR,
  maxAgeMs: config.WEIXIN_MEDIA_MAX_AGE_MS
}).catch((error) => console.error('[weixin-worker] media cleanup failed', error?.message || error));
mediaCleanupTimer = setInterval(() => {
  void cleanupWeixinMediaCache({
    cacheDir: config.WEIXIN_MEDIA_CACHE_DIR,
    maxAgeMs: config.WEIXIN_MEDIA_MAX_AGE_MS
  }).catch((error) => console.error('[weixin-worker] media cleanup failed', error?.message || error));
}, Math.min(config.WEIXIN_MEDIA_MAX_AGE_MS, 60 * 60_000));
mediaCleanupTimer.unref?.();
runtime.start();
