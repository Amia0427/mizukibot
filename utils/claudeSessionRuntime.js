const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function cloneJson(value, fallback = null) {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function ensureDir(filePath = '') {
  const dir = path.dirname(String(filePath || '').trim() || '.');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeReadJson(filePath = '', fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function makeRuntimeId(prefix = 'claude') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
}

function normalizeSession(session = {}) {
  return {
    session_key: normalizeText(session.session_key),
    claude_session_id: normalizeText(session.claude_session_id),
    transcript_path: normalizeText(session.transcript_path),
    status: normalizeText(session.status || 'open') || 'open',
    last_prompt: normalizeText(session.last_prompt),
    last_reply_excerpt: normalizeText(session.last_reply_excerpt),
    last_error: normalizeText(session.last_error),
    tail_offset: Math.max(0, Number(session.tail_offset) || 0),
    active_run_id: normalizeText(session.active_run_id),
    created_at: normalizeText(session.created_at) || nowIso(),
    updated_at: normalizeText(session.updated_at) || nowIso(),
    closed_at: session.closed_at || null
  };
}

function parseJsonLine(line = '') {
  try {
    const parsed = JSON.parse(String(line || '').trim());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function extractAssistantText(entry = {}) {
  const type = normalizeText(entry?.type).toLowerCase();
  if (type === 'assistant') {
    const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    const texts = content
      .filter((item) => normalizeText(item?.type).toLowerCase() === 'text')
      .map((item) => normalizeText(item?.text))
      .filter(Boolean);
    return texts.join('\n').trim();
  }
  if (type === 'result') {
    return normalizeText(entry?.result);
  }
  return '';
}

function extractErrorText(entry = {}) {
  if (entry?.error) return normalizeText(entry.error);
  const type = normalizeText(entry?.type).toLowerCase();
  if (type === 'result' && entry?.is_error === true) {
    return normalizeText(entry?.result);
  }
  return '';
}

function createClaudeSessionRuntime(options = {}) {
  const storeFile = normalizeText(options.storeFile || path.join(config.DATA_DIR, 'claude_sessions.json'));
  const state = {
    sessions: new Map()
  };

  function persist() {
    ensureDir(storeFile);
    const payload = {
      sessions: Array.from(state.sessions.values())
    };
    fs.writeFileSync(storeFile, JSON.stringify(payload, null, 2), 'utf8');
  }

  function load() {
    const raw = safeReadJson(storeFile, {});
    state.sessions.clear();
    for (const item of Array.isArray(raw?.sessions) ? raw.sessions : []) {
      const normalized = normalizeSession(item);
      if (!normalized.session_key) continue;
      state.sessions.set(normalized.session_key, normalized);
    }
    persist();
  }

  function getSession(sessionKey = '') {
    const key = normalizeText(sessionKey);
    if (!key) return null;
    return cloneJson(state.sessions.get(key), null);
  }

  function upsertSession(session = {}) {
    const normalized = normalizeSession(session);
    if (!normalized.session_key) return null;
    const current = state.sessions.get(normalized.session_key) || {};
    const next = normalizeSession({
      ...current,
      ...normalized,
      created_at: current.created_at || normalized.created_at || nowIso(),
      updated_at: nowIso()
    });
    state.sessions.set(next.session_key, next);
    persist();
    return cloneJson(next, null);
  }

  function openSession(payload = {}) {
    return upsertSession({
      session_key: payload.sessionKey,
      claude_session_id: payload.claudeSessionId,
      transcript_path: payload.transcriptPath,
      status: payload.status || 'open',
      last_prompt: payload.lastPrompt || '',
      last_reply_excerpt: payload.lastReplyExcerpt || '',
      last_error: payload.lastError || '',
      tail_offset: payload.tailOffset || 0,
      active_run_id: payload.activeRunId || ''
    });
  }

  function updateSession(sessionKey = '', patch = {}) {
    const current = state.sessions.get(normalizeText(sessionKey));
    if (!current) return null;
    return upsertSession({
      ...current,
      ...patch,
      session_key: current.session_key
    });
  }

  function closeSession(sessionKey = '') {
    const current = state.sessions.get(normalizeText(sessionKey));
    if (!current) return null;
    return upsertSession({
      ...current,
      status: 'closed',
      active_run_id: '',
      closed_at: nowIso()
    });
  }

  function listSessions(limit = 20) {
    const max = Math.max(1, Math.min(200, Number(limit) || 20));
    return Array.from(state.sessions.values())
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, max)
      .map((item) => cloneJson(item, null));
  }

  function readTail(sessionKey = '') {
    const session = state.sessions.get(normalizeText(sessionKey));
    if (!session) {
      return {
        ok: false,
        reason: 'session-not-found',
        text: '',
        status: 'missing',
        hasNewOutput: false
      };
    }

    const transcriptPath = normalizeText(session.transcript_path);
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return {
        ok: false,
        reason: 'transcript-not-found',
        text: '',
        status: session.status || 'open',
        hasNewOutput: false
      };
    }

    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
    const startOffset = Math.max(0, Number(session.tail_offset) || 0);
    const nextLines = lines.slice(startOffset);
    if (!nextLines.length) {
      return {
        ok: true,
        reason: '',
        text: '',
        status: session.status || 'open',
        hasNewOutput: false,
        nextOffset: lines.length
      };
    }

    const chunks = [];
    let latestError = '';
    for (const line of nextLines) {
      const parsed = parseJsonLine(line);
      if (!parsed) continue;
      const assistantText = extractAssistantText(parsed);
      if (assistantText) chunks.push(assistantText);
      const errorText = extractErrorText(parsed);
      if (errorText) latestError = errorText;
    }

    const text = chunks.join('\n').trim();
    const nextOffset = lines.length;
    updateSession(sessionKey, {
      tail_offset: nextOffset,
      last_reply_excerpt: text || session.last_reply_excerpt,
      last_error: latestError || session.last_error,
      status: latestError ? 'failed' : (session.status === 'closed' ? 'closed' : 'idle')
    });

    return {
      ok: true,
      reason: '',
      text,
      status: latestError ? 'failed' : (session.status === 'closed' ? 'closed' : 'idle'),
      hasNewOutput: Boolean(text),
      nextOffset,
      lastError: latestError
    };
  }

  load();

  return {
    closeSession,
    getSession,
    listSessions,
    openSession,
    readTail,
    updateSession
  };
}

let singletonRuntime = null;

function getClaudeSessionRuntime() {
  if (!singletonRuntime) {
    singletonRuntime = createClaudeSessionRuntime();
  }
  return singletonRuntime;
}

module.exports = {
  createClaudeSessionRuntime,
  getClaudeSessionRuntime
};
