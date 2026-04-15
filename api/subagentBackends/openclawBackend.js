const config = require('../../config');
const { buildSessionId } = require('../subagentSessionManager');
const {
  askOpenclawByBridge,
  buildOpenclawArgs,
  createOpenclawBridgeCall,
  parseOpenclawReply,
  summarizeOpenclawFailure
} = require('../openclawExecutor');

function resolveOpenclawSessionId(userId = '', options = {}) {
  const explicitSessionId = String(options?.sessionId || '').trim();
  if (explicitSessionId) return explicitSessionId;
  return buildSessionId(userId, options);
}

function createBridgeCall(params = {}) {
  const options = params?.options && typeof params.options === 'object'
    ? {
        ...params.options,
        sessionId: resolveOpenclawSessionId(params?.userId, params?.options)
      }
    : {
        sessionId: resolveOpenclawSessionId(params?.userId, params?.options)
      };
  return createOpenclawBridgeCall(
    params?.question,
    params?.userInfo,
    params?.userId,
    params?.customPrompt,
    params?.imageUrl,
    options
  );
}

async function askByBridge(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  return askOpenclawByBridge(question, userInfo, userId, customPrompt, imageUrl, {
    ...options,
    sessionId: resolveOpenclawSessionId(userId, options)
  });
}

module.exports = {
  askByBridge,
  buildOpenclawArgs,
  createBridgeCall,
  parseOpenclawReply,
  resolveOpenclawSessionId,
  summarizeOpenclawFailure,
  backendName: String(config.SUBAGENT_BACKEND || 'openclaw').trim().toLowerCase() || 'openclaw'
};
