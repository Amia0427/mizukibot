const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { getAccessibleGroupIdsForUser } = require('../memoryScopeIndex');
const {
  RECALL_FACETS,
  classifyRecallFacet,
  getFacetPerSourceLimit,
  shouldBiasToContinuity
} = require('../recallHeuristics');
const {
  loadSessionProjection,
  loadProfileProjection,
  loadScopeProjection,
  loadEpisodeProjection,
  loadMemoryNodes
} = require('./storage');
const {
  canonicalizeText,
  clampText,
  normalizeText,
  safeReadJson,
  tokenize
} = require('./helpers');
const { shouldUseRemoteEmbedding, requestEmbedding } = require('../vectorMemory');
const { rerankMemoryCandidates } = require('../memoryReranker');
const {
  loadEmbeddingIndex,
  calcEmbeddingSimilarity
} = require('./embeddingIndex');
const {
  buildDailyJournalDocsForAllUsers,
  getDailyJournalFileStats
} = require('./journalDocs');
const { isMemoryNotRecallable } = require('./recallFilter');
const {
  JOURNAL_TRIGGER_RE,
  journalDateMatchBoost,
  resolveJournalTargetDays
} = require('./journalRecallPolicy');
const { diagnoseProjectionFreshness } = require('./diagnostics');

const NOTEBOOK_ROOT = path.join(config.DATA_DIR, 'notebook');
const NOTEBOOK_TRIGGER_RE = /(?:\bnotebook\b|笔记|文档|markdown|\bmd\b)/i;
const SOURCE_SET = new Set(['recent', 'profile', 'personal', 'task', 'group', 'style', 'jargon', 'journal', 'notebook']);
const FACET_SET = new Set(RECALL_FACETS);
const SLOW_QUERY_LOG_MS = 120;
const SEARCH_EXPAND_SCORE_DEFAULT = 0.42;
const SEARCH_EXPAND_MIN_RATIO_DEFAULT = 0.5;

const FACET_SOURCE_PLAN = Object.freeze({
  recent_continuity: {
    primary: ['recent', 'task', 'journal'],
    secondary: ['personal', 'profile']
  },
  task_or_plan: {
    primary: ['recent', 'task', 'journal'],
    secondary: ['personal', 'profile']
  },
  preference: {
    primary: ['profile', 'personal'],
    secondary: ['recent']
  },
  identity: {
    primary: ['profile', 'personal'],
    secondary: ['recent']
  },
  relationship: {
    primary: ['profile', 'personal'],
    secondary: ['recent']
  },
  group_context: {
    primary: ['group', 'jargon', 'recent'],
    secondary: ['journal']
  },
  broad_recall: {
    primary: ['recent', 'personal', 'profile'],
    secondary: ['task', 'journal']
  },
  default_continuity: {
    primary: ['recent', 'personal', 'profile'],
    secondary: ['task', 'journal']
  }
});

const runtimeState = {
  snapshot: null,
  loadingPromise: null,
  refreshPromise: null,
  loadedOnce: false
};

function nowMs() {
  return Date.now();
}

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

function safeStat(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    return {
      filePath,
      mtimeMs: Number(stat.mtimeMs || 0) || 0,
      size: Number(stat.size || 0) || 0
    };
  } catch (_) {
    return {
      filePath,
      mtimeMs: 0,
      size: 0
    };
  }
}

function snapshotSignature(meta = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      parts.push(`${key}:${value.map((item) => `${item.filePath}:${item.mtimeMs}:${item.size}`).join(',')}`);
      continue;
    }
    if (value && typeof value === 'object') {
      parts.push(`${key}:${value.filePath || key}:${value.mtimeMs || 0}:${value.size || 0}`);
      continue;
    }
    parts.push(`${key}:${String(value || '')}`);
  }
  return parts.join('|');
}

function readNotebookUsers() {
  try {
    if (!fs.existsSync(NOTEBOOK_ROOT)) return [];
    return fs.readdirSync(NOTEBOOK_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch (_) {
    return [];
  }
}

function readNotebookIndexes(userIds = []) {
  const indexes = new Map();
  const fileStats = [];
  for (const userId of Array.isArray(userIds) ? userIds : []) {
    const filePath = path.join(NOTEBOOK_ROOT, String(userId || '').trim(), 'index.json');
    const stat = safeStat(filePath);
    fileStats.push(stat);
    const index = safeReadJson(filePath, {
      docs: [],
      file_state: {},
      updated_at: ''
    });
    indexes.set(String(userId || '').trim(), index && typeof index === 'object' ? index : { docs: [], file_state: {}, updated_at: '' });
  }
  return { indexes, fileStats };
}

function readNotebookIndexStats(userIds = []) {
  return normalizeArray(userIds).map((userId) => {
    const filePath = path.join(NOTEBOOK_ROOT, String(userId || '').trim(), 'index.json');
    return safeStat(filePath);
  });
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

function pushIndexValue(map, key, value) {
  const normalizedKey = normalizeText(key);
  const normalizedValue = String(value || '').trim();
  if (!normalizedKey || !normalizedValue) return;
  if (!map.has(normalizedKey)) map.set(normalizedKey, []);
  map.get(normalizedKey).push(normalizedValue);
}

function finalizeIndex(map) {
  for (const [key, values] of map.entries()) {
    const unique = Array.from(new Set(normalizeArray(values).map((item) => String(item || '').trim()).filter(Boolean)));
    map.set(key, unique);
  }
  return map;
}

function buildSnapshot() {
  const hydrateStartedAt = nowMs();
  const meta = {
    sessionProjection: safeStat(config.MEMORY_V3_SESSION_PROJECTION_FILE),
    profileProjection: safeStat(config.MEMORY_V3_PROFILE_PROJECTION_FILE),
    scopeProjection: safeStat(config.MEMORY_V3_SCOPE_PROJECTION_FILE),
    episodeProjection: safeStat(config.MEMORY_V3_EPISODE_PROJECTION_FILE),
    memoryNodes: safeStat(config.MEMORY_V3_NODES_FILE),
    embeddingCache: safeStat(config.MEMORY_V3_EMBEDDING_CACHE_FILE),
    dailyJournalFiles: getDailyJournalFileStats()
  };
  const sessionProjection = loadSessionProjection();
  const profileProjection = loadProfileProjection();
  const scopeProjection = loadScopeProjection();
  const episodeProjection = loadEpisodeProjection();
  const memoryNodes = loadMemoryNodes();
  const notebookUsers = readNotebookUsers();
  const notebookData = readNotebookIndexes(notebookUsers);
  meta.notebookIndexes = notebookData.fileStats;
  const signature = snapshotSignature(meta);

  const rawSnapshot = {
    sessionProjection,
    profileProjection,
    scopeProjection,
    episodeProjection,
    memoryNodes,
    notebookIndexes: notebookData.indexes
  };

  const dailyJournalDocs = buildDailyJournalDocs();
  const docs = []
    .concat(buildSessionDocs(rawSnapshot))
    .concat(buildProfileDocs(rawSnapshot))
    .concat(buildNodeDocs(rawSnapshot))
    .concat(buildEpisodeDocs(rawSnapshot))
    .concat(dailyJournalDocs)
    .concat(buildNotebookDocs(rawSnapshot));

  const docsById = new Map();
  const docIdsBySource = new Map();
  const docIdsByUser = new Map();
  const docIdsByGroup = new Map();
  const docIdsBySession = new Map();
  const docIdsByMemoryKind = new Map();
  const docIdsByFieldKey = new Map();
  const docIdsByOwner = new Map();

  for (const doc of docs) {
    if (!doc || !doc.id || !doc.text) continue;
    docsById.set(doc.id, doc);
    pushIndexValue(docIdsBySource, doc.source, doc.id);
    pushIndexValue(docIdsByUser, doc.userId, doc.id);
    pushIndexValue(docIdsByOwner, doc.ownerUserId || doc.userId, doc.id);
    pushIndexValue(docIdsByGroup, doc.groupId, doc.id);
    pushIndexValue(docIdsBySession, doc.sessionKey || doc.sessionId, doc.id);
    pushIndexValue(docIdsByMemoryKind, doc.memoryKind, doc.id);
    pushIndexValue(docIdsByFieldKey, doc.fieldKey, doc.id);
  }

  return {
    signature,
    loadedAt: nowMs(),
    buildMs: nowMs() - hydrateStartedAt,
    meta,
    docsById,
    docIdsBySource: finalizeIndex(docIdsBySource),
    docIdsByUser: finalizeIndex(docIdsByUser),
    docIdsByOwner: finalizeIndex(docIdsByOwner),
    docIdsByGroup: finalizeIndex(docIdsByGroup),
    docIdsBySession: finalizeIndex(docIdsBySession),
    docIdsByMemoryKind: finalizeIndex(docIdsByMemoryKind),
    docIdsByFieldKey: finalizeIndex(docIdsByFieldKey),
    projections: {
      sessionProjection,
      profileProjection,
      scopeProjection,
      episodeProjection,
      notebookIndexes: notebookData.indexes
    }
  };
}

function shouldReloadSnapshot(current = null) {
  if (!current) return true;
  const notebookUsers = readNotebookUsers();
  const meta = {
    sessionProjection: safeStat(config.MEMORY_V3_SESSION_PROJECTION_FILE),
    profileProjection: safeStat(config.MEMORY_V3_PROFILE_PROJECTION_FILE),
    scopeProjection: safeStat(config.MEMORY_V3_SCOPE_PROJECTION_FILE),
    episodeProjection: safeStat(config.MEMORY_V3_EPISODE_PROJECTION_FILE),
    memoryNodes: safeStat(config.MEMORY_V3_NODES_FILE),
    embeddingCache: safeStat(config.MEMORY_V3_EMBEDDING_CACHE_FILE),
    dailyJournalFiles: getDailyJournalFileStats(),
    notebookIndexes: readNotebookIndexStats(notebookUsers)
  };
  return snapshotSignature(meta) !== String(current.signature || '');
}

async function ensureSnapshot(options = {}) {
  const force = options.force === true;
  if (!force && runtimeState.snapshot && !shouldReloadSnapshot(runtimeState.snapshot)) {
    return runtimeState.snapshot;
  }
  if (!force && runtimeState.snapshot) {
    if (!runtimeState.refreshPromise) {
      runtimeState.refreshPromise = Promise.resolve().then(() => {
        const next = buildSnapshot();
        runtimeState.snapshot = next;
        runtimeState.loadedOnce = true;
        return next;
      }).finally(() => {
        runtimeState.refreshPromise = null;
      });
    }
    return runtimeState.snapshot;
  }
  if (runtimeState.loadingPromise) return runtimeState.loadingPromise;
  runtimeState.loadingPromise = Promise.resolve().then(() => {
    const next = buildSnapshot();
    runtimeState.snapshot = next;
    runtimeState.loadedOnce = true;
    return next;
  }).finally(() => {
    runtimeState.loadingPromise = null;
  });
  return runtimeState.loadingPromise;
}

function schedulePreload() {
  if (!config.MEMORY_CLI_PRELOAD) return;
  if (runtimeState.loadedOnce || runtimeState.loadingPromise) return;
  setImmediate(() => {
    ensureSnapshot().catch((error) => {
      if (config.ENABLE_DEBUG_LOG) {
        console.warn('[memory_cli_fast] preload failed:', error?.message || error);
      }
    });
  });
}

function intersectLists(base = [], include = []) {
  if (!Array.isArray(base) || base.length === 0) return [];
  if (!Array.isArray(include) || include.length === 0) return [];
  const allow = new Set(include.map((item) => String(item || '').trim()));
  return base.filter((item) => allow.has(String(item || '').trim()));
}

function facetPlanForQuery(queryFacet = 'default_continuity') {
  return FACET_SOURCE_PLAN[queryFacet] || FACET_SOURCE_PLAN.default_continuity;
}

function queryFacetForSearch(query = '', source = 'all') {
  if (source === 'recent') return 'recent_continuity';
  if (source === 'task') return 'task_or_plan';
  if (source === 'group') return 'group_context';
  if (source === 'style' || source === 'jargon') return 'preference';
  if (source === 'journal') return 'recent_continuity';
  const facet = classifyRecallFacet(query);
  return FACET_SET.has(facet) ? facet : 'default_continuity';
}

function chooseSourcePlan(query = '', requestedSource = 'all') {
  const source = normalizeText(requestedSource).toLowerCase() || 'all';
  const queryFacet = queryFacetForSearch(query, source);
  if (source === 'notebook') {
    return { queryFacet: 'notebook', primary: ['notebook'], secondary: [] };
  }
  if (SOURCE_SET.has(source) && source !== 'all') {
    return { queryFacet, primary: [source], secondary: [] };
  }
  const plan = facetPlanForQuery(queryFacet);
  const primary = normalizeArray(plan.primary).filter((item) => {
    if (item === 'notebook') return NOTEBOOK_TRIGGER_RE.test(query);
    if (item === 'journal') return true;
    return true;
  });
  const secondary = normalizeArray(plan.secondary);
  if (NOTEBOOK_TRIGGER_RE.test(query)) primary.push('notebook');
  if (JOURNAL_TRIGGER_RE.test(query) && !primary.includes('journal')) primary.push('journal');
  return {
    queryFacet,
    primary: Array.from(new Set(primary)),
    secondary: Array.from(new Set(secondary))
  };
}

function resolveSourceCandidates(snapshot, source = 'all', context = {}) {
  const userId = normalizeText(context.userId);
  const groupId = normalizeText(context.groupId);
  const sessionKey = normalizeText(context.sessionKey || context.sessionId);
  const accessibleGroups = Array.from(new Set([
    ...normalizeArray(context.groupIds),
    ...getAccessibleGroupIdsForUser(userId),
    groupId
  ].map((item) => normalizeText(item)).filter(Boolean)));
  const allowedGroupOwners = new Set(accessibleGroups.map((item) => `group:${item}`));
  const sourceIds = normalizeArray(snapshot.docIdsBySource.get(source));
  const ownerIds = new Set([
    ...normalizeArray(snapshot.docIdsByUser.get(userId)),
    ...normalizeArray(snapshot.docIdsByOwner.get(userId))
  ]);

  if (source === 'group' || source === 'jargon') {
    return sourceIds.filter((id) => {
      const doc = snapshot.docsById.get(id);
      if (!doc) return false;
      return allowedGroupOwners.has(normalizeText(doc.userId)) || accessibleGroups.includes(normalizeText(doc.groupId));
    });
  }

  if (source === 'notebook') {
    return sourceIds.filter((id) => {
      const doc = snapshot.docsById.get(id);
      if (!doc) return false;
      if (normalizeText(doc.scopeType) === 'group') {
        return accessibleGroups.includes(normalizeText(doc.groupId));
      }
      return normalizeText(doc.userId) === userId || normalizeText(doc.ownerUserId) === userId;
    });
  }

  if (source === 'recent') {
    const sessionIds = sessionKey ? normalizeArray(snapshot.docIdsBySession.get(sessionKey)) : [];
    const merged = sourceIds.concat(sessionIds);
    return Array.from(new Set(merged.filter((id) => {
      const doc = snapshot.docsById.get(id);
      return doc && normalizeText(doc.userId) === userId;
    })));
  }

  return sourceIds.filter((id) => ownerIds.has(id) || (() => {
    const doc = snapshot.docsById.get(id);
    return doc && normalizeText(doc.userId) === userId;
  })());
}

function overlapRatio(queryTokens = [], docTokens = []) {
  if (!queryTokens.length || !docTokens.length) return 0;
  const docSet = new Set(docTokens);
  let hit = 0;
  for (const token of queryTokens) {
    if (docSet.has(token)) hit += 1;
  }
  return hit / Math.max(1, queryTokens.length);
}

function directMatchBoost(query = '', doc = {}) {
  const normalizedQuery = normalizeText(query).toLowerCase();
  const normalizedText = normalizeText(doc.canonicalText || doc.text).toLowerCase();
  if (!normalizedQuery || !normalizedText) return 0;
  if (normalizedText.includes(normalizedQuery)) return 0.3;
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const compactText = normalizedText.replace(/\s+/g, '');
  if (compactQuery && compactText.includes(compactQuery)) return 0.22;
  return 0;
}

function recencyBoost(updatedAt = 0) {
  if (!updatedAt) return 0;
  const ageHours = Math.max(0, (nowMs() - updatedAt) / (3600 * 1000));
  if (ageHours <= 24) return 0.22;
  if (ageHours <= 72) return 0.16;
  if (ageHours <= 24 * 14) return 0.08;
  if (ageHours <= 24 * 60) return 0.04;
  return 0;
}

function confidenceBoost(doc = {}) {
  return Math.min(0.12, Math.max(0, toSafeNumber(doc.confidence, 0)) * 0.12);
}

function tierBoost(doc = {}) {
  const tier = normalizeText(doc.tier).toUpperCase();
  if (tier === 'S') return 0.14;
  if (tier === 'A') return 0.1;
  if (tier === 'B') return 0.04;
  if (tier === 'C') return -0.03;
  return 0;
}

function scopeBoost(doc = {}, context = {}, queryFacet = 'default_continuity') {
  let boost = 0;
  if (normalizeText(doc.sessionKey) && normalizeText(context.sessionKey) && normalizeText(doc.sessionKey) === normalizeText(context.sessionKey)) {
    boost += 0.16;
  }
  if (normalizeText(doc.groupId) && normalizeText(context.groupId) && normalizeText(doc.groupId) === normalizeText(context.groupId)) {
    boost += 0.1;
  }
  if (queryFacet === 'recent_continuity' || queryFacet === 'task_or_plan' || queryFacet === 'default_continuity') {
    if (doc.source === 'recent') boost += 0.24;
    if (doc.source === 'task') boost += 0.18;
    if (doc.source === 'journal') boost += 0.12;
    if (doc.source === 'profile') boost -= 0.05;
  }
  if (queryFacet === 'preference' || queryFacet === 'identity' || queryFacet === 'relationship') {
    if (doc.source === 'profile') boost += 0.1;
    if (doc.source === 'personal') boost += 0.06;
  }
  if (queryFacet === 'group_context') {
    if (doc.source === 'group') boost += 0.12;
    if (doc.source === 'jargon') boost += 0.14;
  }
  return boost;
}

function scoreDoc(query = '', queryTokens = [], doc = {}, context = {}, queryFacet = 'default_continuity', scoring = {}) {
  const lexical = overlapRatio(queryTokens, normalizeArray(doc.tokens));
  const direct = directMatchBoost(query, doc);
  const dateBoost = journalDateMatchBoost(doc, resolveJournalTargetDays(query));
  const embedding = scoring.queryEmbedding
    ? calcEmbeddingSimilarity(scoring.queryEmbedding, doc, scoring.embeddingIndex)
    : 0;
  const semanticWeight = Math.max(0, Number(config.MEMORY_SEMANTIC_RECALL_WEIGHT || 0.3) || 0.3);
  const lexicalWeight = 0.72;
  const score = (lexical * 0.72)
    + (embedding * semanticWeight)
    + direct
    + dateBoost
    + recencyBoost(doc.updatedAt)
    + confidenceBoost(doc)
    + tierBoost(doc)
    + scopeBoost(doc, context, queryFacet);
  return {
    doc,
    score,
    lexical,
    direct,
    dateBoost,
    embedding,
    matchMode: embedding > 0 && lexical > 0.04
      ? 'hybrid'
      : embedding > 0
        ? 'semantic'
        : 'lexical',
    scoreParts: {
      lexical,
      lexicalWeight,
      embedding,
      semanticWeight,
      direct,
      dateBoost
    }
  };
}

function shouldExpandSelection(selected = [], limit = 8) {
  const topScore = Number(selected[0]?.score || 0);
  const expandScore = Number(config.MEMORY_CLI_SECONDARY_EXPAND_SCORE || SEARCH_EXPAND_SCORE_DEFAULT) || SEARCH_EXPAND_SCORE_DEFAULT;
  const expandMinRatio = Number(config.MEMORY_CLI_SECONDARY_EXPAND_MIN_RATIO || SEARCH_EXPAND_MIN_RATIO_DEFAULT) || SEARCH_EXPAND_MIN_RATIO_DEFAULT;
  const minSelected = Math.max(2, Math.ceil(Math.max(1, Number(limit) || 1) * expandMinRatio));
  return topScore < expandScore || selected.length < minSelected;
}

function resultRefForDoc(doc = {}) {
  if (doc.source === 'notebook' && doc.notebookRef) {
    return `mc_ref:notebook:${doc.notebookRef.docId}:${doc.notebookRef.chunkIndex}`;
  }
  return `mc_ref:${doc.source}:${doc.id}`;
}

function resultTypeForDoc(doc = {}) {
  if (doc.source === 'notebook') return 'notebook_doc';
  if (doc.source === 'recent') return 'recent_session';
  return doc.type || 'fact';
}

function trimPackedResults(rows = [], limit = 8) {
  const results = [];
  let outputChars = 0;
  let droppedResultCount = 0;
  const maxChars = Math.max(800, Number(config.MEMORY_CLI_RESULT_TOTAL_CHARS || 2200));
  for (const row of normalizeArray(rows)) {
    if (results.length >= Math.max(1, Number(limit) || 1)) break;
    const doc = row.doc || {};
    const preview = sanitizePreviewText(doc.preview || doc.text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS);
    const estimated = preview.length + String(doc.title || '').length + 48;
    if (outputChars + estimated > maxChars) {
      droppedResultCount += 1;
      continue;
    }
    results.push({
      ref: resultRefForDoc(doc),
      source: doc.source,
      type: resultTypeForDoc(doc),
      id: doc.source === 'notebook' && doc.notebookRef ? doc.notebookRef.docId : doc.id,
      title: doc.title || sanitizePreviewText(doc.text, 80),
      preview,
      text: preview,
      score: Number(row.score || 0).toFixed(3),
      updatedAt: doc.updatedAt || 0,
      confidence: doc.confidence || 0,
      tier: doc.tier || '',
      matchMode: row.matchMode || 'lexical',
      status: doc.status || 'active',
      sourceKind: doc.sourceKind || '',
      evidenceTier: doc.evidenceTier || '',
      fieldKey: doc.fieldKey || ''
    });
    outputChars += estimated;
  }
  return { results, outputChars, droppedResultCount };
}

function digestForResults(rows = []) {
  const maxChars = Math.max(120, Number(config.MEMORY_CLI_DIGEST_MAX_CHARS || 480));
  let total = 0;
  const output = [];
  for (const row of normalizeArray(rows).slice(0, 5)) {
    const doc = row.doc || {};
    const line = `[${doc.source}|${resultTypeForDoc(doc)}] ${sanitizePreviewText(doc.preview || doc.text, 120)}`;
    if (total + line.length + 1 > maxChars) break;
    output.push(line);
    total += line.length + 1;
  }
  return output;
}

function selectDiverseRows(rows = [], limit = 8, queryFacet = 'default_continuity') {
  const perSourceLimit = getFacetPerSourceLimit(queryFacet);
  const selected = [];
  const seenCanonical = new Set();
  const seenSourceCount = new Map();
  for (const row of normalizeArray(rows)) {
    if (selected.length >= Math.max(1, Number(limit) || 1)) break;
    const doc = row.doc || {};
    const canonical = normalizeText(doc.canonicalText || doc.text).toLowerCase();
    if (!canonical || seenCanonical.has(canonical)) continue;
    const current = seenSourceCount.get(doc.source) || 0;
    const maxPerSource = Math.max(1, Number(perSourceLimit[doc.source] || 2) || 2);
    if (current >= maxPerSource) continue;
    seenCanonical.add(canonical);
    seenSourceCount.set(doc.source, current + 1);
    selected.push(row);
  }
  if (selected.length >= Math.max(1, Number(limit) || 1)) return selected;
  for (const row of normalizeArray(rows)) {
    if (selected.length >= Math.max(1, Number(limit) || 1)) break;
    const doc = row.doc || {};
    const canonical = normalizeText(doc.canonicalText || doc.text).toLowerCase();
    if (!canonical || seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);
    selected.push(row);
  }
  return selected;
}

function sortRows(rows = []) {
  return normalizeArray(rows).slice().sort((a, b) => {
    if (Number(b.score || 0) !== Number(a.score || 0)) return Number(b.score || 0) - Number(a.score || 0);
    if (Number(b.doc?.updatedAt || 0) !== Number(a.doc?.updatedAt || 0)) return Number(b.doc?.updatedAt || 0) - Number(a.doc?.updatedAt || 0);
    return String(a.doc?.id || '').localeCompare(String(b.doc?.id || ''));
  });
}

function gatherRowsForSources(snapshot, sources = [], query = '', limit = 8, context = {}, queryFacet = 'default_continuity', scoring = {}) {
  const queryTokens = tokenize(`${normalizeText(query)} ${canonicalizeText(query)}`);
  const rows = [];
  const candidateCounts = {};
  for (const source of normalizeArray(sources)) {
    const ids = resolveSourceCandidates(snapshot, source, context);
    candidateCounts[source] = ids.length;
    for (const id of ids) {
      const doc = snapshot.docsById.get(id);
      if (!doc || !doc.text) continue;
      rows.push(scoreDoc(query, queryTokens, doc, context, queryFacet, scoring));
    }
  }
  return {
    rows: sortRows(rows),
    candidateCounts
  };
}

function applyJournalTargetDayPriorityToRows(rows = [], query = '') {
  const targetDays = resolveJournalTargetDays(query);
  if (!targetDays.length) return rows;
  const hardBoost = Math.max(4, Number(config.MEMORY_JOURNAL_TARGET_DATE_HARD_BOOST || 8) || 8);
  return normalizeArray(rows).map((row) => {
    const doc = row.doc || {};
    if (doc.source !== 'journal' || !targetDays.includes(String(doc.episodeDay || doc.title || '').trim())) return row;
    return {
      ...row,
      score: Number(row.score || 0) + hardBoost,
      journalTargetDayPriority: true,
      scoreParts: {
        ...(row.scoreParts || {}),
        targetDatePriorityBoost: hardBoost
      }
    };
  });
}

async function rerankRows(query = '', rows = [], context = {}) {
  const list = normalizeArray(rows);
  if (list.length < 2 || config.MEMORY_CLI_RERANK_ENABLED === false) return list;
  const candidates = list.map((row) => ({
    ...row.doc,
    score: row.score,
    finalScore: row.score,
    matchMode: row.matchMode,
    lexical: row.lexical,
    embedding: row.embedding,
    dateBoost: row.dateBoost
  }));
  const reranked = await rerankMemoryCandidates(query, candidates, {
    userId: context.userId,
    phase: 'memory_cli_fast',
    maxCandidates: config.MEMORY_RERANK_MAX_CANDIDATES
  });
  return normalizeArray(reranked).map((item) => ({
    doc: item,
    score: Number(item.score || item.finalScore || 0) || 0,
    lexical: Number(item.lexical || 0) || 0,
    direct: directMatchBoost(query, item),
    dateBoost: Number(item.dateBoost || item.scoreParts?.dateBoost || 0) || 0,
    embedding: Number(item.embedding || 0) || 0,
    rerankScore: Number(item.rerankScore || 0) || 0,
    matchMode: Number(item.rerankScore || 0) > 0
      ? (item.matchMode === 'semantic' ? 'semantic_rerank' : item.matchMode === 'hybrid' ? 'hybrid_rerank' : 'rerank')
      : (item.matchMode || 'lexical'),
    scoreParts: item.scoreParts || {}
  }));
}

function mergeCandidateCounts(base = {}, extra = {}) {
  const output = { ...(base || {}) };
  for (const [key, value] of Object.entries(extra || {})) {
    output[key] = (output[key] || 0) + (Number(value || 0) || 0);
  }
  return output;
}

function buildSearchResponse(selectedRows = [], candidateCounts = {}, queryFacet = 'default_continuity', fallbackUsed = false, limit = 8) {
  const packed = trimPackedResults(selectedRows, limit);
  const sourceCoverage = {};
  for (const item of packed.results) {
    sourceCoverage[item.source] = (sourceCoverage[item.source] || 0) + 1;
  }
  return {
    results: packed.results,
    digest: digestForResults(selectedRows),
    sourceCoverage,
    queryFacet,
    candidateCounts,
    fallbackUsed,
    outputChars: packed.outputChars,
    recentUsed: Boolean(sourceCoverage.recent),
    droppedResultCount: packed.droppedResultCount
  };
}

function logSlowQuery(details = {}) {
  const totalMs = Number(details.totalMs || 0) || 0;
  if (totalMs < SLOW_QUERY_LOG_MS) return;
  console.log('[memory_cli_fast] slow query', {
    command: details.command || 'search',
    queryFacet: details.queryFacet || '',
    source: details.source || '',
    queryPreview: String(details.query || '').slice(0, 120),
    hydrateMs: Number(details.hydrateMs || 0) || 0,
    selectMs: Number(details.selectMs || 0) || 0,
    gatherMs: Number(details.gatherMs || 0) || 0,
    scoreMs: Number(details.scoreMs || 0) || 0,
    packMs: Number(details.packMs || 0) || 0,
    openMs: Number(details.openMs || 0) || 0,
    totalMs
  });
}

async function searchMemoryCliFast(query = '', options = {}, context = {}) {
  const startedAt = nowMs();
  const snapshot = await ensureSnapshot();
  const hydrateMs = nowMs() - startedAt;
  const queryText = normalizeText(query);
  const limit = Math.max(1, Math.min(20, Number(options.limit || config.MEMORY_CLI_MAX_RESULTS || 8) || 8));
  const requestedSource = normalizeText(options.source || 'all').toLowerCase() || 'all';
  const plan = chooseSourcePlan(queryText, requestedSource);
  const queryEmbedding = shouldUseRemoteEmbedding() ? await requestEmbedding(queryText) : null;
  const scoring = {
    embeddingIndex: queryEmbedding ? loadEmbeddingIndex() : null,
    queryEmbedding
  };
  const selectStartedAt = nowMs();
  const selectedPrimarySources = normalizeArray(plan.primary).filter((item) => SOURCE_SET.has(item));
  const selectedSecondarySources = normalizeArray(plan.secondary).filter((item) => SOURCE_SET.has(item) && !selectedPrimarySources.includes(item));
  const selectMs = nowMs() - selectStartedAt;

  const gatherStartedAt = nowMs();
  const primary = gatherRowsForSources(snapshot, selectedPrimarySources, queryText, limit, context, plan.queryFacet, scoring);
  let candidateCounts = primary.candidateCounts;
  let ranked = primary.rows;
  let fallbackUsed = false;
  if (requestedSource === 'all' && shouldExpandSelection(ranked, limit) && selectedSecondarySources.length > 0) {
    const secondary = gatherRowsForSources(snapshot, selectedSecondarySources, queryText, limit, context, plan.queryFacet, scoring);
    ranked = sortRows(ranked.concat(secondary.rows));
    candidateCounts = mergeCandidateCounts(candidateCounts, secondary.candidateCounts);
    fallbackUsed = true;
  }
  const gatherMs = nowMs() - gatherStartedAt;

  const scoreStartedAt = nowMs();
  ranked = sortRows(applyJournalTargetDayPriorityToRows(await rerankRows(queryText, ranked, context), queryText));
  const selectedRows = selectDiverseRows(ranked, limit, plan.queryFacet);
  const scoreMs = nowMs() - scoreStartedAt;

  const packStartedAt = nowMs();
  const payload = buildSearchResponse(selectedRows, candidateCounts, plan.queryFacet, fallbackUsed, limit);
  payload.diagnostics = {
    projectionFreshness: diagnoseProjectionFreshness({
      ...context,
      userId: normalizeText(context.userId),
      groupId: normalizeText(context.groupId),
      sessionKey: normalizeText(context.sessionKey)
    })
  };
  const packMs = nowMs() - packStartedAt;

  logSlowQuery({
    command: 'search',
    source: requestedSource,
    query: queryText,
    queryFacet: payload.queryFacet,
    hydrateMs,
    selectMs,
    gatherMs,
    scoreMs,
    packMs,
    totalMs: nowMs() - startedAt
  });

  return payload;
}

function docMatchesOpenScope(doc = {}, context = {}) {
  const userId = normalizeText(context.userId);
  if (!userId) return false;
  if (doc.source === 'group' || doc.source === 'jargon') {
    const accessible = new Set(getAccessibleGroupIdsForUser(userId).map((item) => normalizeText(item)).filter(Boolean));
    if (normalizeText(context.groupId)) accessible.add(normalizeText(context.groupId));
    return accessible.has(normalizeText(doc.groupId));
  }
  if (doc.source === 'notebook' && normalizeText(doc.scopeType) === 'group') {
    const accessible = new Set(getAccessibleGroupIdsForUser(userId).map((item) => normalizeText(item)).filter(Boolean));
    if (normalizeText(context.groupId)) accessible.add(normalizeText(context.groupId));
    return accessible.has(normalizeText(doc.groupId));
  }
  return normalizeText(doc.userId) === userId || normalizeText(doc.ownerUserId) === userId;
}

function resolveDocByOpenTarget(snapshot, target = {}, context = {}) {
  const ref = normalizeText(target.ref);
  const source = normalizeText(target.source).toLowerCase();
  const id = normalizeText(target.id);

  let doc = null;
  if (ref) {
    if (ref.startsWith('mc_ref:notebook:')) {
      const suffix = ref.replace(/^mc_ref:notebook:/, '');
      const [docId, chunkIndexRaw] = suffix.split(':');
      doc = snapshot.docsById.get(`notebook:${docId}:${toSafeNumber(chunkIndexRaw, 0)}`);
    } else {
      const match = ref.match(/^mc_ref:([a-z_]+):(.+)$/i);
      if (match) {
        const refSource = normalizeText(match[1]).toLowerCase();
        const refId = String(match[2] || '').trim();
        if (refSource === 'notebook') {
          const [docId, chunkIndexRaw] = refId.split(':');
          doc = snapshot.docsById.get(`notebook:${docId}:${toSafeNumber(chunkIndexRaw, 0)}`);
        } else if (snapshot.docsById.has(refId)) {
          doc = snapshot.docsById.get(refId);
        } else if (refSource === 'recent') {
          doc = snapshot.docsById.get(`session:${refId}`);
        } else if (refSource === 'journal' && snapshot.docsById.has(`episode:${refId}`)) {
          doc = snapshot.docsById.get(`episode:${refId}`);
        }
      }
    }
  }

  if (!doc && source && id) {
    if (source === 'notebook') {
      doc = snapshot.docsById.get(`notebook:${id}:0`) || null;
    } else if (snapshot.docsById.has(id)) {
      doc = snapshot.docsById.get(id);
    } else if (source === 'recent') {
      doc = snapshot.docsById.get(`session:${id}`) || null;
    } else if (source === 'journal') {
      doc = snapshot.docsById.get(`episode:${id}`) || null;
    }
  }

  if (!doc) return null;
  if (!docMatchesOpenScope(doc, context)) return null;
  return doc;
}

async function openMemoryCliFast(target = {}, context = {}) {
  const startedAt = nowMs();
  const snapshot = await ensureSnapshot();
  const hydrateMs = nowMs() - startedAt;
  const openStartedAt = nowMs();
  const doc = resolveDocByOpenTarget(snapshot, target, context);
  const payload = doc
    ? {
        source: doc.source,
        id: doc.source === 'notebook' && doc.notebookRef ? doc.notebookRef.docId : doc.id,
        data: doc.openPayload || {
          id: doc.id,
          type: doc.type,
          text: clampText(doc.text, Math.min(1600, Number(config.MEMORY_CLI_MAX_OPEN_CHARS || 12000))),
          updatedAt: doc.updatedAt || 0
        }
      }
    : null;
  const openMs = nowMs() - openStartedAt;
  logSlowQuery({
    command: 'open',
    source: normalizeText(target.source).toLowerCase(),
    query: normalizeText(target.ref || target.id),
    hydrateMs,
    openMs,
    totalMs: nowMs() - startedAt
  });
  return payload;
}

module.exports = {
  ensureSnapshot,
  openMemoryCliFast,
  schedulePreload,
  searchMemoryCliFast
};
