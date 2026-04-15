const config = require('../config');
const { askAIByGraphV2 } = require('./agentGraphV2');

let warnedRuntimeVersion = false;
let warnedRetiredV1 = false;

function warnLegacyRuntimeVersionOnce() {
  if (warnedRuntimeVersion) return;
  warnedRuntimeVersion = true;
  if (Number(config.LANGGRAPH_RUNTIME_VERSION) === 2) return;
  console.warn('[langgraph] LANGGRAPH_RUNTIME_VERSION is now a no-op; V2 runtime is always used.', {
    configured: Number(config.LANGGRAPH_RUNTIME_VERSION)
  });
}

function warnRetiredV1Once() {
  if (warnedRetiredV1) return;
  warnedRetiredV1 = true;
  console.warn('[langgraph] V1 retired, forwarded to V2');
}

// Public facade keeps the old signature stable while making V2 the only host.
async function askAIByGraph(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  warnLegacyRuntimeVersionOnce();
  return askAIByGraphV2(question, userInfo, userId, customPrompt, imageUrl, options);
}

async function askAIByGraphV1(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  warnLegacyRuntimeVersionOnce();
  warnRetiredV1Once();
  return askAIByGraphV2(question, userInfo, userId, customPrompt, imageUrl, options);
}

module.exports = {
  askAIByGraph,
  askAIByGraphV1
};
