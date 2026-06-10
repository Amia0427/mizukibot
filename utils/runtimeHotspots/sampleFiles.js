const fs = require('fs');
const { normalizeNumber, normalizePath, normalizeText } = require('./common');

const DEFAULT_MAX_LINES = 5000;

function safeStat(filePath = '') {
  try {
    return fs.statSync(filePath);
  } catch (_) {
    return null;
  }
}

function parseJsonLine(line = '') {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function readRecentJsonLines(filePath = '', maxLines = DEFAULT_MAX_LINES) {
  const target = normalizePath(filePath);
  if (!target) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (_) {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => normalizeText(line))
    .slice(-Math.max(1, normalizeNumber(maxLines, DEFAULT_MAX_LINES)))
    .map(parseJsonLine)
    .filter(Boolean);
}

function resolveEventMs(row = {}) {
  const candidates = [
    row.recordedAt,
    row.ts,
    row.timestamp,
    row.updatedAt,
    row.createdAt
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function filterWindow(rows = [], { sinceMs = 0, untilMs = Date.now() } = {}) {
  return rows.filter((row) => {
    const ms = resolveEventMs(row);
    return ms > 0 && ms >= sinceMs && ms <= untilMs;
  });
}

module.exports = {
  filterWindow,
  parseJsonLine,
  readRecentJsonLines,
  resolveEventMs,
  safeStat
};
