const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const config = require('./config');

config.validateRequiredConfig();

const { startServer } = require('./web/server');
const { startTickEngine } = require('./core/tickEngine');
const { createMessageHandler } = require('./core/messageHandler');
const { initializeMemeManager } = require('./core/memeManager');
const { askAIByGraph } = require('./api/agentGraph');
const { shutdown: shutdownMinecraftAgent } = require('./api/minecraftAgent');
const { warmMcpRegistry } = require('./api/toolRegistry');
const { getNapCatActionClient } = require('./api/napcatActionClient');
const { getSchedulerRuntime } = require('./core/schedulerRuntime');
const { sendGroupMessage } = require('./api/qqActionService');
const { createPostReplyWorkerRuntime } = require('./utils/postReplyWorkerRuntime');
const { appendNapcatPacketToLog, createNapcatLogFollower } = require('./core/napcatLogFollower');

// Avoid starting multiple bot instances that compete for one OneBot websocket.
const LOCK_FILE = path.join(__dirname, '.mizukibot.lock');

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireSingleInstanceLock() {
  const writeLock = () => {
    fs.writeFileSync(LOCK_FILE, String(process.pid) + '\n', { encoding: 'utf8', flag: 'wx' });
  };

  const replaceStaleLock = () => {
    fs.writeFileSync(LOCK_FILE, String(process.pid) + '\n', { encoding: 'utf8', flag: 'w' });
  };

  try {
    writeLock();
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;

    let existingPid = NaN;
    try {
      existingPid = Number.parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    } catch (_) {}

    if (isProcessAlive(existingPid)) {
      console.error('[Startup] MizukiBot is already running (PID=' + existingPid + ').');
      process.exit(1);
    }

    try {
      replaceStaleLock();
    } catch (replaceErr) {
      console.error('[Startup] Failed to replace stale lock file:', replaceErr?.message || replaceErr);
      process.exit(1);
    }
  }

  const cleanup = () => {
    try {
      if (!fs.existsSync(LOCK_FILE)) return;
      const ownerPid = Number.parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (ownerPid === process.pid) {
        fs.writeFileSync(LOCK_FILE, '', { encoding: 'utf8', flag: 'w' });
      }
    } catch (_) {}
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    void shutdownMinecraftAgent();
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    void shutdownMinecraftAgent();
    cleanup();
    process.exit(143);
  });
}

acquireSingleInstanceLock();
startServer();
initializeMemeManager();
void warmMcpRegistry();

let ws = null;
let tickStarted = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let schedulerStarted = false;
const napcatActionClient = getNapCatActionClient();
const postReplyWorkerRuntime = config.POST_REPLY_WORKER_INLINE ? createPostReplyWorkerRuntime({ forceStart: true }) : null;

function scheduleReconnect() {
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
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

async function sendWithRetry(payload, retries = 1, waitMs = 500) {
  const maxRetry = Math.max(0, Number(retries) || 0);
  for (let i = 0; i <= maxRetry; i++) {
    if (safeSend(payload)) return true;
    if (i < maxRetry) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return false;
}

const { handleIncomingMessage } = createMessageHandler({
  config,
  sendWithRetry
});
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

function connectNapCat() {
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
    console.log('✅ 瑞希上线啦！已连接到 NapCat');

    if (!tickStarted) {
      startTickEngine(ws, askAIByGraph);
      tickStarted = true;
    }

    if (!schedulerStarted) {
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
    scheduleReconnect();
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      appendNapcatPacketToLog(msg);
      if (napcatActionClient.handleMessage(msg)) return;
      await handleIncomingMessage(msg);
    } catch (e) {
      console.error('[消息处理异常]', e);
    }
  });
}

connectNapCat();
