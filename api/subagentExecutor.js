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
const pendingSubagentRuns = [];

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

  return {
    promise: Promise.resolve(bridgeCall.promise).finally(() => {
      release();
    }),
    cancel(reason = 'cancelled') {
      return typeof bridgeCall?.cancel === 'function'
        ? bridgeCall.cancel(reason)
        : reason;
    }
  };
}

async function askSubagentByBridge(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  if (resolveBackendNameForOptions(options) === 'openclaw') {
    return askOpenclawByBridge(question, userInfo, userId, customPrompt, imageUrl, options);
  }
  const call = await startSubagentBridgeCall(question, userInfo, userId, customPrompt, imageUrl, options);
  return call.promise;
}

module.exports = {
  askSubagentByBridge,
  buildForwardPrompt,
  buildSessionId,
  createBridgeCall,
  finalizeSubagentResult,
  parseSubagentReply,
  startSubagentBridgeCall
};
