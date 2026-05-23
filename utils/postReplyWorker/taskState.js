const TASK_KEYS = [
  'memoryLearning',
  'selfImprovement',
  'dailyJournal',
  'memoryEvent',
  'materialize',
  'vectorMaintenance',
  'memoryQualityAudit',
  'profileMaintenance',
  'enrich'
];

const VALID_TASK_STATUSES = new Set([
  'pending',
  'running',
  'done',
  'failed',
  'failed_nonfatal',
  'skipped'
]);

const COMPLETED_TASK_STATUSES = new Set([
  'done',
  'failed_nonfatal',
  'skipped'
]);

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeTaskStatus(value = '', fallback = 'pending') {
  const status = normalizeText(value).toLowerCase();
  return VALID_TASK_STATUSES.has(status) ? status : fallback;
}

function isTaskStatusCompleted(status = '') {
  return COMPLETED_TASK_STATUSES.has(normalizeTaskStatus(status));
}

function normalizeTaskState(value = {}, fallback = {}) {
  if (value === true) {
    return {
      status: 'done',
      attempt: 0,
      startedAt: '',
      completedAt: '',
      durationMs: 0,
      lastError: ''
    };
  }
  if (value === false || value == null) {
    return {
      status: 'pending',
      attempt: 0,
      startedAt: '',
      completedAt: '',
      durationMs: 0,
      lastError: ''
    };
  }
  const source = normalizeObject(value, {});
  const fallbackState = normalizeObject(fallback, {});
  const status = normalizeTaskStatus(source.status, normalizeTaskStatus(fallbackState.status));
  return {
    status,
    attempt: Math.max(0, Number(source.attempt ?? fallbackState.attempt) || 0),
    startedAt: normalizeText(source.startedAt || source.started_at || fallbackState.startedAt),
    completedAt: normalizeText(source.completedAt || source.completed_at || fallbackState.completedAt),
    durationMs: Math.max(0, Number(source.durationMs ?? source.duration_ms ?? fallbackState.durationMs) || 0),
    lastError: normalizeText(source.lastError || source.last_error || fallbackState.lastError),
    step: normalizeText(source.step || fallbackState.step)
  };
}

function normalizeTaskStates(taskStatesValue = {}, completedTasksValue = {}) {
  const out = {};
  for (const [key, value] of Object.entries(normalizeObject(completedTasksValue, {}))) {
    const normalizedKey = normalizeText(key);
    if (!normalizedKey) continue;
    out[normalizedKey] = normalizeTaskState(value);
  }
  for (const [key, value] of Object.entries(normalizeObject(taskStatesValue, {}))) {
    const normalizedKey = normalizeText(key);
    if (!normalizedKey) continue;
    out[normalizedKey] = normalizeTaskState(value, out[normalizedKey]);
  }
  return out;
}

function normalizeCompletedTasksCompat(completedTasksValue = {}, taskStatesValue = {}) {
  const out = {};
  for (const [key, value] of Object.entries(normalizeObject(completedTasksValue, {}))) {
    const normalizedKey = normalizeText(key);
    if (!normalizedKey) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[normalizedKey] = isTaskStatusCompleted(value.status);
    } else {
      out[normalizedKey] = value === true;
    }
  }
  for (const [key, value] of Object.entries(normalizeObject(taskStatesValue, {}))) {
    const normalizedKey = normalizeText(key);
    if (!normalizedKey) continue;
    out[normalizedKey] = isTaskStatusCompleted(normalizeTaskState(value).status);
  }
  return out;
}

function isTaskStateCompleted(job = {}, taskKey = '') {
  const key = normalizeText(taskKey);
  if (!key) return false;
  const taskStates = normalizeTaskStates(job.taskStates, job.completedTasks);
  if (taskStates[key]) return isTaskStatusCompleted(taskStates[key].status);
  return normalizeCompletedTasksCompat(job.completedTasks)[key] === true;
}

function buildTaskState(currentState = {}, status = 'pending', options = {}) {
  const normalizedCurrent = normalizeTaskState(currentState);
  const nextStatus = normalizeTaskStatus(status);
  const completedAt = isTaskStatusCompleted(nextStatus) || nextStatus === 'failed'
    ? normalizeText(options.completedAt) || nowIso()
    : '';
  const startedAt = normalizeText(options.startedAt) || normalizedCurrent.startedAt || (nextStatus === 'running' ? nowIso() : '');
  const durationMs = Math.max(0, Number(options.durationMs ?? normalizedCurrent.durationMs) || 0);
  return normalizeTaskState({
    ...normalizedCurrent,
    status: nextStatus,
    attempt: Math.max(0, Number(options.attempt ?? normalizedCurrent.attempt) || 0),
    startedAt,
    completedAt,
    durationMs,
    lastError: normalizeText(options.lastError),
    step: normalizeText(options.step || normalizedCurrent.step)
  });
}

function buildTaskStatusPatch(job = {}, taskKey = '', status = 'pending', options = {}) {
  const key = normalizeText(taskKey);
  if (!key) return {};
  const taskStates = normalizeTaskStates(job.taskStates, job.completedTasks);
  const completedTasks = normalizeCompletedTasksCompat(job.completedTasks, taskStates);
  taskStates[key] = buildTaskState(taskStates[key], status, options);
  completedTasks[key] = isTaskStatusCompleted(taskStates[key].status);
  return {
    completedTasks,
    taskStates
  };
}

function resetTaskState(currentState = {}) {
  const normalized = normalizeTaskState(currentState);
  return normalizeTaskState({
    ...normalized,
    status: 'pending',
    startedAt: '',
    completedAt: '',
    durationMs: 0,
    lastError: ''
  });
}

module.exports = {
  COMPLETED_TASK_STATUSES,
  TASK_KEYS,
  VALID_TASK_STATUSES,
  buildTaskState,
  buildTaskStatusPatch,
  isTaskStateCompleted,
  isTaskStatusCompleted,
  normalizeCompletedTasksCompat,
  normalizeTaskState,
  normalizeTaskStates,
  resetTaskState
};
