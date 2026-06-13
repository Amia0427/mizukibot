const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_STORE_PATH = path.join(PROJECT_ROOT, 'data', 'gemini-recent-style-signals.json');
const SCHEMA_VERSION = 'gemini_recent_style_signal_diagnostic_v1';
const DEFAULT_LOOKBACK_RECORDS = 18;
const DEFAULT_MAX_RECORDS = 120;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT = 12;

const SIGNAL_FIELDS = {
  openings: {
    label: '起手',
    recordField: 'openings',
    guardLimit: 4
  },
  tails: {
    label: '尾音',
    recordField: 'tails',
    guardLimit: 5
  },
  stockPhrases: {
    label: '固定短语',
    recordField: 'stockPhrases',
    guardLimit: 6
  }
};

function normalizeText(value = '') {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizePath(value = '') {
  const text = normalizeText(value);
  return text ? path.resolve(PROJECT_ROOT, text) : '';
}

function nowMs(options = {}) {
  if (typeof options.now === 'function') {
    const value = options.now();
    if (value instanceof Date) return value.getTime();
    return normalizeNumber(value, Date.now());
  }
  const fromValue = normalizeNumber(options.now, 0);
  return fromValue > 0 ? fromValue : Date.now();
}

function isoFromMs(value = 0) {
  const ms = normalizeNumber(value, 0);
  return ms > 0 ? new Date(ms).toISOString() : '';
}

function normalizeTimestampMs(value = null) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueValues(values = [], maxItems = 8) {
  const seen = new Set();
  const result = [];
  for (const value of normalizeArray(values)) {
    const text = normalizeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function resolveStorePath(options = {}) {
  return normalizePath(
    options.storePath
    || options.file
    || process.env.GEMINI_RECENT_STYLE_STORE_PATH
    || DEFAULT_STORE_PATH
  );
}

function safeStat(filePath = '') {
  try {
    return fs.statSync(filePath);
  } catch (_) {
    return null;
  }
}

function readStore(filePath = '') {
  const stat = safeStat(filePath);
  if (!stat) {
    return {
      status: 'missing',
      store: { records: [] },
      recordCount: 0,
      error: ''
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const store = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { records: [] };
    const records = normalizeArray(store.records);
    return {
      status: records.length > 0 ? 'ok' : 'empty',
      store: { ...store, records },
      recordCount: records.length,
      mtimeMs: stat.mtimeMs,
      error: ''
    };
  } catch (error) {
    return {
      status: 'invalid',
      store: { records: [] },
      recordCount: 0,
      mtimeMs: stat.mtimeMs,
      error: normalizeText(error?.message || error).slice(0, 240)
    };
  }
}

function recordCreatedAtMs(record = {}) {
  return normalizeTimestampMs(record.createdAt || record.created_at || record.at || record.ts);
}

function pruneRecentRecords(records = [], now = Date.now(), options = {}) {
  const maxAgeMs = Math.max(0, normalizeNumber(options.maxAgeMs, DEFAULT_MAX_AGE_MS));
  const maxRecords = Math.max(1, Math.floor(normalizeNumber(options.maxRecords, DEFAULT_MAX_RECORDS)));
  return normalizeArray(records)
    .filter((record) => record && typeof record === 'object')
    .filter((record) => {
      const createdAtMs = recordCreatedAtMs(record);
      if (createdAtMs <= 0) return true;
      return !maxAgeMs || (now - createdAtMs) <= maxAgeMs;
    })
    .slice(-maxRecords);
}

function selectDiagnosticRecords(records = [], now = Date.now(), options = {}) {
  const lookbackRecords = Math.max(1, Math.floor(normalizeNumber(options.lookbackRecords, DEFAULT_LOOKBACK_RECORDS)));
  const recentNewestFirst = pruneRecentRecords(records, now, options).slice().reverse();
  const scopeKey = normalizeText(options.scopeKey);
  const scopedFirst = scopeKey
    ? recentNewestFirst
      .filter((record) => normalizeText(record.scopeKey) === scopeKey)
      .concat(recentNewestFirst.filter((record) => normalizeText(record.scopeKey) !== scopeKey))
    : recentNewestFirst;
  return scopedFirst.slice(0, lookbackRecords);
}

function rankSignalValues(records = [], field = '', limit = 4) {
  const counts = new Map();
  normalizeArray(records).forEach((record, recordIndex) => {
    for (const value of uniqueValues(record?.[field], 8)) {
      const createdAtMs = recordCreatedAtMs(record);
      const current = counts.get(value) || {
        value,
        hitCount: 0,
        firstSeenIndex: recordIndex,
        lastHitMs: 0
      };
      current.hitCount += 1;
      current.firstSeenIndex = Math.min(current.firstSeenIndex, recordIndex);
      current.lastHitMs = Math.max(current.lastHitMs, createdAtMs);
      counts.set(value, current);
    }
  });

  return [...counts.values()]
    .sort((a, b) => (
      b.hitCount - a.hitCount
      || a.firstSeenIndex - b.firstSeenIndex
      || a.value.localeCompare(b.value)
    ))
    .slice(0, Math.max(1, Math.floor(normalizeNumber(limit, 4))));
}

function countSignalRows(records = [], field = '', triggerSet = new Set(), limit = DEFAULT_OUTPUT_LIMIT) {
  const rows = new Map();
  for (const record of normalizeArray(records)) {
    const createdAtMs = recordCreatedAtMs(record);
    for (const value of uniqueValues(record?.[field], 8)) {
      const current = rows.get(value) || {
        value,
        hitCount: 0,
        firstHitMs: 0,
        lastHitMs: 0,
        scopes: new Map(),
        models: new Map()
      };
      current.hitCount += 1;
      if (createdAtMs > 0) {
        current.firstHitMs = current.firstHitMs ? Math.min(current.firstHitMs, createdAtMs) : createdAtMs;
        current.lastHitMs = Math.max(current.lastHitMs, createdAtMs);
      }
      const scopeKey = normalizeText(record.scopeKey);
      if (scopeKey) current.scopes.set(scopeKey, (current.scopes.get(scopeKey) || 0) + 1);
      const modelName = normalizeText(record.modelName || record.model || record.model_name);
      if (modelName) current.models.set(modelName, (current.models.get(modelName) || 0) + 1);
      rows.set(value, current);
    }
  }

  return [...rows.values()]
    .sort((a, b) => (
      b.hitCount - a.hitCount
      || b.lastHitMs - a.lastHitMs
      || a.value.localeCompare(b.value)
    ))
    .slice(0, Math.max(1, Math.floor(normalizeNumber(limit, DEFAULT_OUTPUT_LIMIT))))
    .map((row) => ({
      value: row.value,
      hitCount: row.hitCount,
      lastHitAt: isoFromMs(row.lastHitMs),
      firstHitAt: isoFromMs(row.firstHitMs),
      triggersGeminiRecentStyleGuard: triggerSet.has(row.value),
      scopeKeys: [...row.scopes.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([key, count]) => ({ key, count })),
      models: [...row.models.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([key, count]) => ({ key, count }))
    }));
}

function buildTriggerSets(records = []) {
  const result = {};
  for (const [key, config] of Object.entries(SIGNAL_FIELDS)) {
    result[key] = new Set(
      rankSignalValues(records, config.recordField, config.guardLimit)
        .map((item) => item.value)
    );
  }
  return result;
}

function latestRecordAt(records = []) {
  const latest = normalizeArray(records)
    .map(recordCreatedAtMs)
    .reduce((max, value) => Math.max(max, value), 0);
  return isoFromMs(latest);
}

function buildGeminiRecentStyleSignalDiagnostic(options = {}) {
  const checkedAtMs = nowMs(options);
  const storePath = resolveStorePath(options);
  const readResult = readStore(storePath);
  const selectedRecords = selectDiagnosticRecords(readResult.store.records, checkedAtMs, options);
  const triggerSets = buildTriggerSets(selectedRecords);
  const outputLimit = Math.max(1, Math.floor(normalizeNumber(options.limit, DEFAULT_OUTPUT_LIMIT)));
  const signals = {};
  let totalSignalRows = 0;
  let triggerSignalCount = 0;

  for (const [key, config] of Object.entries(SIGNAL_FIELDS)) {
    const rows = countSignalRows(selectedRecords, config.recordField, triggerSets[key], outputLimit);
    signals[key] = {
      label: config.label,
      field: config.recordField,
      guardLimit: config.guardLimit,
      items: rows
    };
    totalSignalRows += rows.length;
    triggerSignalCount += rows.filter((item) => item.triggersGeminiRecentStyleGuard).length;
  }

  const wouldInject = readResult.status === 'ok' && triggerSignalCount > 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: isoFromMs(checkedAtMs),
    status: readResult.status,
    summary: {
      status: readResult.status,
      storeExists: readResult.status !== 'missing',
      totalRecords: readResult.recordCount,
      diagnosticRecords: selectedRecords.length,
      latestRecordAt: latestRecordAt(selectedRecords),
      totalSignalRows,
      triggerSignalCount,
      guardBlockId: 'gemini_recent_style_guard',
      wouldInjectGeminiRecentStyleGuard: wouldInject
    },
    options: {
      lookbackRecords: Math.max(1, Math.floor(normalizeNumber(options.lookbackRecords, DEFAULT_LOOKBACK_RECORDS))),
      maxRecords: Math.max(1, Math.floor(normalizeNumber(options.maxRecords, DEFAULT_MAX_RECORDS))),
      maxAgeMs: Math.max(0, normalizeNumber(options.maxAgeMs, DEFAULT_MAX_AGE_MS)),
      limit: outputLimit,
      scopeKey: normalizeText(options.scopeKey)
    },
    inputs: {
      storePath,
      exists: readResult.status !== 'missing',
      status: readResult.status,
      error: readResult.error || '',
      mtimeAt: isoFromMs(readResult.mtimeMs || 0)
    },
    guard: {
      blockId: 'gemini_recent_style_guard',
      triggerPolicy: 'same ranking as the recent style guard: openings top 4, tails top 5, stockPhrases top 6 in the selected recent records',
      wouldInject: wouldInject,
      note: 'Admin, review, system-initiated, and non-Gemini requests are excluded by runtime eligibility before this block is considered.'
    },
    signals
  };
}

function formatSignalItems(items = []) {
  if (!Array.isArray(items) || items.length === 0) return ['- none'];
  return items.map((item) => {
    const guard = item.triggersGeminiRecentStyleGuard ? 'yes' : 'no';
    return `- ${item.value} count=${item.hitCount} last=${item.lastHitAt || 'unknown'} guard=${guard}`;
  });
}

function buildGeminiRecentStyleSignalText(report = {}) {
  const summary = report.summary || {};
  const lines = [
    `gemini-style-signals: ${summary.status || 'unknown'} records=${summary.totalRecords || 0} recent=${summary.diagnosticRecords || 0} guard=${summary.wouldInjectGeminiRecentStyleGuard ? 'would-inject' : 'no'}`,
    `source: ${report.inputs?.storePath || ''}`,
    `latest-record: ${summary.latestRecordAt || 'none'}`
  ];
  if (report.inputs?.error) lines.push(`input-error: ${report.inputs.error}`);
  for (const key of ['openings', 'tails', 'stockPhrases']) {
    const group = report.signals?.[key] || {};
    lines.push(`${group.label || key}:`);
    lines.push(...formatSignalItems(group.items || []));
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_LOOKBACK_RECORDS,
  DEFAULT_STORE_PATH,
  SCHEMA_VERSION,
  buildGeminiRecentStyleSignalDiagnostic,
  buildGeminiRecentStyleSignalText,
  rankSignalValues,
  selectDiagnosticRecords
};
