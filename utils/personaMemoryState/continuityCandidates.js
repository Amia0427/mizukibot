const {
  normalizeShortTermState
} = require('../shortTermMemory');
const {
  buildCandidate,
  createRecentReplyFrameFromMessages,
  looksLikePollutedContinuitySummary,
  normalizeArray,
  normalizeObject
} = require('./helpers');

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

module.exports = {
  buildContinuityCandidates
};
