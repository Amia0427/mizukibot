const config = require('../../../config');
const {
  canonicalizeText,
  clampText,
  normalizeText,
  tokenize
} = require('../helpers');
const { buildDailyJournalDocsForAllUsers } = require('../journalDocs');
const { isMemoryNotRecallable } = require('../recallFilter');

function toSafeNumber(value, fallback = 0) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeArray(values) {
  return Array.isArray(values) ? values : [];
}

function sanitizePreviewText(value, limit = 180) {
  const text = normalizeText(value);
  if (!text) return '';
  const maxChars = Math.max(24, Number(limit) || 180);
  return text.length > maxChars ? `${text.slice(0, maxChars - 3).trim()}...` : text;
}

function fieldTextList(values = [], maxItems = 6) {
  return normalizeArray(values)
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .slice(0, Math.max(1, Number(maxItems) || 1));
}

function makeDocBase(input = {}) {
  const text = normalizeText(input.text);
  if (!text) return null;
  const canonicalText = normalizeText(input.canonicalText || canonicalizeText(text));
  const tokens = tokenize(`${text} ${canonicalText}`);
  return {
    id: String(input.id || '').trim(),
    source: normalizeText(input.source).toLowerCase(),
    type: normalizeText(input.type).toLowerCase() || 'fact',
    scopeType: normalizeText(input.scopeType).toLowerCase() || 'personal',
    userId: normalizeText(input.userId),
    ownerUserId: normalizeText(input.ownerUserId || input.userId),
    groupId: normalizeText(input.groupId),
    sessionKey: normalizeText(input.sessionKey),
    sessionId: normalizeText(input.sessionId),
    fieldKey: normalizeText(input.fieldKey).toLowerCase(),
    memoryKind: normalizeText(input.memoryKind).toLowerCase(),
    sourceKind: normalizeText(input.sourceKind).toLowerCase(),
    status: normalizeText(input.status).toLowerCase() || 'active',
    text,
    canonicalText,
    preview: sanitizePreviewText(input.preview || text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
    updatedAt: toSafeNumber(input.updatedAt, 0),
    confidence: toSafeNumber(input.confidence, 0),
    importance: toSafeNumber(input.importance, 0),
    tier: normalizeText(input.tier || '').toUpperCase() || '',
    evidenceTier: normalizeText(input.evidenceTier).toLowerCase(),
    stabilityScore: toSafeNumber(input.stabilityScore, 0),
    suppressedBy: normalizeText(input.suppressedBy),
    participants: normalizeArray(input.participants),
    entities: normalizeArray(input.entities),
    relations: normalizeArray(input.relations),
    routePolicyKey: normalizeText(input.routePolicyKey),
    topRouteType: normalizeText(input.topRouteType),
    taskType: normalizeText(input.taskType),
    toolName: normalizeText(input.toolName),
    agentName: normalizeText(input.agentName),
    title: normalizeText(input.title || ''),
    refId: normalizeText(input.refId || ''),
    notebookRef: input.notebookRef && typeof input.notebookRef === 'object' ? input.notebookRef : null,
    openPayload: input.openPayload && typeof input.openPayload === 'object' ? input.openPayload : null,
    rollupLevel: normalizeText(input.rollupLevel),
    episodeDay: normalizeText(input.episodeDay || input.day),
    day: normalizeText(input.day || input.episodeDay),
    startDay: normalizeText(input.startDay),
    endDay: normalizeText(input.endDay),
    yearMonth: normalizeText(input.yearMonth),
    part: toSafeNumber(input.part, 0),
    sessionKeys: normalizeArray(input.sessionKeys).map((item) => normalizeText(item)).filter(Boolean),
    topics: normalizeArray(input.topics).map((item) => normalizeText(item)).filter(Boolean),
    textKind: normalizeText(input.textKind),
    sourceCompleteness: normalizeText(input.sourceCompleteness),
    sourceFile: normalizeText(input.sourceFile),
    tokens
  };
}

function buildSessionDocs(snapshot = {}) {
  const docs = [];
  const sessions = snapshot?.sessionProjection?.sessions || {};
  for (const session of Object.values(sessions)) {
    const sessionKey = normalizeText(session?.sessionKey);
    const userId = normalizeText(session?.userId);
    if (!sessionKey || !userId) continue;
    const text = [
      session.summary ? `summary: ${session.summary}` : '',
      session.activeTopic ? `topic: ${session.activeTopic}` : '',
      session.carryOverUserTurn ? `carry: ${session.carryOverUserTurn}` : '',
      normalizeArray(session.openLoops).length ? `open: ${session.openLoops.join(' | ')}` : '',
      normalizeArray(session.assistantCommitments).length ? `commitments: ${session.assistantCommitments.join(' | ')}` : '',
      normalizeArray(session.userConstraints).length ? `constraints: ${session.userConstraints.join(' | ')}` : '',
      normalizeArray(session.recentMessages).length
        ? session.recentMessages.map((item) => `${normalizeText(item.role)}: ${normalizeText(item.content)}`).join('\n')
        : ''
    ].filter(Boolean).join('\n');
    const doc = makeDocBase({
      id: `session:${sessionKey}`,
      source: 'recent',
      type: 'session',
      scopeType: 'session',
      userId,
      ownerUserId: userId,
      sessionKey,
      sessionId: session.sessionId || '',
      text,
      preview: [
        session.carryOverUserTurn,
        session.activeTopic,
        session.summary
      ].filter(Boolean).join(' | '),
      updatedAt: session.updatedAt || 0,
      confidence: 1,
      importance: 1.25,
      title: session.snapshotType ? `Recent session (${session.snapshotType})` : 'Recent session',
      openPayload: {
        sessionKey,
        snapshotType: session.snapshotType || '',
        updatedAt: session.updatedAt || 0,
        shortTermSummary: session.summary || '',
        shortTermState: {
          summary: session.summary || '',
          activeTopic: session.activeTopic || '',
          openLoops: normalizeArray(session.openLoops),
          assistantCommitments: normalizeArray(session.assistantCommitments),
          userConstraints: normalizeArray(session.userConstraints),
          recentToolResults: normalizeArray(session.recentToolResults),
          carryOverUserTurn: session.carryOverUserTurn || ''
        },
        recentMessages: normalizeArray(session.recentMessages)
      }
    });
    if (doc) docs.push(doc);
  }
  return docs;
}

function buildProfileDocs(snapshot = {}) {
  const docs = [];
  const users = snapshot?.profileProjection?.users || {};
  for (const [userId, profile] of Object.entries(users)) {
    const normalizedUserId = normalizeText(userId);
    if (!normalizedUserId || !profile || typeof profile !== 'object') continue;
    const personaCore = profile.personaCore || {};
    const strictProfile = profile.strictProfile || {};
    const weakProfile = profile.weakProfile || {};

    const summaryDoc = makeDocBase({
      id: `profile:${normalizedUserId}:summary`,
      source: 'profile',
      type: 'persona_summary',
      scopeType: 'personal',
      userId: normalizedUserId,
      ownerUserId: normalizedUserId,
      fieldKey: 'persona_summary_support',
      text: personaCore.summary || '',
      updatedAt: personaCore.updatedAt || snapshot?.profileProjection?.updatedAt || 0,
      confidence: 1,
      importance: 1.4,
      tier: 'A',
      title: 'Profile summary',
      openPayload: {
        profile: {
          relation_stage: profile.relation_stage || '陌生人',
          identities: fieldTextList(strictProfile.identities, config.MEMORY_CLI_PROFILE_FIELD_MAX_ITEMS),
          personality_traits: fieldTextList(strictProfile.personality_traits, config.MEMORY_CLI_PROFILE_FIELD_MAX_ITEMS),
          hobbies: [],
          likes: fieldTextList(strictProfile.likes, config.MEMORY_CLI_PROFILE_FIELD_MAX_ITEMS),
          dislikes: fieldTextList(strictProfile.dislikes, config.MEMORY_CLI_PROFILE_FIELD_MAX_ITEMS),
          goals: fieldTextList(strictProfile.goals, config.MEMORY_CLI_PROFILE_FIELD_MAX_ITEMS),
          recent_topics: fieldTextList(weakProfile.recent_topics, config.MEMORY_CLI_PROFILE_FIELD_MAX_ITEMS)
        },
        summary: personaCore.summary || '',
        impression: personaCore.impression || '',
        facts: []
      }
    });
    if (summaryDoc) docs.push(summaryDoc);

    const impressionDoc = makeDocBase({
      id: `profile:${normalizedUserId}:impression`,
      source: 'profile',
      type: 'persona_impression',
      scopeType: 'personal',
      userId: normalizedUserId,
      ownerUserId: normalizedUserId,
      fieldKey: 'persona_impression_support',
      text: personaCore.impression || '',
      updatedAt: personaCore.updatedAt || snapshot?.profileProjection?.updatedAt || 0,
      confidence: 1,
      importance: 1.45,
      tier: 'S',
      title: 'User impression',
      openPayload: summaryDoc ? summaryDoc.openPayload : null
    });
    if (impressionDoc) docs.push(impressionDoc);

    const profileFields = [
      ['identity', strictProfile.identities || [], 'Identities'],
      ['personality', strictProfile.personality_traits || [], 'Personality traits'],
      ['preference_like', strictProfile.likes || [], 'Likes'],
      ['preference_dislike', strictProfile.dislikes || [], 'Dislikes'],
      ['goal', strictProfile.goals || [], 'Goals'],
      ['topic', weakProfile.recent_topics || [], 'Recent topics']
    ];
    for (const [fieldKey, values, title] of profileFields) {
      fieldTextList(values, 20).forEach((text, index) => {
        const doc = makeDocBase({
          id: `profile:${normalizedUserId}:${fieldKey}:${index}`,
          source: 'profile',
          type: fieldKey,
          scopeType: 'personal',
          userId: normalizedUserId,
          ownerUserId: normalizedUserId,
          fieldKey,
          memoryKind: fieldKey === 'preference_like'
            ? 'like'
            : fieldKey === 'preference_dislike'
              ? 'dislike'
              : '',
          text,
          updatedAt: personaCore.updatedAt || snapshot?.profileProjection?.updatedAt || 0,
          confidence: 1,
          importance: 1.15,
          tier: 'A',
          title
        });
        if (doc) docs.push(doc);
      });
    }
  }
  return docs;
}

function buildNodeDocs(snapshot = {}) {
  const docs = [];
  for (const node of normalizeArray(snapshot?.memoryNodes)) {
    if (isMemoryNotRecallable(node)) continue;
    const scopeType = normalizeText(node.scopeType).toLowerCase() || 'personal';
    const source = scopeType === 'task'
      ? 'task'
      : scopeType === 'group'
        ? (normalizeText(node.memoryKind).toLowerCase() === 'jargon' ? 'jargon' : 'group')
        : (normalizeText(node.memoryKind).toLowerCase() === 'style' ? 'style' : 'personal');
    const userId = normalizeText(node.userId);
    const doc = makeDocBase({
      id: String(node.id || '').trim(),
      source,
      type: normalizeText(node.type).toLowerCase() || 'fact',
      scopeType,
      userId,
      ownerUserId: scopeType === 'group' ? userId.replace(/^group:/, '') : userId,
      groupId: node.groupId || '',
      sessionKey: node.sessionKey || '',
      sessionId: node.sessionId || '',
      fieldKey: node.fieldKey || '',
      memoryKind: node.memoryKind || '',
      sourceKind: node.sourceKind || '',
      status: node.status || 'active',
      text: node.text || '',
      updatedAt: node.updatedAt || 0,
      confidence: node.confidence,
      importance: node.importance,
      tier: node.tier || '',
      evidenceTier: node.evidenceTier || '',
      stabilityScore: node.stabilityScore || 0,
      suppressedBy: node.suppressedBy || '',
      participants: normalizeArray(node.participants),
      entities: normalizeArray(node.entities),
      relations: normalizeArray(node.relations),
      routePolicyKey: node.routePolicyKey || '',
      topRouteType: node.topRouteType || '',
      taskType: node.taskType || '',
      toolName: node.toolName || '',
      agentName: node.agentName || '',
      title: normalizeText(node.type || source || 'memory'),
      openPayload: {
        id: String(node.id || '').trim(),
        type: node.type,
        text: clampText(node.text || '', Math.min(1600, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
        confidence: node.confidence,
        importance: node.importance,
        tier: node.tier || '',
        status: normalizeText(node.status).toLowerCase() || 'active',
        sourceKind: normalizeText(node.sourceKind).toLowerCase() || 'runtime',
        evidenceTier: normalizeText(node.evidenceTier).toLowerCase() || 'weak',
        stabilityScore: toSafeNumber(node.stabilityScore, 0),
        fieldKey: normalizeText(node.fieldKey).toLowerCase(),
        suppressedBy: normalizeText(node.suppressedBy),
        updatedAt: node.updatedAt || 0,
        scopeType,
        groupId: node.groupId || '',
        taskType: node.taskType || '',
        routePolicyKey: node.routePolicyKey || '',
        topRouteType: node.topRouteType || '',
        source: node.source || '',
        participants: normalizeArray(node.participants),
        entities: normalizeArray(node.entities),
        relations: normalizeArray(node.relations),
        memoryKind: normalizeText(node.memoryKind).toLowerCase(),
        styleRole: '',
        jargonRole: ''
      }
    });
    if (doc) docs.push(doc);
  }
  return docs;
}

function buildEpisodeDocs(snapshot = {}) {
  const docs = [];
  const users = snapshot?.episodeProjection?.users || {};
  for (const [userId, entry] of Object.entries(users)) {
    const normalizedUserId = normalizeText(userId);
    if (!normalizedUserId) continue;
    for (const episode of normalizeArray(entry?.items)) {
      if (isMemoryNotRecallable(episode)) continue;
      const rollupLevel = normalizeText(episode.rollupLevel || episode.type || 'daily') || 'daily';
      if (rollupLevel === 'segment') continue;
      const title = normalizeText(episode.episodeDay || episode.yearMonth || rollupLevel || 'episode');
      const doc = makeDocBase({
        id: `episode:${String(episode.id || '').trim()}`,
        source: 'journal',
        type: 'episode',
        scopeType: 'personal',
        userId: normalizedUserId,
        ownerUserId: normalizedUserId,
        memoryKind: 'episode',
        fieldKey: 'episode',
        sourceKind: normalizeText(episode.sourceKind || 'journal'),
        text: episode.text || '',
        preview: episode.text || '',
        updatedAt: episode.updatedAt || 0,
        confidence: Number(episode.confidence || 0) || 0.92,
        importance: Number(episode.importance || 0) || (rollupLevel === 'monthly' ? 1.25 : 1.0),
        evidenceTier: 'strict',
        tier: rollupLevel === 'monthly' ? 'S' : rollupLevel === '4day' ? 'A' : 'B',
        title,
        rollupLevel,
        episodeDay: episode.episodeDay || episode.endDay || episode.startDay || '',
        startDay: episode.startDay || '',
        endDay: episode.endDay || '',
        yearMonth: episode.yearMonth || '',
        part: episode.part || 0,
        sessionKeys: episode.sessionKeys || [],
        topics: episode.topics || [],
        textKind: episode.textKind || `journal_${rollupLevel}`,
        sourceCompleteness: episode.sourceCompleteness || 'summary',
        sourceFile: episode.sourceFile || '',
        openPayload: {
          id: episode.id,
          type: rollupLevel,
          title,
          text: clampText(episode.text || '', Math.max(200, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
          updatedAt: episode.updatedAt || 0,
          episodeDay: episode.episodeDay || '',
          startDay: episode.startDay || '',
          endDay: episode.endDay || '',
          yearMonth: episode.yearMonth || '',
          part: episode.part || 0,
          sourceFile: episode.sourceFile || ''
        }
      });
      if (doc) docs.push(doc);
    }
  }
  return docs;
}

function buildDailyJournalDocs() {
  return buildDailyJournalDocsForAllUsers().map((item) => makeDocBase(item)).filter(Boolean);
}

function buildNotebookDocs(snapshot = {}) {
  const docs = [];
  for (const [userId, index] of snapshot?.notebookIndexes || new Map()) {
    const notebookUserId = normalizeText(userId);
    for (const doc of normalizeArray(index?.docs)) {
      const title = normalizeText(doc?.title || '');
      const meta = doc?.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
      const ownerUserId = notebookUserId;
      const scopeType = normalizeText(meta.scopeType || 'personal').toLowerCase() || 'personal';
      for (const chunk of normalizeArray(doc?.chunks)) {
        const chunkIndex = toSafeNumber(chunk?.chunk_index, 0);
        const text = normalizeText(chunk?.text);
        if (!text) continue;
        const normalized = makeDocBase({
          id: `notebook:${String(doc.id || '').trim()}:${chunkIndex}`,
          source: 'notebook',
          type: 'notebook_doc',
          scopeType,
          userId: notebookUserId,
          ownerUserId,
          groupId: meta.groupId || '',
          text,
          updatedAt: meta.updatedAt || toSafeNumber(new Date(doc.updated_at || 0).getTime(), 0),
          confidence: 0.84,
          importance: 0.96,
          title,
          notebookRef: {
            source: 'notebook',
            userId: notebookUserId,
            docId: String(doc.id || '').trim(),
            chunkIndex
          },
          openPayload: {
            ok: true,
            source: 'notebook',
            docId: String(doc.id || '').trim(),
            chunkIndex,
            title,
            text: clampText(text, 4000),
            metadata: meta
          }
        });
        if (normalized) docs.push(normalized);
      }
    }
  }
  return docs;
}

module.exports = {
  buildDailyJournalDocs,
  buildEpisodeDocs,
  buildNodeDocs,
  buildNotebookDocs,
  buildProfileDocs,
  buildSessionDocs,
  makeDocBase
};
