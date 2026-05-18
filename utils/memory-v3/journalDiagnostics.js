const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { safeReadJsonLines, normalizeText } = require('./helpers');
const { loadMemoryEvents } = require('./events');
const { loadEmbeddingIndex } = require('./embeddingIndex');
const { loadEpisodeProjection } = require('./storage');
const { readDailyJournalUsers, scanDailyJournalDays } = require('./journalDocs');

function fileExists(filePath = '') {
  try {
    return fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

function statMs(filePath = '') {
  try {
    return Number(fs.statSync(filePath).mtimeMs || 0) || 0;
  } catch (_) {
    return 0;
  }
}

function countLines(filePath = '') {
  return safeReadJsonLines(filePath).length;
}

function summarizeEmbeddingRows(userId = '') {
  const uid = normalizeText(userId);
  const rows = loadEmbeddingIndex().rows.filter((row) => {
    const nodeId = normalizeText(row.nodeId || row.id);
    return nodeId.startsWith(`journal-day:${uid}:`) || nodeId.startsWith(`journal-segment:${uid}:`);
  });
  return {
    total: rows.length,
    ready: rows.filter((row) => row.status === 'ready' && Array.isArray(row.embedding) && row.embedding.length > 0).length,
    pending: rows.filter((row) => row.status !== 'ready').length,
    failed: rows.filter((row) => row.status === 'failed').length
  };
}

function summarizeJournalUser(userId = '', events = [], episodeProjection = {}) {
  const uid = normalizeText(userId);
  const dir = path.join(config.DAILY_JOURNAL_DIR, uid);
  const days = scanDailyJournalDays(uid);
  const dayRows = days.map((day) => {
    const journalFile = path.join(dir, `${day}.journal.md`);
    const entriesFile = path.join(dir, `${day}.entries.jsonl`);
    const segmentsFile = path.join(dir, `${day}.segments.jsonl`);
    const summaryFile = path.join(dir, `${day}.summary.md`);
    return {
      day,
      hasJournal: fileExists(journalFile),
      hasEntries: fileExists(entriesFile),
      segmentCount: countLines(segmentsFile),
      hasSummary: fileExists(summaryFile),
      updatedAt: Math.max(statMs(journalFile), statMs(entriesFile), statMs(segmentsFile), statMs(summaryFile))
    };
  });
  const userEvents = events.filter((event) => (
    event.userId === uid
    && event.type === 'episode_rollup_generated'
    && (event.source === 'daily_journal_summary' || event.source === 'daily_journal_rollup')
  ));
  const episodeItems = Array.isArray(episodeProjection.users?.[uid]?.items) ? episodeProjection.users[uid].items : [];
  const embeddings = summarizeEmbeddingRows(uid);
  return {
    userId: uid,
    days: days.length,
    journalDays: dayRows.filter((row) => row.hasJournal).length,
    summaryDays: dayRows.filter((row) => row.hasSummary).length,
    segmentDays: dayRows.filter((row) => row.segmentCount > 0).length,
    segments: dayRows.reduce((sum, row) => sum + row.segmentCount, 0),
    v3EpisodeEvents: userEvents.length,
    v3EpisodeItems: episodeItems.length,
    embeddings,
    latestUpdatedAt: Math.max(0, ...dayRows.map((row) => row.updatedAt)),
    missingSummaryDays: dayRows.filter((row) => row.hasJournal && !row.hasSummary).map((row) => row.day).slice(-14)
  };
}

function buildJournalHealthSummary(options = {}) {
  const userIds = Array.isArray(options.userIds) && options.userIds.length
    ? options.userIds.map(normalizeText).filter(Boolean)
    : readDailyJournalUsers();
  const events = loadMemoryEvents();
  const episodeProjection = loadEpisodeProjection();
  const users = userIds.map((userId) => summarizeJournalUser(userId, events, episodeProjection));
  const totals = users.reduce((acc, row) => {
    acc.users += 1;
    acc.days += row.days;
    acc.summaryDays += row.summaryDays;
    acc.segmentDays += row.segmentDays;
    acc.segments += row.segments;
    acc.v3EpisodeEvents += row.v3EpisodeEvents;
    acc.v3EpisodeItems += row.v3EpisodeItems;
    acc.embeddingTotal += row.embeddings.total;
    acc.embeddingReady += row.embeddings.ready;
    acc.embeddingPending += row.embeddings.pending;
    acc.embeddingFailed += row.embeddings.failed;
    acc.latestUpdatedAt = Math.max(acc.latestUpdatedAt, row.latestUpdatedAt);
    return acc;
  }, {
    users: 0,
    days: 0,
    summaryDays: 0,
    segmentDays: 0,
    segments: 0,
    v3EpisodeEvents: 0,
    v3EpisodeItems: 0,
    embeddingTotal: 0,
    embeddingReady: 0,
    embeddingPending: 0,
    embeddingFailed: 0,
    latestUpdatedAt: 0
  });
  return {
    ok: true,
    totals,
    users: users
      .sort((a, b) => Number(b.latestUpdatedAt || 0) - Number(a.latestUpdatedAt || 0))
      .slice(0, Math.max(1, Number(options.limit || 20) || 20))
  };
}

module.exports = {
  buildJournalHealthSummary,
  summarizeJournalUser
};
