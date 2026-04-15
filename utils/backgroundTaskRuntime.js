const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) return fallback;
    return JSON.parse(raw);
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

function createBackgroundTaskRuntime(options = {}) {
  const storeDir = normalizeText(options.storeDir || config.BACKGROUND_TASK_STORE_DIR || path.join(config.DATA_DIR, 'background_tasks'));
  const sessionTtlMs = clampPositiveInt(options.sessionTtlMs || config.BACKGROUND_TASK_SESSION_TTL_MS, 30 * 60 * 1000);
  const tasksById = new Map();
  const sessionsByKey = new Map();
  const controllersByTaskId = new Map();

  function taskPath(taskId) {
    return path.join(storeDir, `${String(taskId || '').trim()}.json`);
  }

  function writeTask(task) {
    const normalized = normalizeTask(task, { sessionTtlMs });
    ensureDir(storeDir);
    fs.writeFileSync(taskPath(normalized.id), JSON.stringify(normalized, null, 2), 'utf8');
    tasksById.set(normalized.id, normalized);
    return normalized;
  }

  function saveSession(session) {
    const normalized = normalizeSession(session, { sessionTtlMs });
    sessionsByKey.set(normalized.session_key, normalized);
    return normalized;
  }

  function removeSession(sessionKey = '') {
    const key = normalizeText(sessionKey);
    if (!key) return false;
    return sessionsByKey.delete(key);
  }

  function getTask(taskId = '') {
    const key = normalizeText(taskId);
    if (!key) return null;
    const task = tasksById.get(key);
    return task ? cloneJson(task, null) : null;
  }

  function getMutableTask(taskId = '') {
    const key = normalizeText(taskId);
    if (!key) return null;
    return tasksById.get(key) || null;
  }

  function getSessionState(sessionKey = '') {
    expireSessions();
    const key = normalizeText(sessionKey);
    if (!key) return null;
    const session = sessionsByKey.get(key);
    return session ? cloneJson(session, null) : null;
  }

  function getMutableSession(sessionKey = '') {
    expireSessions();
    const key = normalizeText(sessionKey);
    if (!key) return null;
    return sessionsByKey.get(key) || null;
  }

  function getActiveTask(sessionKey = '') {
    const session = getMutableSession(sessionKey);
    if (!session || !session.active_task_id) return null;
    const task = getMutableTask(session.active_task_id);
    if (!task || !ACTIVE_STATUSES.has(task.status)) return null;
    return cloneJson(task, null);
  }

  function listTasks(limit = 100) {
    const max = Math.max(1, Math.min(500, Number(limit) || 100));
    return Array.from(tasksById.values())
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, max)
      .map((task) => cloneJson(task, null));
  }

  function touchTask(taskId, mutator) {
    const current = getMutableTask(taskId);
    if (!current) return null;
    const next = typeof mutator === 'function' ? (mutator({ ...current }) || current) : current;
    return writeTask({
      ...current,
      ...next,
      updated_at: nowIso()
    });
  }

  function touchSession(sessionKey, mutator) {
    const current = getMutableSession(sessionKey);
    if (!current) return null;
    const next = typeof mutator === 'function' ? (mutator({ ...current }) || current) : current;
    return saveSession({
      ...current,
      ...next,
      updated_at: nowIso(),
      expires_at: next?.status === 'done'
        ? current.expires_at
        : new Date(Date.now() + sessionTtlMs).toISOString()
    });
  }

  function clearController(taskId = '') {
    controllersByTaskId.delete(normalizeText(taskId));
  }

  function attachController(taskId = '', controller = null) {
    const key = normalizeText(taskId);
    if (!key || !controller || typeof controller.cancel !== 'function') return false;
    controllersByTaskId.set(key, controller);
    return true;
  }

  function cancelAttachedController(taskId = '', reason = 'cancelled') {
    const key = normalizeText(taskId);
    if (!key) return false;
    const controller = controllersByTaskId.get(key);
    if (!controller || typeof controller.cancel !== 'function') return false;
    try {
      controller.cancel(reason);
      return true;
    } catch (_) {
      return false;
    }
  }

  function shouldContinue(taskId = '') {
    const task = getMutableTask(taskId);
    return Boolean(task && ACTIVE_STATUSES.has(task.status));
  }

  function buildSessionSkeleton(sessionKey, defaults = {}) {
    return normalizeSession({
      session_key: sessionKey,
      status: defaults.status || 'active',
      active_task_id: defaults.active_task_id || '',
      latest_task_id: defaults.latest_task_id || '',
      latest_summary: defaults.latest_summary || '',
      latest_result_excerpt: defaults.latest_result_excerpt || '',
      original_text: defaults.original_text || '',
      revision: defaults.revision || 0,
      updated_at: nowIso(),
      expires_at: new Date(Date.now() + sessionTtlMs).toISOString(),
      closed_at: defaults.closed_at || null
    }, { sessionTtlMs });
  }

  function markTaskStatus(taskId = '', payload = {}) {
    const next = touchTask(taskId, (task) => ({
      ...task,
      ...payload,
      updated_at: nowIso()
    }));
    return next ? cloneJson(next, null) : null;
  }

  function startTask(input = {}) {
    expireSessions();
    const sessionKey = normalizeText(input.sessionKey);
    if (!sessionKey) throw new Error('sessionKey is required');

    let session = getMutableSession(sessionKey);
    if (!session || session.status === 'done') {
      session = buildSessionSkeleton(sessionKey, {
        status: 'active',
        original_text: normalizeText(input.originalText),
        revision: 0
      });
      saveSession(session);
    }

    const taskId = makeTaskId();
    const previousActiveTaskId = normalizeText(session.active_task_id);
    if (previousActiveTaskId) {
      supersedeTask(previousActiveTaskId, taskId);
    }

    const revision = Math.max(0, Number(session.revision) || 0) + 1;
    const task = writeTask({
      id: taskId,
      session_key: sessionKey,
      revision,
      executor_type: normalizeText(input.executorType || 'local_tools') || 'local_tools',
      status: 'queued',
      stage: 'queued',
      group_id: normalizeText(input.groupId),
      user_id: normalizeText(input.userId),
      original_text: normalizeText(input.originalText || session.original_text),
      effective_text: normalizeText(input.effectiveText || input.originalText),
      route_policy_key: normalizeText(input.routePolicyKey),
      top_route_type: normalizeText(input.topRouteType),
      created_at: nowIso(),
      updated_at: nowIso(),
      started_at: null,
      completed_at: null,
      expires_at: new Date(Date.now() + sessionTtlMs).toISOString(),
      ack_sent: false,
      followup_sent: false,
      suppress_followup: false,
      cancel_requested_at: null,
      superseded_by: '',
      latest_summary: '',
      result_excerpt: '',
      error: '',
      session_status: 'active'
    });

    saveSession({
      ...session,
      status: 'active',
      active_task_id: task.id,
      latest_task_id: task.id,
      original_text: task.original_text,
      revision,
      updated_at: nowIso(),
      expires_at: new Date(Date.now() + sessionTtlMs).toISOString(),
      closed_at: null
    });

    return cloneJson(task, null);
  }

  function markTaskRunning(taskId = '', stage = 'running') {
    const task = touchTask(taskId, (current) => {
      if (TERMINAL_STATUSES.has(current.status)) return current;
      return {
        ...current,
        status: 'running',
        stage: normalizeText(stage || 'running') || 'running',
        started_at: current.started_at || nowIso(),
        session_status: 'active'
      };
    });
    return task ? cloneJson(task, null) : null;
  }

  function markTaskReviewing(taskId = '') {
    const task = touchTask(taskId, (current) => {
      if (TERMINAL_STATUSES.has(current.status)) return current;
      return {
        ...current,
        status: 'reviewing',
        stage: 'reviewing',
        session_status: 'active'
      };
    });
    return task ? cloneJson(task, null) : null;
  }

  function markAckSent(taskId = '', sent = true) {
    const task = touchTask(taskId, (current) => ({
      ...current,
      ack_sent: Boolean(sent)
    }));
    return task ? cloneJson(task, null) : null;
  }

  function markFollowupSent(taskId = '', sent = true) {
    const task = touchTask(taskId, (current) => ({
      ...current,
      followup_sent: Boolean(sent)
    }));
    return task ? cloneJson(task, null) : null;
  }

  function finalizeTask(taskId = '', payload = {}) {
    const current = getMutableTask(taskId);
    if (!current) return null;
    if (TERMINAL_STATUSES.has(current.status)) {
      return cloneJson(current, null);
    }

    const nextStatus = normalizeText(payload.status || current.status) || current.status;
    const nextStage = normalizeText(payload.stage || nextStatus) || nextStatus;
    const replyText = normalizeText(payload.replyText);
    const latestSummary = normalizeText(payload.latestSummary || summarizeReply(replyText));
    const retainSession = typeof payload.retainSession === 'boolean'
      ? payload.retainSession
      : Boolean(current.ack_sent);
    const completedAt = payload.completedAt || nowIso();

    const task = writeTask({
      ...current,
      status: nextStatus,
      stage: nextStage,
      completed_at: completedAt,
      latest_summary: latestSummary || current.latest_summary,
      result_excerpt: replyText || current.result_excerpt,
      error: normalizeText(payload.error || current.error),
      followup_sent: Boolean(payload.followupSent || current.followup_sent),
      session_status: retainSession ? 'retained' : current.session_status
    });
    clearController(task.id);

    const session = getMutableSession(task.session_key);
    if (!session) {
      return cloneJson(task, null);
    }

    if (!retainSession) {
      removeSession(task.session_key);
      return cloneJson(task, null);
    }

    const latestTaskId = session.latest_task_id === task.id ? task.id : session.latest_task_id;
    saveSession({
      ...session,
      status: session.status === 'done' ? 'done' : 'retained',
      active_task_id: session.active_task_id === task.id ? '' : session.active_task_id,
      latest_task_id: latestTaskId || task.id,
      latest_summary: nextStatus === 'completed'
        ? (latestSummary || session.latest_summary)
        : session.latest_summary,
      latest_result_excerpt: nextStatus === 'completed'
        ? (replyText || session.latest_result_excerpt)
        : session.latest_result_excerpt,
      original_text: task.original_text || session.original_text,
      updated_at: nowIso(),
      expires_at: new Date(Date.now() + sessionTtlMs).toISOString(),
      closed_at: session.closed_at || null
    });

    return cloneJson(task, null);
  }

  function requestCancel(taskId = '', options = {}) {
    const task = getMutableTask(taskId);
    if (!task) return null;
    if (TERMINAL_STATUSES.has(task.status)) return cloneJson(task, null);

    cancelAttachedController(task.id, normalizeText(options.reason || 'cancelled') || 'cancelled');
    const completedAt = nowIso();
    const next = writeTask({
      ...task,
      status: 'cancelled',
      stage: 'cancelled',
      suppress_followup: true,
      cancel_requested_at: completedAt,
      completed_at: completedAt,
      error: normalizeText(options.error || 'cancelled'),
      session_status: 'retained'
    });

    const session = getMutableSession(task.session_key);
    if (session) {
      saveSession({
        ...session,
        status: session.status === 'done' ? 'done' : 'retained',
        active_task_id: session.active_task_id === task.id ? '' : session.active_task_id,
        latest_task_id: task.id,
        updated_at: nowIso(),
        expires_at: new Date(Date.now() + sessionTtlMs).toISOString()
      });
    }

    clearController(task.id);
    return cloneJson(next, null);
  }

  function supersedeTask(taskId = '', supersededBy = '') {
    const task = getMutableTask(taskId);
    if (!task) return null;
    if (TERMINAL_STATUSES.has(task.status)) return cloneJson(task, null);

    cancelAttachedController(task.id, 'superseded');
    const completedAt = nowIso();
    const next = writeTask({
      ...task,
      status: 'superseded',
      stage: 'superseded',
      suppress_followup: true,
      cancel_requested_at: completedAt,
      superseded_by: normalizeText(supersededBy),
      completed_at: completedAt,
      error: normalizeText(task.error || 'superseded'),
      session_status: 'retained'
    });

    const session = getMutableSession(task.session_key);
    if (session && session.active_task_id === task.id) {
      saveSession({
        ...session,
        status: session.status === 'done' ? 'done' : 'retained',
        active_task_id: '',
        latest_task_id: task.id,
        updated_at: nowIso(),
        expires_at: new Date(Date.now() + sessionTtlMs).toISOString()
      });
    }

    clearController(task.id);
    return cloneJson(next, null);
  }

  function closeSession(sessionKey = '') {
    const session = getMutableSession(sessionKey);
    if (!session) return null;

    if (session.active_task_id) {
      requestCancel(session.active_task_id, {
        error: 'session closed',
        reason: 'session closed'
      });
    }

    const next = saveSession({
      ...session,
      status: 'done',
      active_task_id: '',
      updated_at: nowIso(),
      closed_at: nowIso()
    });

    if (next.latest_task_id) {
      touchTask(next.latest_task_id, (task) => ({
        ...task,
        suppress_followup: true,
        session_status: 'done'
      }));
    }

    return cloneJson(next, null);
  }

  function canEmitFollowup(taskId = '') {
    const task = getMutableTask(taskId);
    if (!task) return false;
    if (task.suppress_followup || task.followup_sent) return false;
    const session = getMutableSession(task.session_key);
    if (!session) return false;
    if (session.status === 'done') return false;
    return session.latest_task_id === task.id;
  }

  function expireSessions() {
    const nowTs = Date.now();
    for (const [sessionKey, session] of sessionsByKey.entries()) {
      const expiresAt = Date.parse(String(session.expires_at || ''));
      if (Number.isFinite(expiresAt) && expiresAt <= nowTs) {
        if (session.active_task_id) {
          requestCancel(session.active_task_id, {
            error: 'expired',
            reason: 'expired'
          });
        }
        removeSession(sessionKey);
      }
    }
  }

  function restoreFromDisk() {
    ensureDir(storeDir);
    tasksById.clear();
    sessionsByKey.clear();
    controllersByTaskId.clear();

    const files = fs.readdirSync(storeDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(storeDir, name));

    for (const filePath of files) {
      const parsed = safeReadJson(filePath, null);
      if (!parsed || typeof parsed !== 'object') continue;
      let task = normalizeTask(parsed, { sessionTtlMs });
      if (ACTIVE_STATUSES.has(task.status)) {
        task = {
          ...task,
          status: 'interrupted',
          stage: 'interrupted',
          suppress_followup: true,
          completed_at: task.completed_at || nowIso(),
          error: task.error || 'interrupted on restore'
        };
      }
      writeTask(task);
    }

    const grouped = new Map();
    for (const task of tasksById.values()) {
      const sessionKey = normalizeText(task.session_key);
      if (!sessionKey) continue;
      const list = grouped.get(sessionKey) || [];
      list.push(task);
      grouped.set(sessionKey, list);
    }

    for (const [sessionKey, list] of grouped.entries()) {
      const sorted = list.slice().sort((a, b) => {
        const byRevision = Number(b.revision || 0) - Number(a.revision || 0);
        if (byRevision !== 0) return byRevision;
        return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
      });
      const latest = sorted[0];
      const explicitDone = sorted.find((item) => item.session_status === 'done');
      saveSession(buildSessionSkeleton(sessionKey, {
        status: explicitDone ? 'done' : 'retained',
        active_task_id: '',
        latest_task_id: latest?.id || '',
        latest_summary: latest?.latest_summary || '',
        latest_result_excerpt: latest?.result_excerpt || '',
        original_text: latest?.original_text || '',
        revision: Number(latest?.revision || 0),
        updated_at: latest?.updated_at || nowIso(),
        expires_at: latest?.expires_at || new Date(Date.now() + sessionTtlMs).toISOString(),
        closed_at: explicitDone?.completed_at || null
      }));
    }
  }

  restoreFromDisk();

  return {
    attachController,
    canEmitFollowup,
    closeSession,
    expireSessions,
    finalizeTask,
    getActiveTask,
    getSessionState,
    getTask,
    listTasks,
    markAckSent,
    markFollowupSent,
    markTaskReviewing,
    markTaskRunning,
    markTaskStatus,
    requestCancel,
    restoreFromDisk,
    shouldContinue,
    startTask,
    summarizeReply,
    supersedeTask
  };
}

let singletonRuntime = null;

function getBackgroundTaskRuntime() {
  if (!singletonRuntime) {
    singletonRuntime = createBackgroundTaskRuntime();
  }
  return singletonRuntime;
}

module.exports = {
  createBackgroundTaskRuntime,
  getBackgroundTaskRuntime,
  summarizeReply
};
