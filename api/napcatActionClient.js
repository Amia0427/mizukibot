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
        echo
      }));
    }
  }

  function setWebSocket(nextWs = null) {
    if (ws === nextWs) return;
    if (ws && nextWs !== ws) {
      clearPending('NapCat websocket replaced');
    }
    ws = nextWs || null;
  }

  function isConnected() {
    return Boolean(ws && ws.readyState === WS_OPEN);
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
    clearPending(reason);
  }

  async function callAction(action, params = {}, options = {}) {
    const actionName = String(action || '').trim();
    if (!actionName) {
      throw new NapCatActionError('NapCat action name is required', { action: actionName });
    }
    if (!isConnected()) {
      throw new NapCatActionError('NapCat websocket is not connected', { action: actionName });
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
    handleDisconnect,
    handleMessage,
    isConnected,
    setWebSocket
  };
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
  getNapCatActionClient
};
