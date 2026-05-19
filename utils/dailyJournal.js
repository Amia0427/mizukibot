const fs = require('fs');
const path = require('path');
const config = require('../config');
const { formatDateInTz, formatTimeInTz, getDatePartsInTz } = require('./time');
const { favorites, getUserProfile, getUserSummary, getUserImpression } = require('./memory');
const { postWithRetry } = require('../api/httpClient');
const { extractMessageContent } = require('../api/parser');
const { getBackgroundPressureDelayMs, appendPerfEvent } = require('./perfRuntime');
const {
  atomicWriteJson,
  atomicWriteText,
  ensureDir,
  ensureUserJournalDir,
  getEntrySidecarFilePath,
  getFourDayRollupDir,
  getFourDayRollupFilePath,
  getJournalFilePath,
  getJournalIndex: getStoredJournalIndex,
  getMonthlyRollupDir,
  getMonthlyRollupFilePath,
  getRollupIndex,
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
} = require('./dailyJournal/storage');
const {
  compareFourDayRollups,
  compareMonthlyRollups,
  formatDailyJournalBundleText,
  formatMonthlyPart,
  getYearMonthFromDay,
  isValidDayString,
  isValidYearMonth,
  parseFourDayRollupFileName,
  parseMonthlyRollupFileName,
  selectMostRecentItems
} = require('./dailyJournal/rollupUtils');
const {
  clampText,
  formatJournalEntries,
  normalizeJournalText,
  normalizeTimestampToDay,
  normalizeYearMonth,
  parseJournalEntries,
  shiftDate,
  strictClampText
} = require('./dailyJournal/text');
const {
  buildFourDayRollupPlans,
  buildMonthlyRollupPlans,
  listFourDayRollupsFromDisk,
  listMonthlyRollupsFromDisk,
  listUserSummaryDaysFromDisk
} = require('./dailyJournal/rollups');
const {
  appendJsonLine,
  readJsonLines
} = require('./dailyJournal/jsonLines');
const { createDailyJournalRetrieval } = require('./dailyJournal/retrieval');
const { createDailyJournalRollupMaintenance } = require('./dailyJournal/rollupMaintenance');
const { createDailyJournalSegments } = require('./dailyJournal/segments');

async function syncEpisodeMemory(userId, text, options = {}) {
  const uid = String(userId || '').trim();
  const content = strictClampText(text, Math.max(40, Number(options.maxChars) || 4000));
  if (!uid || !content) return null;
  if (config.MEMORY_V3_ENABLED === false) return null;
  const { appendJournalEpisodeEvent, scheduleJournalV3Refresh } = require('./memory-v3/journalPipeline');
  const event = await appendJournalEpisodeEvent({
    ...options,
    userId: uid,
    text: content,
    source: options.source || 'daily_journal',
    sourceKind: 'journal'
  });
  if (event && options.scheduleRefresh !== false) {
    scheduleJournalV3Refresh({
      userId: uid,
      days: [options.episodeDay, options.startDay, options.endDay].filter(Boolean),
      delayMs: options.delayMs,
      scheduleEmbeddingBackfill: options.scheduleEmbeddingBackfill,
      reason: options.refreshReason || 'journal_episode_event'
    });
  }
  return event;
}

function scheduleDailyJournalEmbeddingBackfill(userId, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid || config.MEMORY_JOURNAL_EMBEDDING_BACKFILL_ENABLED === false) return false;
  try {
    const { scheduleJournalV3Refresh } = require('./memory-v3/journalPipeline');
    const result = scheduleJournalV3Refresh({
      userId: uid,
      days: Array.isArray(options.days) ? options.days : [],
      delayMs: options.delayMs,
      reason: options.reason || 'journal_embedding_backfill'
    });
    return result?.ok !== false;
  } catch (error) {
    console.warn('[daily_journal] failed to schedule embedding backfill:', error?.message || error);
    return false;
  }
}

function getMemoryChatCompletionsUrl() {
  const raw = String(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return raw;
}

function getMemoryModelName() {
  return String(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function getMemoryApiKey() {
  if (String(config.MEMORY_API_BASE_URL || '').trim()) {
    return String(config.MEMORY_API_KEY || config.API_KEY || '').trim();
  }
  return String(config.API_KEY || '').trim();
}

function scanJournalIndex(userId) {
  const uid = String(userId || '').trim();
  const summaryDays = listUserSummaryDaysFromDisk(uid);
  const fourDayRollups = listFourDayRollupsFromDisk(uid).map((item) => ({
    startDay: item.startDay,
    endDay: item.endDay,
    yearMonth: item.yearMonth,
    filePath: item.filePath
  }));
  const monthlyRollups = listMonthlyRollupsFromDisk(uid).map((item) => ({
    yearMonth: item.yearMonth,
    part: item.part,
    filePath: item.filePath
  }));
  return normalizeJournalIndex({
    updatedAt: Date.now(),
    summaryDays,
    fourDayRollups,
    monthlyRollups
  });
}

function getJournalIndex(userId) {
  return getStoredJournalIndex(userId, scanJournalIndex);
}

function listUserSummaryDays(userId) {
  return getJournalIndex(userId).summaryDays.slice();
}

function listFourDayRollups(userId) {
  const index = getJournalIndex(userId);
  return index.fourDayRollups
    .map((item) => {
      const text = safeReadText(item.filePath, '').trim();
      if (!text) return null;
      return {
        kind: 'four_day_rollup',
        startDay: item.startDay,
        endDay: item.endDay,
        yearMonth: item.yearMonth,
        sourceCount: 4,
        filePath: item.filePath,
        text
      };
    })
    .filter(Boolean)
    .sort(compareFourDayRollups);
}

function listMonthlyRollups(userId) {
  const index = getJournalIndex(userId);
  return index.monthlyRollups
    .map((item) => {
      const text = safeReadText(item.filePath, '').trim();
      if (!text) return null;
      return {
        kind: 'monthly_rollup',
        yearMonth: item.yearMonth,
        part: item.part,
        sourceCount: 7,
        filePath: item.filePath,
        text
      };
    })
    .filter(Boolean)
    .sort(compareMonthlyRollups);
}

function getDailySummaryItem(userId, day) {
  const uid = String(userId || '').trim();
  if (!uid || !isValidDayString(day)) return null;
  const sidecarEntries = readEntrySidecar(uid, day);

  const summaryText = safeReadText(getSummaryFilePath(uid, day), '').trim();
  if (summaryText) {
    return { day, text: summaryText, kind: 'daily_summary', sidecarEntries };
  }

  const segments = readSegmentSummaries(uid, day);
  if (segments.length > 0) {
    const merged = segments.map((item) => item.text).join('\n').trim();
    if (merged) {
      return { day, text: merged, kind: 'segments', segments, sidecarEntries };
    }
  }

  const rawEntries = parseJournalEntries(safeReadText(getJournalFilePath(uid, day), ''));
  if (rawEntries.length > 0) {
    const keepTail = Math.max(1, Number(config.DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES) || 8);
    const rawText = strictClampText(formatJournalEntries(rawEntries.slice(-keepTail)), Math.max(600, Number(config.MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS || 160) * 12));
    if (rawText) {
      return {
        day,
        text: rawText,
        kind: 'raw_journal',
        rawEntries: rawEntries.length,
        sidecarEntries
      };
    }
  }

  return null;
}

function collectDailySummaryItems(userId, days = []) {
  const uid = String(userId || '').trim();
  return (Array.isArray(days) ? days : [])
    .map((day) => getDailySummaryItem(uid, day))
    .filter(Boolean)
    .sort((a, b) => a.day.localeCompare(b.day));
}

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

  ensureUserJournalDir(uid);
  const filePath = getJournalFilePath(uid, day);
  const currentEntries = parseJournalEntries(safeReadText(filePath, ''));
  currentEntries.push(record);
  atomicWriteText(filePath, `${formatJournalEntries(currentEntries)}\n`);
  appendJsonLine(getEntrySidecarFilePath(uid, day), buildEntrySidecarRecord(record, options, day), { flushNow: true });
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

function listUserJournalDays(userId) {
  const dir = getUserJournalDir(userId);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.journal\.md$/i.test(name))
    .map((name) => name.slice(0, 10))
    .sort();
}

function getDailyJournalStats(userId, lookbackDays = config.DAILY_JOURNAL_LOOKBACK_DAYS) {
  const uid = String(userId || '').trim();
  if (!uid || !config.DAILY_JOURNAL_ENABLED) {
    return {
      userId: uid,
      lookbackDays: Math.max(1, Number(lookbackDays) || 2),
      totalDays: 0,
      daysWithSummary: 0,
      daysWithSegments: 0,
      totalSegments: 0,
      totalSegmentEntries: 0,
      rawTailEntries: 0,
      summaryChars: 0,
      segmentChars: 0,
      rawTailChars: 0
    };
  }

  const today = formatDateInTz(new Date(), config.TIMEZONE);
  const count = Math.max(1, Number(lookbackDays) || 2);
  const days = [];
  for (let i = 0; i < count; i += 1) {
    days.push(shiftDate(today, -i));
  }

  const stats = {
    userId: uid,
    lookbackDays: count,
    totalDays: days.length,
    daysWithSummary: 0,
    daysWithSegments: 0,
    totalSegments: 0,
    totalSegmentEntries: 0,
    rawTailEntries: 0,
    summaryChars: 0,
    segmentChars: 0,
    rawTailChars: 0
  };

  for (const day of days) {
    const summaryText = safeReadText(getSummaryFilePath(uid, day), '').trim();
    if (summaryText) {
      stats.daysWithSummary += 1;
      stats.summaryChars += summaryText.length;
    }

    const segments = readSegmentSummaries(uid, day);
    if (segments.length > 0) {
      stats.daysWithSegments += 1;
      stats.totalSegments += segments.length;
      stats.totalSegmentEntries += segments.reduce((sum, item) => sum + (Number(item.entryCount || 0) || 0), 0);
      stats.segmentChars += segments.reduce((sum, item) => sum + String(item.text || '').length, 0);
    }

    const rawEntries = parseJournalEntries(safeReadText(getJournalFilePath(uid, day), ''));
    stats.rawTailEntries += rawEntries.length;
    stats.rawTailChars += rawEntries.reduce((sum, item) => {
      return sum + String(item.user || '').length + String(item.assistant || '').length;
    }, 0);
  }

  return stats;
}

function getRecentDailySummaries(userId, lookbackDays = config.DAILY_JOURNAL_LOOKBACK_DAYS) {
  const bundle = getDailyJournalRetrievalBundle(userId, { lookbackDays });
  return {
    text: bundle.byLayer.daily.map((item) => `[${item.day}]\n${item.text}`).join('\n\n'),
    items: bundle.byLayer.daily
  };
}

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

async function summarizeJournalForDay(userId, day) {
  const uid = String(userId || '').trim();
  if (!uid || !day || !config.DAILY_JOURNAL_ENABLED) return '';

  const summaryText = safeReadText(getSummaryFilePath(uid, day), '').trim();
  if (summaryText) return summaryText;

  const segments = readSegmentSummaries(uid, day);
  const journalText = safeReadText(getJournalFilePath(uid, day), '').trim();
  const activeEntries = parseJournalEntries(journalText);
  const activeText = formatJournalEntries(activeEntries.slice(-Math.max(1, Number(config.DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES) || 8)));

  const sourceParts = [];
  if (segments.length > 0) {
    sourceParts.push(`Segment summaries:\n${segments.map((item) => `- ${item.text}`).join('\n')}`);
  }
  if (activeText) {
    sourceParts.push(`Recent raw entries:\n${activeText}`);
  }

  const sourceText = sourceParts.join('\n\n').trim();
  if (!sourceText) return '';

  const maxTokens = Math.max(400, Number(config.DAILY_JOURNAL_SUMMARY_MAX_TOKENS) || 2500);
  const prompt = [
    'You are compressing one day of user interaction into durable daily memory.',
    'Prefer durable preferences, commitments, decisions, progress, blockers, emotional shifts, and follow-up topics.',
    'Use the segment summaries as the primary source and only use recent raw entries as a supplement.',
    'Drop filler chatter and repeated phrasing.',
    'Return plain text only.'
  ].join('\n');

  const resp = await postWithRetry(
    getMemoryChatCompletionsUrl(),
    {
      model: getMemoryModelName(),
      temperature: 0.2,
      top_p: 0.9,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'system',
          content: `User snapshot:\n${buildUserSnapshot(uid)}`
        },
        {
          role: 'user',
          content: `Day: ${day}\n\n${sourceText}`
        }
      ],
      max_tokens: maxTokens,
      stream: false
    },
    Math.max(0, Number(config.AI_RETRIES) || 0),
    getMemoryApiKey()
  );

  const msg = extractMessageContent(resp);
  return String(msg?.content || msg?.text || '').trim();
}

function shouldRunDailySummaryNow(date = new Date()) {
  if (!config.DAILY_JOURNAL_ENABLED) return false;
  const parts = getDatePartsInTz(date, config.TIMEZONE);
  const hour = Math.max(0, Math.min(23, Number(config.DAILY_JOURNAL_SUMMARY_HOUR) || 0));
  const minute = Math.max(0, Math.min(59, Number(config.DAILY_JOURNAL_SUMMARY_MINUTE) || 10));
  return (parts.hour > hour) || (parts.hour === hour && parts.minute >= minute);
}

async function runDailyJournalSummaries(options = {}) {
  if (!config.DAILY_JOURNAL_ENABLED) return { ran: false, count: 0 };
  const pressureDelayMs = getBackgroundPressureDelayMs();
  if (pressureDelayMs > 0 && !options.force) {
    appendPerfEvent({
      category: 'background_pressure',
      type: 'daily_journal_summary_deferred',
      delayMs: pressureDelayMs
    });
    return { ran: false, count: 0, reason: 'resource_pressure_deferred', deferMs: pressureDelayMs };
  }

  const state = loadSummaryState();
  const today = formatDateInTz(new Date(), config.TIMEZONE);
  const targetDay = shiftDate(today, -1);

  if (!targetDay) return { ran: false, count: 0 };
  if (!options.force && state.last_day === targetDay) {
    return { ran: false, count: 0 };
  }

  let count = 0;
  let hadFailure = false;
  let fourDayCreated = 0;
  let monthlyCreated = 0;
  for (const userId of Object.keys(favorites || {})) {
    const journalText = safeReadText(getJournalFilePath(userId, targetDay), '').trim();
    const segments = readSegmentSummaries(userId, targetDay);

    try {
      if (journalText || segments.length > 0) {
        const summary = typeof options.summarySummarizer === 'function'
          ? strictClampText(
            await options.summarySummarizer({ userId, day: targetDay, journalText, segments }),
            Math.max(40, Number(config.DAILY_JOURNAL_SUMMARY_MAX_TOKENS) || 2500)
          )
          : await summarizeJournalForDay(userId, targetDay);
        if (summary) {
          atomicWriteText(getSummaryFilePath(userId, targetDay), `${summary}\n`);
          updateJournalIndex(userId, (index) => ({
            ...index,
            summaryDays: sortUniqueStrings([...(index.summaryDays || []), targetDay])
          }));
          await syncEpisodeMemory(userId, summary, {
            source: 'daily_journal_summary',
            rollupLevel: 'daily',
            episodeDay: targetDay,
            yearMonth: getYearMonthFromDay(targetDay),
            sourceFile: getSummaryFilePath(userId, targetDay),
            textKind: 'journal_daily_summary',
            maxChars: config.DAILY_JOURNAL_SUMMARY_MAX_TOKENS
          });
          scheduleDailyJournalEmbeddingBackfill(userId, { days: [targetDay] });
          count += 1;
        }
      }

      const rollupResult = await maintainDailyJournalRollups(userId, options);
      fourDayCreated += Number(rollupResult?.fourDayCreated || 0);
      monthlyCreated += Number(rollupResult?.monthlyCreated || 0);
    } catch (error) {
      hadFailure = true;
      console.error('[daily_journal] failed to summarize day:', {
        userId,
        day: targetDay,
        message: error?.message || error
      });
    }
  }

  if (!hadFailure) {
    state.last_day = targetDay;
    state.last_run_at = Date.now();
    saveSummaryState(state);
  }

  return { ran: true, count, day: targetDay, hadFailure, fourDayCreated, monthlyCreated };
}

module.exports = {
  appendDailyJournalEntry,
  getRecentDailySummaries,
  getDailyJournalStats,
  getDailyJournalRetrievalBundle,
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
