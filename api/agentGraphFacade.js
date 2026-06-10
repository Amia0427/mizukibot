const config = require('../config');
const { askAIByGraphV2 } = require('./agentGraphV2');

let warnedRuntimeVersion = false;

function warnLegacyRuntimeVersionOnce() {
  if (warnedRuntimeVersion) return;
  warnedRuntimeVersion = true;
  if (!process.env.LANGGRAPH_RUNTIME_VERSION) return;
  console.warn('[langgraph] LANGGRAPH_RUNTIME_VERSION is now a no-op; V2 runtime is always used.', {
    configured: String(process.env.LANGGRAPH_RUNTIME_VERSION || '').trim()
  });
}

// Public facade keeps the old signature stable while making V2 the only host.
async function askAIByGraph(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  warnLegacyRuntimeVersionOnce();
  return askAIByGraphV2(question, userInfo, userId, customPrompt, imageUrl, options);
}

async function askAIByGraphV1(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  warnLegacyRuntimeVersionOnce();
  return askAIByGraphV2(question, userInfo, userId, customPrompt, imageUrl, options);
}

module.exports = {
  askAIByGraph,
  askAIByGraphV1
};
