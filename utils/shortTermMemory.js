const config = require('../config');
const {
  normalizeMessageContent,
  estimateMessagesTokens,
  estimateTokens,
  getAffinitySettings,
  trimMessagesByTokenBudget,
  trimTextByTokenBudget
} = require('./contextBudget');
const { getUserMemories, getUserProfile, getUserSummary, getUserImpression } = require('./memory');
const { retrieveRelevantMemories } = require('./vectorMemory');
const { getRecentSessionContextSummaries } = require('./sessionContextSummaryStore');

function getShortTermCompressionSettings(userInfo = {}, options = {}) {
  const affinity = getAffinitySettings(userInfo, { userId: options.userId });
  const reserveRecentMessages = Math.max(
    2,
    Number(config.SHORT_TERM_MEMORY_RECENT_MESSAGES || config.MAX_HISTORY || 15)
  );
  const summaryMaxTokens = Math.max(96, Number(config.SHORT_TERM_MEMORY_SUMMARY_MAX_TOKENS || 320));
  const triggerRatio = Math.min(
    0.98,
    Math.max(0.3, Number(config.SHORT_TERM_MEMORY_COMPRESSION_TRIGGER_RATIO || 0.7))
  );
  const maxCompressionRounds = Math.max(1, Number(config.SHORT_TERM_MEMORY_MAX_COMPRESSION_ROUNDS || 2));

  return {
    affinity,
    reserveRecentMessages,
    summaryMaxTokens,
    triggerTokens: Math.max(64, Math.floor(affinity.shortTermMemoryTokens * triggerRatio)),
    maxCompressionRounds
  };
}

function getStateMaxItems() {
  return Math.max(1, Math.floor(Number(config.SHORT_TERM_STATE_MAX_ITEMS || 4)));
}

function getToolResultMaxItems() {
  return Math.max(1, Math.floor(Number(config.SHORT_TERM_TOOL_RESULT_MAX_ITEMS || 3)));
}

function getCarryOverMaxChars() {
  return 220;
}

function getStyleAnchorMaxItems() {
  return 4;
}

function getRecentTurnsMaxItems() {
  return Math.max(2, Math.min(6, Number(config.MEMORY_V3_SESSION_RECENT_MESSAGES || 4) || 4));
}

const DEFAULT_REPLY_POSTURE = 'light';
const REPLY_POSTURES = new Set([
  'light',
  'playful',
  'gentle',
  'reserved',
  'focused',
  'comforting'
]);
const shortTermScopeLogCache = new Map();

function trimShortText(value, maxChars = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function deriveActiveTopicFromTurn(userContent = '', assistantContent = '') {
  const userText = trimShortText(userContent, 180);
  const assistantText = trimShortText(assistantContent, 180);
  if (!userText && !assistantText) return '';
  if (userText && userText.length <= 180) return userText;
  return trimShortText([userText, assistantText].filter(Boolean).join(' / '), 180);
}

function normalizeStringList(values = [], limit = 4, itemMaxChars = 140) {
  const output = [];
  const seen = new Set();

  for (const raw of Array.isArray(values) ? values : []) {
    const text = trimShortText(raw, itemMaxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
    if (output.length >= Math.max(1, Number(limit) || 1)) break;
  }

  return output;
}

function normalizeConfidence(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function normalizeRecentTurns(values = [], limit = getRecentTurnsMaxItems()) {
  return (Array.isArray(values) ? values : [])
    .map((item) => {
      const role = String(item?.role || '').trim().toLowerCase();
      const content = trimShortText(item?.content || item?.text || '', 220);
      if ((role !== 'user' && role !== 'assistant') || !content) return null;
      return { role, content };
    })
    .filter(Boolean)
    .slice(-Math.max(1, Number(limit) || 1));
}

function normalizeReplyPosture(value, fallback = DEFAULT_REPLY_POSTURE) {
  const posture = trimShortText(value, 24);
  return REPLY_POSTURES.has(posture) ? posture : fallback;
}

function defaultExpressionState() {
  return {
    replyPosture: DEFAULT_REPLY_POSTURE,
    warmth: '',
    guardedness: '',
    initiative: '',
    jargonMode: '',
    cadenceHint: '',
    styleAnchors: [],
    confidence: 0
  };
}

function normalizeExpressionState(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    replyPosture: normalizeReplyPosture(raw.replyPosture, DEFAULT_REPLY_POSTURE),
    warmth: trimShortText(raw.warmth, 32),
    guardedness: trimShortText(raw.guardedness, 32),
    initiative: trimShortText(raw.initiative, 32),
    jargonMode: trimShortText(raw.jargonMode, 32),
    cadenceHint: trimShortText(raw.cadenceHint, 48),
    styleAnchors: normalizeStringList(raw.styleAnchors, getStyleAnchorMaxItems(), 96),
    confidence: normalizeConfidence(raw.confidence, 0)
  };
}

function defaultModuleState() {
  return {
    activePersonaModules: [],
    stickyTurnsRemaining: 0,
    switchReason: '',
    lastSurface: '',
    lastTopicFingerprint: '',
    lastUpdatedAt: 0
  };
}

function normalizeModuleState(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    activePersonaModules: normalizeStringList(raw.activePersonaModules || raw.personaModules, 2, 64),
    stickyTurnsRemaining: Math.max(0, Math.min(5, Number(raw.stickyTurnsRemaining || 0) || 0)),
    switchReason: trimShortText(raw.switchReason, 160),
    lastSurface: trimShortText(raw.lastSurface, 32),
    lastTopicFingerprint: trimShortText(raw.lastTopicFingerprint, 96),
    lastUpdatedAt: Number(raw.lastUpdatedAt || 0) || 0
  };
}

function defaultSceneState() {
  return {
    sceneKey: '',
    activeTopic: '',
    atmosphere: '',
    activePair: '',
    quoteAnchor: '',
    jargonHints: [],
    recentTurns: [],
    confidence: 0
  };
}

function normalizeSceneState(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    sceneKey: trimShortText(raw.sceneKey, 96),
    activeTopic: trimShortText(raw.activeTopic, 180),
    atmosphere: trimShortText(raw.atmosphere, 120),
    activePair: trimShortText(raw.activePair, 120),
    quoteAnchor: trimShortText(raw.quoteAnchor, 180),
    jargonHints: normalizeStringList(raw.jargonHints, 4, 80),
    recentTurns: normalizeRecentTurns(raw.recentTurns, 4),
    confidence: normalizeConfidence(raw.confidence, 0)
  };
}

function defaultInteractionState() {
  return {
    activeTopic: '',
    carryOverUserTurn: '',
    openLoops: [],
    assistantCommitments: [],
    userConstraints: [],
    recentTurns: [],
    phaseHint: '',
    sourceFlags: [],
    confidence: 0
  };
}

function normalizeInteractionState(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    activeTopic: trimShortText(raw.activeTopic, 180),
    carryOverUserTurn: trimShortText(raw.carryOverUserTurn, getCarryOverMaxChars()),
    openLoops: normalizeStringList(raw.openLoops, getStateMaxItems(), 120),
    assistantCommitments: normalizeStringList(raw.assistantCommitments, getStateMaxItems(), 120),
    userConstraints: normalizeStringList(raw.userConstraints, getStateMaxItems(), 120),
    recentTurns: normalizeRecentTurns(raw.recentTurns, getRecentTurnsMaxItems()),
    phaseHint: trimShortText(raw.phaseHint, 48),
    sourceFlags: normalizeStringList(raw.sourceFlags, 8, 80),
    confidence: normalizeConfidence(raw.confidence, 0)
  };
}

const SESSION_PRESENCE_STATES = new Set([
  'observing',
  'considering',
  'waiting',
  'interjecting',
  'cooling',
  'closed'
]);

const SESSION_PRESENCE_ACTIONS = new Set([
  'no_reply',
  'wait',
  'reply',
  'follow_up',
  'exit'
]);

function normalizeSessionPresenceState(value, fallback = 'observing') {
  const state = trimShortText(value, 24);
  return SESSION_PRESENCE_STATES.has(state) ? state : fallback;
}

function normalizeSessionPresenceAction(value, fallback = 'no_reply') {
  const action = trimShortText(value, 24);
  return SESSION_PRESENCE_ACTIONS.has(action) ? action : fallback;
}

function defaultShortTermPresence() {
  return {
    state: 'observing',
    lastAction: 'no_reply',
    stateUpdatedAt: 0,
    lastInboundAt: 0,
    lastHumanInboundAt: 0,
    lastAtBotInboundAt: 0,
    lastBotReplyAt: 0,
    humanTurnsSinceBotReply: 0,
    waitingSince: 0,
    closedAt: 0
  };
}

function normalizeShortTermPresence(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const fallback = defaultShortTermPresence();
  return {
    state: normalizeSessionPresenceState(raw.state, fallback.state),
    lastAction: normalizeSessionPresenceAction(raw.lastAction, fallback.lastAction),
    stateUpdatedAt: Number(raw.stateUpdatedAt || 0) || 0,
    lastInboundAt: Number(raw.lastInboundAt || 0) || 0,
    lastHumanInboundAt: Number(raw.lastHumanInboundAt || 0) || 0,
    lastAtBotInboundAt: Number(raw.lastAtBotInboundAt || 0) || 0,
    lastBotReplyAt: Number(raw.lastBotReplyAt || 0) || 0,
    humanTurnsSinceBotReply: Math.max(0, Number(raw.humanTurnsSinceBotReply || 0) || 0),
    waitingSince: Number(raw.waitingSince || 0) || 0,
    closedAt: Number(raw.closedAt || 0) || 0
  };
}

function defaultShortTermState() {
  return {
    schemaVersion: 2,
    summary: '',
    activeTopic: '',
    openLoops: [],
    assistantCommitments: [],
    userConstraints: [],
    recentToolResults: [],
    carryOverUserTurn: '',
    interaction: defaultInteractionState(),
    scene: defaultSceneState(),
    expression: defaultExpressionState(),
    moduleState: defaultModuleState(),
    phaseHint: '',
    sceneRef: '',
    confidence: 0,
    presence: defaultShortTermPresence(),
    lastCompressedAt: 0,
    rounds: 0
  };
}

function normalizeShortTermState(input = {}) {
  const old = input && typeof input === 'object' ? input : {};
  const normalizedInteraction = normalizeInteractionState({
    ...defaultInteractionState(),
    ...(old.interaction && typeof old.interaction === 'object' ? old.interaction : {}),
    activeTopic: old.interaction?.activeTopic || old.activeTopic,
    carryOverUserTurn: old.interaction?.carryOverUserTurn || old.carryOverUserTurn,
    openLoops: old.interaction?.openLoops || old.openLoops,
    assistantCommitments: old.interaction?.assistantCommitments || old.assistantCommitments,
    userConstraints: old.interaction?.userConstraints || old.userConstraints,
    recentTurns: old.interaction?.recentTurns || old.recentTurns,
    phaseHint: old.interaction?.phaseHint || old.phaseHint,
    sourceFlags: old.interaction?.sourceFlags || old.sourceFlags,
    confidence: old.interaction?.confidence || old.confidence
  });
  const normalizedScene = normalizeSceneState({
    ...defaultSceneState(),
    ...(old.scene && typeof old.scene === 'object' ? old.scene : {}),
    sceneKey: old.scene?.sceneKey || old.sceneKey || old.sceneRef,
    activeTopic: old.scene?.activeTopic || '',
    recentTurns: old.scene?.recentTurns || []
  });
  const normalizedExpression = normalizeExpressionState({
    ...defaultExpressionState(),
    ...(old.expression && typeof old.expression === 'object' ? old.expression : {})
  });
  const normalizedModuleState = normalizeModuleState({
    ...defaultModuleState(),
    ...(old.moduleState && typeof old.moduleState === 'object' ? old.moduleState : {})
  });
  return {
    schemaVersion: Math.max(2, Number(old.schemaVersion || 2) || 2),
    summary: trimShortText(old.summary, 2400),
    summarySource: trimShortText(old.summarySource, 48),
    activeTopic: normalizedInteraction.activeTopic || trimShortText(old.activeTopic, 180),
    openLoops: normalizedInteraction.openLoops.length > 0
      ? normalizedInteraction.openLoops
      : normalizeStringList(old.openLoops, getStateMaxItems(), 120),
    assistantCommitments: normalizedInteraction.assistantCommitments.length > 0
      ? normalizedInteraction.assistantCommitments
      : normalizeStringList(old.assistantCommitments, getStateMaxItems(), 120),
    userConstraints: normalizedInteraction.userConstraints.length > 0
      ? normalizedInteraction.userConstraints
      : normalizeStringList(old.userConstraints, getStateMaxItems(), 120),
    recentToolResults: normalizeStringList(old.recentToolResults, getToolResultMaxItems(), 160),
    carryOverUserTurn: normalizedInteraction.carryOverUserTurn || trimShortText(old.carryOverUserTurn, getCarryOverMaxChars()),
    interaction: normalizedInteraction,
    scene: normalizedScene,
    expression: normalizedExpression,
    moduleState: normalizedModuleState,
    phaseHint: normalizedInteraction.phaseHint || trimShortText(old.phaseHint, 48),
    sceneRef: normalizedScene.sceneKey || trimShortText(old.sceneRef || old.sceneKey, 96),
    confidence: Math.max(
      normalizeConfidence(old.confidence, 0),
      normalizedInteraction.confidence,
      normalizedExpression.confidence,
      normalizedScene.confidence
    ),
    presence: normalizeShortTermPresence(old.presence),
    lastCompressedAt: Number(old.lastCompressedAt || 0) || 0,
    rounds: Number(old.rounds || 0) || 0
  };
}

function resolveShortTermSceneKey(routeMeta = {}) {
  const meta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  const explicitSceneId = String(meta.sceneKey || meta.scene_id || meta.sceneId || '').trim();
  if (explicitSceneId) return explicitSceneId;
  const groupId = String(meta.groupId || meta.group_id || '').trim();
  if (groupId) return `qq-group:${groupId}:scene`;
  const channelId = String(meta.channelId || meta.channel_id || '').trim();
  if (channelId) return `channel:${channelId}:scene`;
  return '';
}

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

function resolveShortTermSessionKey(userId, routeMeta = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return '';

  if (!config.SHORT_TERM_SESSION_SCOPE_ENABLED) {
    return uid;
  }

  const meta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  const explicitSessionId = String(meta.sessionId || meta.session_id || '').trim();
  if (explicitSessionId) return explicitSessionId;

  const groupId = String(meta.groupId || meta.group_id || '').trim();
  if (groupId) return `qq-group:${groupId}:user:${uid}`;

  const channelId = String(meta.channelId || meta.channel_id || '').trim();
  if (channelId) return `channel:${channelId}:user:${uid}`;

  return `direct:${uid}`;
}

function resolveShortTermScope(userId, routeMeta = {}, sessionKey = '') {
  const meta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  return {
    sessionKey: String(sessionKey || resolveShortTermSessionKey(userId, meta) || '').trim(),
    userId: String(userId || '').trim(),
    groupId: String(meta.groupId || meta.group_id || '').trim(),
    channelId: String(meta.channelId || meta.channel_id || '').trim(),
    sessionId: String(meta.sessionId || meta.session_id || '').trim()
  };
}

function ensureShortTermMemoryState(target, shortTermMemory = {}, routeMeta = {}) {
  const rawTarget = String(target || '').trim();
  const hasRouteMeta = routeMeta && typeof routeMeta === 'object' && Object.keys(routeMeta).length > 0;
  const key = String(hasRouteMeta ? resolveShortTermSessionKey(rawTarget, routeMeta) : rawTarget || '').trim();
  if (!key) return defaultShortTermState();

  shortTermMemory[key] = normalizeShortTermState(shortTermMemory[key]);
  return shortTermMemory[key];
}

function getShortTermPresence(target, shortTermMemory = {}, routeMeta = {}) {
  const state = ensureShortTermMemoryState(target, shortTermMemory, routeMeta);
  return normalizeShortTermPresence(state.presence);
}

function updateShortTermPresence(target, shortTermMemory = {}, routeMeta = {}, updater) {
  const state = ensureShortTermMemoryState(target, shortTermMemory, routeMeta);
  const current = normalizeShortTermPresence(state.presence);
  const next = typeof updater === 'function'
    ? updater({ ...current })
    : { ...current, ...(updater && typeof updater === 'object' ? updater : {}) };

  state.presence = normalizeShortTermPresence(next);
  return normalizeShortTermPresence(state.presence);
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

function normalizeHistoryMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((item) => {
      const role = String(item?.role || '').trim().toLowerCase();
      const content = normalizeMessageContent(item?.content);
      if ((role !== 'user' && role !== 'assistant') || !content) return null;
      return { role, content };
    })
    .filter(Boolean);
}

function listUserSessionKeys(userId, chatHistory = {}, shortTermMemory = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];

  const sessionKeys = new Set();
  for (const key of Object.keys(chatHistory || {})) {
    const sessionKey = String(key || '').trim();
    if (
      sessionKey === `direct:${uid}`
      || sessionKey === uid
      || sessionKey.startsWith(`qq-group:`) && sessionKey.endsWith(`:user:${uid}`)
      || sessionKey.startsWith(`channel:`) && sessionKey.endsWith(`:user:${uid}`)
    ) {
      sessionKeys.add(sessionKey);
    }
  }
  for (const key of Object.keys(shortTermMemory || {})) {
    const sessionKey = String(key || '').trim();
    if (
      sessionKey === `direct:${uid}`
      || sessionKey === uid
      || sessionKey.startsWith(`qq-group:`) && sessionKey.endsWith(`:user:${uid}`)
      || sessionKey.startsWith(`channel:`) && sessionKey.endsWith(`:user:${uid}`)
    ) {
      sessionKeys.add(sessionKey);
    }
  }
  return Array.from(sessionKeys);
}

function buildSharedShortTermSignature(sessionEntries = []) {
  return (Array.isArray(sessionEntries) ? sessionEntries : [])
    .map((entry) => {
      const sessionKey = String(entry?.sessionKey || '').trim();
      const updatedAt = Number(entry?.updatedAt || 0) || 0;
      const historyLength = Number(entry?.historyLength || 0) || 0;
      return `${sessionKey}@${updatedAt}:${historyLength}`;
    })
    .filter(Boolean)
    .join('|');
}

function shouldIncludeSiblingShortTermSessions(deps = {}) {
  if (deps.isolateSession === true || deps.currentSessionOnly === true) return false;
  const raw = deps.includeSiblingSessions ?? deps.includeSharedSessions ?? deps.shareAcrossSessions;
  if (raw === undefined || raw === null || raw === '') return true;
  if (raw === false || raw === 0) return false;
  if (raw === true || raw === 1) return true;
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'false' || text === '0' || text === 'no') return false;
  return text === 'true' || text === '1' || text === 'yes';
}

function pruneShortTermScopeLogCache(now = Date.now()) {
  if (shortTermScopeLogCache.size <= 200) return;
  const cutoff = now - 60 * 1000;
  for (const [key, value] of shortTermScopeLogCache.entries()) {
    if (Number(value || 0) < cutoff) shortTermScopeLogCache.delete(key);
  }
}

function logShortTermScopeDecision(userId, sessionKey, scopeMeta = {}) {
  if (!config.ENABLE_DEBUG_LOG) return;
  const selectedSessionKeys = Array.isArray(scopeMeta.selectedSessionKeys) ? scopeMeta.selectedSessionKeys : [];
  const ignoredSessionKeys = Array.isArray(scopeMeta.ignoredSessionKeys) ? scopeMeta.ignoredSessionKeys : [];
  if (selectedSessionKeys.length <= 1 && ignoredSessionKeys.length === 0) return;

  const mode = String(scopeMeta.mode || '').trim() || 'session';
  const now = Date.now();
  const signature = [
    String(userId || '').trim(),
    String(sessionKey || '').trim(),
    mode,
    selectedSessionKeys.join(','),
    ignoredSessionKeys.join(',')
  ].join('|');
  const previousAt = Number(shortTermScopeLogCache.get(signature) || 0) || 0;
  if (previousAt && now - previousAt < 60 * 1000) return;
  shortTermScopeLogCache.set(signature, now);
  pruneShortTermScopeLogCache(now);

  console.log('[short-term-memory] session scope decision', {
    userId: String(userId || '').trim(),
    sessionKey: String(sessionKey || '').trim(),
    mode,
    selectedSessionKeys,
    selectedSessions: Array.isArray(scopeMeta.selectedSessions) ? scopeMeta.selectedSessions : [],
    ignoredSessionKeys
  });
}

function collectSharedShortTermSessionEntries(userId, deps = {}) {
  const uid = String(userId || '').trim();
  const historyStore = deps.chatHistory || {};
  const shortTermStore = deps.shortTermMemory || {};
  const currentSessionKey = String(deps.sessionKey || resolveShortTermSessionKey(uid, deps.routeMeta) || '').trim();
  const includeSiblingSessions = shouldIncludeSiblingShortTermSessions(deps);
  const availableSessionKeys = listUserSessionKeys(uid, historyStore, shortTermStore);
  const selectedKeys = includeSiblingSessions ? availableSessionKeys.slice() : [];
  if (currentSessionKey && !selectedKeys.includes(currentSessionKey)) {
    selectedKeys.push(currentSessionKey);
  }

  const entries = selectedKeys.map((sessionKey) => {
    const state = ensureShortTermMemoryState(sessionKey, shortTermStore);
    const history = normalizeHistoryMessages(historyStore[sessionKey]);
    const presence = normalizeShortTermPresence(state.presence);
    const updatedAt = Math.max(
      Number(state.lastCompressedAt || 0) || 0,
      Number(presence.stateUpdatedAt || 0) || 0,
      Number(presence.lastInboundAt || 0) || 0,
      history.length > 0 ? history.length : 0
    );
    return {
      sessionKey,
      state: normalizeShortTermState(state),
      history,
      historyLength: history.length,
      updatedAt,
      isCurrent: sessionKey === currentSessionKey
    };
  });

  entries.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return String(a.sessionKey || '').localeCompare(String(b.sessionKey || ''));
  });
  const selectedSessionKeys = entries.map((entry) => entry.sessionKey);
  const selectedSessions = entries.map((entry) => ({
    sessionKey: entry.sessionKey,
    current: Boolean(entry.isCurrent),
    updatedAt: Number(entry.updatedAt || 0) || 0,
    historyLength: Number(entry.historyLength || 0) || 0
  }));
  entries.scopeMeta = {
    mode: includeSiblingSessions ? 'shared' : 'session',
    currentSessionKey,
    availableSessionKeys,
    selectedSessionKeys,
    selectedSessions,
    ignoredSessionKeys: availableSessionKeys.filter((sessionKey) => !selectedSessionKeys.includes(sessionKey))
  };
  return entries;
}

function mergeSharedStringList(entries = [], selector, limit = 4, itemMaxChars = 140) {
  const current = entries.find((entry) => entry?.isCurrent);
  const preferred = normalizeStringList(
    typeof selector === 'function' ? selector(current?.state || {}) : [],
    limit,
    itemMaxChars
  );
  if (preferred.length >= limit) return preferred;

  const deduped = preferred.slice();
  const seen = new Set(deduped);
  for (const entry of entries) {
    if (!entry || entry.isCurrent) continue;
    const values = normalizeStringList(
      typeof selector === 'function' ? selector(entry.state || {}) : [],
      limit,
      itemMaxChars
    );
    for (const value of values) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      deduped.push(value);
      if (deduped.length >= limit) return deduped;
    }
  }
  return deduped;
}

function pickSharedField(entries = [], selector, maxChars = 220) {
  for (const entry of entries) {
    const value = trimShortText(typeof selector === 'function' ? selector(entry?.state || {}) : '', maxChars);
    if (value) return value;
  }
  return '';
}

function buildSharedRecentHistory(entries = [], tokenBudget = 0) {
  const current = entries.find((entry) => entry?.isCurrent);
  const combined = [];
  const seen = new Set();

  const pushHistory = (messages = []) => {
    for (const item of messages) {
      const role = String(item?.role || '').trim().toLowerCase();
      const content = normalizeMessageContent(item?.content);
      if ((role !== 'user' && role !== 'assistant') || !content) continue;
      const key = `${role}:${content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push({ role, content });
    }
  };

  for (const entry of entries) {
    if (!entry || entry.isCurrent) continue;
    pushHistory(entry.history || []);
  }
  pushHistory(current?.history || []);

  return trimMessagesByTokenBudget(combined, tokenBudget);
}

function collectSharedRecentTurns(entries = [], selector, limit = getRecentTurnsMaxItems()) {
  const ordered = [];
  for (const entry of entries) {
    if (!entry || entry.isCurrent) continue;
    const turns = typeof selector === 'function' ? selector(entry.state || {}) : [];
    ordered.push(...normalizeRecentTurns(turns, limit));
  }
  const current = entries.find((entry) => entry?.isCurrent);
  if (current) {
    const turns = typeof selector === 'function' ? selector(current.state || {}) : [];
    ordered.push(...normalizeRecentTurns(turns, limit));
  }
  return normalizeRecentTurns(ordered, limit);
}

function buildSharedShortTermContextMessages(userId, userInfo = {}, deps = {}) {
  const key = String(deps.sessionKey || resolveShortTermSessionKey(userId, deps.routeMeta) || '').trim();
  const settings = getShortTermCompressionSettings(userInfo, { userId: String(userId || '').trim() });
  const sessionEntries = collectSharedShortTermSessionEntries(userId, {
    ...deps,
    sessionKey: key
  });
  const scopeMeta = sessionEntries.scopeMeta || {
    mode: 'session',
    currentSessionKey: key,
    availableSessionKeys: sessionEntries.map((entry) => entry.sessionKey),
    selectedSessionKeys: sessionEntries.map((entry) => entry.sessionKey),
    selectedSessions: sessionEntries.map((entry) => ({
      sessionKey: entry.sessionKey,
      current: Boolean(entry.isCurrent),
      updatedAt: Number(entry.updatedAt || 0) || 0,
      historyLength: Number(entry.historyLength || 0) || 0
    })),
    ignoredSessionKeys: []
  };
  logShortTermScopeDecision(userId, key, scopeMeta);
  const sharedState = normalizeShortTermState({
    summary: pickSharedField(sessionEntries, (state) => state.summary, 2400),
    activeTopic: pickSharedField(sessionEntries, (state) => state.activeTopic, 180),
    openLoops: mergeSharedStringList(sessionEntries, (state) => state.openLoops, getStateMaxItems(), 120),
    assistantCommitments: mergeSharedStringList(sessionEntries, (state) => state.assistantCommitments, getStateMaxItems(), 120),
    userConstraints: mergeSharedStringList(sessionEntries, (state) => state.userConstraints, getStateMaxItems(), 120),
    recentToolResults: mergeSharedStringList(sessionEntries, (state) => state.recentToolResults, getToolResultMaxItems(), 160),
    carryOverUserTurn: pickSharedField(sessionEntries, (state) => state.carryOverUserTurn, getCarryOverMaxChars()),
    interaction: {
      activeTopic: pickSharedField(sessionEntries, (state) => state.interaction?.activeTopic || state.activeTopic, 180),
      carryOverUserTurn: pickSharedField(sessionEntries, (state) => state.interaction?.carryOverUserTurn || state.carryOverUserTurn, getCarryOverMaxChars()),
      openLoops: mergeSharedStringList(sessionEntries, (state) => state.interaction?.openLoops || state.openLoops, getStateMaxItems(), 120),
      assistantCommitments: mergeSharedStringList(sessionEntries, (state) => state.interaction?.assistantCommitments || state.assistantCommitments, getStateMaxItems(), 120),
      userConstraints: mergeSharedStringList(sessionEntries, (state) => state.interaction?.userConstraints || state.userConstraints, getStateMaxItems(), 120),
      recentTurns: collectSharedRecentTurns(
        sessionEntries,
        (state) => state.interaction?.recentTurns || [],
        getRecentTurnsMaxItems()
      ),
      phaseHint: pickSharedField(sessionEntries, (state) => state.interaction?.phaseHint || state.phaseHint, 48),
      sourceFlags: mergeSharedStringList(sessionEntries, (state) => state.interaction?.sourceFlags || [], 8, 80),
      confidence: Math.max(
        ...sessionEntries.map((entry) => normalizeConfidence(entry?.state?.interaction?.confidence, 0)),
        0
      )
    },
    expression: {
      replyPosture: pickSharedField(sessionEntries, (state) => state.expression?.replyPosture, 24) || DEFAULT_REPLY_POSTURE,
      warmth: pickSharedField(sessionEntries, (state) => state.expression?.warmth, 32),
      guardedness: pickSharedField(sessionEntries, (state) => state.expression?.guardedness, 32),
      initiative: pickSharedField(sessionEntries, (state) => state.expression?.initiative, 32),
      jargonMode: pickSharedField(sessionEntries, (state) => state.expression?.jargonMode, 32),
      cadenceHint: pickSharedField(sessionEntries, (state) => state.expression?.cadenceHint, 48),
      styleAnchors: mergeSharedStringList(sessionEntries, (state) => state.expression?.styleAnchors || [], getStyleAnchorMaxItems(), 96),
      confidence: Math.max(
        ...sessionEntries.map((entry) => normalizeConfidence(entry?.state?.expression?.confidence, 0)),
        0
      )
    },
    moduleState: {
      activePersonaModules: mergeSharedStringList(sessionEntries, (state) => state.moduleState?.activePersonaModules || [], 2, 64),
      stickyTurnsRemaining: Math.max(
        ...sessionEntries.map((entry) => Math.max(0, Number(entry?.state?.moduleState?.stickyTurnsRemaining || 0) || 0)),
        0
      ),
      switchReason: pickSharedField(sessionEntries, (state) => state.moduleState?.switchReason, 160),
      lastSurface: pickSharedField(sessionEntries, (state) => state.moduleState?.lastSurface, 32),
      lastTopicFingerprint: pickSharedField(sessionEntries, (state) => state.moduleState?.lastTopicFingerprint, 96),
      lastUpdatedAt: Math.max(
        ...sessionEntries.map((entry) => Number(entry?.state?.moduleState?.lastUpdatedAt || 0) || 0),
        0
      )
    },
    scene: {
      sceneKey: pickSharedField(sessionEntries, (state) => state.scene?.sceneKey || state.sceneRef, 96),
      activeTopic: pickSharedField(sessionEntries, (state) => state.scene?.activeTopic, 180),
      atmosphere: pickSharedField(sessionEntries, (state) => state.scene?.atmosphere, 120),
      activePair: pickSharedField(sessionEntries, (state) => state.scene?.activePair, 120),
      quoteAnchor: pickSharedField(sessionEntries, (state) => state.scene?.quoteAnchor, 180),
      jargonHints: mergeSharedStringList(sessionEntries, (state) => state.scene?.jargonHints || [], 4, 80),
      recentTurns: collectSharedRecentTurns(
        sessionEntries,
        (state) => state.scene?.recentTurns || [],
        4
      ),
      confidence: Math.max(
        ...sessionEntries.map((entry) => normalizeConfidence(entry?.state?.scene?.confidence, 0)),
        0
      )
    },
    phaseHint: pickSharedField(sessionEntries, (state) => state.phaseHint || state.interaction?.phaseHint, 48),
    sceneRef: pickSharedField(sessionEntries, (state) => state.sceneRef || state.scene?.sceneKey, 96),
    confidence: Math.max(
      ...sessionEntries.map((entry) => normalizeConfidence(entry?.state?.confidence, 0)),
      0
    ),
    presence: (sessionEntries.find((entry) => entry?.isCurrent)?.state || defaultShortTermState()).presence
  });
  const summaryText = buildStructuredSummaryText(sharedState, settings.summaryMaxTokens);
  const summaryMessage = buildHistorySummaryMessage(summaryText, settings.summaryMaxTokens);
  const historyStore = deps.chatHistory || {};
  const currentHistory = Array.isArray(historyStore[key]) ? historyStore[key] : [];
  const sessionSummaryBundle = buildSessionSummaryMessages(
    key,
    currentHistory,
    config.SESSION_CONTEXT_SUMMARY_LOAD_COUNT,
    { dedupeAgainstText: summaryText }
  );
  const recentHistory = buildSharedRecentHistory(sessionEntries, settings.affinity.shortTermMemoryTokens);

  return {
    summaryMessage,
    sessionSummaryMessages: sessionSummaryBundle.sessionSummaryMessages,
    recentSessionSummaries: sessionSummaryBundle.recentSessionSummaries,
    recentHistory,
    affinity: settings.affinity,
    shortTermSummary: summaryText,
    shortTermState: sharedState,
    sessionKey: key,
    sharedSessionKeys: sessionEntries.map((entry) => entry.sessionKey),
    sharedShortTermSignature: buildSharedShortTermSignature(sessionEntries),
    shortTermScope: scopeMeta
  };
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

function serializeHistoryChunk(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((item) => {
      const role = String(item?.role || '').trim().toLowerCase() === 'assistant' ? 'Assistant' : 'User';
      const content = trimTextByTokenBudget(normalizeMessageContent(item?.content), 220, 'tail');
      return `${role}: ${content || '[empty]'}`;
    })
    .filter(Boolean)
    .join('\n');
}

function mergeCompressedSummary(previousSummary, chunkSummary, summaryTokens) {
  const older = trimTextByTokenBudget(String(previousSummary || '').trim(), Math.floor(summaryTokens * 0.45), 'tail');
  const newer = trimTextByTokenBudget(String(chunkSummary || '').trim(), Math.floor(summaryTokens * 0.55), 'tail');

  if (older && newer) {
    return trimTextByTokenBudget(`[Earlier]\n${older}\n\n[Added]\n${newer}`, summaryTokens, 'tail');
  }

  return trimTextByTokenBudget(older || newer, summaryTokens, 'tail');
}

function getCompressionCandidateChunk(history = [], reserveRecentMessages = 2) {
  const list = Array.isArray(history) ? history : [];
  const reserve = Math.max(2, Number(reserveRecentMessages) || 2);
  const chunkEnd = Math.max(0, list.length - reserve);
  if (chunkEnd < 4) return [];

  const maxChunk = Math.max(4, Math.min(16, chunkEnd));
  const chunk = list.slice(0, maxChunk);
  return chunk.length >= 4 ? chunk : [];
}

function stripMarkdownFence(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fenced ? String(fenced[1] || '').trim() : raw;
}

function parseStructuredCompressionOutput(output = '') {
  const raw = stripMarkdownFence(output);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const allowedKeys = new Set([
      'summary',
      'activeTopic',
      'openLoops',
      'assistantCommitments',
      'userConstraints',
      'recentToolResults',
      'carryOverUserTurn',
      'interaction',
      'scene',
      'expression',
      'moduleState',
      'phaseHint',
      'sceneRef',
      'confidence'
    ]);
    const hasKnownKey = Object.keys(parsed).some((key) => allowedKeys.has(key));
    if (!hasKnownKey) return null;
    if ('summary' in parsed && typeof parsed.summary !== 'string') return null;
    for (const key of ['openLoops', 'assistantCommitments', 'userConstraints', 'recentToolResults']) {
      if (key in parsed && !Array.isArray(parsed[key])) return null;
    }
    if ('confidence' in parsed) {
      const confidence = Number(parsed.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    }
    return applyPersonaContinuityDelta(defaultShortTermState(), parsed);
  } catch (_) {
    return null;
  }
}

function mergeStructuredState(currentState, nextState, summaryTokens) {
  const current = normalizeShortTermState(currentState);
  const next = applyPersonaContinuityDelta(current, nextState);
  return normalizeShortTermState({
    ...current,
    ...next,
    summary: mergeCompressedSummary(current.summary, next.summary, summaryTokens),
    lastCompressedAt: Date.now(),
    rounds: Number(current.rounds || 0)
  });
}

async function compressShortTermHistoryIfNeeded(userId, userInfo = {}, deps = {}) {
  const key = String(deps.sessionKey || resolveShortTermSessionKey(userId, deps.routeMeta) || '').trim();
  const historyStore = deps.chatHistory || {};
  if (!historyStore[key]) historyStore[key] = [];

  const history = historyStore[key];
  const settings = getShortTermCompressionSettings(userInfo, { userId: String(userId || '').trim() });
  const state = ensureShortTermMemoryState(key, deps.shortTermMemory);
  const summarizeChunk = typeof deps.summarizeChunk === 'function' ? deps.summarizeChunk : null;
  if (!summarizeChunk) return { compressed: false, summary: state.summary, history, state };

  let compressed = false;
  let rounds = 0;

  while (
    history.length > settings.reserveRecentMessages + 2 &&
    estimateMessagesTokens(history) > settings.triggerTokens &&
    rounds < settings.maxCompressionRounds
  ) {
    const chunk = getCompressionCandidateChunk(history, settings.reserveRecentMessages);
    if (chunk.length < 4) break;

    const chunkText = serializeHistoryChunk(chunk);
    if (!chunkText) break;

    const chunkSummary = await summarizeChunk({
      userId: String(userId || '').trim(),
      sessionKey: key,
      userInfo,
      existingSummary: state.summary,
      existingState: normalizeShortTermState(state),
      chunkMessages: chunk,
      chunkText,
      summaryTokens: settings.summaryMaxTokens
    });

    const normalizedOutput = String(chunkSummary || '').trim();
    if (!normalizedOutput) break;

    const structured = parseStructuredCompressionOutput(normalizedOutput);
    if (structured) {
      const merged = mergeStructuredState(state, structured, settings.summaryMaxTokens);
      Object.assign(state, merged);
      state.summarySource = 'compression';
    } else {
      const normalizedSummary = trimTextByTokenBudget(normalizedOutput, settings.summaryMaxTokens, 'tail');
      if (!normalizedSummary) break;
      state.summary = mergeCompressedSummary(state.summary, normalizedSummary, settings.summaryMaxTokens);
      state.summarySource = 'compression';
      state.lastCompressedAt = Date.now();
    }

    state.rounds += 1;
    history.splice(0, chunk.length);
    compressed = true;
    rounds += 1;
  }

  return {
    compressed,
    summary: state.summary,
    history,
    state: normalizeShortTermState(state)
  };
}

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

function buildStructuredCompressionPrompt(existingState, summaryTokens) {
  const state = normalizeShortTermState(existingState);
  const compactState = {
    summary: state.summary,
    activeTopic: state.activeTopic,
    openLoops: state.openLoops,
    assistantCommitments: state.assistantCommitments,
    userConstraints: state.userConstraints,
    recentToolResults: state.recentToolResults,
    carryOverUserTurn: state.carryOverUserTurn,
    interaction: state.interaction,
    scene: state.scene,
    expression: state.expression,
    moduleState: state.moduleState,
    phaseHint: state.phaseHint,
    sceneRef: state.sceneRef,
    confidence: state.confidence
  };
  return [
    '你是对话短期上下文压缩器。',
    '优先保留：用户约束、助手承诺、未完成事项、最近工具结论、最近主线话题、当前回复姿态、当前场景气氛、persona modules。',
    '返回严格 JSON，不要解释，不要 markdown。',
    '字段固定：summary, activeTopic, openLoops, assistantCommitments, userConstraints, recentToolResults, carryOverUserTurn, interaction, scene, expression, moduleState, phaseHint, sceneRef, confidence。',
    'expression.replyPosture 只能是 light, playful, gentle, reserved, focused, comforting 之一。',
    'styleAnchors 只保留 2 到 4 条短语级锚点。',
    '一次偶发玩笑或角色扮演不要直接写成稳定表达态，除非多轮稳定或有显式反馈。',
    `summary 控制在约 ${summaryTokens} tokens 内。`,
    'openLoops / assistantCommitments / userConstraints 最多 4 条，recentToolResults 最多 3 条。',
    `已有结构化状态：${JSON.stringify(compactState)}`
  ].join('\n');
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
