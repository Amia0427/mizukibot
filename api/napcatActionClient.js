const config = require('../config');

const WS_OPEN = 1;

class NapCatActionError extends Error {
  constructor(message, options = {}) {
    super(String(message || 'NapCat action failed'));
    this.name = 'NapCatActionError';
    this.action = String(options.action || '').trim();
    this.echo = String(options.echo || '').trim();
    this.status = String(options.status || '').trim();
    this.retcode = Number.isFinite(Number(options.retcode)) ? Number(options.retcode) : null;
    this.data = options.data;
    this.offline = options.offline === true;
    this.retryable = options.retryable === true;
  }
}

function clampTimeoutMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1000, Math.floor(n));
}

function createNapCatActionClient(options = {}) {
  const defaultTimeoutMs = clampTimeoutMs(
    options.timeoutMs || config.NAPCAT_ACTION_TIMEOUT_MS,
    15000
  );

  let ws = null;
  let sequence = 0;
  let connectedSince = 0;
  let lastConnectedAt = 0;
  let lastDisconnectedAt = 0;
  let lastDisconnectReason = '';
  let disconnectCount = 0;
  const pendingByEcho = new Map();

  function buildEcho(action = 'action') {
    sequence += 1;
    return `mizuki_${Date.now()}_${sequence}_${String(action || 'action').trim() || 'action'}`;
  }

  function clearPending(reason = 'NapCat connection closed') {
    for (const [echo, pending] of pendingByEcho.entries()) {
      pendingByEcho.delete(echo);
      try {
        clearTimeout(pending.timer);
      } catch (_) {}
      pending.reject(new NapCatActionError(reason, {
        action: pending.action,
        echo,
        offline: true,
        retryable: true
      }));
    }
  }

  function readyStateName(readyState) {
    if (readyState === 0) return 'connecting';
    if (readyState === 1) return 'open';
    if (readyState === 2) return 'closing';
    if (readyState === 3) return 'closed';
    return 'none';
  }

  function markConnected() {
    const now = Date.now();
    connectedSince = connectedSince || now;
    lastConnectedAt = now;
    lastDisconnectReason = '';
  }

  function markDisconnected(reason = 'NapCat websocket disconnected') {
    connectedSince = 0;
    lastDisconnectedAt = Date.now();
    lastDisconnectReason = String(reason || 'NapCat websocket disconnected');
    disconnectCount += 1;
  }

  function setWebSocket(nextWs = null) {
    if (ws === nextWs) return;
    if (ws && nextWs !== ws) {
      clearPending('NapCat websocket replaced');
    }
    ws = nextWs || null;
    if (isConnected()) {
      markConnected();
    } else if (!ws) {
      markDisconnected('NapCat websocket cleared');
    }
  }

  function isConnected() {
    return Boolean(ws && ws.readyState === WS_OPEN);
  }

  function getConnectionState() {
    const connected = isConnected();
    if (connected && !connectedSince) markConnected();
    const now = Date.now();
    return {
      connected,
      readyState: ws ? ws.readyState : -1,
      readyStateName: readyStateName(ws ? ws.readyState : -1),
      pendingCount: pendingByEcho.size,
      connectedSince,
      lastConnectedAt,
      lastDisconnectedAt,
      lastDisconnectReason,
      disconnectCount,
      offlineMs: connected || !lastDisconnectedAt ? 0 : Math.max(0, now - lastDisconnectedAt)
    };
  }

  function handleMessage(packet = {}) {
    if (!packet || typeof packet !== 'object') return false;
    const echo = String(packet.echo || '').trim();
    if (!echo || !pendingByEcho.has(echo)) return false;

    const pending = pendingByEcho.get(echo);
    pendingByEcho.delete(echo);
    try {
      clearTimeout(pending.timer);
    } catch (_) {}

    const status = String(packet.status || '').trim().toLowerCase();
    const retcode = Number(packet.retcode);
    const isFailure = (
      (status && status !== 'ok')
      || (Number.isFinite(retcode) && retcode !== 0)
    );

    if (isFailure) {
      pending.reject(new NapCatActionError(
        `NapCat action ${pending.action} failed`,
        {
          action: pending.action,
          echo,
          status,
          retcode,
          data: packet.data
        }
      ));
      return true;
    }

    pending.resolve(packet.data);
    return true;
  }

  function handleDisconnect(reason = 'NapCat websocket disconnected') {
    markDisconnected(reason);
    clearPending(reason);
  }

  function handleConnect() {
    markConnected();
  }

  async function callAction(action, params = {}, options = {}) {
    const actionName = String(action || '').trim();
    if (!actionName) {
      throw new NapCatActionError('NapCat action name is required', { action: actionName });
    }
    if (!isConnected()) {
      throw new NapCatActionError('NapCat websocket is not connected', {
        action: actionName,
        offline: true,
        retryable: true,
        data: getConnectionState()
      });
    }

    const echo = buildEcho(actionName);
    const timeoutMs = clampTimeoutMs(options.timeoutMs, defaultTimeoutMs);
    const payload = {
      action: actionName,
      params: params && typeof params === 'object' ? params : {},
      echo
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingByEcho.delete(echo);
        reject(new NapCatActionError(
          `NapCat action ${actionName} timed out`,
          { action: actionName, echo }
        ));
      }, timeoutMs);

      pendingByEcho.set(echo, {
        action: actionName,
        resolve,
        reject,
        timer
      });

      try {
        ws.send(JSON.stringify(payload));
      } catch (error) {
        pendingByEcho.delete(echo);
        clearTimeout(timer);
        reject(new NapCatActionError(
          error?.message || `NapCat action ${actionName} send failed`,
          { action: actionName, echo }
        ));
      }
    });
  }

  return {
    callAction,
    clearPending,
    getConnectionState,
    handleConnect,
    handleDisconnect,
    handleMessage,
    isConnected,
    setWebSocket
  };
}

function isActionClientConnected(actionClient = null) {
  if (!actionClient || typeof actionClient.isConnected !== 'function') return true;
  try {
    return actionClient.isConnected() !== false;
  } catch (_) {
    return true;
  }
}

function getActionClientConnectionState(actionClient = null) {
  if (actionClient && typeof actionClient.getConnectionState === 'function') {
    try {
      const state = actionClient.getConnectionState();
      if (state && typeof state === 'object') return state;
    } catch (_) {}
  }
  return {
    connected: isActionClientConnected(actionClient),
    readyState: null,
    readyStateName: 'unknown',
    pendingCount: null,
    connectedSince: 0,
    lastConnectedAt: 0,
    lastDisconnectedAt: 0,
    lastDisconnectReason: ''
  };
}

function isNapCatOfflineError(error = null) {
  if (!error) return false;
  const message = String(error.message || error || '');
  return error.offline === true
    || String(error.code || '').trim() === 'NAPCAT_OFFLINE'
    || /NapCat websocket is not connected/i.test(message)
    || /NapCat websocket (closed|disconnected|replaced|cleared)/i.test(message);
}

let singletonClient = null;

function getNapCatActionClient() {
  if (!singletonClient) {
    singletonClient = createNapCatActionClient();
  }
  return singletonClient;
}

module.exports = {
  NapCatActionError,
  createNapCatActionClient,
  getActionClientConnectionState,
  getNapCatActionClient,
  isActionClientConnected,
  isNapCatOfflineError
};
