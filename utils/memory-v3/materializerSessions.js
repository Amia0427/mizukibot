const config = require('../../config');
const {
  normalizeText,
  clampText
} = require('./helpers');
const {
  normalizeSessionScopeFromEvent
} = require('./materializerNodes');

function shouldApplySessionEvent(event = {}) {
  return event.type === 'turn_received'
    || event.type === 'turn_replied'
    || event.type === 'session_checkpoint';
}

function defaultSessionEntry({ sessionKey, userId }) {
  return {
    sessionKey,
    userId,
    groupId: '',
    channelId: '',
    sessionId: '',
    updatedAt: 0,
    snapshotType: '',
    activeTopic: '',
    openLoops: [],
    assistantCommitments: [],
    userConstraints: [],
    recentMessages: [],
    carryOverUserTurn: '',
    summary: '',
    phaseHint: '',
    interactionState: {},
    sceneState: {},
    expressionState: {},
    moduleState: {}
  };
}

function clearsRestartRecallTopic(event = {}, payload = {}) {
  return event.type === 'session_checkpoint'
    && Object.prototype.hasOwnProperty.call(payload, 'activeTopic')
    && (
      normalizeText(event.sourceKind).toLowerCase() === 'restart_recall_clear'
      || normalizeText(payload.summarySource || payload.source || '').toLowerCase() === 'restart_recall_clear'
    );
}

function normalizeRecentMessages(list = []) {
  return list
    .map((item) => ({
      role: normalizeText(item?.role).toLowerCase(),
      content: clampText(item?.content, 320)
    }))
    .filter((item) => item.role && item.content)
    .slice(-Math.max(1, Number(config.MEMORY_V3_SESSION_RECENT_MESSAGES || 6)));
}

function applySessionEvent(sessionProjection, event = {}) {
  if (!shouldApplySessionEvent(event)) return false;
  const userId = normalizeText(event.userId);
  const sessionKey = normalizeText(event.sessionKey);
  if (!sessionKey) return false;

  const existing = sessionProjection.sessions[sessionKey] || defaultSessionEntry({ sessionKey, userId });
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const shouldClearTopic = clearsRestartRecallTopic(event, payload);
  sessionProjection.sessions[sessionKey] = {
    ...existing,
    ...normalizeSessionScopeFromEvent(event),
    updatedAt: Math.max(Number(existing.updatedAt || 0), Number(event.ts || 0)),
    snapshotType: normalizeText(payload.snapshotType || existing.snapshotType),
    activeTopic: Object.prototype.hasOwnProperty.call(payload, 'activeTopic')
      ? normalizeText(payload.activeTopic)
      : normalizeText(existing.activeTopic),
    carryOverUserTurn: Object.prototype.hasOwnProperty.call(payload, 'carryOverUserTurn')
      ? normalizeText(payload.carryOverUserTurn)
      : normalizeText(existing.carryOverUserTurn),
    summary: Object.prototype.hasOwnProperty.call(payload, 'summary')
      ? clampText(payload.summary, 2400)
      : clampText(existing.summary, 2400),
    phaseHint: normalizeText(payload.phaseHint || existing.phaseHint),
    openLoops: Array.isArray(payload.openLoops) ? payload.openLoops.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4) : existing.openLoops,
    assistantCommitments: Array.isArray(payload.assistantCommitments) ? payload.assistantCommitments.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4) : existing.assistantCommitments,
    userConstraints: Array.isArray(payload.userConstraints) ? payload.userConstraints.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4) : existing.userConstraints,
    interactionState: shouldClearTopic
      ? {
          ...(existing.interactionState && typeof existing.interactionState === 'object' ? existing.interactionState : {}),
          activeTopic: normalizeText(payload.activeTopic)
        }
      : payload.interactionState && typeof payload.interactionState === 'object'
        ? payload.interactionState
        : existing.interactionState,
    sceneState: payload.sceneState && typeof payload.sceneState === 'object'
      ? payload.sceneState
      : existing.sceneState,
    expressionState: payload.expressionState && typeof payload.expressionState === 'object'
      ? payload.expressionState
      : existing.expressionState,
    moduleState: payload.moduleState && typeof payload.moduleState === 'object'
      ? payload.moduleState
      : existing.moduleState,
    recentMessages: Array.isArray(payload.recentMessages)
      ? normalizeRecentMessages(payload.recentMessages)
      : existing.recentMessages
  };
  return true;
}

module.exports = {
  applySessionEvent,
  clearsRestartRecallTopic,
  defaultSessionEntry,
  normalizeRecentMessages,
  shouldApplySessionEvent
};
