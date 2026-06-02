const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const {
  ensureDir,
  safeReadJsonLines,
  normalizeText,
  clampText,
  normalizeArray
} = require('./helpers');
const { getJsonLineWriter } = require('../storeRegistry');
const {
  buildProfileCorrectionEvents,
  detectProfileCorrection
} = require('./profileLifecycle');

const EVENT_TYPES = new Set([
  'turn_received',
  'turn_replied',
  'session_checkpoint',
  'memory_candidate_extracted',
  'memory_confirmed',
  'memory_archived',
  'episode_rollup_generated',
  'migration_bootstrap'
]);

function nowTs() {
  return Date.now();
}

function toDayKey(ts = nowTs()) {
  const date = new Date(Number(ts) || nowTs());
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function eventFileForTs(ts = nowTs()) {
  ensureDir(config.MEMORY_V3_EVENTS_DIR);
  return path.join(config.MEMORY_V3_EVENTS_DIR, `${toDayKey(ts)}.ndjson`);
}

function buildEventId(event = {}) {
  const hash = crypto.createHash('sha1');
  hash.update(JSON.stringify({
    type: event.type,
    ts: event.ts,
    userId: event.userId,
    sessionKey: event.sessionKey,
    scopeType: event.scopeType,
    text: event.text,
    source: event.source,
    dedupeKey: event.dedupeKey
  }));
  return `m3_${hash.digest('hex').slice(0, 16)}`;
}

function normalizeMemoryEvent(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const type = normalizeText(raw.type).toLowerCase();
  if (!EVENT_TYPES.has(type)) {
    throw new Error(`Unsupported memory event type: ${type || 'unknown'}`);
  }
  const ts = Math.max(0, Number(raw.ts || nowTs()) || nowTs());
  const text = clampText(raw.text, Math.max(80, Number(config.MEMORY_V3_EVENT_MAX_BYTES || 65536)));
  const event = {
    version: 1,
    id: normalizeText(raw.id) || '',
    type,
    ts,
    userId: normalizeText(raw.userId),
    sessionKey: normalizeText(raw.sessionKey),
    groupId: normalizeText(raw.groupId),
    channelId: normalizeText(raw.channelId),
    sessionId: normalizeText(raw.sessionId),
    routePolicyKey: normalizeText(raw.routePolicyKey),
    topRouteType: normalizeText(raw.topRouteType),
    scopeType: normalizeText(raw.scopeType || 'personal').toLowerCase() || 'personal',
    source: normalizeText(raw.source || 'runtime'),
    sourceKind: normalizeText(raw.sourceKind || ''),
    status: normalizeText(raw.status || ''),
    confidence: Number(raw.confidence || 0) || 0,
    importance: Number(raw.importance || 0) || 0,
    evidenceCount: Math.max(0, Number(raw.evidenceCount || 0) || 0),
    taskType: normalizeText(raw.taskType),
    toolName: normalizeText(raw.toolName),
    agentName: normalizeText(raw.agentName),
    memoryKind: normalizeText(raw.memoryKind).toLowerCase(),
    semanticSlot: normalizeText(raw.semanticSlot).toLowerCase(),
    conflictKey: normalizeText(raw.conflictKey),
    canonicalKey: normalizeText(raw.canonicalKey).toLowerCase(),
    dedupeKey: normalizeText(raw.dedupeKey),
    payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {},
    participants: normalizeArray(raw.participants, (item) => normalizeText(item)).slice(0, 8),
    entities: normalizeArray(raw.entities, (item) => normalizeText(item)).slice(0, 8),
    relations: normalizeArray(raw.relations, (item) => normalizeText(item)).slice(0, 8),
    text
  };
  event.id = event.id || buildEventId(event);
  return event;
}

function syncProfileJournalDbEvent(event = {}) {
  try {
    if (
      !event
      || !['memory_confirmed', 'memory_candidate_extracted', 'memory_archived', 'episode_rollup_generated', 'migration_bootstrap'].includes(event.type)
    ) {
      return;
    }
    const { syncMemoryEvent } = require('../profileJournalDb');
    syncMemoryEvent(event, { now: event.ts });
  } catch (error) {
    if (config.ENABLE_DEBUG_LOG) {
      console.warn('[profile_journal_db] failed to sync memory event:', error?.message || error);
    }
  }
}

async function appendMemoryEvent(event = {}) {
  const correction = detectProfileCorrection(event?.text || '');
  const shouldRewriteCorrection = correction.isCorrection
    && correction.correctedTo
    && ['explicit', 'manual'].includes(normalizeText(event?.sourceKind || event?.source).toLowerCase());
  const shouldSuppressCorrectionCommand = correction.isCorrection
    && !correction.correctedTo
    && ['explicit', 'manual'].includes(normalizeText(event?.sourceKind || event?.source).toLowerCase());
  const normalized = normalizeMemoryEvent(shouldRewriteCorrection
    ? {
      ...event,
      text: correction.correctedTo,
      payload: {
        ...(event.payload && typeof event.payload === 'object' ? event.payload : {}),
        originalCorrectionText: normalizeText(event.text),
        correction
      }
    }
    : shouldSuppressCorrectionCommand
      ? {
        ...event,
        payload: {
          ...(event.payload && typeof event.payload === 'object' ? event.payload : {}),
          correction,
          lifecycleStatus: 'suspect',
          profileQuality: {
            ok: false,
            reasons: ['correction_command'],
            confidence: Number(event.confidence || 0) || 1,
            sourceKind: normalizeText(event.sourceKind || event.source)
          }
        }
      }
      : event);
  const filePath = eventFileForTs(normalized.ts);
  const writer = getJsonLineWriter(filePath);
  const correctionEvents = correction.isCorrection
    ? buildProfileCorrectionEvents(loadMemoryEvents(), normalized, {
      now: normalized.ts,
      correction
    })
    : [];
  for (const correctionEvent of correctionEvents) {
    const normalizedCorrection = normalizeMemoryEvent({
      ...correctionEvent,
      ts: Math.max(0, Number(correctionEvent.ts || normalized.ts - 1) || normalized.ts - 1),
      id: normalizeText(correctionEvent.id) || buildEventId({
        ...correctionEvent,
        ts: Math.max(0, Number(correctionEvent.ts || normalized.ts - 1) || normalized.ts - 1)
      })
    });
    const correctionWriter = getJsonLineWriter(eventFileForTs(normalizedCorrection.ts));
    correctionWriter.append(normalizedCorrection);
    correctionWriter.flushSync();
    syncProfileJournalDbEvent(normalizedCorrection);
  }
  writer.append(normalized);
  writer.flushSync();
  syncProfileJournalDbEvent(normalized);
  return normalized;
}

function listMemoryEventFiles() {
  ensureDir(config.MEMORY_V3_EVENTS_DIR);
  const fs = require('fs');
  return fs.readdirSync(config.MEMORY_V3_EVENTS_DIR)
    .filter((name) => /^\d{4}-\d{2}(?:-\d{2})?\.ndjson$/i.test(name))
    .sort()
    .map((name) => path.join(config.MEMORY_V3_EVENTS_DIR, name));
}

function classifyEventFileName(filePath = '') {
  const name = path.basename(String(filePath || ''));
  if (/^\d{4}-\d{2}-\d{2}\.ndjson$/i.test(name)) return 'daily';
  if (/^\d{4}-\d{2}\.ndjson$/i.test(name)) return 'legacy_month';
  return 'unknown';
}

function compactFileNames(files = [], limit = 24) {
  const names = (Array.isArray(files) ? files : []).map((file) => path.basename(String(file || ''))).filter(Boolean);
  const max = Math.max(4, Number(limit) || 24);
  if (names.length <= max) return { files: names, truncated: false };
  const edge = Math.max(2, Math.floor(max / 2));
  return {
    files: [
      ...names.slice(0, edge),
      `...${names.length - (edge * 2)} omitted...`,
      ...names.slice(-edge)
    ],
    truncated: true
  };
}

function buildEventReadDiagnostics(files = [], options = {}) {
  const names = compactFileNames(files, options.fileNameLimit);
  const dailyFiles = (Array.isArray(files) ? files : []).filter((file) => classifyEventFileName(file) === 'daily');
  const legacyMonthFiles = (Array.isArray(files) ? files : []).filter((file) => classifyEventFileName(file) === 'legacy_month');
  const compactDaily = compactFileNames(dailyFiles, options.fileNameLimit);
  const compactLegacy = compactFileNames(legacyMonthFiles, options.fileNameLimit);
  return {
    eventDir: config.MEMORY_V3_EVENTS_DIR,
    fileCount: files.length,
    firstFile: files.length > 0 ? path.basename(files[0]) : '',
    lastFile: files.length > 0 ? path.basename(files[files.length - 1]) : '',
    files: names.files,
    filesTruncated: names.truncated,
    dailyFileCount: dailyFiles.length,
    legacyMonthFileCount: legacyMonthFiles.length,
    dailyFiles: compactDaily.files,
    legacyMonthFiles: compactLegacy.files,
    fromTs: Math.max(0, Number(options.fromTs || 0) || 0),
    toTs: Math.max(0, Number(options.toTs || 0) || 0),
    totalRows: 0,
    loadedEvents: 0,
    latestEventTs: 0,
    latestEventFile: '',
    latestEventId: '',
    latestRelevantEventTs: 0,
    latestRelevantEventFile: '',
    latestRelevantEventId: ''
  };
}

function matchesDiagnosticScope(event = {}, options = {}) {
  const userId = normalizeText(options.userId);
  const sessionKey = normalizeText(options.sessionKey);
  const groupId = normalizeText(options.groupId);
  const eventTypes = Array.isArray(options.eventTypes)
    ? new Set(options.eventTypes.map((item) => normalizeText(item).toLowerCase()).filter(Boolean))
    : null;
  if (eventTypes && !eventTypes.has(normalizeText(event.type).toLowerCase())) return false;
  const scopes = [];
  if (userId) scopes.push(normalizeText(event.userId) === userId);
  if (sessionKey) scopes.push(normalizeText(event.sessionKey) === sessionKey);
  if (groupId) scopes.push(normalizeText(event.groupId) === groupId);
  return scopes.length === 0 || scopes.some(Boolean);
}

function loadMemoryEventsWithDiagnostics(options = {}) {
  const files = listMemoryEventFiles();
  const results = [];
  const diagnostics = buildEventReadDiagnostics(files, options);
  const fromTs = Math.max(0, Number(options.fromTs || 0) || 0);
  const toTs = Math.max(0, Number(options.toTs || 0) || 0);
  for (const file of files) {
    const rows = safeReadJsonLines(file);
    diagnostics.totalRows += rows.length;
    for (const row of rows) {
      try {
        const event = normalizeMemoryEvent(row);
        if (fromTs && event.ts < fromTs) continue;
        if (toTs && event.ts > toTs) continue;
        results.push(event);
        if (Number(event.ts || 0) >= Number(diagnostics.latestEventTs || 0)) {
          diagnostics.latestEventTs = Number(event.ts || 0) || 0;
          diagnostics.latestEventFile = path.basename(file);
          diagnostics.latestEventId = String(event.id || '');
        }
        if (matchesDiagnosticScope(event, options) && Number(event.ts || 0) >= Number(diagnostics.latestRelevantEventTs || 0)) {
          diagnostics.latestRelevantEventTs = Number(event.ts || 0) || 0;
          diagnostics.latestRelevantEventFile = path.basename(file);
          diagnostics.latestRelevantEventId = String(event.id || '');
        }
      } catch (_) {}
    }
  }
  results.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0) || String(a.id || '').localeCompare(String(b.id || '')));
  diagnostics.loadedEvents = results.length;
  return { events: results, diagnostics };
}

function loadMemoryEvents(options = {}) {
  return loadMemoryEventsWithDiagnostics(options).events;
}

function inspectMemoryEventReadSet(options = {}) {
  return loadMemoryEventsWithDiagnostics(options).diagnostics;
}

module.exports = {
  EVENT_TYPES,
  appendMemoryEvent,
  normalizeMemoryEvent,
  loadMemoryEvents,
  loadMemoryEventsWithDiagnostics,
  inspectMemoryEventReadSet,
  listMemoryEventFiles,
  eventFileForTs,
  classifyEventFileName
};
