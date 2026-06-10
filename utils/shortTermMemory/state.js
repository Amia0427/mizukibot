const config = require('../../config');
const { getAffinitySettings } = require('../contextBudget');

const DEFAULT_REPLY_POSTURE = 'light';
const REPLY_POSTURES = new Set([
  'light',
  'playful',
  'gentle',
  'reserved',
  'focused',
  'comforting'
]);

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
  return Math.max(2, Math.min(80, Math.floor(Number(config.SHORT_TERM_MEMORY_RECENT_TURNS || config.MEMORY_V3_SESSION_RECENT_MESSAGES || 32) || 32)));
}

function getSceneRecentTurnsMaxItems() {
  return Math.max(2, Math.min(48, Math.floor(Number(config.SHORT_TERM_SCENE_RECENT_TURNS || 16) || 16)));
}

function getCompressionChunkMaxMessages() {
  return Math.max(4, Math.min(160, Math.floor(Number(config.SHORT_TERM_MEMORY_COMPRESSION_CHUNK_MESSAGES || 64) || 64)));
}

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
    recentTurns: normalizeRecentTurns(raw.recentTurns, getSceneRecentTurnsMaxItems()),
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

module.exports = {
  DEFAULT_REPLY_POSTURE,
  REPLY_POSTURES,
  SESSION_PRESENCE_STATES,
  SESSION_PRESENCE_ACTIONS,
  getShortTermCompressionSettings,
  getStateMaxItems,
  getToolResultMaxItems,
  getCarryOverMaxChars,
  getStyleAnchorMaxItems,
  getRecentTurnsMaxItems,
  getSceneRecentTurnsMaxItems,
  getCompressionChunkMaxMessages,
  trimShortText,
  deriveActiveTopicFromTurn,
  normalizeStringList,
  normalizeConfidence,
  normalizeRecentTurns,
  normalizeReplyPosture,
  defaultExpressionState,
  normalizeExpressionState,
  defaultModuleState,
  normalizeModuleState,
  defaultSceneState,
  normalizeSceneState,
  defaultInteractionState,
  normalizeInteractionState,
  normalizeSessionPresenceState,
  normalizeSessionPresenceAction,
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
};
