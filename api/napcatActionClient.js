const { createNapCatHttpActionClient, NapCatActionError } = require('./napcatHttpActionClient');

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
    || /NapCat (websocket|action client) is not connected/i.test(message)
    || /NapCat websocket (closed|disconnected|replaced|cleared)/i.test(message);
}

let singletonClient = null;

function getNapCatActionClient() {
  if (!singletonClient) {
    singletonClient = createNapCatHttpActionClient();
  }
  return singletonClient;
}

module.exports = {
  NapCatActionError,
  getActionClientConnectionState,
  getNapCatActionClient,
  isActionClientConnected,
  isNapCatOfflineError
};
