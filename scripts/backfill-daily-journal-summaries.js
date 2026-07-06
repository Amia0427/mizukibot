#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const config = require('../config');
const {
  listUserJournalDays,
  writeDailyJournalSummary
} = require('../utils/dailyJournal');
const { shiftDate } = require('../utils/dailyJournal/text');
const { resolveSummaryDueDay } = require('../utils/memory-v3/journalDiagnostics');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    userId: '',
    from: '',
    to: '',
    write: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = String(argv[index] || '').trim();
    if (item === '--user-id' || item === '--user') {
      args.userId = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (item === '--from') {
      args.from = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (item === '--to') {
      args.to = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (item === '--write') {
      args.write = true;
    }
  }
  return args;
}

function isDay(value = '') {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function summaryFilePath(userId, day) {
  return path.join(config.DAILY_JOURNAL_DIR, userId, `${day}.summary.md`);
}

function hasSummary(userId, day) {
  try {
    return fs.statSync(summaryFilePath(userId, day)).size > 0;
  } catch (_) {
    return false;
  }
}

function resolveDays(userId, from, to, dueDay = resolveSummaryDueDay()) {
  const start = isDay(from) ? from : '';
  const end = isDay(to) ? to : dueDay;
  return listUserJournalDays(userId)
    .filter((day) => (!start || day >= start) && (!end || day <= end) && day <= dueDay)
    .sort((a, b) => a.localeCompare(b));
}

async function runBackfill(options = {}) {
  const userId = String(options.userId || '').trim();
  if (!userId) throw new Error('--user-id is required');
  const dueDay = isDay(options.dueDay) ? options.dueDay : resolveSummaryDueDay();
  const days = resolveDays(userId, options.from, options.to, dueDay);
  const result = {
    ok: true,
    dryRun: options.write !== true,
    userId,
    dueDay,
    considered: days.length,
    written: 0,
    skippedExisting: 0,
    skippedEmpty: 0,
    days: []
  };

  for (const day of days) {
    if (hasSummary(userId, day)) {
      result.skippedExisting += 1;
      result.days.push({ day, status: 'skipped_existing' });
      continue;
    }
    if (options.write !== true) {
      result.days.push({ day, status: 'would_write' });
      continue;
    }
    if (await writeDailyJournalSummary(userId, day, options)) {
      result.written += 1;
      result.days.push({ day, status: 'written' });
    } else {
      result.skippedEmpty += 1;
      result.days.push({ day, status: 'skipped_empty' });
    }
  }

  return result;
}

async function main() {
  const result = await runBackfill(parseArgs());
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[backfill-daily-journal-summaries] failed:', error?.stack || error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  resolveDays,
  runBackfill
};
