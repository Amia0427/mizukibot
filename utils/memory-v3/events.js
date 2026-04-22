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

function toMonthKey(ts = nowTs()) {
  const date = new Date(Number(ts) || nowTs());
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function eventFileForTs(ts = nowTs()) {
  ensureDir(config.MEMORY_V3_EVENTS_DIR);
  return path.join(config.MEMORY_V3_EVENTS_DIR, `${toMonthKey(ts)}.ndjson`);
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

async function appendMemoryEvent(event = {}) {
  const normalized = normalizeMemoryEvent(event);
  const filePath = eventFileForTs(normalized.ts);
  const writer = getJsonLineWriter(filePath);
  writer.append(normalized);
  writer.flushSync();
  return normalized;
}

function listMemoryEventFiles() {
  ensureDir(config.MEMORY_V3_EVENTS_DIR);
  const fs = require('fs');
  return fs.readdirSync(config.MEMORY_V3_EVENTS_DIR)
    .filter((name) => /^\d{4}-\d{2}\.ndjson$/i.test(name))
    .sort()
    .map((name) => path.join(config.MEMORY_V3_EVENTS_DIR, name));
}

function loadMemoryEvents(options = {}) {
  const files = listMemoryEventFiles();
  const results = [];
  const fromTs = Math.max(0, Number(options.fromTs || 0) || 0);
  const toTs = Math.max(0, Number(options.toTs || 0) || 0);
  for (const file of files) {
    const rows = safeReadJsonLines(file);
    for (const row of rows) {
      try {
        const event = normalizeMemoryEvent(row);
        if (fromTs && event.ts < fromTs) continue;
        if (toTs && event.ts > toTs) continue;
        results.push(event);
      } catch (_) {}
    }
  }
  results.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0) || String(a.id || '').localeCompare(String(b.id || '')));
  return results;
}

module.exports = {
  EVENT_TYPES,
  appendMemoryEvent,
  normalizeMemoryEvent,
  loadMemoryEvents,
  listMemoryEventFiles,
  eventFileForTs
};
