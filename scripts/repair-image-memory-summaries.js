#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const config = require('../config');
const { formatDateInTz } = require('../utils/time');
const {
  cleanImageMemorySummary,
  looksLikeRawProviderText
} = require('../utils/imageMemorySummarySanitizer');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function getIndexFile() {
  return config.IMAGE_MEMORY_INDEX_FILE || path.join(config.DATA_DIR, 'image_memory_index.json');
}

function readRawIndex(filePath = getIndexFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { version: 1, images: {} };
  } catch (_) {
    return { version: 1, images: {} };
  }
}

function writeRawIndex(filePath = getIndexFile(), index = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseArgs(argv = []) {
  const args = {
    apply: false,
    day: '',
    allDays: false,
    limit: 0
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = normalizeText(argv[i]);
    if (arg === '--apply') args.apply = true;
    else if (arg === '--all-days') args.allDays = true;
    else if (arg === '--day') {
      args.day = normalizeText(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--day=')) {
      args.day = normalizeText(arg.slice('--day='.length));
    } else if (arg === '--limit') {
      args.limit = Math.max(0, Math.floor(Number(argv[i + 1] || 0) || 0));
      i += 1;
    } else if (arg.startsWith('--limit=')) {
      args.limit = Math.max(0, Math.floor(Number(arg.slice('--limit='.length) || 0) || 0));
    }
  }
  if (args.day && !/^\d{4}-\d{2}-\d{2}$/.test(args.day)) {
    throw new Error('Invalid --day, expected YYYY-MM-DD');
  }
  if (!args.day && !args.allDays) {
    args.day = formatDateInTz(new Date(), config.TIMEZONE || 'Asia/Shanghai');
  }
  return args;
}

function recordDay(record = {}) {
  const ts = Number(record.createdAt || record.lastSeenAt || 0);
  const date = Number.isFinite(ts) && ts > 0 ? new Date(ts) : new Date();
  return formatDateInTz(date, config.TIMEZONE || 'Asia/Shanghai');
}

function shouldInspectRecord(record = {}, args = {}) {
  if (args.allDays) return true;
  return recordDay(record) === args.day;
}

function cleanSummaryField(container = {}, field = 'summary') {
  const before = normalizeText(container?.[field]);
  if (!before || !looksLikeRawProviderText(before)) return null;
  const cleaned = cleanImageMemorySummary(before);
  if (!cleaned.changed) return null;
  container[field] = cleaned.summary;
  return {
    before: before.slice(0, 240),
    after: cleaned.summary.slice(0, 240),
    rejected: cleaned.rejected,
    reason: cleaned.reason
  };
}

function repairImageMemorySummaries(options = {}) {
  const args = {
    apply: options.apply === true,
    day: normalizeText(options.day),
    allDays: options.allDays === true,
    limit: Math.max(0, Math.floor(Number(options.limit || 0) || 0))
  };
  if (!args.day && !args.allDays) args.day = formatDateInTz(new Date(), config.TIMEZONE || 'Asia/Shanghai');
  const index = readRawIndex();
  const findings = [];
  let changed = 0;

  for (const [cacheKey, record] of Object.entries(index.images || {})) {
    if (args.limit && findings.length >= args.limit) break;
    if (!shouldInspectRecord(record, args)) continue;

    const recordChanges = [];
    const summaryChange = cleanSummaryField(record, 'summary');
    if (summaryChange) recordChanges.push({ field: 'summary', ...summaryChange });

    const observations = Array.isArray(record.observations) ? record.observations : [];
    observations.forEach((observation, index) => {
      const observationChange = cleanSummaryField(observation, 'summary');
      if (observationChange) recordChanges.push({ field: `observations.${index}.summary`, ...observationChange });
    });

    if (!recordChanges.length) continue;
    changed += recordChanges.length;
    findings.push({
      cacheKey,
      day: recordDay(record),
      changes: recordChanges
    });
  }

  if (args.apply && changed > 0) writeRawIndex(getIndexFile(), index);

  return {
    ok: true,
    apply: args.apply,
    day: args.allDays ? '' : args.day,
    allDays: args.allDays,
    changed,
    records: findings.length,
    findings
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(repairImageMemorySummaries(args), null, 2)}\n`);
  } catch (error) {
    console.error(error?.message || error);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  readRawIndex,
  repairImageMemorySummaries
};
