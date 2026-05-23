const fs = require('fs');
const path = require('path');
const config = require('../config');

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

// V2 persistence intentionally stays on local JSON files under `data` so the
// runtime can gain resume/event semantics without introducing a database.
function createCheckpointStore(options = {}) {
  const checkpointDir = String(options.checkpointDir || config.LANGGRAPH_V2_CHECKPOINT_DIR || '').trim();
  const eventDir = String(options.eventDir || config.LANGGRAPH_V2_EVENT_DIR || '').trim();

  ensureDir(checkpointDir);
  ensureDir(eventDir);

  function checkpointFile(threadId) {
    return path.join(checkpointDir, `${sanitizeThreadId(threadId)}.json`);
  }

  function eventFile(threadId) {
    return path.join(eventDir, `${sanitizeThreadId(threadId)}.json`);
  }

  function loadCheckpoint(threadId) {
    return safeReadJson(checkpointFile(threadId), null);
  }

  function saveCheckpoint(threadId, payload = {}) {
    const normalized = {
      threadId: sanitizeThreadId(threadId),
      status: String(payload.status || 'running').trim() || 'running',
      node: String(payload.node || '').trim(),
      updatedAt: Number.isFinite(Number(payload.updatedAt)) ? Number(payload.updatedAt) : Date.now(),
      state: sanitizeForJson(compactStateForCheckpoint(payload.state || {}))
    };
    atomicWriteJson(checkpointFile(threadId), normalized);
    return normalized;
  }

  function loadEvents(threadId) {
    return safeReadJson(eventFile(threadId), []);
  }

  function appendEvents(threadId, events = []) {
    const nextEvents = Array.isArray(events)
      ? events.map((item) => sanitizeForJson(item)).filter(Boolean)
      : [];
    if (nextEvents.length === 0) return [];
    const existing = loadEvents(threadId);
    const merged = Array.isArray(existing) ? existing.concat(nextEvents) : nextEvents;
    atomicWriteJson(eventFile(threadId), merged);
    return nextEvents;
  }

  function clear(threadId) {
    for (const filePath of [checkpointFile(threadId), eventFile(threadId)]) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) {}
    }
  }

  return {
    checkpointDir,
    eventDir,
    loadCheckpoint,
    saveCheckpoint,
    loadEvents,
    appendEvents,
    clear
  };
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
  createCheckpointStore,
  resolveThreadId,
  safeReadJson,
  sanitizeForJson,
  sanitizeThreadId
};
