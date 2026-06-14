const axios = require('axios');
const config = require('../config');

class NapCatActionError extends Error {
  constructor(message, options = {}) {
    super(String(message || 'NapCat action failed'));
    this.name = 'NapCatActionError';
    this.action = String(options.action || '').trim();
    this.status = String(options.status || '').trim();
    this.retcode = Number.isFinite(Number(options.retcode)) ? Number(options.retcode) : null;
    this.data = options.data;
  }
}

function createNapCatHttpActionClient() {
  const baseURL = 'http://127.0.0.1:3000';
  const secret = 'G57TTZpxzRKhYFA7';
  const timeout = config.NAPCAT_ACTION_TIMEOUT_MS || 30000;

  async function callAction(action, params = {}, options = {}) {
    const actionName = String(action || '').trim();
    if (!actionName) {
      throw new NapCatActionError('NapCat action name is required', { action: actionName });
    }

    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` };

    try {
      const actionTimeout = Math.max(1000, Number(options.timeoutMs || timeout) || timeout);
      const response = await axios.post(`${baseURL}/${actionName}`, params, { headers, timeout: actionTimeout });
      const data = response.data;

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
      console.error(`[HTTP action] ${actionName} failed:`, error.message);
      throw new NapCatActionError(error?.message || `NapCat action ${actionName} failed`, {
        action: actionName
      });
    }
  }

  function getConnectionState() {
    return {
      connected: true,
      readyState: null,
      readyStateName: 'http',
      pendingCount: null,
      connectedSince: 0,
      lastConnectedAt: 0,
      lastDisconnectedAt: 0,
      lastDisconnectReason: ''
    };
  }

  return {
    callAction,
    getConnectionState,
    handleConnect: () => {},
    handleMessage: () => false,
    handleDisconnect: () => {},
    isConnected: () => true,
    setWebSocket: () => {}
  };
}

module.exports = { createNapCatHttpActionClient, NapCatActionError };
