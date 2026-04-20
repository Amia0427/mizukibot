const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { getJsonStore } = require('./storeRegistry');

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

function makeRequestId() {
  return `hreq_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
}

function normalizeApproval(item = {}, ttlMs = 24 * 60 * 60 * 1000) {
  const createdAt = normalizeText(item.created_at) || nowIso();
  const expiresAt = normalizeText(item.expires_at)
    || new Date(Date.parse(createdAt) + Math.max(60000, Number(ttlMs) || (24 * 60 * 60 * 1000))).toISOString();
  return {
    id: normalizeText(item.id) || makeRequestId(),
    session_id: normalizeText(item.session_id),
    request_id: normalizeText(item.request_id),
    task_id: normalizeText(item.task_id),
    user_id: normalizeText(item.user_id),
    group_id: normalizeText(item.group_id),
    machine_id: normalizeText(item.machine_id),
    status: normalizeText(item.status || 'pending') || 'pending',
    title: normalizeText(item.title || item.summary),
    summary: normalizeText(item.summary),
    raw_event: cloneJson(item.raw_event, {}),
    created_at: createdAt,
    updated_at: normalizeText(item.updated_at) || createdAt,
    expires_at: expiresAt,
    resolved_at: item.resolved_at || null,
    resolution: normalizeText(item.resolution),
    resolution_note: normalizeText(item.resolution_note)
  };
}

function normalizeSession(item = {}) {
  return {
    session_id: normalizeText(item.session_id),
    machine_id: normalizeText(item.machine_id),
    agent_id: normalizeText(item.agent_id),
    user_id: normalizeText(item.user_id),
    group_id: normalizeText(item.group_id),
    task_id: normalizeText(item.task_id),
    route_policy_key: normalizeText(item.route_policy_key),
    status: normalizeText(item.status || 'idle') || 'idle',
    last_event_type: normalizeText(item.last_event_type),
    latest_summary: normalizeText(item.latest_summary),
    latest_error: normalizeText(item.latest_error),
    created_at: normalizeText(item.created_at) || nowIso(),
    updated_at: normalizeText(item.updated_at) || nowIso()
  };
}

function createHapiControlRuntime(options = {}) {
  const filePath = normalizeText(options.filePath || config.HAPI_CONTROL_FILE || path.join(config.DATA_DIR, 'hapi_control.json'));
  const approvalTtlMs = Math.max(60000, Number(options.approvalTtlMs || config.HAPI_APPROVAL_REQUEST_TTL_MS) || (24 * 60 * 60 * 1000));
  const state = {
    approvals: new Map(),
    sessions: new Map()
  };

  function persist() {
    const payload = {
      approvals: Array.from(state.approvals.values()),
      sessions: Array.from(state.sessions.values())
    };
    getJsonStore(filePath, {
      fallback: () => ({ approvals: [], sessions: [] })
    }).replace(payload, { flushNow: true });
  }

  function load() {
    const raw = safeReadJson(filePath, {});
    state.approvals.clear();
    state.sessions.clear();
    for (const item of Array.isArray(raw?.approvals) ? raw.approvals : []) {
      const normalized = normalizeApproval(item, approvalTtlMs);
      state.approvals.set(normalized.id, normalized);
    }
    for (const item of Array.isArray(raw?.sessions) ? raw.sessions : []) {
      const normalized = normalizeSession(item);
      if (!normalized.session_id) continue;
      state.sessions.set(normalized.session_id, normalized);
    }
    expireApprovals();
    persist();
  }

  function expireApprovals() {
    const now = Date.now();
    for (const [approvalId, approval] of state.approvals.entries()) {
      const expiresAt = Date.parse(String(approval.expires_at || ''));
      if (approval.status === 'pending' && Number.isFinite(expiresAt) && expiresAt <= now) {
        state.approvals.set(approvalId, normalizeApproval({
          ...approval,
          status: 'expired',
          resolution: 'deny',
          resolution_note: approval.resolution_note || 'approval request expired',
          resolved_at: approval.resolved_at || nowIso(),
          updated_at: nowIso()
        }, approvalTtlMs));
      }
    }
  }

  function upsertSession(session = {}) {
    const normalized = normalizeSession(session);
    if (!normalized.session_id) return null;
    const current = state.sessions.get(normalized.session_id) || {};
    const next = normalizeSession({
      ...current,
      ...normalized,
      updated_at: nowIso(),
      created_at: current.created_at || normalized.created_at || nowIso()
    });
    state.sessions.set(next.session_id, next);
    persist();
    return cloneJson(next, null);
  }

  function getSession(sessionId = '') {
    const key = normalizeText(sessionId);
    if (!key) return null;
    return cloneJson(state.sessions.get(key), null);
  }

  function listSessions(limit = 20, filter = {}) {
    const max = Math.max(1, Math.min(200, Number(limit) || 20));
    const userId = normalizeText(filter.userId);
    const groupId = normalizeText(filter.groupId);
    const status = normalizeText(filter.status);
    return Array.from(state.sessions.values())
      .filter((item) => (!userId || item.user_id === userId))
      .filter((item) => (!groupId || item.group_id === groupId))
      .filter((item) => (!status || item.status === status))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, max)
      .map((item) => cloneJson(item, null));
  }

  function createApproval(payload = {}) {
    expireApprovals();
    const normalized = normalizeApproval({
      ...payload,
      id: payload.id || makeRequestId(),
      created_at: payload.created_at || nowIso(),
      updated_at: payload.updated_at || nowIso()
    }, approvalTtlMs);
    state.approvals.set(normalized.id, normalized);
    persist();
    return cloneJson(normalized, null);
  }

  function getApproval(approvalId = '') {
    expireApprovals();
    const key = normalizeText(approvalId);
    if (!key) return null;
    return cloneJson(state.approvals.get(key), null);
  }

  function findPendingApprovalBySession(sessionId = '') {
    expireApprovals();
    const normalizedSessionId = normalizeText(sessionId);
    if (!normalizedSessionId) return null;
    const matches = Array.from(state.approvals.values())
      .filter((item) => item.session_id === normalizedSessionId && item.status === 'pending')
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return cloneJson(matches[0], null);
  }

  function listApprovals(limit = 20, filter = {}) {
    expireApprovals();
    const max = Math.max(1, Math.min(200, Number(limit) || 20));
    const userId = normalizeText(filter.userId);
    const groupId = normalizeText(filter.groupId);
    const status = normalizeText(filter.status);
    return Array.from(state.approvals.values())
      .filter((item) => (!userId || item.user_id === userId))
      .filter((item) => (!groupId || item.group_id === groupId))
      .filter((item) => (!status || item.status === status))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, max)
      .map((item) => cloneJson(item, null));
  }

  function resolveApproval(approvalId = '', resolution = 'approve', note = '') {
    expireApprovals();
    const key = normalizeText(approvalId);
    if (!key) return null;
    const current = state.approvals.get(key);
    if (!current) return null;
    const resolved = normalizeApproval({
      ...current,
      status: resolution === 'approve' ? 'approved' : 'denied',
      resolution: resolution === 'approve' ? 'approve' : 'deny',
      resolution_note: normalizeText(note),
      resolved_at: nowIso(),
      updated_at: nowIso()
    }, approvalTtlMs);
    state.approvals.set(key, resolved);
    persist();
    return cloneJson(resolved, null);
  }

  function markSessionEvent(sessionId = '', payload = {}) {
    const current = state.sessions.get(normalizeText(sessionId)) || { session_id: normalizeText(sessionId) };
    if (!current.session_id) return null;
    return upsertSession({
      ...current,
      ...payload,
      session_id: current.session_id,
      updated_at: nowIso()
    });
  }

  load();

  return {
    createApproval,
    expireApprovals,
    findPendingApprovalBySession,
    getApproval,
    getSession,
    listApprovals,
    listSessions,
    markSessionEvent,
    resolveApproval,
    upsertSession
  };
}

let singletonRuntime = null;

function getHapiControlRuntime() {
  if (!singletonRuntime) {
    singletonRuntime = createHapiControlRuntime();
  }
  return singletonRuntime;
}

module.exports = {
  createHapiControlRuntime,
  getHapiControlRuntime
};
