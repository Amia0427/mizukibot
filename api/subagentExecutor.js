const config = require('../config');
const {
  buildForwardPrompt,
  createCommandBridgeCall,
  finalizeSubagentResult,
  parseSubagentReply
} = require('./subagentBackends/commandBackend');
const { createGatewayBridgeCall } = require('./subagentBackends/gatewayBackend');
const {
  askByBridge: askOpenclawByBridge,
  createBridgeCall: createOpenclawBridgeCall
} = require('./subagentBackends/openclawBackend');
const { createHapiBridgeCall } = require('./subagentBackends/hapiBackend');
const { buildSessionId } = require('./subagentSessionManager');

const SUBAGENT_MAX_CONCURRENCY = Math.max(1, Number(config.SUBAGENT_MAX_CONCURRENCY) || 2);
let activeSubagentRuns = 0;
let shuttingDown = false;
const pendingSubagentRuns = [];
const activeBridgeCalls = new Set();

function resolveBackendName() {
  return String(config.SUBAGENT_BACKEND || 'command').trim().toLowerCase() || 'command';
}

function resolveBackendNameForOptions(options = {}) {
  const override = String(options?.backendOverride || '').trim().toLowerCase();
  if (override) return override;
  return resolveBackendName();
}

function acquireSubagentSlot() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (shuttingDown) {
        resolve(null);
        return;
      }
      if (activeSubagentRuns < SUBAGENT_MAX_CONCURRENCY) {
        activeSubagentRuns += 1;
        resolve(() => {
          activeSubagentRuns = Math.max(0, activeSubagentRuns - 1);
          const next = pendingSubagentRuns.shift();
          if (typeof next === 'function') next();
        });
        return;
      }

      pendingSubagentRuns.push(tryAcquire);
    };

    tryAcquire();
  });
}

function createBridgeCall(params = {}) {
  const backend = resolveBackendNameForOptions(params?.options);
  const sessionId = buildSessionId(params?.userId, params?.options);
  const normalizedParams = {
    ...params,
    sessionId
  };

  if (backend === 'command') {
    return createCommandBridgeCall(normalizedParams);
  }
  if (backend === 'openclaw') {
    return createOpenclawBridgeCall(normalizedParams);
  }
  if (backend === 'gateway') {
    return createGatewayBridgeCall(normalizedParams);
  }
  if (backend === 'hapi') {
    return createHapiBridgeCall(normalizedParams);
  }

  throw new Error(`unsupported SUBAGENT_BACKEND: ${backend}`);
}

async function startSubagentBridgeCall(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  const release = await acquireSubagentSlot();
  if (!release) {
    const error = new Error('subagent executor is shutting down');
    error.code = 'SUBAGENT_SHUTTING_DOWN';
    throw error;
  }
  let bridgeCall = null;

  try {
    bridgeCall = createBridgeCall({
      question,
      userInfo,
      userId,
      customPrompt,
      imageUrl,
      options
    });
  } catch (error) {
    release();
    throw error;
  }

  const trackedCall = {
    mode: String(bridgeCall?.mode || '').trim(),
    cancel(reason = 'cancelled') {
      return typeof bridgeCall?.cancel === 'function'
        ? bridgeCall.cancel(reason)
        : reason;
    }
  };
  activeBridgeCalls.add(trackedCall);

  return {
    promise: Promise.resolve(bridgeCall.promise).finally(() => {
      activeBridgeCalls.delete(trackedCall);
      release();
    }),
    cancel(reason = 'cancelled') {
      activeBridgeCalls.delete(trackedCall);
      return trackedCall.cancel(reason);
    }
  };
}

async function askSubagentByBridge(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  if (shuttingDown) {
    const error = new Error('subagent executor is shutting down');
    error.code = 'SUBAGENT_SHUTTING_DOWN';
    throw error;
  }
  if (resolveBackendNameForOptions(options) === 'openclaw') {
    return askOpenclawByBridge(question, userInfo, userId, customPrompt, imageUrl, options);
  }
  const call = await startSubagentBridgeCall(question, userInfo, userId, customPrompt, imageUrl, options);
  return call.promise;
}

function shutdownSubagentExecutor(reason = 'shutdown') {
  shuttingDown = true;
  while (pendingSubagentRuns.length > 0) {
    const next = pendingSubagentRuns.shift();
    if (typeof next === 'function') {
      try { next(); } catch (_) {}
    }
  }

  let cancelled = 0;
  for (const call of Array.from(activeBridgeCalls)) {
    try {
      call.cancel(reason);
      cancelled += 1;
    } catch (_) {}
    activeBridgeCalls.delete(call);
  }

  try {
    const commandBackend = require('./subagentBackends/commandBackend');
    if (typeof commandBackend.shutdownCommandBackend === 'function') {
      commandBackend.shutdownCommandBackend(reason);
    } else if (typeof commandBackend.resetPersistentWorkerState === 'function') {
      commandBackend.resetPersistentWorkerState();
    }
  } catch (_) {}
  try {
    const { shutdownOpenclawExecutor } = require('./openclawExecutor');
    if (typeof shutdownOpenclawExecutor === 'function') {
      shutdownOpenclawExecutor(reason);
    }
  } catch (_) {}

  console.log('[subagent] shutdown requested', {
    activeSubagentRuns,
    cancelled,
    reason: String(reason || '').trim() || 'shutdown'
  });

  return {
    activeSubagentRuns,
    cancelled
  };
}

function resetSubagentExecutorForTest() {
  shuttingDown = false;
  activeSubagentRuns = 0;
  pendingSubagentRuns.length = 0;
  activeBridgeCalls.clear();
}

module.exports = {
  askSubagentByBridge,
  buildForwardPrompt,
  buildSessionId,
  createBridgeCall,
  finalizeSubagentResult,
  parseSubagentReply,
  resetSubagentExecutorForTest,
  shutdownSubagentExecutor,
  startSubagentBridgeCall
};
