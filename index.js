const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const fsp = fs.promises;

process.env.MIZUKIBOT_RUNTIME_ROLE = process.env.MIZUKIBOT_RUNTIME_ROLE || 'main';

const config = require('./config');

config.validateRequiredConfig();

const { startServer } = require('./web/server');
const { startTickEngine } = require('./core/tickEngine');
const { createMessageHandler } = require('./core/messageHandler');
const { initializeMemeManager } = require('./core/memeManager');
const { clearRuntimeSlotsForCurrentProcess } = require('./api/createAgentExecutor');
const { shutdown: shutdownMinecraftAgent } = require('./api/minecraftAgent');
const { shutdownCycleTLS } = require('./api/httpClient');
const { clearMcpRuntimeCaches } = require('./api/mcpRuntime');
const { getNapCatActionClient } = require('./api/napcatActionClient');
const { createNapCatHttpActionClient } = require('./api/napcatHttpActionClient');
const { getSchedulerRuntime } = require('./core/schedulerRuntime');
const { sendGroupMessage } = require('./api/qqActionService');
const { createPostReplyWorkerRuntime } = require('./utils/postReplyWorkerRuntime');
const { appendNapcatPacketToLog, createNapcatLogFollower } = require('./core/napcatLogFollower');
const { startResourceSnapshotLoop } = require('./utils/perfRuntime');
const { cleanupStaleDataTmpFiles, DEFAULT_MAX_AGE_MS } = require('./utils/dataTmpCleanup');
const { startNapCatHttpReverseServer } = require('./core/napcatHttpReverseServer');
const { createMessageIngressDispatcher } = require('./core/messageIngressDispatcher');
const { recordNapCatConnectionState } = require('./utils/napcatHealthDiagnostics');

// Avoid starting multiple bot instances that compete for one OneBot websocket.
const LOCK_FILE = process.env.MIZUKIBOT_INDEX_TEST_MODE === '1' && process.env.MIZUKIBOT_LOCK_FILE
  ? process.env.MIZUKIBOT_LOCK_FILE
  : path.join(__dirname, '.mizukibot.lock');
const EXPECTED_SHUTDOWN_FILE = path.join(config.DATA_DIR, 'bot-main-expected-shutdown.json');
const RUNTIME_STATE_FILE = path.join(config.DATA_DIR, 'bot-main-runtime-state.json');
const EXIT_OBSERVATIONS_FILE = path.join(config.DATA_DIR, 'bot-main-exit-observations.jsonl');
const NODE_REPORT_DIR = path.join(config.DATA_DIR, 'node-reports');
let cleanupSingleInstanceLock = null;
let preserveSingleInstanceLockOnExit = false;
let messageIngressDispatcher = null;
let mainRuntimeHeartbeatTimer = null;
const mainRuntimeStartedAt = new Date();

function configureNodeProcessReports() {
  try {
    fs.mkdirSync(NODE_REPORT_DIR, { recursive: true });
    if (process.report && typeof process.report === 'object') {
      process.report.directory = NODE_REPORT_DIR;
      process.report.reportOnFatalError = true;
      process.report.reportOnSignal = false;
      process.report.reportOnUncaughtException = false;
    }
  } catch (_) {}
}

function writeNodeReportBestEffort(reason = 'runtime') {
  try {
    if (!process.report || typeof process.report.writeReport !== 'function') return '';
    fs.mkdirSync(NODE_REPORT_DIR, { recursive: true });
    const safeReason = String(reason || 'runtime').replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 64) || 'runtime';
    const filePath = path.join(NODE_REPORT_DIR, `main-${process.pid}-${Date.now()}-${safeReason}.json`);
    process.report.writeReport(filePath);
    return filePath;
  } catch (_) {
    return '';
  }
}

configureNodeProcessReports();

function writeJsonFileBestEffort(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function appendJsonLineBestEffort(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(value) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function isMainRuntimeHeartbeatEnabled() {
  const raw = String(process.env.BOT_MAIN_HEARTBEAT_ENABLED || 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function getMainRuntimeHeartbeatIntervalMs() {
  const parsed = Math.floor(Number(process.env.BOT_MAIN_HEARTBEAT_INTERVAL_MS || 30000));
  if (!Number.isFinite(parsed) || parsed <= 0) return 30000;
  return Math.min(300000, Math.max(5000, parsed));
}

function buildMainRuntimeState(stage = 'heartbeat', extra = {}) {
  const now = new Date();
  return {
    schemaVersion: 'main_bot_runtime_state_v1',
    role: 'main',
    pid: process.pid,
    startedAt: mainRuntimeStartedAt.toISOString(),
    heartbeatAt: now.toISOString(),
    stage: String(stage || 'heartbeat'),
    uptimeMs: Math.round(process.uptime() * 1000),
    lockFile: LOCK_FILE,
    ...extra
  };
}

function recordMainRuntimeState(stage = 'heartbeat', extra = {}) {
  return writeJsonFileBestEffort(RUNTIME_STATE_FILE, buildMainRuntimeState(stage, extra));
}

function appendMainExitObservation(event = 'exit', extra = {}) {
  const message = typeof extra.message === 'string' ? extra.message.slice(0, 4000) : extra.message;
  return appendJsonLineBestEffort(EXIT_OBSERVATIONS_FILE, {
    schemaVersion: 'main_bot_exit_observation_v1',
    source: 'main_process',
    event: String(event || 'exit'),
    observedAt: new Date().toISOString(),
    pid: process.pid,
    startedAt: mainRuntimeStartedAt.toISOString(),
    uptimeMs: Math.round(process.uptime() * 1000),
    ...extra,
    ...(message ? { message } : {})
  });
}

function startMainRuntimeHeartbeat(stage = 'started') {
  if (!isMainRuntimeHeartbeatEnabled()) return;
  recordMainRuntimeState(stage);
  if (mainRuntimeHeartbeatTimer) return;
  mainRuntimeHeartbeatTimer = setInterval(() => {
    recordMainRuntimeState('heartbeat');
  }, getMainRuntimeHeartbeatIntervalMs());
  if (typeof mainRuntimeHeartbeatTimer.unref === 'function') {
    mainRuntimeHeartbeatTimer.unref();
  }
}

function stopMainRuntimeHeartbeat(stage = 'stopped', extra = {}) {
  if (mainRuntimeHeartbeatTimer) {
    clearInterval(mainRuntimeHeartbeatTimer);
    mainRuntimeHeartbeatTimer = null;
  }
  recordMainRuntimeState(stage, extra);
}

function recordExpectedShutdown(reason, extra = {}) {
  const now = new Date();
  writeJsonFileBestEffort(EXPECTED_SHUTDOWN_FILE, {
    pid: process.pid,
    reason: String(reason || 'shutdown'),
    recordedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
    ...extra
  });
}

function logFatalStartupError(kind, error) {
  const message = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
  const reportPath = writeNodeReportBestEffort(kind);
  appendMainExitObservation(kind, {
    level: 'fatal',
    message,
    reportPath
  });
  recordMainRuntimeState(kind, {
    level: 'fatal',
    reportPath
  });
  console.error(`[fatal] ${kind}`, {
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    message,
    reportPath
  });
}

process.on('uncaughtException', (error) => {
  preserveSingleInstanceLockOnExit = true;
  logFatalStartupError('uncaughtException', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  preserveSingleInstanceLockOnExit = true;
  logFatalStartupError('unhandledRejection', error);
  process.exit(1);
});

process.on('beforeExit', (code) => {
  appendMainExitObservation('beforeExit', {
    code,
    messageIngress: messageIngressDispatcher?.getSnapshot?.()
  });
  recordMainRuntimeState('beforeExit', { code });
  console.warn('[process] beforeExit', {
    pid: process.pid,
    code,
    uptimeMs: Math.round(process.uptime() * 1000),
    messageIngress: messageIngressDispatcher?.getSnapshot?.()
  });
});

process.on('exit', (code) => {
  appendMainExitObservation('exit', { code });
  recordMainRuntimeState('exit', { code });
  console.warn('[process] exit', {
    pid: process.pid,
    code,
    uptimeMs: Math.round(process.uptime() * 1000)
  });
});

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function getProcessCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';

  try {
    if (process.platform === 'win32') {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue; if ($p) { [string]$p.CommandLine }`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout: 2000,
        windowsHide: true
      });
      return String(stdout || '').trim();
    }

    const procCmdline = `/proc/${pid}/cmdline`;
    try {
      const cmdline = await fsp.readFile(procCmdline, 'utf8');
      return cmdline.replace(/\0/g, ' ').trim();
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }

    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2000
    });
    return String(stdout || '').trim();
  } catch (_) {
    return '';
  }
}

function commandLineLooksLikeMainBot(commandLine) {
  const value = String(commandLine || '').trim();
  if (!value) return false;
  return /\bnode(?:\.exe)?\b/i.test(value) && /(^|[\\/\s"'])index\.js(["'\s]|$)/i.test(value);
}

async function isMainBotProcess(pid) {
  if (!isProcessAlive(pid)) return false;
  const commandLine = await getProcessCommandLine(pid);
  if (!commandLine) return true;
  return commandLineLooksLikeMainBot(commandLine);
}

async function readLockOwnerPid() {
  try {
    const content = await fsp.readFile(LOCK_FILE, 'utf8');
    return Number.parseInt(String(content || '').trim(), 10);
  } catch (_) {
    return NaN;
  }
}

function cleanupSingleInstanceLockSync() {
  try {
    if (preserveSingleInstanceLockOnExit) return;
    if (!fs.existsSync(LOCK_FILE)) return;
    const ownerPid = Number.parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (ownerPid === process.pid) {
      fs.writeFileSync(LOCK_FILE, '', { encoding: 'utf8', flag: 'w' });
    }
  } catch (_) {}
}

async function acquireSingleInstanceLock() {
  const writeLock = async () => {
    await fsp.writeFile(LOCK_FILE, String(process.pid) + '\n', { encoding: 'utf8', flag: 'wx' });
  };

  const replaceStaleLock = async () => {
    await fsp.writeFile(LOCK_FILE, String(process.pid) + '\n', { encoding: 'utf8', flag: 'w' });
  };

  try {
    await writeLock();
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;

    const existingPid = await readLockOwnerPid();

    if (existingPid === process.pid) {
      try {
        await replaceStaleLock();
      } catch (replaceErr) {
        console.error('[Startup] Failed to replace self-owned lock file:', replaceErr?.message || replaceErr);
        process.exit(1);
      }
      process.on('exit', cleanupSingleInstanceLockSync);
      return cleanupSingleInstanceLockSync;
    }

    if (await isMainBotProcess(existingPid)) {
      console.error('[Startup] MizukiBot is already running (PID=' + existingPid + ').');
      process.exit(1);
    }

    if (isProcessAlive(existingPid)) {
      const commandLine = await getProcessCommandLine(existingPid);
      console.warn('[Startup] Replacing stale lock owned by non-bot process:', {
        pid: existingPid,
        commandLine: commandLine.slice(0, 240)
      });
    }

    try {
      await replaceStaleLock();
    } catch (replaceErr) {
      console.error('[Startup] Failed to replace stale lock file:', replaceErr?.message || replaceErr);
      process.exit(1);
    }
  }

  process.on('exit', cleanupSingleInstanceLockSync);
  return cleanupSingleInstanceLockSync;
}

async function cleanupStaleTmpFilesOnStartup() {
  try {
    const tmpCleanupEnabled = !['0', 'false', 'no', 'off'].includes(
      String(process.env.DATA_TMP_CLEANUP_ENABLED || '').toLowerCase().trim()
    );
    if (tmpCleanupEnabled) {
      const configuredMaxAgeMs = Number(process.env.DATA_TMP_CLEANUP_MAX_AGE_MS);
      const summary = cleanupStaleDataTmpFiles({
        dataDir: config.DATA_DIR,
        maxAgeMs: Number.isFinite(configuredMaxAgeMs) ? configuredMaxAgeMs : DEFAULT_MAX_AGE_MS,
        excludeDirs: [path.join(config.DATA_DIR, 'inbound_image_cache')]
      });
      if (summary.deletedFiles > 0 || summary.failedFiles > 0) {
        console.log('[Startup] stale tmp cleanup', {
          deletedFiles: summary.deletedFiles,
          deletedMB: Math.round((summary.deletedBytes / 1024 / 1024) * 10) / 10,
          skippedFreshFiles: summary.skippedFreshFiles,
          failedFiles: summary.failedFiles
        });
      }
    }
  } catch (error) {
    console.warn('[Startup] stale tmp cleanup failed:', error?.message || error);
  }
}
let webServer = null;
let resourceSnapshotLoop = null;

let ws = null;
let shuttingDown = false;
let shutdownInProgress = false;
let tickStarted = false;
let tickRuntime = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let schedulerStarted = false;
const napcatActionClient = config.NAPCAT_HTTP_REVERSE_ENABLED
  ? createNapCatHttpActionClient()
  : getNapCatActionClient();
const postReplyWorkerRuntime = config.POST_REPLY_WORKER_INLINE ? createPostReplyWorkerRuntime({ forceStart: true }) : null;

function askAIByGraph(...args) {
  return require('./api/agentGraph').askAIByGraph(...args);
}

function scheduleReconnect() {
  if (shuttingDown) return;
  if (reconnectTimer) return;
  const delay = Math.min(30000, 1500 * Math.max(1, reconnectAttempts));
  reconnectAttempts += 1;
  console.log(`[NapCat] disconnected, retry in ${delay}ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNapCat();
  }, delay);
}

function safeSend(payload) {
  if (shuttingDown) return false;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

async function sendWithRetry(payload, retries = 1, waitMs = 500) {
  if (config.NAPCAT_HTTP_REVERSE_ENABLED) {
    const maxRetry = Math.max(0, Number(retries) || 0);
    for (let i = 0; i <= maxRetry; i++) {
      try {
        await napcatActionClient.callAction(payload.action, payload.params);
        return true;
      } catch (error) {
        console.error(`[HTTP action] ${payload.action} failed (attempt ${i+1}/${maxRetry+1}):`, error.message);
        if (i < maxRetry) await new Promise(r => setTimeout(r, waitMs));
      }
    }
    return false;
  } else {
    const maxRetry = Math.max(0, Number(retries) || 0);
    for (let i = 0; i <= maxRetry; i++) {
      if (safeSend(payload)) return true;
      if (i < maxRetry) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    return false;
  }
}

const { handleIncomingMessage } = createMessageHandler({
  config,
  sendWithRetry,
  actionClient: napcatActionClient
});
messageIngressDispatcher = config.MESSAGE_INGRESS_ASYNC_ENABLED
  ? createMessageIngressDispatcher({
    handleMessage: handleIncomingMessage,
    maxActive: config.MESSAGE_INGRESS_ASYNC_MAX_ACTIVE,
    maxQueueLength: config.MESSAGE_INGRESS_ASYNC_MAX_QUEUE_LENGTH
  })
  : null;

async function acceptIncomingMessage(msg, source = '') {
  if (messageIngressDispatcher) {
    messageIngressDispatcher.enqueue(msg, { source });
    return true;
  }
  await handleIncomingMessage(msg);
  return true;
}
const napcatLogFollower = createNapcatLogFollower({
  sendWithRetry,
  sendGroupReply: async ({
    groupId,
    senderId,
    replyText,
    atSender = true,
    retries = 1,
    waitMs = 300
  } = {}) => sendWithRetry({
    action: 'send_group_msg',
    params: {
      group_id: groupId,
      message: `${atSender ? `[CQ:at,qq=${senderId}] ` : ''}${String(replyText || '').trim()}`
    }
  }, retries, waitMs)
});

const schedulerRuntime = getSchedulerRuntime({
  sendGroupMessage: async (groupId, message) => {
    await sendGroupMessage(groupId, message, {
      actionClient: napcatActionClient
    });
    return true;
  }
});
function startResourceSnapshots() {
  if (resourceSnapshotLoop) return;
  resourceSnapshotLoop = startResourceSnapshotLoop(() => ({
    component: 'main_process',
    wsReadyState: ws ? ws.readyState : -1,
    reconnectAttempts,
    schedulerStarted,
    tickStarted,
    postReplyInline: Boolean(postReplyWorkerRuntime)
  }));
}

function connectNapCat() {
  if (shuttingDown) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const headers = {};
  const wsToken = String(config.NAPCAT_WS_TOKEN || '').trim();
  if (wsToken) {
    headers.Authorization = `Bearer ${wsToken}`;
  }

  ws = new WebSocket(config.NAPCAT_WS_URL, { headers });
  napcatActionClient.setWebSocket(ws);

  ws.on('open', () => {
    reconnectAttempts = 0;
    napcatActionClient.handleConnect();
    recordNapCatConnectionState('online', napcatActionClient.getConnectionState(), {
      mode: 'websocket'
    });
    console.log('✅ 瑞希上线啦！已连接到 NapCat');

    if (config.TICK_ENGINE_ENABLED && !tickStarted) {
      tickRuntime = startTickEngine(ws, askAIByGraph, napcatActionClient);
      tickStarted = true;
    }

    if (config.SCHEDULER_RUNTIME_ENABLED && !schedulerStarted) {
      schedulerRuntime.start();
      schedulerStarted = true;
    }

    if (postReplyWorkerRuntime) {
      postReplyWorkerRuntime.start();
    }
    napcatLogFollower.start();
  });

  ws.on('error', (err) => {
    console.error('[NapCat ws error]', err?.message || err);
  });

  ws.on('close', (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString() : String(reasonBuffer || '');
    if (code || reason) {
      console.warn('[NapCat ws close]', { code, reason });
    }
    napcatActionClient.handleDisconnect('NapCat websocket closed');
    recordNapCatConnectionState('offline', napcatActionClient.getConnectionState(), {
      mode: 'websocket',
      reason: reason || 'NapCat websocket closed'
    });
    if (!shuttingDown) scheduleReconnect();
  });

  ws.on('message', async (data) => {
    if (shuttingDown) return;
    try {
      const msg = JSON.parse(data);
      appendNapcatPacketToLog(msg);
      if (config.FOLLOWER_DIRECT_DISPATCH_ENABLED) {
        void napcatLogFollower.handleLivePacket(msg).catch((error) => {
          console.error('[NapCat follower live packet error]', error?.message || error);
        });
      }
      if (napcatActionClient.handleMessage(msg)) return;
      await acceptIncomingMessage(msg, 'napcat_ws');
    } catch (e) {
      console.error('[消息处理异常]', e);
    }
  });
}

let httpReverseServer = null;

function startNapCatTransport() {
  if (config.NAPCAT_HTTP_REVERSE_ENABLED) {
    httpReverseServer = startNapCatHttpReverseServer({
      handleMessage: async (msg) => {
        if (shuttingDown) return;
        try {
          appendNapcatPacketToLog(msg);
          if (config.FOLLOWER_DIRECT_DISPATCH_ENABLED) {
            void napcatLogFollower.handleLivePacket(msg).catch((error) => {
              console.error('[NapCat follower live packet error]', error?.message || error);
            });
          }
          if (napcatActionClient.handleMessage(msg)) return;
          await acceptIncomingMessage(msg, 'napcat_http_reverse');
        } catch (e) {
          console.error('[HTTP reverse message error]', e);
        }
      }
    });

    recordNapCatConnectionState('online', napcatActionClient.getConnectionState(), {
      mode: 'http_reverse',
      reason: 'HTTP reverse mode started'
    });

    if (config.TICK_ENGINE_ENABLED && !tickStarted) {
      tickRuntime = startTickEngine(null, askAIByGraph, napcatActionClient);
      tickStarted = true;
    }
    if (config.SCHEDULER_RUNTIME_ENABLED && !schedulerStarted) {
      schedulerRuntime.start();
      schedulerStarted = true;
    }
    if (postReplyWorkerRuntime) {
      postReplyWorkerRuntime.start();
    }
    napcatLogFollower.start();
    console.log('✅ HTTP 反向连接模式启动，等待 NapCat POST 消息');
  } else {
    connectNapCat();
  }
}

async function shutdownMainProcess(signal = 'SIGTERM', exitCode = 0) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  shuttingDown = true;
  const reason = String(signal || 'shutdown').trim() || 'shutdown';
  recordExpectedShutdown(reason, { exitCode });
  console.log('[shutdown] begin', { reason, pid: process.pid });

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (ws) {
      ws.removeAllListeners('message');
      ws.removeAllListeners('open');
      ws.removeAllListeners('error');
      ws.removeAllListeners('close');
      try { ws.close(1001, 'mizuki shutdown'); } catch (_) {}
      try { ws.terminate(); } catch (_) {}
      ws = null;
    }
  } catch (error) {
    console.error('[shutdown] websocket cleanup failed:', error?.message || error);
  }

  try {
    napcatActionClient.handleDisconnect('MizukiBot shutdown');
    napcatActionClient.setWebSocket(null);
  } catch (_) {}

  try { schedulerRuntime.stop(); } catch (error) {
    console.error('[shutdown] scheduler stop failed:', error?.message || error);
  }
  try { tickRuntime?.stop?.(); } catch (error) {
    console.error('[shutdown] tick stop failed:', error?.message || error);
  }
  try { napcatLogFollower.stop(); } catch (error) {
    console.error('[shutdown] follower stop failed:', error?.message || error);
  }
  try { postReplyWorkerRuntime?.stop?.(); } catch (error) {
    console.error('[shutdown] post-reply worker stop failed:', error?.message || error);
  }
  try {
    await messageIngressDispatcher?.stop?.({
      drain: true,
      timeoutMs: config.MESSAGE_INGRESS_ASYNC_SHUTDOWN_DRAIN_MS
    });
  } catch (error) {
    console.error('[shutdown] message ingress drain failed:', error?.message || error);
  }
  try { resourceSnapshotLoop.stop(); } catch (error) {
    console.error('[shutdown] resource snapshot stop failed:', error?.message || error);
  }
  try { webServer?.close?.(); } catch (error) {
    console.error('[shutdown] web server close failed:', error?.message || error);
  }
  try { httpReverseServer?.close?.(); } catch (error) {
    console.error('[shutdown] http reverse server close failed:', error?.message || error);
  }

  try { clearMcpRuntimeCaches(); } catch (error) {
    console.error('[shutdown] mcp cleanup failed:', error?.message || error);
  }
  try { clearRuntimeSlotsForCurrentProcess(); } catch (error) {
    console.error('[shutdown] create-agent runtime cleanup failed:', error?.message || error);
  }
  try { await shutdownMinecraftAgent(); } catch (error) {
    console.error('[shutdown] minecraft cleanup failed:', error?.message || error);
  }
  try { await shutdownCycleTLS(); } catch (error) {
    console.error('[shutdown] cycletls cleanup failed:', error?.message || error);
  }

  cleanupSingleInstanceLock();
  stopMainRuntimeHeartbeat('shutdown_complete', { reason, exitCode });
  console.log('[shutdown] complete', { reason, pid: process.pid });
  process.exit(exitCode);
}

function drainForScheduledRestart(meta = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  const delayMs = Math.max(0, Number(meta?.delayMs || 0) || 0);
  recordExpectedShutdown('remote_restart_scheduled', {
    delayMs,
    source: String(meta?.source || 'remote_restart').trim() || 'remote_restart',
    requestedBy: String(meta?.userId || '').trim(),
    requestId: String(meta?.requestId || '').trim(),
    messageId: String(meta?.messageId || '').trim(),
    groupId: String(meta?.groupId || '').trim(),
    command: String(meta?.command || '').trim()
  });
  console.log('[restart] drain old instance before external restart', {
    pid: process.pid,
    delayMs,
    source: String(meta?.source || '').trim(),
    requestedBy: String(meta?.userId || '').trim(),
    requestId: String(meta?.requestId || '').trim(),
    messageId: String(meta?.messageId || '').trim(),
    groupId: String(meta?.groupId || '').trim()
  });
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try { schedulerRuntime.stop(); } catch (_) {}
  try { tickRuntime?.stop?.(); } catch (_) {}
  try { napcatLogFollower.stop(); } catch (_) {}
  try { postReplyWorkerRuntime?.stop?.(); } catch (_) {}
  try { messageIngressDispatcher?.stop?.({ drain: false }); } catch (_) {}
  try { resourceSnapshotLoop.stop(); } catch (_) {}
  try {
    if (ws) {
      ws.removeAllListeners('message');
      ws.removeAllListeners('open');
      ws.removeAllListeners('error');
      ws.removeAllListeners('close');
      try { ws.close(1001, 'mizuki restart draining'); } catch (_) {}
      try { ws.terminate(); } catch (_) {}
      ws = null;
    }
  } catch (_) {}
  try {
    napcatActionClient.handleDisconnect('MizukiBot restart draining');
    napcatActionClient.setWebSocket(null);
  } catch (_) {}
}

process.on('mizuki:restartScheduled', drainForScheduledRestart);

process.on('SIGINT', () => {
  void shutdownMainProcess('SIGINT', 130);
});
process.on('SIGTERM', () => {
  void shutdownMainProcess('SIGTERM', 143);
});
process.on('SIGBREAK', () => {
  void shutdownMainProcess('SIGBREAK', 131);
});
process.on('SIGHUP', () => {
  void shutdownMainProcess('SIGHUP', 129);
});

async function startMainProcess() {
  cleanupSingleInstanceLock = await acquireSingleInstanceLock();
  startMainRuntimeHeartbeat('lock_acquired');
  await cleanupStaleTmpFilesOnStartup();
  webServer = startServer();
  initializeMemeManager();
  if (config.MAIN_PROCESS_EMBEDDING_BACKFILL_ON_START) {
    const { enqueueMissingEmbeddings } = require('./utils/memory-v3/embeddingIndex');
    enqueueMissingEmbeddings(null, {
      schedule: true,
      delayMs: 15000,
      continueDelayMs: 60000
    });
  }
  startResourceSnapshots();
  startNapCatTransport();
  recordMainRuntimeState('initialized', {
    mode: config.NAPCAT_HTTP_REVERSE_ENABLED ? 'http_reverse' : 'websocket'
  });
  console.log('[startup] main bot initialized', {
    pid: process.pid,
    mode: config.NAPCAT_HTTP_REVERSE_ENABLED ? 'http_reverse' : 'websocket',
    lockFile: LOCK_FILE
  });
}

if (process.env.MIZUKIBOT_INDEX_TEST_MODE === '1') {
  module.exports = {
    __test: {
      acquireSingleInstanceLock,
      commandLineLooksLikeMainBot,
      cleanupSingleInstanceLockSync,
      getProcessCommandLine,
      isMainBotProcess,
      isProcessAlive,
      readLockOwnerPid
    }
  };
} else {
  startMainProcess().catch((error) => {
    preserveSingleInstanceLockOnExit = true;
    logFatalStartupError('startup', error);
    process.exit(1);
  });
}
