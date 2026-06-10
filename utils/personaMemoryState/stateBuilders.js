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

function buildExpressionState({ surface, relationshipState, styleProfile, socialContext, memoryContext }) {
  const persona = normalizeObject(memoryContext.persona, {});
  const relationshipStyle = normalizeText(persona.relationshipStyle || persona.userAdaptationPersona, 320);
  const botBasePersona = normalizeText(persona.botBasePersona, 320);
  const warmth = parsePersonaPreference(relationshipStyle, 'relationship_tone')
    || parsePersonaPreference(botBasePersona, 'bot_persona_tone')
    || inferWarmth(relationshipState.relationship, relationshipState.attitude, surface);
  const playfulness = parsePersonaPreference(botBasePersona, 'bot_persona_playfulness')
    || inferPlayfulness(styleProfile, socialContext, surface);
  const initiative = parsePersonaPreference(botBasePersona, 'bot_persona_initiative')
    || parsePersonaPreference(relationshipStyle, 'relationship_engagement')
    || inferInitiative(surface);
  const guardedness = parsePersonaPreference(relationshipStyle, 'relationship_distance')
    || parsePersonaPreference(botBasePersona, 'bot_persona_guardedness')
    || inferGuardedness(surface, relationshipState.relationship);
  const verbosity = parsePersonaPreference(botBasePersona, 'bot_persona_verbosity')
    || inferVerbosity(surface, styleProfile);
  return {
    warmth: buildExpressionValue(warmth, parsePersonaPreference(relationshipStyle, 'relationship_tone') ? 'relationship_memory' : (parsePersonaPreference(botBasePersona, 'bot_persona_tone') ? 'persona_memory' : 'runtime_inference')),
    playfulness: buildExpressionValue(playfulness, parsePersonaPreference(botBasePersona, 'bot_persona_playfulness') ? 'persona_memory' : 'runtime_inference'),
    tease: buildExpressionValue(inferTease(styleProfile, socialContext, surface), 'runtime_inference'),
    initiative: buildExpressionValue(initiative, parsePersonaPreference(botBasePersona, 'bot_persona_initiative') ? 'persona_memory' : (parsePersonaPreference(relationshipStyle, 'relationship_engagement') ? 'relationship_memory' : 'surface_policy')),
    jargon: buildExpressionValue(inferJargon(surface, relationshipState.groupId, memoryContext?.styleSignalText), 'surface_policy'),
    verbosity: buildExpressionValue(verbosity, parsePersonaPreference(botBasePersona, 'bot_persona_verbosity') ? 'persona_memory' : 'runtime_inference'),
    guardedness: buildExpressionValue(guardedness, parsePersonaPreference(relationshipStyle, 'relationship_distance') ? 'relationship_memory' : (parsePersonaPreference(botBasePersona, 'bot_persona_guardedness') ? 'persona_memory' : 'surface_policy'))
  };
}

function buildRelationshipState({ userId, groupId, memoryContext, affinityState, profile }) {
  const persona = normalizeObject(memoryContext.persona, {});
  const relationshipStyle = normalizeText(persona.relationshipStyle || persona.userAdaptationPersona, 320);
  const relation = normalizeText(
    profile?.relation_stage
    || memoryContext?.profile?.relation_stage
    || affinityState?.relationship
    || affinityState?.level
    || '陌生人',
    48
  ) || '陌生人';
  const attitude = normalizeText(
    affinityState?.attitude
    || memoryContext?.impressionText
    || '中立、保持距离',
    160
  ) || '中立、保持距离';
  const inferredDistance = relation === '亲密伙伴' ? 'close' : (relation === '普通朋友' ? 'friendly' : 'reserved');
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
  resolveContinuitySlots
};
