function getMemoryExtractionModule() {
  return require('../../api/memoryExtraction');
}

function getDailyJournalModule() {
  return require('../dailyJournal');
}

function getSelfImprovementModule() {
  return require('../selfImprovementRuntime');
}

function getMemoryModule() {
  return require('../memory');
}

function getTaskMemoryModule() {
  return require('../taskMemory');
}

function getGroupMemoryModule() {
  return require('../groupMemory');
}

function getVectorMemoryModule() {
  return require('../vectorMemory');
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeTurnItems(turns = []) {
  return normalizeArray(turns).filter((item) => item && typeof item === 'object');
}

function buildTurnsConversation(turns = []) {
  return normalizeTurnItems(turns)
    .map((item) => ({
      question: normalizeText(item.question),
      finalReply: normalizeText(item.finalReply)
    }))
    .filter((item) => item.question || item.finalReply);
}

function buildCoreLearningTurns(job = {}) {
  const turns = normalizeTurnItems(job.turns)
    .map((item, index) => {
      const routeMeta = normalizeObject(item.routeMeta, {});
      const question = normalizeText(item.question);
      const finalReply = normalizeText(item.finalReply);
      if (!question && !finalReply) return null;
      const createdAt = normalizeText(item.createdAt);
      return {
        turnId: normalizeText(item.turnId || item.turn_id) || `${normalizeText(job.jobId) || 'post_reply'}:${index + 1}`,
        question,
        finalReply,
        createdAt,
        evidence: normalizeObject(item.evidence, {}),
        sourceSessionId: normalizeText(item.sourceSessionId || item.source_session_id || routeMeta.sessionId || routeMeta.session_id || job.sessionKey),
        routeMeta
      };
    })
    .filter(Boolean);

  if (turns.length > 0) return turns;
  const fallbackQuestion = normalizeText(job.question);
  const fallbackReply = normalizeText(job.finalReply);
  if (!fallbackQuestion && !fallbackReply) return [];
  const routeMeta = normalizeObject(job.routeMeta, {});
  return [{
    turnId: `${normalizeText(job.jobId) || 'post_reply'}:1`,
    question: fallbackQuestion,
    finalReply: fallbackReply,
    createdAt: normalizeText(job.createdAt || new Date().toISOString()),
    evidence: {},
    sourceSessionId: normalizeText(routeMeta.sessionId || routeMeta.session_id || job.sessionKey),
    routeMeta
  }];
}

function buildCoreLearningConversation(job = {}) {
  const turns = buildCoreLearningTurns(job);
  if (turns.length <= 1) {
    const only = turns[0] || {};
    return {
      turns,
      userText: only.question || normalizeText(job.question),
      botReply: only.finalReply || normalizeText(job.finalReply)
    };
  }
  return {
    turns,
    userText: turns.map((item, index) => `Turn ${index + 1} User: ${item.question}`).join('\n'),
    botReply: turns.map((item, index) => `Turn ${index + 1} Assistant: ${item.finalReply}`).join('\n')
  };
}

function buildCoreLearningEvidence(job = {}) {
  const { turns } = buildCoreLearningConversation(job);
  const turnIds = turns.map((item) => normalizeText(item.turnId)).filter(Boolean);
  const latestTurn = turns[turns.length - 1] || {};
  const evidenceItems = turns.map((item, index) => ({
    turnId: normalizeText(item.turnId),
    createdAt: normalizeText(item.createdAt),
    userText: normalizeText(item.evidence?.userText || item.question).slice(0, 500),
    assistantText: normalizeText(item.evidence?.assistantText || item.finalReply).slice(0, 500),
    sourceSessionId: normalizeText(item.sourceSessionId),
    index: index + 1
  }));
  return {
    turns,
    turnId: normalizeText(latestTurn.turnId),
    turnIds,
    evidence: evidenceItems,
    sourceSessionId: normalizeText(latestTurn.sourceSessionId || job.sessionKey)
  };
}

function buildLearningDecisionMeta(type = '', meta = {}, status = 'candidate') {
  return {
    status,
    reason: 'post_reply_enrich_extractor',
    fieldKey: normalizeText(type),
    sourceKind: 'extractor',
    postReplyJobId: normalizeText(meta.jobId),
    jobId: normalizeText(meta.jobId),
    turnId: normalizeText(meta.turnId),
    turnIds: normalizeArray(meta.turnIds).map((item) => normalizeText(item)).filter(Boolean),
    sourceSessionId: normalizeText(meta.sourceSessionId || meta.sessionId),
    evidenceCount: normalizeArray(meta.evidence).length,
    phase: 'post_reply_enrich_write'
  };
}

function buildPostReplyEnrichMeta(base = {}, fieldKey = '', status = 'candidate') {
  const turnIds = normalizeArray(base.turnIds).map((item) => normalizeText(item)).filter(Boolean);
  const turnId = normalizeText(base.turnId || turnIds[turnIds.length - 1]);
  return {
    routePolicyKey: normalizeText(base.routePolicyKey),
    topRouteType: normalizeText(base.topRouteType),
    sessionId: normalizeText(base.sessionId),
    groupId: normalizeText(base.groupId),
    channelId: normalizeText(base.channelId),
    sourceSessionId: normalizeText(base.sourceSessionId || base.sessionId),
    turnId,
    turnIds,
    evidence: normalizeArray(base.evidence),
    learningDecision: buildLearningDecisionMeta(fieldKey, { ...base, turnId, turnIds }, status)
  };
}

function buildMinimalStyleMemoryItems(userId = '', styleMemory = {}, meta = {}) {
  const uid = normalizeText(userId);
  if (!uid) return [];
  const confidence = Number(styleMemory?.confidence || 0) || 0;
  const patterns = normalizeArray(styleMemory?.style_patterns).map((item) => normalizeText(item)).filter(Boolean).slice(0, 1);
  const avoids = normalizeArray(styleMemory?.style_avoid).map((item) => normalizeText(item)).filter(Boolean).slice(0, 1);
  const out = [];
  if (patterns[0]) {
    const enrichMeta = buildPostReplyEnrichMeta(meta, 'style_pattern', 'active');
    out.push({
      userId: uid,
      text: `style: ${patterns[0]}`,
      type: 'fact',
      weight: 1.02,
      source: 'post_reply_enrich',
      confidence,
      semanticSlot: 'style_pattern',
      routePolicyKey: enrichMeta.routePolicyKey,
      topRouteType: enrichMeta.topRouteType,
      sessionId: enrichMeta.sessionId,
      sourceSessionId: enrichMeta.sourceSessionId,
      turnId: enrichMeta.turnId,
      turnIds: enrichMeta.turnIds,
      evidence: enrichMeta.evidence,
      meta: {
        source: 'post_reply_enrich',
        confidence,
        sourceKind: 'extractor',
        status: 'active',
        memoryKind: 'style',
        fieldKey: 'style_pattern',
        participants: [],
        entities: [],
        relations: [],
        routePolicyKey: enrichMeta.routePolicyKey,
        topRouteType: enrichMeta.topRouteType,
        sourceSessionId: enrichMeta.sourceSessionId,
        turnId: enrichMeta.turnId,
        turnIds: enrichMeta.turnIds,
        evidence: enrichMeta.evidence,
        learningDecision: enrichMeta.learningDecision
      }
    });
  }
  if (!patterns[0] && avoids[0]) {
    const enrichMeta = buildPostReplyEnrichMeta(meta, 'style_avoid', 'active');
    out.push({
      userId: uid,
      text: `style: ${avoids[0]}`,
      type: 'fact',
      weight: 1.01,
      source: 'post_reply_enrich',
      confidence,
      semanticSlot: 'style_avoid',
      routePolicyKey: enrichMeta.routePolicyKey,
      topRouteType: enrichMeta.topRouteType,
      sessionId: enrichMeta.sessionId,
      sourceSessionId: enrichMeta.sourceSessionId,
      turnId: enrichMeta.turnId,
      turnIds: enrichMeta.turnIds,
      evidence: enrichMeta.evidence,
      meta: {
        source: 'post_reply_enrich',
        confidence,
        sourceKind: 'extractor',
        status: 'active',
        memoryKind: 'style',
        fieldKey: 'style_avoid',
        participants: [],
        entities: [],
        relations: [],
        routePolicyKey: enrichMeta.routePolicyKey,
        topRouteType: enrichMeta.topRouteType,
        sourceSessionId: enrichMeta.sourceSessionId,
        turnId: enrichMeta.turnId,
        turnIds: enrichMeta.turnIds,
        evidence: enrichMeta.evidence,
        learningDecision: enrichMeta.learningDecision
      }
    });
  }
  return out;
}

function buildMinimalJargonMemoryItems(groupId = '', jargonMemory = {}, meta = {}) {
  const gid = normalizeText(groupId);
  if (!gid) return [];
  const confidence = Number(jargonMemory?.confidence || 0) || 0;
  const terms = normalizeArray(jargonMemory?.jargon_terms).map((item) => normalizeText(item)).filter(Boolean).slice(0, 1);
  const patterns = normalizeArray(jargonMemory?.jargon_patterns).map((item) => normalizeText(item)).filter(Boolean).slice(0, 1);
  const selected = terms[0] || patterns[0];
  if (!selected) return [];
  const enrichMeta = buildPostReplyEnrichMeta(meta, 'group_jargon', 'active');
  return [{
    userId: `group:${gid}`,
    text: `group jargon: ${selected}`,
    type: 'fact',
    weight: 0.98,
    source: 'post_reply_enrich',
    confidence,
    semanticSlot: 'group_jargon',
    routePolicyKey: enrichMeta.routePolicyKey,
    topRouteType: enrichMeta.topRouteType,
    sessionId: enrichMeta.sessionId,
    sourceSessionId: enrichMeta.sourceSessionId,
    turnId: enrichMeta.turnId,
    turnIds: enrichMeta.turnIds,
    evidence: enrichMeta.evidence,
    meta: {
      source: 'post_reply_enrich',
      confidence,
      sourceKind: 'extractor',
      status: 'active',
      memoryKind: 'jargon',
      fieldKey: 'group_jargon',
      participants: [],
      entities: [],
      relations: [],
      routePolicyKey: enrichMeta.routePolicyKey,
      topRouteType: enrichMeta.topRouteType,
      sourceSessionId: enrichMeta.sourceSessionId,
      turnId: enrichMeta.turnId,
      turnIds: enrichMeta.turnIds,
      evidence: enrichMeta.evidence,
      learningDecision: enrichMeta.learningDecision
    }
  }];
}

async function runEnrichPhase(job = {}, meta = {}) {
  const { extractPostReplyEnrichment } = getMemoryExtractionModule();
  const { maybeSegmentJournalByThreshold } = getDailyJournalModule();
  const { storeExtractedSelfImprovementItems } = getSelfImprovementModule();
  const { applyAffinityProposal } = getMemoryModule();
  const { addTaskMemory, addTaskMemoryWithVectorBackfill } = getTaskMemoryModule();
  const { addGroupMemory, addGroupMemoryWithVectorBackfill } = getGroupMemoryModule();
  const { addMemoryItemsBatch, addMemoryItemsBatchWithVectorBackfill } = getVectorMemoryModule();
  const turns = buildTurnsConversation(job.turns);
  const latest = turns[turns.length - 1] || { question: normalizeText(job.question), finalReply: normalizeText(job.finalReply) };
  const enrichment = await extractPostReplyEnrichment(job.userId, turns, {
    routePolicyKey: meta.routePolicyKey,
    topRouteType: meta.topRouteType,
    groupId: meta.groupId
  });

  if (enrichment?.affinity && typeof enrichment.affinity === 'object') {
    applyAffinityProposal(job.userId, enrichment.affinity, {
      userText: latest.question,
      assistantText: latest.finalReply,
      routePolicyKey: meta.routePolicyKey,
      topRouteType: meta.topRouteType,
      groupId: meta.groupId,
      sessionId: meta.sessionId
    });
  }

  if (enrichment?.task_memory && typeof enrichment.task_memory === 'object') {
    const taskMemory = enrichment.task_memory;
    const confidence = Number(taskMemory.confidence || 0) || 0;
    if (confidence > 0 && normalizeText(taskMemory.task_type)) {
      const taskPayload = {
        taskType: normalizeText(taskMemory.task_type),
        trigger: normalizeText(taskMemory.trigger),
        strategy: normalizeText(taskMemory.strategy),
        avoid: normalizeText(taskMemory.avoid),
        outcome: normalizeText(taskMemory.outcome) || 'success',
        confidence,
        source: 'post_reply_enrich',
        routePolicyKey: meta.routePolicyKey,
        topRouteType: meta.topRouteType,
        agentName: meta.agentName,
        toolName: meta.toolName,
        sessionId: meta.sessionId,
        channelId: meta.channelId,
        sourceKind: 'extractor',
        status: 'candidate',
        sourceSessionId: meta.sourceSessionId || meta.sessionId,
        turnId: meta.turnId,
        turnIds: meta.turnIds,
        evidence: meta.evidence,
        learningDecision: buildLearningDecisionMeta('task', meta, 'candidate'),
        participants: [],
        entities: [],
        relations: []
      };
      if (typeof addTaskMemoryWithVectorBackfill === 'function') {
        await addTaskMemoryWithVectorBackfill(job.userId, taskPayload, meta);
      } else {
        addTaskMemory(job.userId, taskPayload);
      }
    }
  }

  if (meta.groupId && enrichment?.group_memory && typeof enrichment.group_memory === 'object') {
    const confidence = Number(enrichment.group_memory.confidence || 0) || 0;
    for (const value of normalizeArray(enrichment.group_memory.shared_facts).map((item) => normalizeText(item)).filter(Boolean)) {
      const groupMeta = { confidence, sourceKind: 'extractor', status: 'candidate', ...buildPostReplyEnrichMeta(meta, 'group_fact', 'candidate') };
      if (typeof addGroupMemoryWithVectorBackfill === 'function') {
        await addGroupMemoryWithVectorBackfill(meta.groupId, value, 'fact', groupMeta, 1.08, meta);
      } else {
        addGroupMemory(meta.groupId, value, 'fact', groupMeta, 1.08);
      }
    }
    for (const value of normalizeArray(enrichment.group_memory.shared_goals).map((item) => normalizeText(item)).filter(Boolean)) {
      const groupMeta = { confidence, sourceKind: 'extractor', status: 'active', ...buildPostReplyEnrichMeta(meta, 'group_goal', 'active') };
      if (typeof addGroupMemoryWithVectorBackfill === 'function') {
        await addGroupMemoryWithVectorBackfill(meta.groupId, `group goal: ${value}`, 'goal', groupMeta, 1.15, meta);
      } else {
        addGroupMemory(meta.groupId, `group goal: ${value}`, 'goal', groupMeta, 1.15);
      }
    }
    for (const value of normalizeArray(enrichment.group_memory.shared_topics).map((item) => normalizeText(item)).filter(Boolean)) {
      const groupMeta = { confidence, sourceKind: 'extractor', status: 'candidate', ...buildPostReplyEnrichMeta(meta, 'group_topic', 'candidate') };
      if (typeof addGroupMemoryWithVectorBackfill === 'function') {
        await addGroupMemoryWithVectorBackfill(meta.groupId, `group topic: ${value}`, 'topic', groupMeta, 0.96, meta);
      } else {
        addGroupMemory(meta.groupId, `group topic: ${value}`, 'topic', groupMeta, 0.96);
      }
    }
  }

  const signalItems = [
    ...buildMinimalStyleMemoryItems(job.userId, enrichment?.style_memory, meta),
    ...buildMinimalJargonMemoryItems(meta.groupId, enrichment?.jargon_memory, meta)
  ];
  if (signalItems.length > 0) {
    if (typeof addMemoryItemsBatchWithVectorBackfill === 'function') {
      await addMemoryItemsBatchWithVectorBackfill(signalItems, {
        ...meta,
        phase: 'post_reply_enrich_write'
      });
    } else {
      addMemoryItemsBatch(signalItems);
    }
  }

  if (enrichment?.self_improvement && typeof enrichment.self_improvement === 'object') {
    storeExtractedSelfImprovementItems(job.userId, enrichment.self_improvement.items, {
      routePolicyKey: meta.routePolicyKey,
      topRouteType: meta.topRouteType,
      toolName: meta.toolName,
      taskType: meta.taskType,
      sessionId: meta.sessionId,
      channelId: meta.channelId,
      groupId: meta.groupId
    });
  }

  const latestTurn = normalizeTurnItems(job.turns).slice(-1)[0] || {};
  const latestTurnCreatedAt = normalizeText(latestTurn.createdAt);
  const targetDay = latestTurnCreatedAt
    ? String(latestTurnCreatedAt).slice(0, 10)
    : '';
  if (targetDay) {
    await maybeSegmentJournalByThreshold(job.userId, targetDay, {
      sessionKey: meta.sessionKey,
      routePolicyKey: meta.routePolicyKey,
      topRouteType: meta.topRouteType,
      routeMeta: normalizeObject(job.routeMeta, {}),
      continuitySnapshot: normalizeObject(job.continuitySnapshot, {}),
      contextStats: normalizeObject(job.contextStats, {}),
      groupId: meta.groupId,
      channelId: meta.channelId,
      taskType: meta.taskType
    });
  }
}

module.exports = {
  buildCoreLearningConversation,
  buildCoreLearningEvidence,
  runEnrichPhase
};
