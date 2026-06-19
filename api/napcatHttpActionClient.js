const axios = require('axios');
const config = require('../config');

class NapCatActionError extends Error {
  constructor(message, options = {}) {
    super(String(message || 'NapCat action failed'));
    this.name = 'NapCatActionError';
    this.action = String(options.action || '').trim();
    this.code = String(options.code || '').trim();
    this.status = String(options.status || '').trim();
    this.retcode = Number.isFinite(Number(options.retcode)) ? Number(options.retcode) : null;
    this.data = options.data;
    this.offline = options.offline === true;
    this.retryable = options.retryable === true;
  }
}

function isHttpTransportOfflineError(error = null) {
  return Boolean(error && !error.response);
}

function createNapCatHttpActionClient() {
  const baseURL = String(config.NAPCAT_HTTP_API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const secret = String(config.NAPCAT_HTTP_ACTION_SECRET || '').trim();
  const timeout = config.NAPCAT_ACTION_TIMEOUT_MS || 30000;
  let connected = true;
  let connectedSince = Date.now();
  let lastConnectedAt = connectedSince;
  let lastDisconnectedAt = 0;
  let lastDisconnectReason = '';
  let disconnectCount = 0;
  let pendingCount = 0;

  function markConnected() {
    const now = Date.now();
    connected = true;
    connectedSince = connectedSince || now;
    lastConnectedAt = now;
    lastDisconnectReason = '';
  }

  function markDisconnected(reason = 'NapCat HTTP action endpoint unavailable') {
    const wasConnected = connected;
    const now = Date.now();
    connected = false;
    connectedSince = 0;
    if (wasConnected || !lastDisconnectedAt) {
      lastDisconnectedAt = now;
      disconnectCount += 1;
    }
    lastDisconnectReason = String(reason || 'NapCat HTTP action endpoint unavailable');
  }

  function getConnectionState() {
    const now = Date.now();
    return {
      connected,
      readyState: null,
      readyStateName: connected ? 'http' : 'http_offline',
      pendingCount,
      connectedSince,
      lastConnectedAt,
      lastDisconnectedAt,
      lastDisconnectReason,
      disconnectCount,
      offlineMs: connected || !lastDisconnectedAt ? 0 : Math.max(0, now - lastDisconnectedAt)
    };
  }

  async function callAction(action, params = {}, options = {}) {
    const actionName = String(action || '').trim();
    if (!actionName) {
      throw new NapCatActionError('NapCat action name is required', { action: actionName });
    }

    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers.Authorization = `Bearer ${secret}`;

    try {
      const actionTimeout = Math.max(1000, Number(options.timeoutMs || timeout) || timeout);
      pendingCount += 1;
      const response = await axios.post(`${baseURL}/${actionName}`, params, { headers, timeout: actionTimeout });
      markConnected();
      const data = response.data || {};

      if (data.status === 'failed' || (data.retcode !== undefined && data.retcode !== 0)) {
        throw new NapCatActionError(`NapCat action ${actionName} failed`, {
          action: actionName,
          status: data.status,
          retcode: data.retcode,
          data: data.data
        });
      }

      return data.data;
    } catch (error) {
      if (error instanceof NapCatActionError) throw error;
      const offline = isHttpTransportOfflineError(error);
      if (offline) {
        markDisconnected(error?.message || 'NapCat HTTP action endpoint unavailable');
      } else {
        markConnected();
      }
      console.error(`[HTTP action] ${actionName} failed:`, error.message);
      throw new NapCatActionError(error?.message || `NapCat action ${actionName} failed`, {
        action: actionName,
        code: offline ? 'NAPCAT_OFFLINE' : '',
        status: error?.response?.status,
        data: offline ? getConnectionState() : error?.response?.data,
        offline,
        retryable: offline
      });
    } finally {
      pendingCount = Math.max(0, pendingCount - 1);
    }
  }

  return {
    callAction,
    getConnectionState,
    handleConnect: markConnected,
    handleMessage: () => false,
    handleDisconnect: markDisconnected,
    isConnected: () => connected,
    setWebSocket: () => {}
  };
}

module.exports = { createNapCatHttpActionClient, NapCatActionError, isHttpTransportOfflineError };
