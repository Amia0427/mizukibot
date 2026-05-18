#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const config = require('../config');
const {
  listFourDayRollups,
  listMonthlyRollups
} = require('../utils/dailyJournal');
const {
  readDailyJournalUsers,
  scanDailyJournalDays
} = require('../utils/memory-v3/journalDocs');
const {
  appendJournalEpisodeEvent,
  buildJournalEpisodeDedupeKey,
  scheduleJournalV3Refresh
} = require('../utils/memory-v3/journalPipeline');
const { loadMemoryEvents } = require('../utils/memory-v3/events');
const { normalizeText } = require('../utils/memory-v3/helpers');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    user: '',
    dryRun: true,
    write: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = String(argv[index] || '').trim();
    if (item === '--user') {
      args.user = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (item === '--dry-run') {
      args.dryRun = true;
      args.write = false;
    } else if (item === '--write') {
      args.write = true;
      args.dryRun = false;
    }
  }
  return args;
}

function normalizeDay(value = '') {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function readText(filePath = '') {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function summaryFilePath(userId = '', day = '') {
  return path.join(config.DAILY_JOURNAL_DIR, String(userId || '').trim(), `${day}.summary.md`);
}

function getYearMonth(day = '') {
  const normalized = normalizeDay(day);
  return normalized ? normalized.slice(0, 7) : '';
}

function shiftDate(day = '', offsetDays = 0) {
  const normalized = normalizeDay(day);
  if (!normalized) return '';
  const [year, month, date] = normalized.split('-').map((part) => Number(part));
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() + Number(offsetDays || 0));
  return utc.toISOString().slice(0, 10);
}

function uniqueStrings(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
}

function buildMonthlyRangeMap(fourDayItems = []) {
  const sorted = (Array.isArray(fourDayItems) ? fourDayItems : [])
    .filter((item) => normalizeDay(item.startDay) && normalizeDay(item.endDay))
    .slice()
    .sort((a, b) => String(a.startDay || '').localeCompare(String(b.startDay || ''))
      || String(a.endDay || '').localeCompare(String(b.endDay || '')));
  const map = new Map();
  const monthParts = {};
  for (let index = 0; index + 6 < sorted.length;) {
    const chunk = sorted.slice(index, index + 7);
    let contiguous = true;
    for (let offset = 1; offset < chunk.length; offset += 1) {
      if (chunk[offset].startDay !== shiftDate(chunk[offset - 1].endDay, 1)) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) {
      index += 1;
      continue;
    }
    const yearMonth = getYearMonth(chunk[chunk.length - 1].endDay);
    monthParts[yearMonth] = Math.max(0, Number(monthParts[yearMonth] || 0)) + 1;
    map.set(`${yearMonth}|${monthParts[yearMonth]}`, {
      startDay: chunk[0].startDay,
      endDay: chunk[chunk.length - 1].endDay
    });
    index += 7;
  }
  return map;
}

function loadExistingDedupeKeys() {
  const keys = new Set();
  for (const event of loadMemoryEvents()) {
    if (event.type !== 'episode_rollup_generated') continue;
    const key = normalizeText(event.dedupeKey);
    if (key) keys.add(key);
  }
  return keys;
}

function buildDailyPayload(userId = '', day = '') {
  const sourceFile = summaryFilePath(userId, day);
  const text = readText(sourceFile);
  if (!text) return null;
  return {
    userId,
    text,
    source: 'daily_journal_summary',
    rollupLevel: 'daily',
    episodeDay: day,
    startDay: day,
    endDay: day,
    yearMonth: getYearMonth(day),
    sourceFile,
    textKind: 'journal_daily_summary',
    sourceCompleteness: 'summary',
    maxChars: config.DAILY_JOURNAL_SUMMARY_MAX_TOKENS
  };
}

function buildFourDayPayload(userId = '', item = {}) {
  const text = normalizeText(item.text);
  if (!text) return null;
  return {
    userId,
    text: item.text,
    source: 'daily_journal_rollup',
    rollupLevel: '4day',
    episodeDay: item.endDay,
    startDay: item.startDay,
    endDay: item.endDay,
    yearMonth: item.yearMonth || getYearMonth(item.endDay),
    sourceFile: item.filePath,
    textKind: 'journal_4day_rollup',
    sourceCompleteness: 'summary',
    maxChars: config.DAILY_JOURNAL_4DAY_MAX_CHARS
  };
}

function buildMonthlyPayload(userId = '', item = {}) {
  const text = normalizeText(item.text);
  if (!text) return null;
  return {
    userId,
    text,
    source: 'daily_journal_rollup',
    rollupLevel: 'monthly',
    episodeDay: item.endDay || '',
    startDay: item.startDay || '',
    endDay: item.endDay || '',
    yearMonth: item.yearMonth,
    part: Number(item.part || 0) || 0,
    sourceFile: item.filePath,
    textKind: 'journal_monthly_rollup',
    sourceCompleteness: 'summary',
    maxChars: config.DAILY_JOURNAL_MONTHLY_MAX_CHARS
  };
}

function resolveUsers(userArg = '') {
  const target = String(userArg || '').trim();
  if (!target || target.toLowerCase() === 'all') return readDailyJournalUsers();
  return [target];
}

async function runBackfill(args = {}) {
  const users = resolveUsers(args.user || 'all');
  const dryRun = args.write !== true;
  const existingKeys = loadExistingDedupeKeys();
  const result = {
    ok: true,
    dryRun,
    users: users.length,
    daily: 0,
    fourDay: 0,
    monthly: 0,
    considered: 0,
    written: 0,
    skippedExisting: 0,
    skippedEmpty: 0,
    refreshedUsers: 0,
    byUser: []
  };

  for (const userId of users) {
    const userSummary = {
      userId,
      daily: 0,
      fourDay: 0,
      monthly: 0,
      written: 0,
      skippedExisting: 0,
      skippedEmpty: 0
    };
    const payloads = [];
    for (const day of scanDailyJournalDays(userId)) {
      const payload = buildDailyPayload(userId, day);
      if (payload) payloads.push(payload);
      else userSummary.skippedEmpty += 1;
    }
    const fourDayItems = listFourDayRollups(userId);
    for (const item of fourDayItems) {
      const payload = buildFourDayPayload(userId, item);
      if (payload) payloads.push(payload);
      else userSummary.skippedEmpty += 1;
    }
    const monthlyRangeMap = buildMonthlyRangeMap(fourDayItems);
    for (const item of listMonthlyRollups(userId)) {
      const range = monthlyRangeMap.get(`${item.yearMonth}|${Number(item.part || 0) || 0}`) || {};
      const payload = buildMonthlyPayload(userId, { ...item, ...range });
      if (payload) payloads.push(payload);
      else userSummary.skippedEmpty += 1;
    }

    const refreshedDays = [];
    for (const payload of payloads) {
      const level = String(payload.rollupLevel || 'daily');
      if (level === 'daily') userSummary.daily += 1;
      else if (level === '4day') userSummary.fourDay += 1;
      else if (level === 'monthly') userSummary.monthly += 1;
      result.considered += 1;
      const dedupeKey = buildJournalEpisodeDedupeKey(payload);
      if (existingKeys.has(dedupeKey)) {
        userSummary.skippedExisting += 1;
        continue;
      }
      if (!dryRun) {
        const event = await appendJournalEpisodeEvent({ ...payload, dedupeKey });
        if (event?.dedupeKey) existingKeys.add(event.dedupeKey);
      } else {
        existingKeys.add(dedupeKey);
      }
      userSummary.written += 1;
      if (payload.episodeDay) refreshedDays.push(payload.episodeDay);
    }

    result.daily += userSummary.daily;
    result.fourDay += userSummary.fourDay;
    result.monthly += userSummary.monthly;
    result.written += userSummary.written;
    result.skippedExisting += userSummary.skippedExisting;
    result.skippedEmpty += userSummary.skippedEmpty;
    if (!dryRun && userSummary.written > 0) {
      scheduleJournalV3Refresh({
        userId,
        days: uniqueStrings(refreshedDays),
        reason: 'journal_v3_event_backfill'
      });
      result.refreshedUsers += 1;
    }
    result.byUser.push(userSummary);
  }

  return result;
}

async function main() {
  const result = await runBackfill(parseArgs());
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[backfill-journal-v3-events] failed:', error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  buildDailyPayload,
  buildFourDayPayload,
  buildMonthlyPayload,
  parseArgs,
  runBackfill
};
