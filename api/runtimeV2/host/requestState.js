const { normalizeToolNames } = require('../../../utils/localToolAccess');
const { shouldUseMinecraftLLM, getMinecraftModelOverrides } = require('../../../utils/minecraftRouting');
const { resolveThreadId } = require('../../../utils/langgraphV2Store');
const {
  resolveShortTermSessionKey,
  resolveShortTermScope
} = require('../../../utils/shortTermMemory');
const { createMemoryCliTurnState } = require('../../../utils/memoryCliTurnPolicy');
const { createInitialState: createInitialStateBase } = require('../state');
const {
  nowTs,
  normalizeObject,
  normalizeArray,
  buildLatencyDecision
} = require('./runtimeHelpers');

function isWriteLikeCapability(capability = '') {
  return /write/i.test(String(capability || ''));
}

function isSideEffectPolicy(policy = {}) {
  return isWriteLikeCapability(policy.capability) || String(policy.risk || '').trim().toLowerCase() === 'high';
}

function createInitialState(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  const normalizedOptions = normalizeObject(options, {});
  const latencyDecision = buildLatencyDecision({
    question,
    runtimeQuestionText: question,
    routeMeta: normalizedOptions.routeMeta,
    topRouteType: normalizedOptions.topRouteType,
    routePolicyKey: normalizedOptions.routePolicyKey,
    allowedTools: normalizedOptions.allowedTools,
    allowTools: normalizedOptions.disableTools ? false : true,
    systemInitiated: normalizedOptions.systemInitiated,
    deferPersist: normalizedOptions.deferPersist
  }, normalizedOptions);
  return createInitialStateBase(question, userInfo, userId, customPrompt, imageUrl, {
    ...normalizedOptions,
    resolveThreadId,
    resolveShortTermSessionKey,
    resolveShortTermScope,
    normalizeToolNames,
    shouldUseMinecraftLLM,
    getMinecraftModelOverrides,
    createMemoryCliTurnState,
    nowTs,
    latencyDecision
  });
}

function normalizeMode(request = {}) {
  const topRouteType = String(request.topRouteType || request.routeMeta?.topRouteType || '').trim().toLowerCase();
  const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
  if (request.systemInitiated || topRouteType === 'proactive' || routePolicyKey === 'proactive/default') return 'proactive';
  if (String(request.reviewMode || '').trim()) return 'review';
  if (request.imageUrl) return 'image';
  if (request.useMinecraftModel) return 'minecraft';
  return normalizeArray(request.allowedTools).length > 0 && request.allowTools !== false ? 'agent' : 'chat';
}

module.exports = {
  isSideEffectPolicy,
  createInitialState,
  normalizeMode
};
