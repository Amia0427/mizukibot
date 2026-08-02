const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { createLangGraphV2Database } = require('./langgraphV2StoreDatabase');

const openStores = new Set();

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function atomicWriteJson(filePath, data) {
  const dirPath = path.dirname(filePath);
  ensureDir(dirPath);
  const tempFile = `${filePath}.${process.pid}.tmp`;
  const text = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tempFile, text, 'utf8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, text, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM') throw error;
  }
}

function sanitizeThreadId(value) {
  const raw = String(value || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 180);
  return cleaned || 'anonymous_thread';
}

function sanitizeForJson(value, seen = new WeakSet()) {
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    return undefined;
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value
      .map((item) => sanitizeForJson(item, seen))
      .filter((item) => item !== undefined);
    seen.delete(value);
    return output;
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const sanitized = sanitizeForJson(item, seen);
    if (sanitized !== undefined) {
      output[key] = sanitized;
    }
  }
  seen.delete(value);
  return output;
}

function compactListForCheckpoint(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, Math.max(0, Number(limit) || 0)).map((item) => sanitizeForJson(item));
}

function compactStableProfileForCheckpoint(stableProfile = {}) {
  if (!stableProfile || typeof stableProfile !== 'object' || Array.isArray(stableProfile)) {
    return stableProfile;
  }
  const strictItems = Array.isArray(stableProfile.strictItems)
    ? stableProfile.strictItems
    : [];
  const weakItems = Array.isArray(stableProfile.weakItems)
    ? stableProfile.weakItems
    : [];
  const conflicts = Array.isArray(stableProfile.conflicts)
    ? stableProfile.conflicts
    : [];
  const suppressed = Array.isArray(stableProfile.suppressed)
    ? stableProfile.suppressed
    : [];
  const traceItems = Array.isArray(stableProfile.traceItems)
    ? stableProfile.traceItems
    : [];
  return {
    text: String(stableProfile.text || ''),
    source: String(stableProfile.source || ''),
    disabled: stableProfile.disabled === true,
    reason: String(stableProfile.reason || ''),
    legacyFallbackUsed: stableProfile.legacyFallbackUsed === true,
    persona: sanitizeForJson(stableProfile.persona || {}),
    strictItems: compactListForCheckpoint(strictItems, 12),
    weakItems: compactListForCheckpoint(weakItems, 8),
    traceItems: compactListForCheckpoint(traceItems, 20),
    conflicts: compactListForCheckpoint(conflicts, 20),
    suppressed: compactListForCheckpoint(suppressed, 20),
    expiresSoon: compactListForCheckpoint(stableProfile.expiresSoon, 20),
    checkpointCompacted: true,
    checkpointOriginalCounts: {
      strictItems: strictItems.length,
      weakItems: weakItems.length,
      traceItems: traceItems.length,
      conflicts: conflicts.length,
      suppressed: suppressed.length,
      expiresSoon: Array.isArray(stableProfile.expiresSoon) ? stableProfile.expiresSoon.length : 0
    }
  };
}

function compactMemoryContextForCheckpoint(context = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return context;
  return {
    ...context,
    stableProfile: compactStableProfileForCheckpoint(context.stableProfile)
  };
}

function compactStateForCheckpoint(state = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const memory = state.memory && typeof state.memory === 'object' && !Array.isArray(state.memory)
    ? state.memory
    : null;
  if (!memory) return state;
  return {
    ...state,
    memory: {
      ...memory,
      context: compactMemoryContextForCheckpoint(memory.context),
      checkpointCompacted: true
    }
  };
}

function createCheckpointStore(options = {}, dependencies = {}) {
  const hasCustomLegacyPath = Boolean(options.checkpointDir || options.eventDir);
  if (hasCustomLegacyPath && !options.storeFile) {
    const error = new Error('storeFile is required when overriding LangGraph V2 legacy directories');
    error.code = 'LANGGRAPH_V2_STORE_FILE_REQUIRED';
    throw error;
  }

  const storeFile = String(options.storeFile || config.LANGGRAPH_V2_STORE_FILE || '').trim();
  const checkpointDir = String(options.checkpointDir || config.LANGGRAPH_V2_CHECKPOINT_DIR || '').trim();
  const eventDir = String(options.eventDir || config.LANGGRAPH_V2_EVENT_DIR || '').trim();
  const database = createLangGraphV2Database(storeFile, dependencies);

  function legacyFile(dir, threadId) {
    return path.join(dir, `${sanitizeThreadId(threadId)}.json`);
  }

  function readLegacy(filePath, threadId, sourceKind, isValid, fallback) {
    let raw;
    try {
      raw = fs.readFileSync(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return fallback;
      database.insertQuarantine({
        sourceKind,
        sourceKey: `${path.resolve(filePath)}:read:${error?.code || 'unknown'}`,
        threadId,
        rawPayload: null,
        error: String(error?.message || error),
        quarantinedAt: Date.now()
      });
      return fallback;
    }

    try {
      const value = JSON.parse(raw.toString('utf8'));
      if (!isValid(value)) throw new TypeError(`invalid ${sourceKind} payload shape`);
      return value;
    } catch (error) {
      const digest = crypto.createHash('sha256').update(raw).digest('hex');
      database.insertQuarantine({
        sourceKind,
        sourceKey: `${path.resolve(filePath)}:${digest}`,
        threadId,
        rawPayload: null,
        error: String(error?.message || error),
        quarantinedAt: Date.now()
      });
      return fallback;
    }
  }

  function loadCheckpoint(threadId) {
    const normalizedThreadId = sanitizeThreadId(threadId);
    const row = database.getCheckpoint(normalizedThreadId);
    if (row) {
      try {
        const state = JSON.parse(row.state_json);
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
          throw new TypeError('checkpoint state_json must contain an object');
        }
        return {
          threadId: row.thread_id,
          status: row.status,
          node: row.node,
          updatedAt: row.updated_at,
          state
        };
      } catch (error) {
        database.isolateCheckpoint(row, String(error?.message || error), Date.now());
        return null;
      }
    }
    if (database.hasLegacyTombstone(normalizedThreadId)) return null;
    return readLegacy(
      legacyFile(checkpointDir, normalizedThreadId),
      normalizedThreadId,
      'legacy_checkpoint',
      (value) => value && typeof value === 'object' && !Array.isArray(value),
      null
    );
  }

  function normalizeCheckpoint(threadId, payload = {}) {
    return {
      threadId: sanitizeThreadId(threadId),
      status: String(payload.status || 'running').trim() || 'running',
      node: String(payload.node || '').trim(),
      updatedAt: Number.isFinite(Number(payload.updatedAt)) ? Number(payload.updatedAt) : Date.now(),
      state: sanitizeForJson(compactStateForCheckpoint(payload.state || {}))
    };
  }

  function checkpointRow(checkpoint) {
    return {
      threadId: checkpoint.threadId,
      status: checkpoint.status,
      node: checkpoint.node,
      updatedAt: checkpoint.updatedAt,
      stateJson: JSON.stringify(checkpoint.state)
    };
  }

  function normalizeEvents(threadId, events = []) {
    const normalizedThreadId = sanitizeThreadId(threadId);
    return (Array.isArray(events) ? events : [])
      .map((item) => sanitizeForJson(item))
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((event) => ({
        event,
        row: {
          threadId: normalizedThreadId,
          timestamp: Number.isFinite(Number(event.ts)) ? Number(event.ts) : Date.now(),
          eventType: String(event.type || '').trim(),
          eventJson: JSON.stringify(event)
        }
      }));
  }

  function saveCheckpoint(threadId, payload = {}) {
    const normalized = normalizeCheckpoint(threadId, payload);
    database.saveCheckpoint(checkpointRow(normalized));
    return normalized;
  }

  function loadEvents(threadId) {
    const normalizedThreadId = sanitizeThreadId(threadId);
    const current = [];
    for (const row of database.getEvents(normalizedThreadId)) {
      try {
        const event = JSON.parse(row.event_json);
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          throw new TypeError('event_json must contain an object');
        }
        current.push(event);
      } catch (error) {
        database.isolateEvent(row, String(error?.message || error), Date.now());
      }
    }
    if (database.hasLegacyTombstone(normalizedThreadId)) return current;
    const legacy = readLegacy(
      legacyFile(eventDir, normalizedThreadId),
      normalizedThreadId,
      'legacy_events',
      Array.isArray,
      []
    );
    return legacy.concat(current);
  }

  function appendEvents(threadId, events = []) {
    const normalized = normalizeEvents(threadId, events);
    if (normalized.length === 0) return [];
    database.appendEvents(normalized.map((item) => item.row));
    return normalized.map((item) => item.event);
  }

  function saveTransition(threadId, checkpoint = {}, events = []) {
    const normalizedCheckpoint = normalizeCheckpoint(threadId, checkpoint);
    const normalizedEvents = normalizeEvents(threadId, events);
    database.saveTransition(
      checkpointRow(normalizedCheckpoint),
      normalizedEvents.map((item) => item.row)
    );
    return {
      checkpoint: normalizedCheckpoint,
      events: normalizedEvents.map((item) => item.event)
    };
  }

  function clear(threadId) {
    database.clear(sanitizeThreadId(threadId), Date.now());
  }

  let store;
  store = {
    checkpointDir,
    close() {
      database.close();
      openStores.delete(store);
    },
    clear,
    eventDir,
    loadCheckpoint,
    loadEvents,
    appendEvents,
    saveCheckpoint,
    saveTransition,
    storeFile
  };
  openStores.add(store);
  return store;
}

function closeDb() {
  for (const store of [...openStores]) store.close();
}

// Thread ids must remain deterministic across retries and restarts so `auto`
// resume can locate the latest incomplete checkpoint for the same turn.
function resolveThreadId({
  userId = '',
  routePolicyKey = '',
  reviewMode = '',
  routeMeta = null,
  sessionKey = '',
  imageUrl = null,
  options = {}
} = {}) {
  const meta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  const explicit = String(
    options.threadId
    || meta.threadId
    || meta.thread_id
    || ''
  ).trim();
  if (explicit) return sanitizeThreadId(explicit);

  const parts = [
    String(userId || '').trim() || 'anonymous',
    String(sessionKey || meta.sessionKey || meta.session_key || 'default').trim() || 'default',
    String(routePolicyKey || 'chat').trim() || 'chat'
  ];

  if (String(reviewMode || '').trim()) parts.push('review');
  if (imageUrl) parts.push('image');
  return sanitizeThreadId(parts.join(':'));
}

module.exports = {
  atomicWriteJson,
  compactStateForCheckpoint,
  compactStableProfileForCheckpoint,
  closeDb,
  createCheckpointStore,
  resolveThreadId,
  safeReadJson,
  sanitizeForJson,
  sanitizeThreadId
};
