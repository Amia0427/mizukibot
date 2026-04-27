const fs = require('fs');
const path = require('path');
const config = require('../config');
const { buildDailyJournalDocsForUser } = require('../utils/memory-v3/journalDocs');
const { queryMemory } = require('../utils/memory-v3/query');

const DAY_ARTIFACT_RE = /^(\d{4}-\d{2}-\d{2})\.(summary\.md|segments\.jsonl|journal\.md)$/i;

function listUserDirs() {
  if (!fs.existsSync(config.DAILY_JOURNAL_DIR)) return [];
  return fs.readdirSync(config.DAILY_JOURNAL_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function scanUser(userId) {
  const dir = path.join(config.DAILY_JOURNAL_DIR, userId);
  const days = new Map();
  const tmpFiles = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const fullPath = path.join(dir, name);
    let stat = null;
    try {
      stat = fs.statSync(fullPath);
    } catch (_) {
      continue;
    }
    if (!stat.isFile()) continue;
    if (/\.tmp$/i.test(name)) {
      tmpFiles.push(name);
      continue;
    }
    const match = name.match(DAY_ARTIFACT_RE);
    if (!match) continue;
    const day = match[1];
    const kind = match[2].toLowerCase();
    if (!days.has(day)) {
      days.set(day, { day, summary: false, segments: false, journal: false, bytes: 0 });
    }
    const item = days.get(day);
    item.bytes += Number(stat.size || 0) || 0;
    if (kind === 'summary.md') item.summary = stat.size > 0;
    if (kind === 'segments.jsonl') item.segments = stat.size > 0;
    if (kind === 'journal.md') item.journal = stat.size > 0;
  }

  const docs = buildDailyJournalDocsForUser(userId, { maxDays: 10000 });
  const docDays = new Set(docs.map((doc) => String(doc.episodeDay || doc.title || '').trim()).filter(Boolean));
  const contentDays = Array.from(days.values())
    .filter((item) => item.summary || item.segments || item.journal)
    .sort((a, b) => a.day.localeCompare(b.day));
  const unavailableDays = contentDays.filter((item) => !docDays.has(item.day));

  return {
    userId,
    contentDays: contentDays.length,
    retrievableDays: docDays.size,
    unavailableDays,
    tmpFiles: tmpFiles.length
  };
}

async function auditDailyJournalAvailability(options = {}) {
  const verifyQuery = Boolean(options.verifyQuery);
  const users = listUserDirs();
  const rows = users.map(scanUser);
  const queryFailures = [];
  if (verifyQuery) {
    for (const row of rows.filter((item) => item.contentDays > 0)) {
      const result = await queryMemory({
        userId: row.userId,
        query: '2026 日记 聊了什么',
        source: 'journal',
        topK: 3,
        disableRerank: true
      });
      if (!result?.ok || !Array.isArray(result.results) || result.results.length === 0) {
        queryFailures.push(row.userId);
      }
    }
  }
  const withContent = rows.filter((row) => row.contentDays > 0);
  const unavailable = rows.filter((row) => row.unavailableDays.length > 0);
  const tmpOnly = rows.filter((row) => row.contentDays === 0 && row.tmpFiles > 0);
  const empty = rows.filter((row) => row.contentDays === 0 && row.tmpFiles === 0);

  const report = {
    ok: unavailable.length === 0 && queryFailures.length === 0,
    usersTotal: users.length,
    usersWithContent: withContent.length,
    usersFullyRetrievable: withContent.length - unavailable.length,
    usersWithUnavailableContent: unavailable.length,
    tmpOnlyUsers: tmpOnly.length,
    emptyUsers: empty.length,
    contentDays: withContent.reduce((sum, row) => sum + row.contentDays, 0),
    retrievableDays: withContent.reduce((sum, row) => sum + row.retrievableDays, 0),
    queryVerified: verifyQuery,
    queryFailures,
    unavailable: unavailable.map((row) => ({
      userId: row.userId,
      unavailableDays: row.unavailableDays.map((item) => ({
        day: item.day,
        summary: item.summary,
        segments: item.segments,
        journal: item.journal,
        bytes: item.bytes
      }))
    }))
  };

  return report;
}

async function main() {
  const report = await auditDailyJournalAvailability({
    verifyQuery: process.argv.includes('--verify-query')
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  auditDailyJournalAvailability,
  scanUser
};
