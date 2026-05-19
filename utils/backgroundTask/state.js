const crypto = require('crypto');

const ACTIVE_STATUSES = new Set(['queued', 'running', 'reviewing']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'superseded', 'interrupted', 'expired']);
const SESSION_STATUSES = new Set(['active', 'retained', 'done']);

function nowIso() {
  return new Date().toISOString();
}

function clampPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeText(value) {
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

function makeTaskId() {
  return `bg_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function summarizeReply(text = '', maxChars = 160) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

function normalizeTask(task = {}, options = {}) {
  const now = nowIso();
  const ttlMs = clampPositiveInt(options.sessionTtlMs, 30 * 60 * 1000);
  const updatedAt = normalizeText(task.updated_at) || now;
  return {
    id: normalizeText(task.id) || makeTaskId(),
    session_key: normalizeText(task.session_key),
    revision: Math.max(1, Number(task.revision) || 1),
    executor_type: normalizeText(task.executor_type || 'local_tools') || 'local_tools',
    status: normalizeText(task.status || 'queued') || 'queued',
    stage: normalizeText(task.stage || task.status || 'queued') || 'queued',
    group_id: normalizeText(task.group_id),
    user_id: normalizeText(task.user_id),
    original_text: normalizeText(task.original_text),
    effective_text: normalizeText(task.effective_text),
    route_policy_key: normalizeText(task.route_policy_key),
    top_route_type: normalizeText(task.top_route_type),
    created_at: normalizeText(task.created_at) || now,
    updated_at: updatedAt,
    started_at: task.started_at || null,
    completed_at: task.completed_at || null,
    expires_at: normalizeText(task.expires_at) || new Date(Date.parse(updatedAt) + ttlMs).toISOString(),
    ack_sent: Boolean(task.ack_sent),
    followup_sent: Boolean(task.followup_sent),
    suppress_followup: Boolean(task.suppress_followup),
    cancel_requested_at: task.cancel_requested_at || null,
    superseded_by: normalizeText(task.superseded_by),
    latest_summary: normalizeText(task.latest_summary),
    result_excerpt: normalizeText(task.result_excerpt),
    error: normalizeText(task.error),
    session_status: SESSION_STATUSES.has(String(task.session_status || '').trim())
      ? String(task.session_status).trim()
      : ''
  };
}

function normalizeSession(session = {}, options = {}) {
  const ttlMs = clampPositiveInt(options.sessionTtlMs, 30 * 60 * 1000);
  const updatedAt = normalizeText(session.updated_at) || nowIso();
  const expiresAt = normalizeText(session.expires_at) || new Date(Date.parse(updatedAt) + ttlMs).toISOString();
  const status = SESSION_STATUSES.has(String(session.status || '').trim())
    ? String(session.status).trim()
    : 'retained';
  return {
    session_key: normalizeText(session.session_key),
    status,
    active_task_id: normalizeText(session.active_task_id),
    latest_task_id: normalizeText(session.latest_task_id),
    latest_summary: normalizeText(session.latest_summary),
    latest_result_excerpt: normalizeText(session.latest_result_excerpt),
    original_text: normalizeText(session.original_text),
    revision: Math.max(0, Number(session.revision) || 0),
    updated_at: updatedAt,
    expires_at: expiresAt,
    closed_at: session.closed_at || null
  };
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  SESSION_STATUSES,
  nowIso,
  clampPositiveInt,
  normalizeText,
  cloneJson,
  makeTaskId,
  summarizeReply,
  normalizeTask,
  normalizeSession
};
