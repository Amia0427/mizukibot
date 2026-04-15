// Public shell only. Keep exports stable here, but route all runtime behavior
// through the facade/V2 host and keep compat helpers isolated from the shell.
const { askAIByGraph, askAIByGraphV1 } = require('./agentGraphFacade');
const {
  createPlanRuntime,
  extractStreamDelta,
  finalizePlanRuntime,
  looksLikeFailureReply,
  recordPlanRuntimeToolResult,
  shouldSuppressStreamMessage
} = require('./agentGraphCompat');

module.exports = {
  askAIByGraph,
  askAIByGraphV1,
  createPlanRuntime,
  extractStreamDelta,
  finalizePlanRuntime,
  looksLikeFailureReply,
  recordPlanRuntimeToolResult,
  shouldSuppressStreamMessage
};
