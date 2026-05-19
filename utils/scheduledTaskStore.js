const config = require('../config');
const { createJsonHotStore } = require('./jsonHotStore');
const {
  compareDateTimeText,
  computeNextCronRun
} = require('./scheduledTaskTime');
const {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  cloneJson,
  makeTaskId,
  normalizeText,
  nowDateTimeText,
  nowIso,
  resolveStoreFile
} = require('./scheduledTaskStore/common');
const {
  normalizeTask,
  validateTaskInput
} = require('./scheduledTaskStore/taskShape');

function createScheduledTaskStore(options = {}) {
  const filePath = resolveStoreFile(options);
  const tasksById = new Map();
  const hotStore = createJsonHotStore(filePath, {
    fallback: () => ({ version: 1, tasks: [] }),
    debounceMs: Math.max(0, Number(options.debounceMs || config.HOT_STORE_DEBOUNCE_MS || 250) || 250),
    maxDelayMs: Math.max(0, Number(options.maxDelayMs || config.HOT_STORE_MAX_DELAY_MS || 2000) || 2000)
  });

  function persist() {
    const tasks = Array.from(tasksById.values())
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    hotStore.replace({
      version: 1,
      tasks
    });
  }

  function restore() {
    tasksById.clear();
    const data = hotStore.read({ forceReload: true });
    for (const item of Array.isArray(data?.tasks) ? data.tasks : []) {
      const normalized = normalizeTask(item);
      if (!normalized.id) continue;
      tasksById.set(normalized.id, normalized);
    }
  }

  function listTasks(filters = {}) {
    const groupId = normalizeText(filters.groupId);
    const ownerUserId = normalizeText(filters.ownerUserId);
    const statuses = Array.isArray(filters.statuses)
      ? new Set(filters.statuses.map((item) => normalizeText(item)).filter(Boolean))
      : null;

    return Array.from(tasksById.values())
      .filter((task) => !groupId || task.groupId === groupId)
      .filter((task) => !ownerUserId || task.ownerUserId === ownerUserId)
      .filter((task) => !statuses || statuses.size === 0 || statuses.has(task.status))
      .sort((a, b) => compareDateTimeText(a.nextRunAt || a.executeAt || '', b.nextRunAt || b.executeAt || '') || String(a.id).localeCompare(String(b.id)))
      .map((task) => cloneJson(task, null));
  }

  function getTask(taskId = '') {
    const task = tasksById.get(normalizeText(taskId));
    return task ? cloneJson(task, null) : null;
  }

  function saveTask(task = {}) {
    const normalized = normalizeTask(task);
    tasksById.set(normalized.id, normalized);
    persist();
    return cloneJson(normalized, null);
  }

  function createTask(input = {}) {
    const validated = validateTaskInput(input);
    const createdAt = nowIso();
    const task = normalizeTask({
      id: makeTaskId(),
      ownerUserId: validated.ownerUserId,
      groupId: validated.groupId,
      kind: validated.kind,
      commandType: validated.commandType,
      status: 'active',
      scheduleType: validated.scheduleType,
      cronExpr: validated.cronExpr,
      executeAt: validated.executeAt,
      payload: validated.payload,
      createdAt,
      updatedAt: createdAt,
      lastRunAt: '',
      lastResult: null
    });
    tasksById.set(task.id, task);
    persist();
    return {
      task: cloneJson(task, null),
      whenSummary: validated.whenSummary
    };
  }

  function updateTask(taskId = '', mutator = null) {
    const key = normalizeText(taskId);
    const current = tasksById.get(key);
    if (!current) return null;
    const next = typeof mutator === 'function' ? (mutator(cloneJson(current, {})) || current) : current;
    const normalized = normalizeTask({
      ...current,
      ...next,
      updatedAt: nowIso()
    });
    tasksById.set(key, normalized);
    persist();
    return cloneJson(normalized, null);
  }

  function cancelTask(taskId = '') {
    return updateTask(taskId, (task) => ({
      ...task,
      status: 'cancelled',
      nextRunAt: ''
    }));
  }

  function deleteTask(taskId = '') {
    const key = normalizeText(taskId);
    if (!key || !tasksById.has(key)) return false;
    tasksById.delete(key);
    persist();
    return true;
  }

  function getDueTasks(nowText = nowDateTimeText()) {
    return Array.from(tasksById.values())
      .filter((task) => ACTIVE_STATUSES.has(task.status))
      .filter((task) => normalizeText(task.nextRunAt))
      .filter((task) => compareDateTimeText(task.nextRunAt, nowText) <= 0)
      .sort((a, b) => compareDateTimeText(a.nextRunAt, b.nextRunAt))
      .map((task) => cloneJson(task, null));
  }

  function markRunResult(taskId = '', payload = {}) {
    return updateTask(taskId, (task) => {
      const status = normalizeText(payload.status) || task.status;
      const nowText = normalizeText(payload.nowText || nowDateTimeText()) || nowDateTimeText();
      const lastResult = payload.lastResult && typeof payload.lastResult === 'object'
        ? cloneJson(payload.lastResult, {})
        : task.lastResult;
      const nextRunAt = (() => {
        if (status !== 'active') return '';
        if (task.scheduleType === 'once') return '';
        return computeNextCronRun(task.cronExpr, nowText);
      })();
      return {
        ...task,
        status,
        lastRunAt: payload.lastRunAt || nowIso(),
        lastResult,
        nextRunAt,
        updatedAt: nowIso()
      };
    });
  }

  function advanceCronWithoutExecution(taskId = '', nowText = nowDateTimeText()) {
    return updateTask(taskId, (task) => {
      if (task.scheduleType !== 'cron' || !ACTIVE_STATUSES.has(task.status)) return task;
      return {
        ...task,
        nextRunAt: computeNextCronRun(task.cronExpr, nowText),
        updatedAt: nowIso()
      };
    });
  }

  restore();

  return {
    advanceCronWithoutExecution,
    cancelTask,
    createTask,
    deleteTask,
    flushSync() {
      return hotStore.flushSync();
    },
    getDueTasks,
    getTask,
    listTasks,
    markRunResult,
    restore,
    saveTask,
    updateTask
  };
}

let singletonStore = null;

function getScheduledTaskStore() {
  if (!singletonStore) {
    singletonStore = createScheduledTaskStore();
  }
  return singletonStore;
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  createScheduledTaskStore,
  getScheduledTaskStore,
  normalizeTask,
  nowDateTimeText
};
