const path = require('path');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePath(value = '') {
  const text = normalizeText(value);
  return text ? path.resolve(text) : '';
}

function nowMs(options = {}) {
  if (typeof options.now === 'function') {
    const value = options.now();
    if (value instanceof Date) return value.getTime();
    return normalizeNumber(value, Date.now());
  }
  return Date.now();
}

function isoFromMs(value) {
  return new Date(normalizeNumber(value, Date.now())).toISOString();
}

function formatMb(bytes = 0) {
  return Math.round((normalizeNumber(bytes, 0) / 1024 / 1024) * 10) / 10;
}

function summarizeNumeric(rows = [], field = '') {
  const values = rows
    .map((row) => normalizeNumber(row?.[field], NaN))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    return {
      min: 0,
      max: 0,
      avg: 0,
      latest: 0
    };
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / values.length,
    latest: values[values.length - 1]
  };
}

function summarizeBytesAsMb(rows = [], field = '') {
  const stats = summarizeNumeric(rows, field);
  return {
    min: formatMb(stats.min),
    max: formatMb(stats.max),
    avg: formatMb(stats.avg),
    latest: formatMb(stats.latest)
  };
}

function collectTopCounts(rows = [], keySelector, limit = 8) {
  const counts = new Map();
  for (const row of rows) {
    const key = normalizeText(typeof keySelector === 'function' ? keySelector(row) : row?.[keySelector]);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, Math.max(1, normalizeNumber(limit, 8)));
}

function normalizePressureReasons(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
  const text = normalizeText(value);
  return text ? [text] : [];
}

module.exports = {
  collectTopCounts,
  formatMb,
  isoFromMs,
  normalizeNumber,
  normalizePath,
  normalizePressureReasons,
  normalizeText,
  nowMs,
  summarizeBytesAsMb,
  summarizeNumeric
};
