const config = require('../../config');
const {
  normalizeMessageContent,
  estimateMessagesTokens,
  trimTextByTokenBudget
} = require('../contextBudget');
const { getUserMemories, getUserProfile, getUserSummary, getUserImpression } = require('../memory');
const { retrieveRelevantMemories } = require('../vectorMemory');
const { getRecentSessionContextSummaries } = require('../sessionContextSummaryStore');
const {
  getShortTermCompressionSettings,
  getRecentTurnsMaxItems,
  getCompressionChunkMaxMessages,
  deriveActiveTopicFromTurn,
  normalizeConfidence,
  normalizeRecentTurns,
  defaultExpressionState,
  normalizeExpressionState,
  defaultModuleState,
  normalizeModuleState,
  defaultSceneState,
  normalizeSceneState,
  defaultInteractionState,
  normalizeInteractionState,
  defaultShortTermPresence,
  normalizeShortTermPresence,
  defaultShortTermState,
  normalizeShortTermState,
  resolveShortTermSceneKey,
  resolveShortTermSessionKey,
  resolveShortTermScope,
  ensureShortTermMemoryState,
  getShortTermPresence,
  updateShortTermPresence
} = require('./state');
const {
  buildSharedShortTermContextMessages: buildSharedShortTermContextMessagesBase,
  buildSharedShortTermSignature,
  normalizeHistoryMessages
} = require('./sharedContext');
const { createShortTermCompressionHelpers } = require('./compression');
const { createShortTermContinuityDeltaHelpers } = require('./continuityDelta');
const { createShortTermRestartRecallHelpers } = require('./restartRecall');
const { createShortTermSummaryHelpers } = require('./summaries');

const {
  buildHistorySummaryMessage,
  buildSessionSummaryMessages,
  buildStructuredSummaryText,
  filterSessionSummariesForFirstTurn,
  isContinuityDuplicate,
  normalizeContinuityText
} = createShortTermSummaryHelpers({
  config,
  getRecentSessionContextSummaries,
  normalizeExpressionState,
  normalizeInteractionState,
  normalizeModuleState,
  normalizeSceneState,
  normalizeShortTermState,
  trimTextByTokenBudget
});

const {
  applyPersonaContinuityDelta,
  deriveShortTermFieldsFromContinuity
} = createShortTermContinuityDeltaHelpers({
  buildStructuredSummaryText,
  config,
  normalizeConfidence,
  normalizeExpressionState,
  normalizeInteractionState,
  normalizeModuleState,
  normalizeRecentTurns,
  normalizeSceneState,
  normalizeShortTermState
});

const { rehydrateShortTermMemoryAfterRestartIfNeeded } = createShortTermRestartRecallHelpers({
  config,
  ensureShortTermMemoryState,
  getShortTermCompressionSettings,
  getUserImpression,
  getUserMemories,
  getUserProfile,
  getUserSummary,
  resolveShortTermSessionKey,
  retrieveRelevantMemories,
  trimTextByTokenBudget
});

function buildSharedShortTermContextMessages(userId, userInfo = {}, deps = {}) {
  return buildSharedShortTermContextMessagesBase(userId, userInfo, {
    ...deps,
    buildStructuredSummaryText,
    buildHistorySummaryMessage,
    buildSessionSummaryMessages
  });
}

const {
  buildStructuredCompressionPrompt,
  compressShortTermHistoryIfNeeded,
  parseStructuredCompressionOutput
} = createShortTermCompressionHelpers({
  config,
  defaultShortTermState,
  ensureShortTermMemoryState,
  estimateMessagesTokens,
  getCompressionChunkMaxMessages,
  getShortTermCompressionSettings,
  normalizeMessageContent,
  normalizeShortTermState,
  resolveShortTermSessionKey,
  trimTextByTokenBudget,
  applyPersonaContinuityDelta
});

function buildShortTermContextMessages(userId, userInfo = {}, deps = {}) {
  return buildSharedShortTermContextMessages(userId, userInfo, deps);
}

function appendShortTermHistory(userId, userContent, assistantContent, userInfo = {}, deps = {}) {
  const key = String(deps.sessionKey || resolveShortTermSessionKey(userId, deps.routeMeta) || '').trim();
  const historyStore = deps.chatHistory || {};
  if (!historyStore[key]) historyStore[key] = [];

  historyStore[key].push({ role: 'user', content: userContent });
  historyStore[key].push({ role: 'assistant', content: assistantContent });

  const settings = getShortTermCompressionSettings(userInfo, { userId: String(userId || '').trim() });
  const maxKeep = settings.affinity.highAffinity
    ? Math.max(settings.reserveRecentMessages + 12, Number(config.MAX_HISTORY || 15) * 8)
    : Math.max(settings.reserveRecentMessages + 6, Number(config.MAX_HISTORY || 15) * 3);

  if (historyStore[key].length > maxKeep) {
    historyStore[key] = historyStore[key].slice(-maxKeep);
  }

  const state = ensureShortTermMemoryState(key, deps.shortTermMemory);
  const turnTopic = deriveActiveTopicFromTurn(userContent, assistantContent);
  state.carryOverUserTurn = '';
  state.interaction = normalizeInteractionState({
    ...state.interaction,
    activeTopic: turnTopic || state.interaction?.activeTopic || state.activeTopic,
    carryOverUserTurn: '',
    recentTurns: normalizeRecentTurns(
      [...(state.interaction?.recentTurns || []), { role: 'user', content: userContent }, { role: 'assistant', content: assistantContent }],
      getRecentTurnsMaxItems()
    )
  });
  state.activeTopic = state.interaction.activeTopic || state.activeTopic;
  state.expression = normalizeExpressionState(state.expression);
  state.moduleState = normalizeModuleState(state.moduleState);

  return historyStore[key];
}

module.exports = {
  defaultShortTermState,
  normalizeShortTermState,
  defaultShortTermPresence,
  normalizeShortTermPresence,
  resolveShortTermSessionKey,
  resolveShortTermScope,
  ensureShortTermMemoryState,
  getShortTermPresence,
  updateShortTermPresence,
  buildHistorySummaryMessage,
  buildSessionSummaryMessages,
  normalizeContinuityText,
  isContinuityDuplicate,
  filterSessionSummariesForFirstTurn,
  buildStructuredSummaryText,
  buildStructuredCompressionPrompt,
  parseStructuredCompressionOutput,
  compressShortTermHistoryIfNeeded,
  buildSharedShortTermContextMessages,
  buildShortTermContextMessages,
  appendShortTermHistory,
  getShortTermCompressionSettings,
  rehydrateShortTermMemoryAfterRestartIfNeeded,
  buildSharedShortTermSignature,
  resolveShortTermSceneKey,
  defaultInteractionState,
  normalizeInteractionState,
  defaultSceneState,
  normalizeSceneState,
  defaultExpressionState,
  normalizeExpressionState,
  defaultModuleState,
  normalizeModuleState,
  deriveShortTermFieldsFromContinuity,
  applyPersonaContinuityDelta
};
