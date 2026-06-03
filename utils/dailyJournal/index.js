const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { formatDateInTz, formatTimeInTz, getDatePartsInTz } = require('../time');
const { favorites, getUserProfile, getUserSummary, getUserImpression } = require('../memory');
const { postWithRetry } = require('../../api/httpClient');
const { extractMessageContent } = require('../../api/parser');
const { getBackgroundPressureDelayMs, appendPerfEvent } = require('../perfRuntime');
const {
  atomicWriteJson,
  atomicWriteText,
  ensureUserJournalDir,
  getEntrySidecarFilePath,
  getFourDayRollupFilePath,
  getJournalFilePath,
  getJournalIndex: getStoredJournalIndex,
  getMonthlyRollupFilePath,
  getSegmentsFilePath,
  getSummaryFilePath,
  getUserJournalDir,
  normalizeJournalIndex,
  READ_LOG_FILE,
  safeReadJson,
  safeReadText,
  sortUniqueStrings,
  SUMMARY_STATE_FILE,
  toSafeJournalPathSegment,
  updateJournalIndex,
  updateRollupIndex
} = require('./storage');
const {
  compareFourDayRollups,
  compareMonthlyRollups,
  formatDailyJournalBundleText,
  getYearMonthFromDay,
  isValidDayString,
  selectMostRecentItems
} = require('./rollupUtils');
const {
  formatJournalEntries,
  normalizeJournalText,
  normalizeTimestampToDay,
  normalizeYearMonth,
  parseJournalEntries,
  shiftDate,
  strictClampText
} = require('./text');
const {
  buildFourDayRollupPlans,
  buildMonthlyRollupPlans,
  listFourDayRollupsFromDisk,
  listMonthlyRollupsFromDisk,
  listUserSummaryDaysFromDisk
} = require('./rollups');
const {
  appendJsonLine,
  readJsonLines
} = require('./jsonLines');
const { createDailyJournalRetrieval } = require('./retrieval');
const { createDailyJournalRollupMaintenance } = require('./rollupMaintenance');
const { createDailyJournalSegments } = require('./segments');
const { createDailyJournalMemorySync } = require('./memorySync');
const { createDailyJournalSummaryRunner } = require('./summaryRunner');
const { createDailyJournalViews } = require('./views');
const {
  classifyJournalEntrySafety,
  filterInjectableJournalEntries
} = require('./safety');

function syncJournalEntryToProfileJournalDb(userId, day, record = {}, options = {}, patch = {}) {
  try {
    const { upsertJournalEntry } = require('../profileJournalDb');
    return upsertJournalEntry({
      userId,
      day,
      ts: record.ts,
      sessionKey: options.sessionKey,
      turnId: options.turnId,
      userText: record.user,
      assistantText: record.assistant,
      safety: patch.safety || 'safe',
      status: patch.status || 'active',
      unsafeReason: patch.unsafeReason
    }, options);
  } catch (error) {
    if (config.ENABLE_DEBUG_LOG) {
      console.warn('[profile_journal_db] failed to sync journal entry:', error?.message || error);
    }
    return { ok: false, reason: error?.message || String(error) };
  }
}

function syncJournalRollupToProfileJournalDb(userId, rollup = {}) {
  try {
    const { upsertJournalRollup } = require('../profileJournalDb');
    return upsertJournalRollup({
      userId,
      ...rollup
    });
  } catch (error) {
    if (config.ENABLE_DEBUG_LOG) {
      console.warn('[profile_journal_db] failed to sync journal rollup:', error?.message || error);
    }
    return { ok: false, reason: error?.message || String(error) };
  }
}

const {
  syncEpisodeMemory,
  scheduleDailyJournalEmbeddingBackfill,
  getMemoryChatCompletionsUrl,
  getMemoryModelName,
  getMemoryApiKey
} = createDailyJournalMemorySync({
  config,
  strictClampText
});

const {
  collectDailySummaryItems,
  createRecentDailySummariesGetter,
  getDailyJournalStats,
  getDailySummaryItem,
  listFourDayRollups,
  listMonthlyRollups,
  listUserJournalDays,
  listUserSummaryDays
} = createDailyJournalViews({
  compareFourDayRollups,
  compareMonthlyRollups,
  config,
  formatDateInTz,
  formatJournalEntries,
  fs,
  getJournalFilePath,
  getJournalIndex: getStoredJournalIndex,
  getSummaryFilePath,
  getUserJournalDir,
  isValidDayString,
  listFourDayRollupsFromDisk,
  listMonthlyRollupsFromDisk,
  listUserSummaryDaysFromDisk,
  normalizeJournalIndex,
  parseJournalEntries,
  readEntrySidecar: (...args) => readEntrySidecar(...args),
  readSegmentSummaries: (...args) => readSegmentSummaries(...args),
  safeReadText,
  filterInjectableJournalEntries,
  shiftDate,
  strictClampText
});

const {
  maintainDailyJournalRollups,
  summarizeDerivedRollup
} = createDailyJournalRollupMaintenance({
  atomicWriteText,
  buildFourDayRollupPlans,
  buildMonthlyRollupPlans,
  buildUserSnapshot,
  config,
  extractMessageContent,
  fs,
  getFourDayRollupFilePath,
  getMemoryApiKey,
  getMemoryChatCompletionsUrl,
  getMemoryModelName,
  getMonthlyRollupFilePath,
  getSummaryFilePath,
  getYearMonthFromDay,
  listFourDayRollups,
  listUserSummaryDays,
  postWithRetry,
  safeReadText,
  shiftDate,
  strictClampText,
  syncEpisodeMemory,
  syncJournalRollupToProfileJournalDb,
  updateJournalIndex,
  updateRollupIndex
});

const {
  buildActiveRawJournalItem,
  buildEmptyRetrievalBundle,
  getDailyJournalRetrievalBundle,
  hashText,
  logDailyJournalRead,
  matchSidecarEntries,
  nowMs,
  shouldLogDailyJournalReads
} = createDailyJournalRetrieval({
  READ_LOG_FILE,
  appendJsonLine,
  collectDailySummaryItems,
  compareFourDayRollups,
  compareMonthlyRollups,
  config,
  formatDailyJournalBundleText,
  formatDateInTz,
  formatJournalEntries,
  getDailyJournalStats: (...args) => getDailyJournalStats(...args),
  getDailySummaryItem,
  getEntrySidecarFilePath,
  getJournalFilePath,
  getYearMonthFromDay,
  isValidDayString,
  listFourDayRollups,
  listMonthlyRollups,
  normalizeContinuitySnapshot,
  normalizeTimestampToDay,
  normalizeYearMonth,
  parseJournalEntries,
  filterInjectableJournalEntries,
  readEntrySidecar: (...args) => readEntrySidecar(...args),
  readJsonLines,
  safeReadText,
  selectMostRecentItems,
  shiftDate,
  strictClampText
});

const {
  buildEntrySidecarRecord,
  collectRecentEntrySidecars,
  maybeSegmentJournal,
  maybeSegmentJournalByThreshold,
  readEntrySidecar,
  readSegmentSummaries
} = createDailyJournalSegments({
  appendJsonLine,
  appendPerfEvent,
  atomicWriteText,
  buildUserSnapshot,
  config,
  extractMessageContent,
  formatDateInTz,
  formatJournalEntries,
  getBackgroundPressureDelayMs,
  getEntrySidecarFilePath,
  getJournalFilePath,
  getMemoryApiKey,
  getMemoryChatCompletionsUrl,
  getMemoryModelName,
  getSegmentsFilePath,
  getYearMonthFromDay,
  isValidDayString,
  loadSummaryState: (...args) => loadSummaryState(...args),
  normalizeContinuitySnapshot,
  normalizeTimestampToDay,
  parseJournalEntries,
  filterInjectableJournalEntries,
  postWithRetry,
  readJsonLines,
  safeReadText,
  saveSummaryState: (...args) => saveSummaryState(...args),
  scheduleDailyJournalEmbeddingBackfill,
  shiftDate,
  strictClampText,
  syncEpisodeMemory
});

function buildJournalEntryRecord(question, reply, userInfo = {}, date = new Date()) {
  const userText = normalizeJournalText(question, config.DAILY_JOURNAL_MAX_USER_CHARS);
  const assistantText = normalizeJournalText(reply, config.DAILY_JOURNAL_MAX_ASSISTANT_CHARS);
  if (!userText || !assistantText) return null;

  return {
    ts: date.toISOString(),
    time: formatTimeInTz('zh-CN', date, config.TIMEZONE),
    affinity: String(userInfo?.level || '').trim() || 'unknown',
    user: userText,
    assistant: assistantText
  };
}

function normalizeContinuitySnapshot(snapshot = {}) {
  const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    activeTopic: String(input.activeTopic || input.active_topic || '').trim(),
    openLoops: Array.isArray(input.openLoops || input.open_loops)
      ? (input.openLoops || input.open_loops).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
      : [],
    assistantCommitments: Array.isArray(input.assistantCommitments || input.assistant_commitments)
      ? (input.assistantCommitments || input.assistant_commitments).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
      : [],
    userConstraints: Array.isArray(input.userConstraints || input.user_constraints)
      ? (input.userConstraints || input.user_constraints).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
      : [],
    carryOverUserTurn: String(input.carryOverUserTurn || input.carry_over_user_turn || '').trim()
  };
}

async function appendDailyJournalEntry(userId, question, reply, userInfo = {}, options = {}) {
  if (!config.DAILY_JOURNAL_ENABLED) return false;

  const uid = String(userId || '').trim();
  if (!uid) return false;

  const now = options.date instanceof Date ? options.date : new Date();
  const day = formatDateInTz(now, config.TIMEZONE);
  const record = buildJournalEntryRecord(question, reply, userInfo, now);
  if (!record) return false;
  const safety = classifyJournalEntrySafety(record, { question, reply });
  if (config.MEMORY_JOURNAL_UNSAFE_REPLY_FILTER !== false && !safety.safe) {
    ensureUserJournalDir(uid);
    appendJsonLine(getEntrySidecarFilePath(uid, day), {
      ...buildEntrySidecarRecord(record, options, day),
      unsafe: true,
      unsafeReason: safety.reason,
      journalWriteSkipped: true
    }, { flushNow: true });
    syncJournalEntryToProfileJournalDb(uid, day, record, options, {
      status: 'unsafe',
      safety: safety.reason,
      unsafeReason: safety.reason
    });
    return false;
  }

  ensureUserJournalDir(uid);
  const filePath = getJournalFilePath(uid, day);
  const currentEntries = parseJournalEntries(safeReadText(filePath, ''));
  currentEntries.push(record);
  atomicWriteText(filePath, `${formatJournalEntries(currentEntries)}\n`);
  appendJsonLine(getEntrySidecarFilePath(uid, day), buildEntrySidecarRecord(record, options, day), { flushNow: true });
  syncJournalEntryToProfileJournalDb(uid, day, record, options, {
    status: 'active',
    safety: 'safe'
  });
  updateJournalIndex(uid, (index) => ({
    ...index,
    summaryDays: index.summaryDays.filter((item) => item !== day)
  }));
  updateRollupIndex(uid, (index) => {
    const currentDay = index.daily && typeof index.daily === 'object' ? index.daily[day] : null;
    const snapshot = normalizeContinuitySnapshot(options.continuitySnapshot);
    return {
      ...index,
      daily: {
        ...(index.daily || {}),
        [day]: {
          sessionKeys: Array.from(new Set([
            ...((currentDay && Array.isArray(currentDay.sessionKeys)) ? currentDay.sessionKeys : []),
            String(options.sessionKey || '').trim()
          ].filter(Boolean))),
          topics: Array.from(new Set([
            ...((currentDay && Array.isArray(currentDay.topics)) ? currentDay.topics : []),
            snapshot.activeTopic
          ].filter(Boolean)))
        }
      }
    };
  });

  const state = loadSummaryState();
  if (options.segmentNow !== false) {
    try {
      await maybeSegmentJournal(uid, day, state, options);
    } catch (error) {
      console.error('[daily_journal] failed to segment journal:', {
        userId: uid,
        day,
        message: error?.message || error
      });
      if (options.throwOnError) throw error;
    }
  }
  saveSummaryState(state);
  return true;
}

function loadSummaryState() {
  const state = safeReadJson(SUMMARY_STATE_FILE, {});
  if (!state || typeof state !== 'object') return { users: {} };
  if (!state.users || typeof state.users !== 'object') state.users = {};
  return state;
}

function saveSummaryState(state) {
  atomicWriteJson(SUMMARY_STATE_FILE, state || {});
}

const getRecentDailySummaries = createRecentDailySummariesGetter(getDailyJournalRetrievalBundle);

function buildUserSnapshot(userId) {
  const profile = getUserProfile(userId) || {};
  const favorite = favorites[String(userId || '').trim()] || {};
  const likes = Array.isArray(profile.likes) ? profile.likes.slice(-8).join('、') : '';
  const dislikes = Array.isArray(profile.dislikes) ? profile.dislikes.slice(-8).join('、') : '';
  const goals = Array.isArray(profile.goals) ? profile.goals.slice(-8).join('、') : '';
  const topics = Array.isArray(profile.recent_topics) ? profile.recent_topics.slice(-8).join('、') : '';

  return [
    `关系阶段：${profile.relation_stage || favorite.level || '陌生人'}`,
    `好感点数：${Number(favorite.points || 0)}`,
    `喜欢：${likes || '暂无'}`,
    `不喜欢：${dislikes || '暂无'}`,
    `目标：${goals || '暂无'}`,
    `最近话题：${topics || '暂无'}`,
    `已有总结：${String(getUserSummary(userId) || '').trim() || '暂无'}`,
    `印象：${String(getUserImpression(userId) || '').trim() || '暂无'}`
  ].join('\n');
}

const {
  runDailyJournalSummaries,
  shouldRunDailySummaryNow,
  summarizeJournalForDay
} = createDailyJournalSummaryRunner({
  appendPerfEvent,
  atomicWriteText,
  buildUserSnapshot,
  config,
  extractMessageContent,
  favorites,
  formatDateInTz,
  formatJournalEntries,
  getBackgroundPressureDelayMs,
  getDatePartsInTz,
  getJournalFilePath,
  getMemoryApiKey,
  getMemoryChatCompletionsUrl,
  getMemoryModelName,
  getSummaryFilePath,
  getYearMonthFromDay,
  loadSummaryState,
  maintainDailyJournalRollups,
  parseJournalEntries,
  filterInjectableJournalEntries,
  postWithRetry,
  readSegmentSummaries,
  safeReadText,
  saveSummaryState,
  scheduleDailyJournalEmbeddingBackfill,
  shiftDate,
  sortUniqueStrings,
  strictClampText,
  syncEpisodeMemory,
  syncJournalRollupToProfileJournalDb,
  updateJournalIndex
});

module.exports = {
  appendDailyJournalEntry,
  getRecentDailySummaries,
  getDailyJournalStats,
  getDailyJournalRetrievalBundle,
  classifyJournalEntrySafety,
  maintainDailyJournalRollups,
  runDailyJournalSummaries,
  shouldRunDailySummaryNow,
  listUserJournalDays,
  listUserSummaryDays,
  listFourDayRollups,
  listMonthlyRollups,
  summarizeJournalForDay,
  parseJournalEntries,
  readSegmentSummaries,
  collectRecentEntrySidecars,
  maybeSegmentJournalByThreshold,
  _test: {
    syncEpisodeMemory,
    scheduleDailyJournalEmbeddingBackfill,
    getSummaryFilePath,
    getFourDayRollupFilePath,
    getMonthlyRollupFilePath,
    updateJournalIndex,
    getUserJournalDir,
    toSafeJournalPathSegment
  }
};
