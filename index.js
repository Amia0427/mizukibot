const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const WebSocket = require('ws');

const execFileAsync = promisify(execFile);
const fsp = fs.promises;

process.env.MIZUKIBOT_RUNTIME_ROLE = process.env.MIZUKIBOT_RUNTIME_ROLE || 'main';

const config = require('./config');

config.validateRequiredConfig();

const { startServer } = require('./web/server');
const { startTickEngine } = require('./core/tickEngine');
const { startDailyJournalSummaryScheduler } = require('./core/dailyJournalSummaryScheduler');
const { createMessageHandler } = require('./core/messageHandler');
const { createPrivateProactiveEngine } = require('./core/privateProactiveEngine');
const { initializeMemeManager } = require('./core/memeManager');
const { clearRuntimeSlotsForCurrentProcess } = require('./api/createAgentExecutor');
const { shutdown: shutdownMinecraftAgent } = require('./api/minecraftAgent');
const { shutdownCycleTLS } = require('./api/httpClient');
const { clearMcpRuntimeCaches } = require('./api/mcpRuntime');
const { getNapCatActionClient } = require('./api/napcatActionClient');
const { getSchedulerRuntime } = require('./core/schedulerRuntime');
const { isAdminUser, sendGroupMessage, sendPrivateMessage } = require('./api/qqActionService');
const { createPostReplyWorkerRuntime } = require('./utils/postReplyWorkerRuntime');
const { appendNapcatPacketToLog, createNapcatLogFollower } = require('./core/napcatLogFollower');
const { startResourceSnapshotLoop } = require('./utils/perfRuntime');
const { cleanupStaleDataTmpFiles, DEFAULT_MAX_AGE_MS } = require('./utils/dataTmpCleanup');
const { startNapCatHttpReverseServer } = require('./core/napcatHttpReverseServer');
const { createMessageIngressDispatcher } = require('./core/messageIngressDispatcher');
const { recordNapCatConnectionState } = require('./utils/napcatHealthDiagnostics');
const { maybeSendRestartResultFeedback } = require('./utils/restartResultFeedback');
const { flushAllHotStoresSync } = require('./utils/jsonHotStore');
const { sendNapCatActionWithRetry } = require('./utils/napcatActionRetry');
const { createRuntimeReadiness } = require('./utils/runtimeReadiness');
const { closeServer, waitForServerListening } = require('./utils/serverLifecycle');
const { createMainProcessLifecycle } = require('./utils/mainProcessLifecycle');
const { closeLoadedSqliteConnections } = require('./utils/sqliteRuntime');
const { createMaimaiCommandHandler } = require('./src/features/maimai/commands');
const { closeMaimaiRuntime, getMaimaiRuntime, peekMaimaiRuntime } = require('./src/features/maimai/runtime');
const { closePjskRuntime, getPjskRuntime, peekPjskRuntime } = require('./src/features/pjsk/runtime');

// Avoid starting multiple bot instances that compete for one OneBot connection.
const LOCK_FILE = process.env.MIZUKIBOT_MAIN_LOCK_FILE
  || (process.env.MIZUKIBOT_INDEX_TEST_MODE === '1' && process.env.MIZUKIBOT_LOCK_FILE)
  || path.join(__dirname, '.mizukibot.lock');
const EXPECTED_SHUTDOWN_FILE = path.join(config.DATA_DIR, 'bot-main-expected-shutdown.json');
const RUNTIME_STATE_FILE = path.join(config.DATA_DIR, 'bot-main-runtime-state.json');
const EXIT_OBSERVATIONS_FILE = path.join(config.DATA_DIR, 'bot-main-exit-observations.jsonl');
const NODE_REPORT_DIR = path.join(config.DATA_DIR, 'node-reports');
let cleanupSingleInstanceLock = null;
let preserveSingleInstanceLockOnExit = false;
let messageIngressDispatcher = null;
let mainRuntimeHeartbeatTimer = null;
const mainRuntimeStartedAt = new Date();
const runtimeReadiness = createRuntimeReadiness();

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

function handleMainUncaughtException(error) {
  preserveSingleInstanceLockOnExit = true;
  logFatalStartupError('uncaughtException', error);
  process.exit(1);
}

function handleMainUnhandledRejection(error) {
  preserveSingleInstanceLockOnExit = true;
  logFatalStartupError('unhandledRejection', error);
  process.exit(1);
}

function handleMainBeforeExit(code) {
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
}

function handleMainExit(code) {
  appendMainExitObservation('exit', { code });
  recordMainRuntimeState('exit', { code });
  console.warn('[process] exit', {
    pid: process.pid,
    code,
    uptimeMs: Math.round(process.uptime() * 1000)
  });
}

process.on('uncaughtException', handleMainUncaughtException);
process.on('unhandledRejection', handleMainUnhandledRejection);
process.on('beforeExit', handleMainBeforeExit);
process.on('exit', handleMainExit);

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
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (_) {}
}

async function acquireSingleInstanceLock() {
  const acquireGuardDir = `${LOCK_FILE}.acquire`;
  const acquireGuard = async () => {
    while (true) {
      try {
        await fsp.mkdir(acquireGuardDir);
        return async () => {
          await fsp.rm(acquireGuardDir, { recursive: true, force: true });
        };
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
        try {
          const stat = await fsp.stat(acquireGuardDir);
          if (Date.now() - stat.mtimeMs > 30_000) {
            await fsp.rm(acquireGuardDir, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError?.code === 'ENOENT') continue;
          throw statError;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };

  await fsp.mkdir(path.dirname(LOCK_FILE), { recursive: true });
  try {
    await fsp.writeFile(LOCK_FILE, String(process.pid) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;

    const releaseGuard = await acquireGuard();
    try {
      await fsp.writeFile(LOCK_FILE, String(process.pid) + '\n', { encoding: 'utf8', flag: 'wx' });
    } catch (guardedError) {
      if (!guardedError || guardedError.code !== 'EEXIST') throw guardedError;

      const existingPid = await readLockOwnerPid();
      if (existingPid !== process.pid) {
        if (await isMainBotProcess(existingPid)) {
          console.error('[Startup] MizukiBot is already running (PID=' + existingPid + ').');
          await releaseGuard();
          process.exit(1);
        }

        if (isProcessAlive(existingPid)) {
          const commandLine = await getProcessCommandLine(existingPid);
          console.warn('[Startup] Replacing stale lock owned by non-bot process:', {
            pid: existingPid,
            commandLine: commandLine.slice(0, 240)
          });
        }

        await fsp.unlink(LOCK_FILE).catch((unlinkError) => {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        });
        await fsp.writeFile(LOCK_FILE, String(process.pid) + '\n', { encoding: 'utf8', flag: 'wx' });
      }
    } finally {
      await releaseGuard();
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
let reconnectTimer = null;
let reconnectAttempts = 0;

let shuttingDown = false;
let tickStarted = false;
let tickRuntime = null;
let dailyJournalSummaryStarted = false;
let dailyJournalSummaryRuntime = null;
let schedulerStarted = false;
const napcatActionClient = getNapCatActionClient();
const privateProactiveEngine = createPrivateProactiveEngine({
  config,
  actionClient: napcatActionClient
});
const postReplyWorkerRuntime = config.POST_REPLY_WORKER_INLINE ? createPostReplyWorkerRuntime({ forceStart: true }) : null;

function askAIByGraph(...args) {
  return require('./api/agentGraph').askAIByGraph(...args);
}

async function sendWithRetry(payload, retries = 1, waitMs = 500) {
  return sendNapCatActionWithRetry({
    actionClient: napcatActionClient,
    payload,
    retries,
    waitMs
  });
}

const maimaiCommandHandler = createMaimaiCommandHandler({
  getRuntime: getMaimaiRuntime,
  isAdmin: isAdminUser,
  sendReply: async (msg, replyText) => {
    const isPrivate = String(msg?.message_type || '').trim().toLowerCase() === 'private';
    await sendWithRetry({
      action: isPrivate ? 'send_private_msg' : 'send_group_msg',
      params: isPrivate
        ? { user_id: String(msg?.user_id || '').trim(), message: replyText }
        : { group_id: String(msg?.group_id || '').trim(), message: replyText }
    }, 1, 300);
  }
});

const { handleIncomingMessage } = createMessageHandler({
  config,
  sendWithRetry,
  actionClient: napcatActionClient,
  privateProactiveEngine
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

async function acceptNapCatIncomingMessage(msg, source = '', preparePacket = prepareNapCatEventPacket) {
  if (preparePacket(msg)) return false;
  await acceptIncomingMessage(msg, source);
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
  sendGroupMessage: async (groupId, message, meta = {}) => {
    await sendGroupMessage(groupId, message, {
      actionClient: napcatActionClient,
      ...meta
    });
    return true;
  }
});
function startResourceSnapshots() {
  if (resourceSnapshotLoop) return;
  resourceSnapshotLoop = startResourceSnapshotLoop(() => ({
    component: 'main_process',
    schedulerStarted,
    tickStarted,
    postReplyInline: Boolean(postReplyWorkerRuntime),
    wsReadyState: ws ? ws.readyState : -1,
    reconnectAttempts
  }));
}

let httpReverseServer = null;

function prepareNapCatEventPacket(msg) {
  if (maimaiCommandHandler.shouldHandle(msg?.raw_message)) {
    void maimaiCommandHandler.handle(msg).catch((error) => {
      console.error('[maimai command] failed:', error?.message || error);
    });
    return true;
  }
  appendNapcatPacketToLog(msg);
  if (config.FOLLOWER_DIRECT_DISPATCH_ENABLED) {
    void napcatLogFollower.handleLivePacket(msg).catch((error) => {
      console.error('[NapCat follower live packet error]', error?.message || error);
    });
  }
  return napcatActionClient.handleMessage(msg);
}

function startConnectedRuntimes() {
  getMaimaiRuntime()?.syncScheduler?.start();
  getPjskRuntime()?.syncScheduler?.start();
  privateProactiveEngine.start();
  if (config.TICK_ENGINE_ENABLED && !tickStarted) {
    tickRuntime = startTickEngine(askAIByGraph, napcatActionClient);
    tickStarted = true;
  }
  if (!config.TICK_ENGINE_ENABLED && !dailyJournalSummaryStarted) {
    dailyJournalSummaryRuntime = startDailyJournalSummaryScheduler();
    dailyJournalSummaryStarted = true;
  }
  if (config.SCHEDULER_RUNTIME_ENABLED && !schedulerStarted) {
    schedulerRuntime.start();
    schedulerStarted = true;
  }
  if (postReplyWorkerRuntime) {
    postReplyWorkerRuntime.start();
  }
  napcatLogFollower.start();
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  const delay = Math.min(30000, 1500 * Math.max(1, reconnectAttempts));
  reconnectAttempts += 1;
  console.log(`[NapCat ws] disconnected, retry in ${delay}ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNapCat();
  }, delay);
  reconnectTimer.unref?.();
}

function connectNapCat() {
  if (shuttingDown) return;
  const wsUrl = String(config.NAPCAT_WS_URL || '').trim();
  if (!wsUrl) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const headers = {};
  const wsToken = String(config.NAPCAT_WS_TOKEN || '').trim();
  if (wsToken) headers.Authorization = `Bearer ${wsToken}`;

  ws = new WebSocket(wsUrl, { headers });
  napcatActionClient.setWebSocket(ws);

  ws.on('open', () => {
    reconnectAttempts = 0;
    recordNapCatConnectionState('online', getWebSocketConnectionState(), {
      mode: 'websocket',
      reason: 'NapCat websocket connected'
    });
    startConnectedRuntimes();
    console.log('✅ NapCat WebSocket 已连接');
  });

  ws.on('close', (code, reason) => {
    const closeReason = reason ? reason.toString() : '';
    console.warn('[NapCat ws close]', { code, reason: closeReason });
    recordNapCatConnectionState('offline', getWebSocketConnectionState({ closed: true, reason: closeReason || `close:${code}` }), {
      mode: 'websocket',
      reason: closeReason || `close:${code}`
    });
    if (!shuttingDown) scheduleReconnect();
  });

  ws.on('error', (error) => {
    console.error('[NapCat ws error]', error?.message || error);
  });

  ws.on('message', async (data) => {
    if (shuttingDown) return;
    try {
      const msg = JSON.parse(data);
      await acceptNapCatIncomingMessage(msg, 'napcat_ws');
    } catch (e) {
      console.error('[NapCat ws message error]', e);
    }
  });
}

function getWebSocketConnectionState(extra = {}) {
  const now = Date.now();
  const readyState = extra.closed ? WebSocket.CLOSED : (ws ? ws.readyState : WebSocket.CLOSED);
  const connected = readyState === WebSocket.OPEN;
  const readyStateNames = {
    [WebSocket.CONNECTING]: 'connecting',
    [WebSocket.OPEN]: 'open',
    [WebSocket.CLOSING]: 'closing',
    [WebSocket.CLOSED]: 'closed'
  };
  return {
    connected,
    readyState,
    readyStateName: readyStateNames[readyState] || 'unknown',
    pendingCount: null,
    connectedSince: connected ? now : 0,
    lastConnectedAt: connected ? now : 0,
    lastDisconnectedAt: connected ? 0 : now,
    lastDisconnectReason: connected ? '' : String(extra.reason || ''),
    disconnectCount: connected ? 0 : 1,
    offlineMs: 0
  };
}

function closeNapCatWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (!ws) return;
  const current = ws;
  ws = null;
  try {
    current.removeAllListeners();
    if (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING) {
      current.close();
    } else {
      current.terminate?.();
    }
  } catch (error) {
    console.error('[NapCat ws cleanup failed]', error?.message || error);
  } finally {
    napcatActionClient.setWebSocket(null);
  }
}

function startNapCatTransport() {
  httpReverseServer = startNapCatHttpReverseServer({
    handleMessage: async (msg) => {
      if (shuttingDown) return;
      try {
        await acceptNapCatIncomingMessage(msg, 'napcat_http_reverse');
      } catch (e) {
        console.error('[HTTP reverse message error]', e);
      }
    }
  });

  recordNapCatConnectionState('online', napcatActionClient.getConnectionState(), {
    mode: 'http_reverse',
    reason: 'HTTP reverse mode started'
  });

  startConnectedRuntimes();
  connectNapCat();
  console.log('✅ HTTP 反向连接模式启动，等待 NapCat POST 消息');
}

function scheduleRestartResultFeedback(attempt = 1) {
  setTimeout(() => {
    void maybeSendRestartResultFeedback({
      actionClient: napcatActionClient,
      sendGroupMessage,
      sendPrivateMessage
    }).then((result) => {
      if (result?.reason === 'send_failed' && attempt < 5) {
        scheduleRestartResultFeedback(attempt + 1);
      }
    }).catch((error) => {
      console.warn('[restart] feedback failed', error?.message || error);
    });
  }, 4000).unref?.();
}

const mainProcessLifecycle = createMainProcessLifecycle({
  begin: ({ reason, exitCode, marker }) => {
    shuttingDown = true;
    runtimeReadiness.beginDrain(reason);
    recordExpectedShutdown(reason, { exitCode, ...marker });
    console.log('[shutdown] begin', { reason, pid: process.pid });
  },
  stopAccepting: async () => {
    const serverClose = Promise.all([
      closeServer(webServer, { timeoutMs: config.RUNTIME_SHUTDOWN_TIMEOUT_MS }),
      closeServer(httpReverseServer, { timeoutMs: config.RUNTIME_SHUTDOWN_TIMEOUT_MS })
    ]);
    let disconnectError = null;
    try {
      napcatActionClient.handleDisconnect('MizukiBot shutdown');
      napcatActionClient.setWebSocket(null);
    } catch (error) {
      disconnectError = error;
    } finally {
      closeNapCatWebSocket();
    }
    const [webCloseResult, reverseCloseResult] = await serverClose;
    if (!webCloseResult.closed) console.error('[shutdown] web server close incomplete:', webCloseResult);
    if (!reverseCloseResult.closed) console.error('[shutdown] http reverse server close incomplete:', reverseCloseResult);
    if (disconnectError) throw disconnectError;
  },
  stopRuntimes: [
    { name: 'maimai_sync_scheduler', run: () => peekMaimaiRuntime()?.syncScheduler?.stop({ drain: true }) },
    { name: 'pjsk_sync_scheduler', run: () => peekPjskRuntime()?.syncScheduler?.stop({ drain: true }) },
    { name: 'private_proactive', run: () => privateProactiveEngine.stop() },
    { name: 'scheduler', run: () => schedulerRuntime.stop() },
    { name: 'tick', run: () => tickRuntime?.stop?.() },
    { name: 'daily_journal_summary', run: () => dailyJournalSummaryRuntime?.stop?.() },
    { name: 'napcat_follower', run: () => napcatLogFollower.stop() },
    { name: 'resource_snapshots', run: () => resourceSnapshotLoop?.stop?.() }
  ],
  drainWorkers: [
    {
      name: 'post_reply_worker',
      run: ({ reason }) => postReplyWorkerRuntime?.drainAndStop?.({
        timeoutMs: config.RUNTIME_SHUTDOWN_TIMEOUT_MS,
        source: reason
      })
    },
    {
      name: 'message_ingress',
      run: () => messageIngressDispatcher?.stop?.({
        drain: true,
        timeoutMs: config.MESSAGE_INGRESS_ASYNC_SHUTDOWN_DRAIN_MS
      })
    }
  ],
  cleanupExternal: [
    { name: 'mcp_runtime', run: () => clearMcpRuntimeCaches() },
    { name: 'create_agent_runtime', run: () => clearRuntimeSlotsForCurrentProcess() },
    { name: 'minecraft', run: () => shutdownMinecraftAgent() },
    { name: 'cycletls', run: () => shutdownCycleTLS() }
  ],
  finalize: [
    { name: 'hot_stores', run: () => flushAllHotStoresSync() },
    { name: 'maimai_runtime', run: () => closeMaimaiRuntime() },
    { name: 'pjsk_runtime', run: () => closePjskRuntime() },
    { name: 'sqlite', run: () => closeLoadedSqliteConnections() },
    { name: 'single_instance_lock', run: () => cleanupSingleInstanceLock?.() }
  ],
  complete: ({ reason, exitCode }) => {
    runtimeReadiness.markStopped('shutdown_complete');
    stopMainRuntimeHeartbeat('shutdown_complete', { reason, exitCode });
    console.log('[shutdown] complete', { reason, pid: process.pid });
  },
  exit: (exitCode) => process.exit(exitCode)
});

function shutdownMainProcess(signal = 'SIGTERM', exitCode = 0) {
  return mainProcessLifecycle.drain({
    reason: String(signal || 'shutdown').trim() || 'shutdown',
    exitCode,
    exitProcess: true
  });
}

function buildScheduledRestartMarker(meta = {}) {
  return {
    delayMs: Math.max(0, Number(meta?.delayMs || 0) || 0),
    source: String(meta?.source || 'remote_restart').trim() || 'remote_restart',
    requestedBy: String(meta?.userId || '').trim(),
    requestId: String(meta?.requestId || '').trim(),
    messageId: String(meta?.messageId || '').trim(),
    groupId: String(meta?.groupId || '').trim(),
    command: String(meta?.command || '').trim()
  };
}

function drainForScheduledRestart(meta = {}) {
  const marker = buildScheduledRestartMarker(meta);
  console.log('[restart] drain old instance before external restart', {
    pid: process.pid,
    delayMs: marker.delayMs,
    source: marker.source
  });
  const drain = mainProcessLifecycle.drain({
    reason: 'remote_restart_scheduled',
    marker
  });
  if (typeof meta.waitUntil === 'function') meta.waitUntil(drain);
  return drain;
}

process.on('mizuki:restartScheduled', drainForScheduledRestart);

function handleMainSigint() {
  void shutdownMainProcess('SIGINT', 130);
}

function handleMainSigterm() {
  void shutdownMainProcess('SIGTERM', 143);
}

function handleMainSigbreak() {
  void shutdownMainProcess('SIGBREAK', 131);
}

function handleMainSighup() {
  void shutdownMainProcess('SIGHUP', 129);
}

process.on('SIGINT', handleMainSigint);
process.on('SIGTERM', handleMainSigterm);
process.on('SIGBREAK', handleMainSigbreak);
process.on('SIGHUP', handleMainSighup);

async function startMainProcess() {
  cleanupSingleInstanceLock = await acquireSingleInstanceLock();
  startMainRuntimeHeartbeat('lock_acquired');
  await cleanupStaleTmpFilesOnStartup();
  webServer = startServer({ readiness: runtimeReadiness });
  initializeMemeManager();
  scheduleMainProcessEmbeddingBackfill();
  startResourceSnapshots();
  startNapCatTransport();
  await Promise.all([
    waitForServerListening(webServer),
    waitForServerListening(httpReverseServer)
  ]);
  runtimeReadiness.markReady('startup_complete');
  scheduleRestartResultFeedback();
  recordMainRuntimeState('initialized', {
    mode: 'http_reverse'
  });
  console.log('[startup] main bot initialized', {
    pid: process.pid,
    mode: 'http_reverse',
    lockFile: LOCK_FILE
  });
}

function scheduleMainProcessEmbeddingBackfill() {
  if (!config.MAIN_PROCESS_EMBEDDING_BACKFILL_ON_START) return false;
  const { enqueueMissingEmbeddings } = require('./utils/memory-v3/embeddingIndex');
  enqueueMissingEmbeddings(null, {
    schedule: true,
    delayMs: 15000,
    continueDelayMs: 60000
  });
  return true;
}

if (process.env.MIZUKIBOT_INDEX_TEST_MODE === '1') {
  module.exports = {
    __test: {
      acquireSingleInstanceLock,
      acceptIncomingMessage,
      acceptNapCatIncomingMessage,
      appendMainExitObservation,
      buildScheduledRestartMarker,
      commandLineLooksLikeMainBot,
      cleanupSingleInstanceLockSync,
      connectNapCat,
      configureNodeProcessReports,
      drainForScheduledRestart,
      expectedShutdownFile: EXPECTED_SHUTDOWN_FILE,
      exitObservationsFile: EXIT_OBSERVATIONS_FILE,
      getProcessCommandLine,
      handleMainBeforeExit,
      handleMainExit,
      handleMainSigbreak,
      handleMainSighup,
      handleMainSigint,
      handleMainSigterm,
      handleMainUncaughtException,
      handleMainUnhandledRejection,
      isMainBotProcess,
      isProcessAlive,
      nodeReportDir: NODE_REPORT_DIR,
      readLockOwnerPid,
      recordExpectedShutdown,
      recordMainRuntimeState,
      runtimeStateFile: RUNTIME_STATE_FILE,
      runtimeReadiness,
      privateProactiveEngine,
      scheduleMainProcessEmbeddingBackfill,
      setMessageIngressDispatcherForTest(dispatcher) {
        messageIngressDispatcher = dispatcher;
      },
      startMainRuntimeHeartbeat,
      stopMainRuntimeHeartbeat,
      stopNapCatWebSocketForTest: closeNapCatWebSocket
    }
  };
} else {
  startMainProcess().catch((error) => {
    preserveSingleInstanceLockOnExit = true;
    runtimeReadiness.markStopped('startup_failed');
    logFatalStartupError('startup', error);
    process.exit(1);
  });
}
