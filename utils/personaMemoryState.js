const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getStyleProfile } = require('./styleProfileRuntime');
const { getGroupSocialContext } = require('./socialContextRuntime');
const {
  resolveShortTermSessionKey,
  resolveShortTermSceneKey,
  normalizeShortTermState,
  normalizeModuleState,
  buildSharedShortTermContextMessages
} = require('./shortTermMemory');
const { loadBridgeStore } = require('./shortTermBridgeMemory');
const { getRecentSessionContextSummaries } = require('./sessionContextSummaryStore');
const { getDailyJournalRetrievalBundle } = require('./dailyJournal');
const { getUserAffinityState, getUserProfile } = require('./memory');
const {
  CONTINUITY_PRIORITY,
  DEFAULT_SURFACE,
  buildCandidate,
  buildExpressionValue,
  computeTopicFingerprint,
  createRecentReplyFrameFromMessages,
  getSurfacePolicy,
  inferReplyPostureFromSignals,
  looksLikePollutedContinuitySummary,
  normalizeArray,
  normalizeObject,
  normalizeReplyPosture,
  normalizeText,
  uniqueStrings
} = require('./personaMemoryState/helpers');
const {
  buildExpressionState,
  buildRelationshipState,
  buildMemoryDigest,
  resolveContinuitySlots
} = require('./personaMemoryState/stateBuilders');
const { renderPersonaMemoryPrompt } = require('./personaMemoryState/promptRenderer');
const {
  detectExplicitPersonaFeedback,
  recordPersonaMemoryOutcome
} = require('./personaMemoryState/outcomeRecorder');

const STATE_VERSION = 2;

function buildMemoryContext(...args) {
  return require('./memoryContext').buildMemoryContext(...args);
}

function buildMemoryContextAsync(...args) {
  return require('./memoryContext').buildMemoryContextAsync(...args);
}

function restoreSessionState(...args) {
  return require('./memory-v3').restoreSessionState(...args);
}

function readPromptManifest() {
  try {
    if (!fs.existsSync(config.PROMPT_MANIFEST_PATH)) return null;
    return JSON.parse(fs.readFileSync(config.PROMPT_MANIFEST_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeReadText(filePath = '') {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function loadPersonaCoreText() {
  const manifest = readPromptManifest();
  const sections = Array.isArray(manifest?.system_prompt?.sections)
    ? manifest.system_prompt.sections
    : [];
  const selected = sections.filter((section) => [
    'persona_core',
    'persona_style',
    'persona_policy',
    'persona_behavior',
    'persona_modulation'
  ].includes(String(section?.kind || '').trim()));
  const parts = selected
    .map((section) => safeReadText(path.join(config.PROMPTS_DIR, String(section.path || '').trim())))
    .map((text) => String(text || '').trim())
    .filter(Boolean);
  return parts.join('\n\n').trim() || String(config.SYSTEM_PROMPT || '').trim();
}

async function readSessionProjectionState(userId = '', sessionKey = '', request = {}) {
  if (!config.MEMORY_V3_ENABLED) return { restored: false, mode: 'none', session: null };
  return restoreSessionState(sessionKey, {
    userId,
    groupId: request.groupId || request.routeMeta?.groupId || request.routeMeta?.group_id || '',
    query: request.question || ''
  });
}

function buildContinuityCandidates({
  sessionProjection = {},
  shortTermState = {},
  shortTermRecentMessages = [],
  bridgeState = {},
  bridgeRecentMessages = [],
  sessionSummaries = [],
  journalBundle = {},
  memoryContext = {}
}) {
  const activeTopic = [];
  const openLoops = [];
  const assistantCommitments = [];
  const userConstraints = [];
  const carryOver = [];
  const summary = [];
  const recentReplyFrame = [];
  const phaseHint = [];
  const replyPosture = [];
  const sceneTopic = [];
  const sceneAtmosphere = [];
  const styleAnchors = [];
  const activePersonaModules = [];

  const pushScalar = (bucket, source, value, extras = {}) => {
    const candidate = buildCandidate(source, value, extras);
    if (candidate) bucket.push(candidate);
  };
  const pushList = (bucket, source, values, extras = {}) => {
    for (const value of normalizeArray(values)) {
      const candidate = buildCandidate(source, value, extras);
      if (candidate) bucket.push(candidate);
    }
  };

  const projection = normalizeObject(sessionProjection.session);
  pushScalar(activeTopic, 'session_projection', projection.activeTopic, { confidence: 0.98 });
  pushScalar(carryOver, 'session_projection', projection.carryOverUserTurn, { confidence: 0.98 });
  if (!looksLikePollutedContinuitySummary(projection.summary)) {
    pushScalar(summary, 'session_projection', projection.summary, { confidence: 0.96 });
  }
  pushScalar(phaseHint, 'session_projection', projection.phaseHint, { confidence: 0.92 });
  pushScalar(replyPosture, 'session_projection', projection.expressionState?.replyPosture, { confidence: 0.94 });
  pushScalar(sceneTopic, 'session_projection', projection.sceneState?.activeTopic, { confidence: 0.92 });
  pushScalar(sceneAtmosphere, 'session_projection', projection.sceneState?.atmosphere, { confidence: 0.9 });
  pushList(styleAnchors, 'session_projection', projection.expressionState?.styleAnchors, { confidence: 0.9 });
  pushList(activePersonaModules, 'session_projection', projection.moduleState?.activePersonaModules, { confidence: 0.92 });
  pushList(openLoops, 'session_projection', projection.openLoops, { confidence: 0.96 });
  pushList(assistantCommitments, 'session_projection', projection.assistantCommitments, { confidence: 0.96 });
  pushList(userConstraints, 'session_projection', projection.userConstraints, { confidence: 0.94 });
  if (normalizeArray(projection.recentMessages).length > 0) {
    pushScalar(recentReplyFrame, 'session_projection', createRecentReplyFrameFromMessages(projection.recentMessages)?.summary, { confidence: 0.94 });
  }

  const normalizedBridgeState = normalizeShortTermState(bridgeState);
  pushScalar(activeTopic, 'short_term_bridge', normalizedBridgeState.activeTopic, { confidence: 0.88 });
  pushScalar(carryOver, 'short_term_bridge', normalizedBridgeState.carryOverUserTurn, { confidence: 0.92 });
  if (!looksLikePollutedContinuitySummary(normalizedBridgeState.summary)) {
    pushScalar(summary, 'short_term_bridge', normalizedBridgeState.summary, { confidence: 0.84 });
  }
  pushScalar(phaseHint, 'short_term_bridge', normalizedBridgeState.phaseHint, { confidence: 0.84 });
  pushScalar(replyPosture, 'short_term_bridge', normalizedBridgeState.expression?.replyPosture, { confidence: 0.88 });
  pushScalar(sceneTopic, 'short_term_bridge', normalizedBridgeState.scene?.activeTopic, { confidence: 0.82 });
  pushScalar(sceneAtmosphere, 'short_term_bridge', normalizedBridgeState.scene?.atmosphere, { confidence: 0.8 });
  pushList(styleAnchors, 'short_term_bridge', normalizedBridgeState.expression?.styleAnchors, { confidence: 0.82 });
  pushList(activePersonaModules, 'short_term_bridge', normalizedBridgeState.moduleState?.activePersonaModules, { confidence: 0.86 });
  pushList(openLoops, 'short_term_bridge', normalizedBridgeState.openLoops, { confidence: 0.86 });
  pushList(assistantCommitments, 'short_term_bridge', normalizedBridgeState.assistantCommitments, { confidence: 0.86 });
  pushList(userConstraints, 'short_term_bridge', normalizedBridgeState.userConstraints, { confidence: 0.84 });
  if (normalizeArray(bridgeRecentMessages).length > 0) {
    pushScalar(recentReplyFrame, 'short_term_bridge', createRecentReplyFrameFromMessages(bridgeRecentMessages)?.summary, { confidence: 0.84 });
  }

  const normalizedShortTerm = normalizeShortTermState(shortTermState);
  pushScalar(activeTopic, 'short_term_state', normalizedShortTerm.activeTopic, { confidence: 0.82 });
  pushScalar(carryOver, 'short_term_state', normalizedShortTerm.carryOverUserTurn, { confidence: 0.82 });
  if (!looksLikePollutedContinuitySummary(normalizedShortTerm.summary)) {
    pushScalar(summary, 'short_term_state', normalizedShortTerm.summary, { confidence: 0.78 });
  }
  pushScalar(phaseHint, 'short_term_state', normalizedShortTerm.phaseHint, { confidence: 0.76 });
  pushScalar(replyPosture, 'short_term_state', normalizedShortTerm.expression?.replyPosture, { confidence: 0.76 });
  pushScalar(sceneTopic, 'short_term_state', normalizedShortTerm.scene?.activeTopic, { confidence: 0.72 });
  pushScalar(sceneAtmosphere, 'short_term_state', normalizedShortTerm.scene?.atmosphere, { confidence: 0.7 });
  pushList(styleAnchors, 'short_term_state', normalizedShortTerm.expression?.styleAnchors, { confidence: 0.74 });
  pushList(activePersonaModules, 'short_term_state', normalizedShortTerm.moduleState?.activePersonaModules, { confidence: 0.76 });
  pushList(openLoops, 'short_term_state', normalizedShortTerm.openLoops, { confidence: 0.78 });
  pushList(assistantCommitments, 'short_term_state', normalizedShortTerm.assistantCommitments, { confidence: 0.78 });
  pushList(userConstraints, 'short_term_state', normalizedShortTerm.userConstraints, { confidence: 0.76 });
  if (normalizeArray(shortTermRecentMessages).length > 0) {
    pushScalar(recentReplyFrame, 'short_term_state', createRecentReplyFrameFromMessages(shortTermRecentMessages)?.summary, { confidence: 0.76 });
  }

  const latestSessionSummary = normalizeArray(sessionSummaries)[0];
  pushScalar(summary, 'same_session_summary', latestSessionSummary?.summary, { confidence: 0.72 });
  pushScalar(activeTopic, 'same_session_summary', latestSessionSummary?.structured?.activeTopic, { confidence: 0.72 });
  pushScalar(carryOver, 'same_session_summary', latestSessionSummary?.structured?.carryOverUserTurn, { confidence: 0.72 });
  pushScalar(replyPosture, 'same_session_summary', latestSessionSummary?.structured?.expression?.replyPosture, { confidence: 0.68 });
  pushList(styleAnchors, 'same_session_summary', latestSessionSummary?.structured?.expression?.styleAnchors, { confidence: 0.66 });
  pushList(activePersonaModules, 'same_session_summary', latestSessionSummary?.structured?.moduleState?.activePersonaModules, { confidence: 0.66 });

  const sameSessionJournal = normalizeArray(journalBundle?.continuity?.sameSession);
  const journalEntry = sameSessionJournal[0] || normalizeArray(journalBundle?.continuity?.sameTopic)[0];
  if (journalEntry?.continuitySnapshot) {
    const snapshot = normalizeObject(journalEntry.continuitySnapshot);
    pushScalar(activeTopic, 'same_session_journal', snapshot.activeTopic, { confidence: 0.68 });
    pushScalar(carryOver, 'same_session_journal', snapshot.carryOverUserTurn, { confidence: 0.68 });
    pushList(openLoops, 'same_session_journal', snapshot.openLoops, { confidence: 0.68 });
    pushList(assistantCommitments, 'same_session_journal', snapshot.assistantCommitments, { confidence: 0.66 });
    pushList(userConstraints, 'same_session_journal', snapshot.userConstraints, { confidence: 0.64 });
  }

  pushScalar(activeTopic, 'task_memory', memoryContext.taskMemoryText, { confidence: 0.44 });
  pushScalar(activeTopic, 'group_memory', memoryContext.groupMemoryText, { confidence: 0.42 });

  return {
    activeTopic,
    openLoops,
    assistantCommitments,
    userConstraints,
    carryOver,
    summary,
    recentReplyFrame,
    phaseHint,
    replyPosture,
    sceneTopic,
    sceneAtmosphere,
    styleAnchors,
    activePersonaModules
  };
}

async function composePersonaMemoryState(request = {}, options = {}) {
  const normalizedRequest = normalizeObject(request);
  const routeMeta = normalizeObject(normalizedRequest.routeMeta);
  const userId = normalizeText(normalizedRequest.userId || options.userId);
  const surface = normalizeText(options.surface || normalizedRequest.surface || DEFAULT_SURFACE).toLowerCase() || DEFAULT_SURFACE;
  const groupId = normalizeText(options.groupId || normalizedRequest.groupId || routeMeta.groupId || routeMeta.group_id);
  const sceneKey = normalizeText(
    options.sceneKey
    || normalizedRequest.sceneKey
    || routeMeta.sceneKey
    || resolveShortTermSceneKey(routeMeta)
  );
  const sessionKey = normalizeText(
    options.sessionKey
    || normalizedRequest.sessionKey
    || routeMeta.sessionKey
    || resolveShortTermSessionKey(userId, routeMeta)
  );
  const question = normalizeText(normalizedRequest.question || normalizedRequest.text || options.question, 1000);
  const shortTermStore = normalizeObject(options.shortTermMemory || options.shortTermStore);
  const chatHistory = normalizeObject(options.chatHistory || options.historyStore);
  const sharedShortTermContext = options.sharedShortTermContext && typeof options.sharedShortTermContext === 'object'
    ? options.sharedShortTermContext
    : buildSharedShortTermContextMessages(userId, normalizeObject(options.userInfo), {
      chatHistory,
      shortTermMemory: shortTermStore,
      routeMeta,
      sessionKey
    });
  const shortTermState = normalizeShortTermState(sharedShortTermContext.shortTermState);
  const shortTermRecentMessages = normalizeArray(sharedShortTermContext.recentHistory);
  const bridgeStore = loadBridgeStore();
  const bridgeEntry = normalizeObject(bridgeStore.sessions?.[sessionKey]);
  const bridgeState = normalizeShortTermState(bridgeEntry.shortTermState);
  const bridgeRecentMessages = normalizeArray(bridgeEntry.recentMessages);
  const sceneEntry = sceneKey ? normalizeShortTermState(shortTermStore?.[sceneKey]) : normalizeShortTermState({});
  const sessionProjection = await readSessionProjectionState(userId, sessionKey, {
    ...normalizedRequest,
    groupId
  });
  const sessionSummaries = getRecentSessionContextSummaries(sessionKey, { limit: 3 });
  const journalBundle = getDailyJournalRetrievalBundle(userId, {
    sessionKey,
    question,
    topic: shortTermState.activeTopic || bridgeState.activeTopic || question,
    lookbackDays: options.lookbackDays
  });
  const memoryContext = options.memoryContext && typeof options.memoryContext === 'object'
    ? options.memoryContext
    : await (options.useSyncMemoryContext ? buildMemoryContext : buildMemoryContextAsync)(userId, question, {
      routePolicyKey: normalizeText(normalizedRequest.routePolicyKey || options.routePolicyKey),
      topRouteType: normalizeText(normalizedRequest.topRouteType || options.topRouteType),
      groupId,
      sessionId: normalizeText(routeMeta.sessionId || routeMeta.session_id || normalizedRequest.sessionId),
      sessionKey,
      channelId: normalizeText(routeMeta.channelId || routeMeta.channel_id || normalizedRequest.channelId),
      taskType: normalizeText(routeMeta.taskType || routeMeta.task_type || normalizedRequest.taskType),
      agentName: normalizeText(routeMeta.agentName || routeMeta.agent_name),
      toolName: normalizeText(routeMeta.toolName || routeMeta.tool_name),
      sharedShortTermSignature: sharedShortTermContext.sharedShortTermSignature
    });
  const styleProfile = getStyleProfile(groupId);
  const socialContext = groupId ? getGroupSocialContext(groupId) : {};
  const affinityState = normalizeObject(memoryContext.affinityState) && Object.keys(normalizeObject(memoryContext.affinityState)).length
    ? memoryContext.affinityState
    : getUserAffinityState(userId);
  const profile = getUserProfile(userId) || {};
  const relationshipState = buildRelationshipState({
    userId,
    groupId,
    memoryContext,
    affinityState,
    profile
  });
  const continuityCandidates = buildContinuityCandidates({
    sessionProjection,
    shortTermState,
    shortTermRecentMessages,
    bridgeState,
    bridgeRecentMessages,
    sessionSummaries,
    journalBundle,
    memoryContext
  });
  const continuityState = resolveContinuitySlots(continuityCandidates, getSurfacePolicy(surface));
  if (!continuityState.sceneTopic && sceneEntry?.scene?.activeTopic) {
    continuityState.sceneTopic = sceneEntry.scene.activeTopic;
    continuityState.sources.sceneTopic = continuityState.sources.sceneTopic || 'scene_state';
  }
  if (!continuityState.sceneAtmosphere && sceneEntry?.scene?.atmosphere) {
    continuityState.sceneAtmosphere = sceneEntry.scene.atmosphere;
    continuityState.sources.sceneAtmosphere = continuityState.sources.sceneAtmosphere || 'scene_state';
  }
  if (normalizeArray(continuityState.styleAnchors).length === 0 && normalizeArray(sceneEntry?.expression?.styleAnchors).length > 0) {
    continuityState.styleAnchors = uniqueStrings(sceneEntry.expression.styleAnchors, 4, 96);
    continuityState.sources.styleAnchors = continuityState.sources.styleAnchors || ['scene_state'];
  }
  if (normalizeArray(continuityState.activePersonaModules).length === 0 && normalizeArray(shortTermState?.moduleState?.activePersonaModules).length > 0) {
    continuityState.activePersonaModules = uniqueStrings(shortTermState.moduleState.activePersonaModules, 2, 64);
    continuityState.sources.activePersonaModules = continuityState.sources.activePersonaModules || ['short_term_state'];
  }
  const recentReplyFrame = createRecentReplyFrameFromMessages(
    normalizeArray(sessionProjection.session?.recentMessages).length
      ? sessionProjection.session.recentMessages
      : (normalizeArray(bridgeRecentMessages).length ? bridgeRecentMessages : shortTermRecentMessages)
  );
  if (recentReplyFrame?.summary && !continuityState.recentReplyFrame) {
    continuityState.recentReplyFrame = recentReplyFrame.summary;
    continuityState.sources.recentReplyFrame = continuityState.sources.recentReplyFrame || 'recent_messages';
  }
  const expressionState = buildExpressionState({
    surface,
    relationshipState,
    styleProfile,
    socialContext,
    memoryContext
  });
  const inheritedReplyPosture = normalizeReplyPosture(
    shortTermState.expression?.replyPosture
    || bridgeState.expression?.replyPosture
    || continuityState.replyPosture
  );
  expressionState.replyPosture = buildExpressionValue(
    inheritedReplyPosture || inferReplyPostureFromSignals({
      surface,
      expressionState: shortTermState.expression || {},
      continuityState,
      question
    }),
    inheritedReplyPosture ? 'short_term_state' : 'runtime_inference'
  );
  if (normalizeArray(continuityState.styleAnchors).length > 0) {
    expressionState.styleAnchors = {
      value: continuityState.styleAnchors.join(' | '),
      source: normalizeArray(continuityState.sources?.styleAnchors).length > 0
        ? continuityState.sources.styleAnchors[0]
        : 'continuity_state'
    };
  }

  const currentModuleState = normalizeModuleState(shortTermState.moduleState || bridgeState.moduleState || {});
  const requestedModuleIds = normalizeArray(options.personaModules || normalizedRequest.personaModules).map((item) => normalizeText(item)).filter(Boolean);
  const candidateModuleIds = requestedModuleIds.length > 0 ? requestedModuleIds : normalizeArray(continuityState.activePersonaModules);
  let nextModuleState = normalizeModuleState({
    ...currentModuleState,
    activePersonaModules: candidateModuleIds.length > 0 ? candidateModuleIds : currentModuleState.activePersonaModules,
    lastSurface: surface,
    lastTopicFingerprint: computeTopicFingerprint([continuityState.activeTopic, continuityState.sceneTopic, question]),
    lastUpdatedAt: Date.now()
  });
  const previousTopicFingerprint = normalizeText(currentModuleState.lastTopicFingerprint);
  const currentTopicFingerprint = normalizeText(nextModuleState.lastTopicFingerprint);
  const explicitFeedback = detectExplicitPersonaFeedback(question);
  const sameSurface = normalizeText(currentModuleState.lastSurface) === surface;
  const topicStable = previousTopicFingerprint && previousTopicFingerprint === currentTopicFingerprint;
  const currentModules = uniqueStrings(currentModuleState.activePersonaModules, 2, 64);
  const requestedModules = uniqueStrings(candidateModuleIds, 2, 64);
  const requestedChanged = JSON.stringify(currentModules) !== JSON.stringify(requestedModules);
  if (currentModules.length > 0 && sameSurface && topicStable && !explicitFeedback.isFeedback && !requestedChanged && Number(continuityState.confidence || 0) >= 0.55) {
    nextModuleState = normalizeModuleState({
      ...nextModuleState,
      activePersonaModules: currentModules,
      stickyTurnsRemaining: Math.max(0, Math.min(5, Number(currentModuleState.stickyTurnsRemaining || 3) || 3)),
      switchReason: currentModuleState.switchReason || 'sticky_continue'
    });
  } else if (currentModules.length > 0 && requestedChanged) {
    nextModuleState = normalizeModuleState({
      ...nextModuleState,
      activePersonaModules: requestedModules,
      stickyTurnsRemaining: 3,
      switchReason: 'requested_switch'
    });
  } else if (currentModules.length > 0 && !sameSurface) {
    nextModuleState = normalizeModuleState({
      ...nextModuleState,
      stickyTurnsRemaining: 3,
      switchReason: 'surface_changed'
    });
  } else if (currentModules.length > 0 && previousTopicFingerprint && previousTopicFingerprint !== currentTopicFingerprint) {
    nextModuleState = normalizeModuleState({
      ...nextModuleState,
      activePersonaModules: requestedModules.length > 0 ? requestedModules : currentModules,
      stickyTurnsRemaining: 3,
      switchReason: 'topic_shift'
    });
  } else if (explicitFeedback.isFeedback) {
    nextModuleState = normalizeModuleState({
      ...nextModuleState,
      stickyTurnsRemaining: 3,
      switchReason: explicitFeedback.polarity === 'negative' ? 'explicit_negative_feedback' : 'explicit_positive_feedback'
    });
  } else if (currentModules.length === 0 && requestedModules.length > 0) {
    nextModuleState = normalizeModuleState({
      ...nextModuleState,
      activePersonaModules: requestedModules,
      stickyTurnsRemaining: 3,
      switchReason: 'new_activation'
    });
  }

  continuityState.phaseHint = continuityState.phaseHint || shortTermState.phaseHint || shortTermState.interaction?.phaseHint || '';
  continuityState.replyPosture = expressionState.replyPosture.value || continuityState.replyPosture;
  continuityState.activePersonaModules = uniqueStrings(
    nextModuleState.activePersonaModules.length > 0 ? nextModuleState.activePersonaModules : continuityState.activePersonaModules,
    2,
    64
  );
  continuityState.styleAnchors = uniqueStrings(
    normalizeArray(continuityState.styleAnchors).length > 0
      ? continuityState.styleAnchors
      : normalizeArray(shortTermState.expression?.styleAnchors),
    4,
    96
  );

  const memoryDigest = buildMemoryDigest(memoryContext, { surface });
  const personaCore = {
    text: loadPersonaCoreText(),
    source: 'static_persona_manifest'
  };
  const evidence = {
    continuityCandidates,
    sessionProjection: normalizeObject(sessionProjection.session),
    shortTermBridge: bridgeEntry,
    shortTermState,
    sessionSummaries,
    journal: normalizeObject(journalBundle.continuity),
    memoryContext: {
      promptRetrievedMemoryText: memoryContext.promptRetrievedMemoryText || '',
      styleSignalText: memoryContext.styleSignalText || '',
      taskMemoryText: memoryContext.taskMemoryText || '',
      groupMemoryText: memoryContext.groupMemoryText || '',
      dailyJournalText: memoryContext.promptDailyJournalText || memoryContext.dailyJournalText || '',
      persona: normalizeObject(memoryContext.persona)
    },
    styleProfile,
    socialContext,
    affinityState
  };

  return {
    version: STATE_VERSION,
    surface,
    sceneKey,
    sessionKey,
    userId,
    groupId,
    personaCore,
    relationshipState,
    continuityState,
    expressionState,
    moduleState: nextModuleState,
    memoryDigest,
    evidence
  };
}

module.exports = {
  CONTINUITY_PRIORITY,
  STATE_VERSION,
  composePersonaMemoryState,
  getSurfacePolicy,
  recordPersonaMemoryOutcome,
  renderPersonaMemoryPrompt,
  resolveContinuitySlots
};
