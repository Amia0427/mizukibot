const path = require('path');
const config = require('../../config');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeDay(value) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function normalizeYearMonth(value) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}$/.test(text) ? text : '';
}

function normalizeRollupLevel(value = 'daily') {
  const text = normalizeText(value).toLowerCase();
  if (text === '4day' || text === 'monthly' || text === 'segment') return text;
  return 'daily';
}

function clampText(text = '', maxChars = 4000) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const limit = Math.max(40, Number(maxChars) || 4000);
  return value.length > limit ? value.slice(0, limit).trim() : value;
}

function buildJournalEpisodeDedupeKey(payload = {}) {
  return [
    'journal',
    normalizeText(payload.userId),
    normalizeRollupLevel(payload.rollupLevel),
    normalizeDay(payload.episodeDay),
    normalizeDay(payload.startDay),
    normalizeDay(payload.endDay),
    normalizeYearMonth(payload.yearMonth),
    Number(payload.part || 0) || 0,
    normalizeText(payload.sourceFile)
  ].filter(Boolean).join('|');
}

async function appendJournalEpisodeEvent(payload = {}) {
  if (!config.MEMORY_V3_ENABLED) return null;
  const userId = normalizeText(payload.userId);
  const text = clampText(payload.text, payload.maxChars || 4000);
  if (!userId || !text) return null;

  const rollupLevel = normalizeRollupLevel(payload.rollupLevel);
  const episodeDay = normalizeDay(payload.episodeDay || payload.endDay || payload.startDay);
  const startDay = normalizeDay(payload.startDay || ((rollupLevel === 'daily' || rollupLevel === 'segment') ? episodeDay : ''));
  const endDay = normalizeDay(payload.endDay || ((rollupLevel === 'daily' || rollupLevel === 'segment') ? episodeDay : ''));
  const yearMonth = normalizeYearMonth(payload.yearMonth || (episodeDay ? episodeDay.slice(0, 7) : ''));
  const sourceFile = normalizeText(payload.sourceFile);
  const dedupeKey = normalizeText(payload.dedupeKey) || buildJournalEpisodeDedupeKey({
    ...payload,
    rollupLevel,
    episodeDay,
    startDay,
    endDay,
    yearMonth,
    sourceFile
  });
  const canonicalKey = normalizeText(payload.canonicalKey) || dedupeKey;
  const { appendMemoryEvent } = require('./events');
  return appendMemoryEvent({
    type: 'episode_rollup_generated',
    userId,
    sessionKey: normalizeText(payload.sessionKey),
    groupId: normalizeText(payload.groupId),
    channelId: normalizeText(payload.channelId),
    routePolicyKey: normalizeText(payload.routePolicyKey),
    topRouteType: normalizeText(payload.topRouteType),
    scopeType: 'personal',
    source: normalizeText(payload.source) || 'daily_journal',
    sourceKind: normalizeText(payload.sourceKind) || 'journal',
    status: 'active',
    confidence: Number(payload.confidence ?? 0.94) || 0.94,
    importance: Number(payload.importance ?? (rollupLevel === 'monthly' ? 1.2 : 1.08)) || 1.08,
    evidenceCount: Math.max(1, Number(payload.evidenceCount || 1) || 1),
    memoryKind: 'episode',
    semanticSlot: 'episode',
    canonicalKey,
    dedupeKey,
    text,
    payload: {
      memoryKind: 'episode',
      type: rollupLevel,
      rollupLevel,
      episodeDay,
      startDay,
      endDay,
      yearMonth,
      part: Number(payload.part || 0) || 0,
      sourceFile,
      fieldKey: 'episode',
      textKind: normalizeText(payload.textKind) || `journal_${rollupLevel}`,
      sourceCompleteness: normalizeText(payload.sourceCompleteness) || 'summary',
      coveredByRollups: Array.isArray(payload.coveredByRollups) ? payload.coveredByRollups : [],
      sessionKeys: Array.isArray(payload.sessionKeys) ? payload.sessionKeys.map(normalizeText).filter(Boolean) : [],
      topics: Array.isArray(payload.topics) ? payload.topics.map(normalizeText).filter(Boolean) : []
    }
  });
}

function buildJournalEpisodeDocsForUser(userId = '') {
  const uid = normalizeText(userId);
  if (!uid) return [];
  const { canonicalizeText } = require('./helpers');
  const { loadEpisodeProjection } = require('./storage');
  const entry = loadEpisodeProjection().users?.[uid];
  const items = Array.isArray(entry?.items) ? entry.items : [];
  return items.map((episode) => {
    const text = normalizeText(episode.text);
    const eventId = normalizeText(episode.id);
    if (!text || !eventId) return null;
    const rollupLevel = normalizeRollupLevel(episode.rollupLevel || episode.type || 'daily');
    if (rollupLevel === 'segment') return null;
    return {
      id: `episode:${eventId}`,
      source: 'journal',
      sourceKind: normalizeText(episode.sourceKind || 'journal'),
      type: 'episode',
      memoryKind: 'episode',
      scopeType: 'personal',
      userId: uid,
      ownerUserId: uid,
      fieldKey: 'episode',
      semanticSlot: 'episode',
      status: 'active',
      canonicalKey: normalizeText(episode.canonicalKey || episode.dedupeKey || canonicalizeText(text)).toLowerCase(),
      text,
      updatedAt: Number(episode.updatedAt || 0) || 0,
      confidence: Number(episode.confidence || 0) || 0.92,
      importance: Number(episode.importance || 0) || (rollupLevel === 'monthly' ? 1.2 : 1.0),
      evidenceCount: Math.max(1, Number(episode.evidenceCount || 1) || 1),
      evidenceTier: 'strict',
      rollupLevel,
      episodeDay: normalizeDay(episode.episodeDay || episode.endDay || episode.startDay),
      startDay: normalizeDay(episode.startDay),
      endDay: normalizeDay(episode.endDay),
      yearMonth: normalizeYearMonth(episode.yearMonth),
      part: Math.max(0, Number(episode.part || 0) || 0),
      textKind: normalizeText(episode.textKind) || `journal_${rollupLevel}`,
      sourceCompleteness: normalizeText(episode.sourceCompleteness || 'summary'),
      sourceFile: normalizeText(episode.sourceFile)
    };
  }).filter(Boolean);
}

function scheduleJournalV3Refresh(options = {}) {
  const userId = normalizeText(options.userId);
  if (!userId) return { ok: false, reason: 'missing_user_id' };
  const days = Array.isArray(options.days)
    ? options.days.map(normalizeDay).filter(Boolean)
    : [];
  const result = {
    ok: true,
    materialized: null,
    embeddings: null,
    reason: normalizeText(options.reason) || 'journal_refresh'
  };
  try {
    if (config.MEMORY_V3_ENABLED) {
      const { materializeMemoryViews } = require('./materializer');
      result.materialized = materializeMemoryViews({
        mode: 'incremental',
        userId,
        reason: result.reason,
        scheduleEmbeddingBackfill: false
      });
    }
  } catch (error) {
    result.materializeError = error?.message || String(error);
  }
  try {
    if (config.MEMORY_JOURNAL_EMBEDDING_BACKFILL_ENABLED !== false) {
      const { buildDailyJournalDocsForUser } = require('./journalDocs');
      const { enqueueMissingEmbeddings } = require('./embeddingIndex');
      const docs = buildDailyJournalDocsForUser(userId, {
        includeSegments: true,
        days: days.length ? days : undefined
      }).concat(buildJournalEpisodeDocsForUser(userId));
      result.embeddings = enqueueMissingEmbeddings(docs, {
        schedule: options.scheduleEmbeddingBackfill !== false,
        delayMs: options.delayMs
      });
    }
  } catch (error) {
    result.embeddingError = error?.message || String(error);
  }
  return result;
}

function getJournalSourceFile(filePath = '') {
  const text = normalizeText(filePath);
  return text ? path.normalize(text) : '';
}

module.exports = {
  appendJournalEpisodeEvent,
  buildJournalEpisodeDedupeKey,
  buildJournalEpisodeDocsForUser,
  getJournalSourceFile,
  scheduleJournalV3Refresh
};
