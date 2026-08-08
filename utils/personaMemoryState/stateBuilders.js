const {
  buildExpressionValue,
  chooseBestScalar,
  getSurfacePolicy,
  inferGuardedness,
  inferInitiative,
  inferJargon,
  inferPlayfulness,
  inferTease,
  inferVerbosity,
  inferWarmth,
  mergeListCandidates,
  normalizeArray,
  normalizeEvidenceItem,
  normalizeObject,
  normalizeText,
  parsePersonaPreference,
  uniqueBy
} = require('./helpers');
const { formatCharacterState } = require('../conversationVariables');

function deriveCharacterExpressionState(character = {}) {
  const mood = Number(character.mood || 0);
  const energy = Number(character.energy || 0);
  const stress = Number(character.stress || 0);
  const socialWillingness = Number(character.socialWillingness || 0);
  return {
    warmth: mood <= -30 || stress >= 65
      ? 'low'
      : (mood >= 30 && socialWillingness >= 60 ? 'high' : ''),
    initiative: energy <= 35 || socialWillingness <= 35 || stress >= 70
      ? 'reply'
      : (energy >= 70 && socialWillingness >= 70 && stress < 50 ? 'proactive' : ''),
    guardedness: stress >= 70 || socialWillingness <= 35
      ? 'guarded'
      : (mood >= 20 && socialWillingness >= 70 ? 'soft_open' : '')
  };
}

function buildExpressionState({ surface, relationshipState, styleProfile, socialContext, memoryContext, variableSnapshot }) {
  const persona = normalizeObject(memoryContext.persona, {});
  const relationshipStyle = normalizeText(persona.relationshipStyle || persona.userAdaptationPersona, 320);
  const botBasePersona = normalizeText(persona.botBasePersona, 320);
  const relationshipWarmth = parsePersonaPreference(relationshipStyle, 'relationship_tone');
  const personaWarmth = parsePersonaPreference(botBasePersona, 'bot_persona_tone');
  const personaInitiative = parsePersonaPreference(botBasePersona, 'bot_persona_initiative');
  const relationshipInitiative = parsePersonaPreference(relationshipStyle, 'relationship_engagement');
  const relationshipGuardedness = parsePersonaPreference(relationshipStyle, 'relationship_distance');
  const personaGuardedness = parsePersonaPreference(botBasePersona, 'bot_persona_guardedness');
  const characterExpression = variableSnapshot?.character
    ? deriveCharacterExpressionState(variableSnapshot.character)
    : {};
  const warmth = characterExpression.warmth
    || relationshipWarmth
    || personaWarmth
    || inferWarmth(relationshipState.relationship, relationshipState.attitude, surface);
  const playfulness = parsePersonaPreference(botBasePersona, 'bot_persona_playfulness')
    || inferPlayfulness(styleProfile, socialContext, surface);
  const initiative = characterExpression.initiative
    || personaInitiative
    || relationshipInitiative
    || inferInitiative(surface);
  const guardedness = characterExpression.guardedness
    || relationshipGuardedness
    || personaGuardedness
    || inferGuardedness(surface, relationshipState.relationship);
  const verbosity = parsePersonaPreference(botBasePersona, 'bot_persona_verbosity')
    || inferVerbosity(surface, styleProfile);
  return {
    warmth: buildExpressionValue(warmth, characterExpression.warmth ? 'conversation_variables' : (relationshipWarmth ? 'relationship_memory' : (personaWarmth ? 'persona_memory' : 'runtime_inference'))),
    playfulness: buildExpressionValue(playfulness, parsePersonaPreference(botBasePersona, 'bot_persona_playfulness') ? 'persona_memory' : 'runtime_inference'),
    tease: buildExpressionValue(inferTease(styleProfile, socialContext, surface), 'runtime_inference'),
    initiative: buildExpressionValue(initiative, characterExpression.initiative ? 'conversation_variables' : (personaInitiative ? 'persona_memory' : (relationshipInitiative ? 'relationship_memory' : 'surface_policy'))),
    jargon: buildExpressionValue(inferJargon(surface, relationshipState.groupId, memoryContext?.styleSignalText), 'surface_policy'),
    verbosity: buildExpressionValue(verbosity, parsePersonaPreference(botBasePersona, 'bot_persona_verbosity') ? 'persona_memory' : 'runtime_inference'),
    guardedness: buildExpressionValue(guardedness, characterExpression.guardedness ? 'conversation_variables' : (relationshipGuardedness ? 'relationship_memory' : (personaGuardedness ? 'persona_memory' : 'surface_policy'))),
    characterState: variableSnapshot?.character ? formatCharacterState(variableSnapshot) : ''
  };
}

function buildRelationshipState({ userId, groupId, memoryContext, affinityState, profile, variableSnapshot }) {
  const persona = normalizeObject(memoryContext.persona, {});
  const relationshipStyle = normalizeText(persona.relationshipStyle || persona.userAdaptationPersona, 320);
  const relation = normalizeText(
    variableSnapshot?.relationship?.stageLabel
    || profile?.relation_stage
    || memoryContext?.profile?.relation_stage
    || affinityState?.relationship
    || affinityState?.level
    || '陌生人',
    48
  ) || '陌生人';
  const attitude = normalizeText(
    variableSnapshot?.relationship?.attitude
    || affinityState?.attitude
    || memoryContext?.impressionText
    || '中立、保持距离',
    160
  ) || '中立、保持距离';
  const inferredDistance = variableSnapshot?.relationship?.boundaryMode
    || (relation === '亲密伙伴' ? 'close' : (relation === '普通朋友' ? 'friendly' : 'reserved'));
  return {
    userId: normalizeText(userId),
    groupId: normalizeText(groupId),
    relationship: relation,
    attitude,
    replyStylePolicy: normalizeText(
      parsePersonaPreference(relationshipStyle, 'relationship_reply_style')
      || persona.replyStyle
      || memoryContext?.affinityState?.replyStylePolicy
      || '',
      220
    ),
    salutationPolicy: relation === '亲密伙伴' ? 'close' : (relation === '普通朋友' ? 'friendly' : 'reserved'),
    distanceMode: normalizeText(
      parsePersonaPreference(relationshipStyle, 'relationship_distance')
      || inferredDistance,
      64
    ),
    salutationStyle: normalizeText(parsePersonaPreference(relationshipStyle, 'relationship_salutation') || '', 120)
  };
}

function buildMemoryDigest(memoryContext = {}, options = {}) {
  const surfacePolicy = getSurfacePolicy(options.surface);
  const items = [];
  const push = (source, label, text, confidence = 0.5) => {
    const normalized = normalizeEvidenceItem({ source, label, text, confidence }, source);
    if (normalized) items.push(normalized);
  };

  push('generic_recall', 'retrieved', memoryContext.promptRetrievedMemoryText || memoryContext.retrievedMemoryForPrompt, 0.72);
  push('task_memory', 'task', memoryContext.taskMemoryText, 0.66);
  push('group_memory', 'group', memoryContext.groupMemoryText, 0.62);
  push('generic_recall', 'profile', memoryContext.promptLongTermProfileText || memoryContext.longTermProfileText, 0.7);
  push('bot_persona', 'bot_persona', memoryContext.persona?.botBasePersona, 0.82);
  push('relationship_style', 'relationship_style', memoryContext.persona?.relationshipStyle || memoryContext.persona?.userAdaptationPersona, 0.84);
  push('same_session_journal', 'journal', memoryContext.promptDailyJournalText || memoryContext.dailyJournalText, 0.58);

  const selected = uniqueBy(
    items.sort((a, b) => {
      const priorityBoost = (source) => {
        if (source === 'relationship_style') return 3;
        if (source === 'bot_persona') return 2;
        return 0;
      };
      const boostDiff = priorityBoost(b.source) - priorityBoost(a.source);
      if (boostDiff !== 0) return boostDiff;
      return Number(b.confidence || 0) - Number(a.confidence || 0);
    }),
    (item) => `${item.source}:${item.text}`
  ).slice(0, Math.max(1, Number(surfacePolicy.maxMemoryDigestItems) || 1));

  return {
    items: selected,
    text: selected.map((item) => `[${item.source}] ${item.text}`).join('\n'),
    bySource: selected.reduce((acc, item) => {
      acc[item.source] = acc[item.source] || [];
      acc[item.source].push(item.text);
      return acc;
    }, {})
  };
}

function resolveContinuitySlots(candidates = {}, policy = {}) {
  const normalized = normalizeObject(candidates);
  const activeTopic = chooseBestScalar(normalized.activeTopic);
  const carryOver = chooseBestScalar(normalized.carryOver);
  const summary = chooseBestScalar(normalized.summary);
  const recentReplyFrame = chooseBestScalar(normalized.recentReplyFrame);
  const phaseHint = chooseBestScalar(normalized.phaseHint);
  const replyPosture = chooseBestScalar(normalized.replyPosture);
  const sceneTopic = chooseBestScalar(normalized.sceneTopic);
  const sceneAtmosphere = chooseBestScalar(normalized.sceneAtmosphere);
  const openLoops = mergeListCandidates(normalized.openLoops, 4);
  const assistantCommitments = mergeListCandidates(normalized.assistantCommitments, 4);
  const userConstraints = mergeListCandidates(normalized.userConstraints, 4);
  const styleAnchors = mergeListCandidates(normalized.styleAnchors, 4);
  const activePersonaModules = mergeListCandidates(normalized.activePersonaModules, 2);

  return {
    activeTopic: activeTopic?.text || '',
    openLoops,
    assistantCommitments,
    userConstraints,
    carryOverUserTurn: carryOver?.text || '',
    summary: summary?.text || '',
    recentReplyFrame: recentReplyFrame?.text || '',
    phaseHint: phaseHint?.text || '',
    replyPosture: replyPosture?.text || '',
    sceneTopic: sceneTopic?.text || '',
    sceneAtmosphere: sceneAtmosphere?.text || '',
    styleAnchors,
    activePersonaModules,
    confidence: Math.max(
      Number(activeTopic?.confidence || 0) || 0,
      Number(summary?.confidence || 0) || 0,
      Number(replyPosture?.confidence || 0) || 0,
      Number(sceneTopic?.confidence || 0) || 0
    ),
    sources: {
      activeTopic: activeTopic?.source || '',
      carryOverUserTurn: carryOver?.source || '',
      summary: summary?.source || '',
      phaseHint: phaseHint?.source || '',
      replyPosture: replyPosture?.source || '',
      sceneTopic: sceneTopic?.source || '',
      sceneAtmosphere: sceneAtmosphere?.source || '',
      openLoops: normalizeArray(normalized.openLoops).map((item) => item?.source).filter(Boolean),
      assistantCommitments: normalizeArray(normalized.assistantCommitments).map((item) => item?.source).filter(Boolean),
      userConstraints: normalizeArray(normalized.userConstraints).map((item) => item?.source).filter(Boolean),
      recentReplyFrame: recentReplyFrame?.source || '',
      styleAnchors: normalizeArray(normalized.styleAnchors).map((item) => item?.source).filter(Boolean),
      activePersonaModules: normalizeArray(normalized.activePersonaModules).map((item) => item?.source).filter(Boolean)
    },
    conflicts: {
      activeTopic: normalizeArray(normalized.activeTopic).length > 1,
      carryOverUserTurn: normalizeArray(normalized.carryOver).length > 1,
      summary: normalizeArray(normalized.summary).length > 1,
      replyPosture: normalizeArray(normalized.replyPosture).length > 1
    },
    policy: normalizeObject(policy)
  };
}

module.exports = {
  buildExpressionState,
  buildRelationshipState,
  buildMemoryDigest,
  deriveCharacterExpressionState,
  resolveContinuitySlots
};
