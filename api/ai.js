// Compat barrel only. Runtime ownership moved to the V2 host; keep helper
// imports stable here so older callers/tests do not need to know the new paths.
const { askAIByGraph } = require('./agentGraphFacade');
const {
  buildDynamicPrompt,
  buildVisionMessageContent,
  mergeAllowedToolsWithMemoryCli,
  shouldExposeMemoryCli,
  shouldBypassHumanizerForPolicy
} = require('./graphPrompting');
const {
  buildPlan,
  sanitizePlan,
  fallbackReplyPlan,
  synthesizeFromPlan,
  getPlannerModelName,
  getPlannerTemperature,
  getPlannerApiBaseUrl,
  getPlannerApiKey,
  shouldUsePlanModeForRequest,
  executePlan,
  executePlanLoop
} = require('./graphPlanning');
const {
  requestStreamingReply,
  requestNonStreamingReply,
  finalizeStreamingReplyWithHumanizer,
  shouldUseStreamingReply
} = require('./graphModelIO');
const { drawPicture } = require('./imageGeneration');
const { getLatestReasoning } = require('./parser');
const { learnSomethingNew } = require('./memoryExtraction');

async function askAI(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  return askAIByGraph(question, userInfo, userId, customPrompt, imageUrl, options);
}

module.exports = {
  askAI,
  drawPicture,
  learnSomethingNew,
  getLatestReasoning,
  buildVisionMessageContent,
  shouldUseStreamingReply,
  shouldUsePlanModeForRequest,
  getPlannerModelName,
  getPlannerTemperature,
  getPlannerApiBaseUrl,
  getPlannerApiKey,
  fallbackReplyPlan,
  sanitizePlan,
  buildPlan,
  buildDynamicPrompt,
  executePlan,
  executePlanLoop,
  synthesizeFromPlan,
  requestStreamingReply,
  finalizeStreamingReplyWithHumanizer,
  requestNonStreamingReply,
  mergeAllowedToolsWithMemoryCli,
  shouldExposeMemoryCli,
  shouldBypassHumanizerForPolicy
};
