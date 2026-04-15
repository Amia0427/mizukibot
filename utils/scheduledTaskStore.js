const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const {
  compareDateTimeText,
  computeNextCronRun,
  normalizeWhenExpression
} = require('./scheduledTaskTime');

const ACTIVE_STATUSES = new Set(['active']);
const TERMINAL_STATUSES = new Set(['cancelled', 'completed', 'failed']);
const ALLOWED_KINDS = new Set(['message', 'command']);
const ALLOWED_COMMAND_TYPES = new Set(['group_message', 'qzone_post']);
const ALLOWED_SCHEDULE_TYPES = new Set(['once', 'cron']);
const ALLOWED_STATUSES = new Set(['active', 'cancelled', 'completed', 'failed']);

function nowIso() {
  return new Date().toISOString();
}

function nowDateTimeText() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
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

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tempPath, text, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, text, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM' && error.code !== 'EXDEV') throw error;
  }
}

function makeTaskId() {
  return `qqtask_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
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

function resolveStoreFile(options = {}) {
  const configured = normalizeText(options.filePath || config.SCHEDULED_QQ_TASKS_FILE);
  return configured || path.join(config.DATA_DIR, 'scheduled_qq_tasks.json');
}

function computeNextRunAt(task = {}, nowText = nowDateTimeText()) {
  if (task.scheduleType === 'once') {
    return normalizeText(task.executeAt);
  }
  if (task.scheduleType === 'cron') {
    return computeNextCronRun(task.cronExpr, nowText);
  }
  return '';
}

function normalizePayload(task = {}) {
  const payload = task.payload && typeof task.payload === 'object' ? task.payload : {};
  if (normalizeText(task.commandType) === 'qzone_post') {
    const mode = normalizeText(payload.mode).toLowerCase() === 'bot_diary' ? 'bot_diary' : 'manual';
    return cloneJson({
      mode,
      ...(mode === 'manual'
        ? { content: normalizeText(payload.content) }
        : { hint: normalizeText(payload.hint) })
    }, {});
  }
  return cloneJson(payload, {});
}

function normalizeTask(task = {}, options = {}) {
  const nowText = normalizeText(options.nowText || nowDateTimeText()) || nowDateTimeText();
  const createdAt = normalizeText(task.createdAt || task.created_at) || nowIso();
  const updatedAt = normalizeText(task.updatedAt || task.updated_at) || createdAt;
  const scheduleType = ALLOWED_SCHEDULE_TYPES.has(normalizeText(task.scheduleType))
    ? normalizeText(task.scheduleType)
    : (normalizeText(task.cronExpr) ? 'cron' : 'once');
  const kind = ALLOWED_KINDS.has(normalizeText(task.kind)) ? normalizeText(task.kind) : 'message';
  const commandType = ALLOWED_COMMAND_TYPES.has(normalizeText(task.commandType))
    ? normalizeText(task.commandType)
    : (kind === 'message' ? 'group_message' : '');
  const status = ALLOWED_STATUSES.has(normalizeText(task.status))
    ? normalizeText(task.status)
    : 'active';
  const normalized = {
    id: normalizeText(task.id) || makeTaskId(),
    ownerUserId: normalizeText(task.ownerUserId || task.owner_user_id || task.userId || task.user_id),
    groupId: normalizeText(task.groupId || task.group_id),
    kind,
    commandType,
    status,
    scheduleType,
    cronExpr: scheduleType === 'cron' ? normalizeText(task.cronExpr || task.cron_expr) : '',
    executeAt: scheduleType === 'once' ? normalizeText(task.executeAt || task.execute_at) : '',
    nextRunAt: normalizeText(task.nextRunAt || task.next_run_at),
    payload: normalizePayload(task),
    createdAt,
    updatedAt,
    lastRunAt: normalizeText(task.lastRunAt || task.last_run_at),
    lastResult: task.lastResult && typeof task.lastResult === 'object' ? cloneJson(task.lastResult, {}) : null
  };

  if (!normalized.nextRunAt && ACTIVE_STATUSES.has(normalized.status)) {
    normalized.nextRunAt = computeNextRunAt(normalized, nowText);
  }
  return normalized;
}

function validateTaskInput(input = {}) {
  const ownerUserId = normalizeText(input.ownerUserId);
  const groupId = normalizeText(input.groupId);
  const kind = normalizeText(input.kind);
  const commandType = normalizeText(input.commandType);

  if (!ownerUserId) throw new Error('ownerUserId 不能为空');
  if (!groupId) throw new Error('groupId 不能为空');
  if (!ALLOWED_KINDS.has(kind)) throw new Error('kind 仅支持 message 或 command');
  if (!ALLOWED_COMMAND_TYPES.has(commandType)) throw new Error('commandType 仅支持 group_message 或 qzone_post');
  if (kind === 'message' && commandType !== 'group_message') {
    throw new Error('message 任务仅支持 group_message');
  }

  const normalizedWhen = normalizeWhenExpression(input.when);
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  if (commandType === 'group_message') {
    if (!normalizeText(payload.message)) throw new Error('群消息内容不能为空');
  }
  if (commandType === 'qzone_post') {
    const mode = normalizeText(payload.mode).toLowerCase() === 'bot_diary' ? 'bot_diary' : 'manual';
    if (mode === 'manual' && !normalizeText(payload.content)) throw new Error('空间内容不能为空');
    if (mode === 'bot_diary') {
      return {
        ownerUserId,
        groupId,
        kind,
        commandType,
        scheduleType: normalizedWhen.kind === 'cron' ? 'cron' : 'once',
        cronExpr: normalizedWhen.cronExpr || '',
        executeAt: normalizedWhen.executeAt || '',
        payload: cloneJson({
          mode,
          hint: normalizeText(payload.hint)
        }, {}),
        whenSummary: normalizedWhen.summary || ''
      };
    }
  }

  return {
    ownerUserId,
    groupId,
    kind,
    commandType,
    scheduleType: normalizedWhen.kind === 'cron' ? 'cron' : 'once',
    cronExpr: normalizedWhen.cronExpr || '',
    executeAt: normalizedWhen.executeAt || '',
    payload: cloneJson(commandType === 'qzone_post'
      ? {
        mode: normalizeText(payload.mode).toLowerCase() === 'bot_diary' ? 'bot_diary' : 'manual',
        ...(normalizeText(payload.mode).toLowerCase() === 'bot_diary'
          ? { hint: normalizeText(payload.hint) }
          : { content: normalizeText(payload.content) })
      }
      : payload, {}),
    whenSummary: normalizedWhen.summary || ''
  };
}

function createScheduledTaskStore(options = {}) {
  const filePath = resolveStoreFile(options);
  const tasksById = new Map();

  function persist() {
    const tasks = Array.from(tasksById.values())
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    atomicWriteJson(filePath, {
      version: 1,
      tasks
    });
  }

  function restore() {
    tasksById.clear();
    const data = safeReadJson(filePath, { version: 1, tasks: [] });
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
