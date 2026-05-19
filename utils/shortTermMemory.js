const config = require('../config');
const {
  normalizeMessageContent,
  estimateMessagesTokens,
  trimTextByTokenBudget
} = require('./contextBudget');
const { getUserMemories, getUserProfile, getUserSummary, getUserImpression } = require('./memory');
const { retrieveRelevantMemories } = require('./vectorMemory');
const { getRecentSessionContextSummaries } = require('./sessionContextSummaryStore');
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
} = require('./shortTermMemory/state');
const {
  buildSharedShortTermContextMessages: buildSharedShortTermContextMessagesBase,
  buildSharedShortTermSignature,
  normalizeHistoryMessages
} = require('./shortTermMemory/sharedContext');
const { createShortTermCompressionHelpers } = require('./shortTermMemory/compression');

function deriveShortTermSummaryFromContinuity(state = {}) {
  const normalized = normalizeShortTermState(state);
  return buildStructuredSummaryText({
    summary: normalized.summary,
    activeTopic: normalized.interaction.activeTopic || normalized.activeTopic,
    openLoops: normalized.interaction.openLoops.length > 0 ? normalized.interaction.openLoops : normalized.openLoops,
    assistantCommitments: normalized.interaction.assistantCommitments.length > 0 ? normalized.interaction.assistantCommitments : normalized.assistantCommitments,
    userConstraints: normalized.interaction.userConstraints.length > 0 ? normalized.interaction.userConstraints : normalized.userConstraints,
    recentToolResults: normalized.recentToolResults,
    carryOverUserTurn: normalized.interaction.carryOverUserTurn || normalized.carryOverUserTurn
  }, Math.max(96, Number(config.SHORT_TERM_MEMORY_SUMMARY_MAX_TOKENS || 320)));
}

function deriveShortTermFieldsFromContinuity(state = {}) {
  const normalized = normalizeShortTermState(state);
  return {
    activeTopic: normalized.interaction.activeTopic || normalized.activeTopic,
    carryOverUserTurn: normalized.interaction.carryOverUserTurn || normalized.carryOverUserTurn,
    openLoops: normalized.interaction.openLoops.length > 0 ? normalized.interaction.openLoops : normalized.openLoops,
    assistantCommitments: normalized.interaction.assistantCommitments.length > 0 ? normalized.interaction.assistantCommitments : normalized.assistantCommitments,
    userConstraints: normalized.interaction.userConstraints.length > 0 ? normalized.interaction.userConstraints : normalized.userConstraints,
    phaseHint: normalized.interaction.phaseHint || normalized.phaseHint,
    sceneRef: normalized.scene.sceneKey || normalized.sceneRef,
    confidence: normalized.confidence,
    summary: normalized.summary || deriveShortTermSummaryFromContinuity(normalized),
    summarySource: normalized.summarySource || (normalized.summary ? 'continuity' : '')
  };
}

function applyPersonaContinuityDelta(targetState = {}, delta = {}) {
  const current = normalizeShortTermState(targetState);
  const patch = delta && typeof delta === 'object' ? delta : {};
  const nextInteraction = normalizeInteractionState({
    ...current.interaction,
    ...(patch.interaction && typeof patch.interaction === 'object' ? patch.interaction : {}),
    activeTopic: patch.activeTopic || patch.interaction?.activeTopic || current.interaction.activeTopic,
    carryOverUserTurn: patch.carryOverUserTurn || patch.interaction?.carryOverUserTurn || current.interaction.carryOverUserTurn,
    openLoops: patch.openLoops || patch.interaction?.openLoops || current.interaction.openLoops,
    assistantCommitments: patch.assistantCommitments || patch.interaction?.assistantCommitments || current.interaction.assistantCommitments,
    userConstraints: patch.userConstraints || patch.interaction?.userConstraints || current.interaction.userConstraints,
    recentTurns: patch.recentTurns || patch.interaction?.recentTurns || current.interaction.recentTurns,
    phaseHint: patch.phaseHint || patch.interaction?.phaseHint || current.interaction.phaseHint,
    sourceFlags: patch.sourceFlags || patch.interaction?.sourceFlags || current.interaction.sourceFlags,
    confidence: patch.confidence ?? patch.interaction?.confidence ?? current.interaction.confidence
  });
  const nextScene = normalizeSceneState({
    ...current.scene,
    ...(patch.scene && typeof patch.scene === 'object' ? patch.scene : {}),
    sceneKey: patch.sceneRef || patch.sceneKey || patch.scene?.sceneKey || current.scene.sceneKey,
    activeTopic: patch.scene?.activeTopic || current.scene.activeTopic,
    recentTurns: patch.scene?.recentTurns || current.scene.recentTurns,
    confidence: patch.scene?.confidence ?? current.scene.confidence
  });
  const nextExpression = normalizeExpressionState({
    ...current.expression,
    ...(patch.expression && typeof patch.expression === 'object' ? patch.expression : {}),
    replyPosture: patch.replyPosture || patch.expression?.replyPosture || current.expression.replyPosture,
    warmth: patch.warmth || patch.expression?.warmth || current.expression.warmth,
    guardedness: patch.guardedness || patch.expression?.guardedness || current.expression.guardedness,
    initiative: patch.initiative || patch.expression?.initiative || current.expression.initiative,
    jargonMode: patch.jargonMode || patch.expression?.jargonMode || current.expression.jargonMode,
    cadenceHint: patch.cadenceHint || patch.expression?.cadenceHint || current.expression.cadenceHint,
    styleAnchors: patch.styleAnchors || patch.expression?.styleAnchors || current.expression.styleAnchors,
    confidence: patch.expression?.confidence ?? current.expression.confidence
  });
  const nextModuleState = normalizeModuleState({
    ...current.moduleState,
    ...(patch.moduleState && typeof patch.moduleState === 'object' ? patch.moduleState : {}),
    activePersonaModules: patch.activePersonaModules || patch.moduleState?.activePersonaModules || current.moduleState.activePersonaModules,
    switchReason: patch.switchReason || patch.moduleState?.switchReason || current.moduleState.switchReason
  });

  const next = normalizeShortTermState({
    ...current,
    ...patch,
    interaction: nextInteraction,
    scene: nextScene,
    expression: nextExpression,
    moduleState: nextModuleState,
    phaseHint: nextInteraction.phaseHint || current.phaseHint,
    sceneRef: nextScene.sceneKey || current.sceneRef,
    confidence: Math.max(
      normalizeConfidence(patch.confidence, current.confidence),
      nextInteraction.confidence,
      nextExpression.confidence,
      nextScene.confidence
    )
  });
  const derived = deriveShortTermFieldsFromContinuity(next);
  return normalizeShortTermState({
    ...next,
    ...derived
  });
}

function joinProfileValues(values = [], limit = 4) {
  return (Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, Math.max(1, Number(limit) || 1))
    .join(', ');
}

function compactFactTextForRecall(factText, maxLines = 4) {
  const lines = String(factText || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .slice(0, Math.max(1, Number(maxLines) || 1));

  return lines.join(' | ');
}

function buildRestartRecallSummary(userId, question = '', userInfo = {}, options = {}) {
  const key = String(userId || '').trim();
  if (!key) return { summary: '', hitCount: 0 };

  const settings = getShortTermCompressionSettings(userInfo, { userId: key });
  const profile = getUserProfile(key) || {};
  const summary = String(getUserSummary(key) || '').trim();
  const impression = String(getUserImpression(key) || '').trim();
  const factText = String(getUserMemories(key) || '').trim();
  const hits = retrieveRelevantMemories(
    key,
    String(question || '').trim(),
    Number(options.topK || config.MEMORY_RAG_TOP_K || 8),
    {
      scopeType: 'personal',
      trackAccess: false
    }
  );

  const sections = [];
  const relevantHitTexts = hits
    .map((item) => trimTextByTokenBudget(String(item?.text || '').trim(), 80, 'tail'))
    .filter(Boolean)
    .slice(0, 4);

  if (relevantHitTexts.length > 0) {
    sections.push(`[RelevantRecall] ${relevantHitTexts.join(' | ')}`);
  }

  if (summary) {
    sections.push(`[KnownSummary] ${trimTextByTokenBudget(summary, 110, 'tail')}`);
  }

  if (impression) {
    sections.push(`[KnownImpression] ${trimTextByTokenBudget(impression, 90, 'tail')}`);
  }

  const identities = joinProfileValues(profile.identities, 4);
  if (identities) sections.push(`[Identity] ${identities}`);

  const likes = joinProfileValues(profile.likes, 4);
  if (likes) sections.push(`[Likes] ${likes}`);

  const dislikes = joinProfileValues(profile.dislikes, 3);
  if (dislikes) sections.push(`[Dislikes] ${dislikes}`);

  const goals = joinProfileValues(profile.goals, 4);
  if (goals) sections.push(`[Goals] ${goals}`);

  const recentTopics = joinProfileValues(profile.recent_topics, 4);
  if (recentTopics) sections.push(`[RecentTopics] ${recentTopics}`);

  const facts = compactFactTextForRecall(factText === '目前没有特别记忆。' ? '' : factText, 4);
  if (facts) sections.push(`[KnownFacts] ${facts}`);

  const summaryText = trimTextByTokenBudget(
    sections.join('\n'),
    settings.summaryMaxTokens,
    'tail'
  );

  return {
    summary: summaryText,
    hitCount: relevantHitTexts.length
  };
}

function shouldAttemptRestartRecall(userId, deps = {}) {
  const key = String(deps.sessionKey || '').trim();
  const uid = String(userId || '').trim();
  if (!uid || !key) return false;
  if (!config.RESTART_RECALL_ENABLED) return false;

  const historyStore = deps.chatHistory || {};
  const history = Array.isArray(historyStore[key]) ? historyStore[key] : [];
  if (history.length > 0) return false;

  const state = ensureShortTermMemoryState(key, deps.shortTermMemory);
  if (String(state.summary || '').trim()) return false;

  return true;
}

function rehydrateShortTermMemoryAfterRestartIfNeeded(userId, question = '', userInfo = {}, deps = {}) {
  const uid = String(userId || '').trim();
  const sessionKey = String(deps.sessionKey || resolveShortTermSessionKey(uid, deps.routeMeta) || '').trim();
  if (!shouldAttemptRestartRecall(uid, { ...deps, sessionKey })) {
    return { rehydrated: false, hitCount: 0, summaryLength: 0 };
  }

  const state = ensureShortTermMemoryState(sessionKey, deps.shortTermMemory);
  const reconstructed = buildRestartRecallSummary(uid, question, userInfo, deps);
  const summaryText = String(reconstructed.summary || '').trim();
  if (!summaryText) {
    if (config.ENABLE_DEBUG_LOG) {
      console.log('[memory] restart recall skipped: no personal memory to restore', {
        userId: uid,
        sessionKey
      });
    }
    return { rehydrated: false, hitCount: Number(reconstructed.hitCount || 0) || 0, summaryLength: 0 };
  }

  state.summary = summaryText;
  state.summarySource = 'restart_recall';
  state.lastCompressedAt = Date.now();

  if (config.ENABLE_DEBUG_LOG) {
    console.log('[memory] restart recall restored short-term summary', {
      userId: uid,
      sessionKey,
      hits: Number(reconstructed.hitCount || 0) || 0,
      summaryLength: summaryText.length
    });
  }

  return {
    rehydrated: true,
    hitCount: Number(reconstructed.hitCount || 0) || 0,
    summaryLength: summaryText.length
  };
}

function buildStructuredSummaryText(shortTermState, summaryTokens) {
  const state = normalizeShortTermState(shortTermState);
  const interaction = normalizeInteractionState(state.interaction);
  const expression = normalizeExpressionState(state.expression);
  const moduleState = normalizeModuleState(state.moduleState);
  const scene = normalizeSceneState(state.scene);
  const sections = [];

  if (interaction.carryOverUserTurn || state.carryOverUserTurn) {
    sections.push(`[UnresolvedUserTurn] ${interaction.carryOverUserTurn || state.carryOverUserTurn}`);
  }
  if (interaction.activeTopic || state.activeTopic) {
    sections.push(`[ActiveTopic] ${interaction.activeTopic || state.activeTopic}`);
  }
  if (interaction.openLoops.length > 0 || state.openLoops.length > 0) {
    sections.push(`[OpenLoops] ${(interaction.openLoops.length > 0 ? interaction.openLoops : state.openLoops).join(' | ')}`);
  }
  if (interaction.assistantCommitments.length > 0 || state.assistantCommitments.length > 0) {
    sections.push(`[AssistantCommitments] ${(interaction.assistantCommitments.length > 0 ? interaction.assistantCommitments : state.assistantCommitments).join(' | ')}`);
  }
  if (interaction.userConstraints.length > 0 || state.userConstraints.length > 0) {
    sections.push(`[UserConstraints] ${(interaction.userConstraints.length > 0 ? interaction.userConstraints : state.userConstraints).join(' | ')}`);
  }
  if (state.recentToolResults.length > 0) {
    sections.push(`[RecentToolResults] ${state.recentToolResults.join(' | ')}`);
  }
  if (expression.replyPosture) {
    sections.push(`[ReplyPosture] ${expression.replyPosture}`);
  }
  if (expression.styleAnchors.length > 0) {
    sections.push(`[StyleAnchors] ${expression.styleAnchors.join(' | ')}`);
  }
  if (moduleState.activePersonaModules.length > 0) {
    sections.push(`[ActivePersonaModules] ${moduleState.activePersonaModules.join(' | ')}`);
  }
  if (scene.activeTopic) {
    sections.push(`[SceneTopic] ${scene.activeTopic}`);
  }
  if (state.summary) {
    sections.push(`[Summary] ${state.summary}`);
  }

  return trimTextByTokenBudget(sections.join('\n'), summaryTokens, 'tail');
}

function buildHistorySummaryMessage(summaryText, summaryTokens) {
  const text = trimTextByTokenBudget(String(summaryText || '').trim(), summaryTokens, 'tail');
  if (!text) return null;

  return {
    role: 'system',
    content: [
      '[ShortTermSummary]',
      'Compressed summary of earlier conversation. Treat this as recent context, not long-term memory.',
      text
    ].join('\n')
  };
}

function normalizeContinuityText(text = '') {
  return String(text || '')
    .replace(/^\s*\d+\.\s*/gm, '')
    .replace(/^\s*\[[^\]\n]+\]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildSharedShortTermContextMessages(userId, userInfo = {}, deps = {}) {
  return buildSharedShortTermContextMessagesBase(userId, userInfo, {
    ...deps,
    buildStructuredSummaryText,
    buildHistorySummaryMessage,
    buildSessionSummaryMessages
  });
}

function isContinuityDuplicate(candidate = '', baseline = '') {
  const normalizedCandidate = normalizeContinuityText(candidate);
  const normalizedBaseline = normalizeContinuityText(baseline);
  if (!normalizedCandidate || !normalizedBaseline) return false;
  if (normalizedCandidate === normalizedBaseline) return true;

  const shorterLength = Math.min(normalizedCandidate.length, normalizedBaseline.length);
  if (shorterLength < 18) return false;

  return normalizedBaseline.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedBaseline);
}

function filterSessionSummariesForFirstTurn(items = [], dedupeAgainstText = '') {
  const list = Array.isArray(items) ? items : [];
  const filtered = [];
  const seen = new Set();

  for (const item of list) {
    const summary = String(item?.summary || '').trim();
    const normalizedSummary = normalizeContinuityText(summary);
    if (!summary || !normalizedSummary || seen.has(normalizedSummary)) continue;
    if (isContinuityDuplicate(summary, dedupeAgainstText)) continue;
    seen.add(normalizedSummary);
    filtered.push(item);
  }

  return filtered;
}

function buildSessionSummaryMessages(
  sessionKey = '',
  history = [],
  loadCount = config.SESSION_CONTEXT_SUMMARY_LOAD_COUNT,
  options = {}
) {
  const key = String(sessionKey || '').trim();
  const existingHistory = Array.isArray(history) ? history : [];
  if (!key || existingHistory.length > 0) {
    return {
      sessionSummaryMessages: [],
      recentSessionSummaries: []
    };
  }

  const recentSessionSummaries = getRecentSessionContextSummaries(key, { limit: loadCount });
  const filteredSessionSummaries = filterSessionSummariesForFirstTurn(
    recentSessionSummaries,
    options.dedupeAgainstText
  );
  if (filteredSessionSummaries.length === 0) {
    return {
      sessionSummaryMessages: [],
      recentSessionSummaries: []
    };
  }

  const content = [
    '[RecentSessionSummaries]',
    'Recent restart-recovery summaries for this exact session. Treat them as high-priority continuity context for the first turn after restart.',
    ...filteredSessionSummaries.map((item, index) => `${index + 1}. ${String(item.summary || '').trim()}`)
  ].join('\n');

  return {
    sessionSummaryMessages: [{ role: 'system', content }],
    recentSessionSummaries: filteredSessionSummaries
  };
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
