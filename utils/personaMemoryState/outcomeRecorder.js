const config = require('../../config');
const { resolveShortTermSessionKey } = require('../shortTermMemory');
const { sanitizeUntrustedContent, shouldBlockMemoryLearning } = require('../promptSecurity');
const {
  DEFAULT_SURFACE,
  computeTopicFingerprint,
  normalizeArray,
  normalizeObject,
  normalizeText,
  uniqueStrings
} = require('./helpers');

function appendMemoryEvent(...args) {
  return require('../memory-v3').appendMemoryEvent(...args);
}

function appendVersionedMemoryUpdate(...args) {
  return require('../memory-v3').appendVersionedMemoryUpdate(...args);
}

function materializeMemoryViews(...args) {
  return require('../memory-v3').materializeMemoryViews(...args);
}

function deriveSessionCheckpointPayload(state = {}, payload = {}) {
  const continuity = normalizeObject(state.continuityState);
  const expression = normalizeObject(state.expressionState);
  const moduleState = normalizeObject(state.moduleState);
  const recentReplyFrame = normalizeText(payload.recentReplyFrame || continuity.recentReplyFrame, 320);
  const recentMessages = normalizeArray(payload.recentMessages)
    .map((item) => ({
      role: normalizeText(item?.role || '', 16).toLowerCase(),
      content: normalizeText(item?.content || item?.text || '', 320)
    }))
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.content)
    .slice(-Math.max(1, Number(config.MEMORY_V3_SESSION_RECENT_MESSAGES || 6)));

  if (!recentMessages.length && recentReplyFrame) {
    recentMessages.push({ role: 'assistant', content: recentReplyFrame });
  }

  return {
    snapshotType: normalizeText(payload.snapshotType || 'post_reply'),
    activeTopic: normalizeText(payload.activeTopic || continuity.activeTopic, 180),
    carryOverUserTurn: normalizeText(payload.carryOverUserTurn || continuity.carryOverUserTurn, 220),
    summary: normalizeText(payload.summary || continuity.summary, 2400),
    openLoops: uniqueStrings(payload.openLoops || continuity.openLoops, 4, 120),
    assistantCommitments: uniqueStrings(payload.assistantCommitments || continuity.assistantCommitments, 4, 120),
    userConstraints: uniqueStrings(payload.userConstraints || continuity.userConstraints, 4, 120),
    recentMessages,
    phaseHint: normalizeText(payload.phaseHint || continuity.phaseHint, 48),
    interactionState: {
      activeTopic: normalizeText(payload.activeTopic || continuity.activeTopic, 180),
      carryOverUserTurn: normalizeText(payload.carryOverUserTurn || continuity.carryOverUserTurn, 220),
      openLoops: uniqueStrings(payload.openLoops || continuity.openLoops, 4, 120),
      assistantCommitments: uniqueStrings(payload.assistantCommitments || continuity.assistantCommitments, 4, 120),
      userConstraints: uniqueStrings(payload.userConstraints || continuity.userConstraints, 4, 120),
      recentTurns: recentMessages,
      phaseHint: normalizeText(payload.phaseHint || continuity.phaseHint, 48),
      sourceFlags: uniqueStrings(continuity.sources?.activePersonaModules || continuity.sources?.styleAnchors || [], 8, 80),
      confidence: Math.max(0, Math.min(1, Number(continuity.confidence || 0) || 0))
    },
    sceneState: {
      sceneKey: normalizeText(payload.sceneKey || state.sceneKey, 96),
      activeTopic: normalizeText(payload.sceneTopic || continuity.sceneTopic, 180),
      atmosphere: normalizeText(payload.sceneAtmosphere || continuity.sceneAtmosphere, 120),
      activePair: normalizeText(payload.activePair || '', 120),
      quoteAnchor: normalizeText(payload.quoteAnchor || '', 180),
      jargonHints: uniqueStrings(payload.jargonHints || [], 4, 80),
      recentTurns: recentMessages.slice(-Math.max(2, Math.min(48, Math.floor(Number(config.SHORT_TERM_SCENE_RECENT_TURNS || 16) || 16)))),
      confidence: Math.max(0, Math.min(1, Number(payload.sceneConfidence || continuity.confidence || 0) || 0))
    },
    expressionState: {
      replyPosture: normalizeText(payload.replyPosture || continuity.replyPosture || expression.replyPosture?.value || expression.replyPosture, 24),
      warmth: normalizeText(payload.warmth || expression.warmth?.value || expression.warmth, 24),
      guardedness: normalizeText(payload.guardedness || expression.guardedness?.value || expression.guardedness, 24),
      initiative: normalizeText(payload.initiative || expression.initiative?.value || expression.initiative, 24),
      jargonMode: normalizeText(payload.jargonMode || expression.jargon?.value || expression.jargon, 24),
      cadenceHint: normalizeText(payload.cadenceHint || '', 48),
      styleAnchors: uniqueStrings(payload.styleAnchors || continuity.styleAnchors || [], 4, 96),
      confidence: Math.max(0, Math.min(1, Number(payload.expressionConfidence || continuity.confidence || 0) || 0))
    },
    moduleState: {
      activePersonaModules: uniqueStrings(payload.activePersonaModules || moduleState.activePersonaModules || continuity.activePersonaModules || [], 2, 64),
      stickyTurnsRemaining: Math.max(0, Math.min(5, Number(payload.stickyTurnsRemaining || moduleState.stickyTurnsRemaining || 0) || 0)),
      switchReason: normalizeText(payload.switchReason || moduleState.switchReason, 160),
      lastSurface: normalizeText(payload.lastSurface || state.surface, 32),
      lastTopicFingerprint: normalizeText(payload.lastTopicFingerprint || computeTopicFingerprint([continuity.activeTopic, continuity.sceneTopic]), 96),
      lastUpdatedAt: Date.now()
    }
  };
}

function flattenExpressionState(expression = {}) {
  const normalized = normalizeObject(expression);
  return Object.entries(normalized).reduce((acc, [key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      acc[key] = normalizeText(value.value || '', 32);
      acc[`${key}Source`] = normalizeText(value.source || '', 32);
      return acc;
    }
    acc[key] = normalizeText(value, 32);
    return acc;
  }, {});
}

function detectExplicitPersonaFeedback(text = '') {
  const normalized = normalizeText(text, 800);
  if (!normalized) return { isFeedback: false, polarity: '', text: '' };
  if (/(你这样说更好|你这样就对了|这样说挺好|保持这样|就按这个风格|这样回复我喜欢)/i.test(normalized)) {
    return { isFeedback: true, polarity: 'positive', text: normalized };
  }
  if (/(别这么说|不要这么说|你太.*了|你别.*语气|别那么.*|不要这么回复|你这样说我不喜欢)/i.test(normalized)) {
    return { isFeedback: true, polarity: 'negative', text: normalized };
  }
  return { isFeedback: false, polarity: '', text: normalized };
}

function buildBotPersonaSlots(state = {}, payload = {}) {
  const expression = flattenExpressionState(state.expressionState);
  const personaText = normalizeText(state.evidence?.memoryContext?.persona?.botBasePersona || '', 320);
  const out = [];
  const push = (fieldKey, value, confidence = 0.78, sourceKind = 'runtime') => {
    const normalized = normalizeText(value, 140);
    if (!normalized) return;
    out.push({ fieldKey, value: normalized, confidence, sourceKind });
  };

  if (expression.warmth) push('bot_persona_tone', `基础语气偏${expression.warmth}`, 0.78);
  if (expression.initiative) push('bot_persona_initiative', `互动主动性=${expression.initiative}`, 0.8);
  if (expression.guardedness) push('bot_persona_guardedness', `边界感=${expression.guardedness}`, 0.8);
  if (expression.playfulness) push('bot_persona_playfulness', `玩笑感=${expression.playfulness}`, 0.78);
  if (expression.verbosity) push('bot_persona_verbosity', `回复详细度=${expression.verbosity}`, 0.78);
  if (personaText) push('bot_persona_boundaries', personaText, 0.84);

  const feedback = detectExplicitPersonaFeedback(
    `${normalizeText(payload.question || payload.userText || '', 320)} ${normalizeText(payload.finalReply || payload.reply || '', 320)}`
  );
  if (feedback.isFeedback) {
    push('bot_persona_tone', `用户对基础语气的${feedback.polarity === 'positive' ? '正向' : '负向'}反馈：${feedback.text}`, 0.9, 'explicit_feedback');
  }
  return out;
}

function buildRelationshipStyleSlots(state = {}, payload = {}) {
  const relationship = normalizeObject(state.relationshipState);
  const expression = flattenExpressionState(state.expressionState);
  const relationshipText = normalizeText(state.evidence?.memoryContext?.persona?.relationshipStyle || state.evidence?.memoryContext?.persona?.userAdaptationPersona || '', 320);
  const out = [];
  const push = (fieldKey, value, confidence = 0.8, sourceKind = 'runtime') => {
    const normalized = normalizeText(value, 160);
    if (!normalized) return;
    out.push({ fieldKey, value: normalized, confidence, sourceKind });
  };

  if (relationshipText) push('relationship_reply_style', relationshipText.replace(/relationship_[a-z_]+:\s*/gi, ''), 0.84);
  if (relationship.attitude) push('relationship_tone', relationship.attitude, 0.8);
  if (relationship.distanceMode) push('relationship_distance', relationship.distanceMode, 0.82);
  if (relationship.salutationStyle || relationship.salutationPolicy) push('relationship_salutation', relationship.salutationStyle || relationship.salutationPolicy, 0.8);
  if (relationship.replyStylePolicy) push('relationship_reply_style', relationship.replyStylePolicy, 0.82);
  if (expression.initiative) push('relationship_engagement', `互动积极度=${expression.initiative}`, 0.76);
  if (expression.guardedness) push('relationship_boundaries', `关系边界=${expression.guardedness}`, 0.76);

  const feedback = detectExplicitPersonaFeedback(normalizeText(payload.question || payload.userText || '', 320));
  if (feedback.isFeedback) {
    push('relationship_reply_style', `用户对相处语气的${feedback.polarity === 'positive' ? '正向' : '负向'}反馈：${feedback.text}`, 0.92, 'explicit_feedback');
  }
  return out;
}

async function recordPersonaMemoryOutcome(surface = '', payload = {}) {
  const normalizedPayload = normalizeObject(payload);
  const state = normalizeObject(normalizedPayload.state);
  const request = normalizeObject(normalizedPayload.request);
  const routeMeta = normalizeObject(request.routeMeta || normalizedPayload.routeMeta);
  const userId = normalizeText(normalizedPayload.userId || request.userId || state.userId);
  const sessionKey = normalizeText(
    normalizedPayload.sessionKey
    || request.sessionKey
    || state.sessionKey
    || resolveShortTermSessionKey(userId, routeMeta)
  );
  if (!config.MEMORY_V3_ENABLED || !userId || !sessionKey) {
    return { updatedSlots: {}, persisted: false };
  }

  const continuity = normalizeObject(state.continuityState);
  const expression = normalizeObject(state.expressionState);
  const groupId = normalizeText(normalizedPayload.groupId || request.groupId || routeMeta.groupId || routeMeta.group_id || state.groupId);
  const channelId = normalizeText(routeMeta.channelId || routeMeta.channel_id || request.channelId);
  const sessionId = normalizeText(routeMeta.sessionId || routeMeta.session_id || request.sessionId);
  const routePolicyKey = normalizeText(request.routePolicyKey || normalizedPayload.routePolicyKey);
  const topRouteType = normalizeText(request.topRouteType || normalizedPayload.topRouteType);
  const flattenedExpression = flattenExpressionState(expression);
  const expressionFingerprint = Object.entries(flattenedExpression)
    .map(([key, value]) => `${key}=${normalizeText(value, 32)}`)
    .filter(Boolean)
    .join(', ');
  const expressionGate = shouldBlockMemoryLearning(expressionFingerprint, 'style_pattern', {
    routePolicyKey,
    topRouteType
  });
  const checkpointPayload = deriveSessionCheckpointPayload(state, normalizedPayload);

  await appendMemoryEvent({
    type: 'session_checkpoint',
    userId,
    sessionKey,
    groupId,
    channelId,
    sessionId,
    routePolicyKey,
    topRouteType,
    scopeType: 'session',
    source: normalizeText(surface || state.surface || DEFAULT_SURFACE),
    sourceKind: 'runtime',
    payload: checkpointPayload
  });

  const botPersonaSlots = buildBotPersonaSlots(state, {
    ...normalizedPayload,
    question: request.question || normalizedPayload.question || '',
    finalReply: normalizedPayload.finalReply || normalizedPayload.reply || ''
  });
  const relationshipSlots = buildRelationshipStyleSlots(state, {
    ...normalizedPayload,
    question: request.question || normalizedPayload.question || '',
    finalReply: normalizedPayload.finalReply || normalizedPayload.reply || ''
  });

  const sourceName = normalizeText(surface || state.surface || DEFAULT_SURFACE);
  const writePersonaSlot = async (memoryKind, fieldKey, value, options = {}) => {
    const sanitizedValue = sanitizeUntrustedContent(value, 'memory');
    if (!sanitizedValue) return false;
    await appendVersionedMemoryUpdate({
      type: 'memory_confirmed',
      userId,
      sessionKey,
      groupId,
      channelId,
      sessionId,
      routePolicyKey,
      topRouteType,
      scopeType: 'personal',
      source: sourceName,
      sourceKind: options.sourceKind || 'runtime',
      status: 'active',
      memoryKind,
      semanticSlot: fieldKey,
      text: sanitizedValue,
      payload: {
        fieldKey,
        type: 'fact'
      },
      confidence: Number(options.confidence || 0.8) || 0.8,
      importance: Number(options.importance || 0.72) || 0.72,
      evidenceCount: Math.max(2, Number(options.evidenceCount || 2) || 2)
    });
    return true;
  };

  if (expressionFingerprint && !expressionGate.blocked) {
    await appendVersionedMemoryUpdate({
      type: 'memory_confirmed',
      userId,
      sessionKey,
      groupId,
      channelId,
      sessionId,
      routePolicyKey,
      topRouteType,
      scopeType: 'personal',
      source: sourceName,
      sourceKind: 'runtime',
      status: 'active',
      memoryKind: 'style',
      semanticSlot: 'style_pattern',
      text: `style: ${sanitizeUntrustedContent(expressionFingerprint, 'memory')}`,
      payload: {
        fieldKey: 'style_pattern',
        type: 'fact'
      },
      confidence: 0.7,
      importance: 0.6,
      evidenceCount: 1
    });
  }

  const personaSlotsUpdated = [];
  for (const slot of botPersonaSlots) {
    const wrote = await writePersonaSlot('bot_persona', slot.fieldKey, slot.value, {
      confidence: slot.confidence,
      importance: slot.sourceKind === 'explicit_feedback' ? 0.88 : 0.72,
      sourceKind: slot.sourceKind,
      evidenceCount: slot.sourceKind === 'explicit_feedback' ? 3 : 2
    });
    if (wrote) personaSlotsUpdated.push(slot.fieldKey);
  }

  const relationshipSlotsUpdated = [];
  for (const slot of relationshipSlots) {
    const wrote = await writePersonaSlot('relationship_style', slot.fieldKey, slot.value, {
      confidence: slot.confidence,
      importance: slot.sourceKind === 'explicit_feedback' ? 0.9 : 0.76,
      sourceKind: slot.sourceKind,
      evidenceCount: slot.sourceKind === 'explicit_feedback' ? 3 : 2
    });
    if (wrote) relationshipSlotsUpdated.push(slot.fieldKey);
  }

  materializeMemoryViews();
  return {
    updatedSlots: {
      activeTopic: checkpointPayload.activeTopic,
      openLoops: checkpointPayload.openLoops,
      assistantCommitments: checkpointPayload.assistantCommitments,
      userConstraints: checkpointPayload.userConstraints,
      carryOverUserTurn: checkpointPayload.carryOverUserTurn,
      replyPosture: checkpointPayload.expressionState?.replyPosture || '',
      activePersonaModules: uniqueStrings(checkpointPayload.moduleState?.activePersonaModules || [], 2, 64),
      recentReplyFrame: continuity.recentReplyFrame || '',
      personaSlotsUpdated: uniqueStrings(personaSlotsUpdated, 12, 80),
      relationshipSlotsUpdated: uniqueStrings(relationshipSlotsUpdated, 12, 80)
    },
    persisted: true
  };
}

module.exports = {
  buildBotPersonaSlots,
  buildRelationshipStyleSlots,
  deriveSessionCheckpointPayload,
  detectExplicitPersonaFeedback,
  flattenExpressionState,
  recordPersonaMemoryOutcome
};
